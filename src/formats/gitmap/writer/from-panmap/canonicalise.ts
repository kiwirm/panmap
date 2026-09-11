import type { MapSymbol, RenderLayer } from '../../../../panmap/model.js'

// Derive the canonical symbol type from the (already-canonicalised) layers.
// OCAD models an area-with-outline as an `area` symbol + a border line; OMap
// models the same thing as a `combined` symbol (area part + line ref). Both
// readers build the identical `fill` + `border-symbol` render layers — only
// the container type label differs. Canonicalise the pair to `combined`.
//
// Also downgrades `combined → line` when my transforms (e.g.
// `mergePrimaryStrokeWithBorders`) collapsed a two-part combined symbol
// into a single-stroke-with-borders line. Without this, gitmap would keep
// the source-format `combined` label while the layer content reads as a
// plain line — causing a one-cycle drift on omap round-trips where the
// re-imported xmap sees `line` (matching the layer content).
export function canonicalSymbolType(
  originalType: string | undefined,
  canonLayers: readonly RenderLayer[],
): string | undefined {
  const hasBorder = canonLayers.some(l => l.type === 'border-symbol')
  const hasFill = canonLayers.some(
    l =>
      l.type === 'fill' ||
      l.type === 'hatch-fill' ||
      l.type === 'point-pattern-fill' ||
      l.type === 'structure-fill',
  )
  const hasStroke = canonLayers.some(l => l.type === 'stroke')
  const hasLineGeometry = canonLayers.some(
    l =>
      l.type === 'stroke' ||
      l.type === 'line-elements' ||
      l.type === 'line-symbols',
  )
  // Area-with-border (border-symbol reference OR its post-dereference `stroke`
  // form): both dialects should serialise as `combined` so the OMap writer's
  // `combined_symbol` path fires and preserves the borderSym on OCD round-trip.
  if (
    hasFill &&
    (hasBorder || hasStroke) &&
    (originalType === 'area' || originalType === 'combined')
  ) {
    return 'combined'
  }
  // `combined` labelled but its layers infer to a plain line — downgrade.
  if (originalType === 'combined' && !hasFill && hasLineGeometry) return 'line'
  return originalType
}

// Extract a canonical `point-fill` / `point-stroke` layer from an OCAD-style
// `point-elements` element record, or return null if the element doesn't match
// one of those shapes. The two shapes are:
//   Disc (type 4, lineWidth 0):     {type: 'point-fill',   colorId, radius}
//   Ring (type 3, lineWidth > 0):   {type: 'point-stroke', colorId, radius, width}
// OMap's `radius` for a ring is the INNER radius `(diameter - lineWidth) / 2`.
function pointElementToLayer(el: unknown): RenderLayer | null {
  const e = el as {
    type?: number
    color?: unknown
    lineWidth?: number
    diameter?: number
    coords?: unknown[]
    flags?: number
  }
  const coords = e.coords
  if (!Array.isArray(coords) || coords.length !== 1) return null
  const c = coords[0] as { x?: number; y?: number } | [number?, number?]
  // Snap the coord the same way serialisation (stripPointElementXyFlags) will,
  // BEFORE the origin test — otherwise a disc centred a fraction off origin
  // (e.g. [1,0] → snaps to [0,0]) reads as "not a disc" on the source write but
  // as a disc on the gitmap-read re-write, breaking round-trip idempotence.
  const cx = snapSymCoord(Array.isArray(c) ? (c[0] ?? 0) : (c?.x ?? 0))
  const cy = snapSymCoord(Array.isArray(c) ? (c[1] ?? 0) : (c?.y ?? 0))
  if (cx !== 0 || cy !== 0 || e.flags) return null
  const diameter = Number(e.diameter ?? 0)
  const lineWidth = Number(e.lineWidth ?? 0)
  if (e.type === 4 && lineWidth === 0 && diameter > 0) {
    return {
      type: 'point-fill',
      colorId: e.color,
      radius: diameter / 2,
    } as unknown as RenderLayer
  }
  if (e.type === 3 && lineWidth > 0 && diameter > 0) {
    return {
      type: 'point-stroke',
      colorId: e.color,
      radius: (diameter - lineWidth) / 2,
      width: lineWidth,
    } as unknown as RenderLayer
  }
  return null
}

// OCAD encodes a "single disc" / "single ring" point symbol as a
// `point-elements` layer with exactly ONE element; OMap represents the same
// visual as a dedicated `point-fill` / `point-stroke` layer. Rewrite the OCD
// single-element form to match.
//
// Multi-element point-elements survive as `point-elements` but their
// element records get canonicalised to the OCD-flat shape: OMap-native
// records arrive as `{symbol, object}` xmap trees, which are flattened via
// `flattenXmapLineDecorElement` (the same helper `line-elements` uses).
// OMap's opinionated multi-element SPLIT into typed sub-layers is not
// reproduced — OMap's rule was opaque and eager splitting produced spurious
// diffs on symbols like 105.1 (Earth wall, minimum) where OMap keeps
// everything as one point-elements layer.
export function canonicalisePointElementsLayer(
  layer: RenderLayer,
): RenderLayer[] {
  const l = layer as { type?: string; elements?: unknown[] }
  if (l.type !== 'point-elements' || !Array.isArray(l.elements)) return [layer]
  // Flatten any OMap-nested `{symbol, object}` elements to OCD-flat records
  // so both dialects agree. Records that already look OCD-flat pass through
  // stripPointElementXyFlags.
  const canonical = l.elements.flatMap(el => {
    const e = el as { symbol?: unknown; type?: number }
    if (e && typeof e === 'object' && e.symbol) {
      return flattenXmapLineDecorElement(el)
    }
    return [stripPointElementXyFlags(el)]
  })
  // Drop the whole layer if the flatten produced nothing — OMap sometimes
  // emits a `point-elements` containing a single invisible pointSymbol
  // (innerRadius=0, outerWidth=0) that renders nothing. My OCD side never
  // creates such phantoms; drop OMap's to match (e.g. butlers-bush 113.1).
  if (canonical.length === 0) return []
  // Extract EVERY leading disc/ring-at-origin element into a typed point-fill/
  // point-stroke layer, stopping at the first element that isn't one. This is a
  // FIXED POINT: the residual (when non-empty) starts with a non-extractable
  // element, so re-reading a gitmap and re-canonicalising extracts nothing more
  // — a single disc/ring and a multi-element point symbol serialise the same on
  // every write. (Earlier this stopped one short and capped each type once to
  // mirror an assumed OMap residual; that wasn't idempotent — the leftover
  // single element re-extracted on the next write.)
  const extras: RenderLayer[] = []
  let splitIndex = 0
  while (splitIndex < canonical.length) {
    const ex = pointElementToLayer(canonical[splitIndex])
    if (!ex) break
    extras.push(ex)
    splitIndex++
  }
  if (extras.length === 0)
    return [{ ...layer, elements: canonical } as RenderLayer]
  const residual = canonical.slice(splitIndex)
  return residual.length > 0
    ? [...extras, { ...layer, elements: residual } as RenderLayer]
    : extras
}

// Strip derived xFlags/yFlags from OCD-flat element coords. The OCAD reader
// decodes them from the on-disk flag byte; the OMap side stores only the
// raw `flags` byte and skips `normaliseOmapFlags` on symbol-internal
// element coords. Removing the derived fields lets both dialects agree on
// the coord shape without losing Bezier / dash-point info (still present
// on the object coords + on the primary stroke, and re-derived on write).
//
// Coords may be either plain `{x,y}` objects OR `TdPoly` array-likes
// (`[x, y]` with `xFlags`/`yFlags` attached as extra properties) —
// normalise both to `{x, y}` objects with no derived flags.
function stripPointElementXyFlags(el: unknown): unknown {
  if (!el || typeof el !== 'object') return el
  const e = el as { coords?: unknown[] } & Record<string, unknown>
  if (!Array.isArray(e.coords)) return el
  const cleanedCoords = e.coords.map(c => {
    if (!c || typeof c !== 'object') return c
    if (Array.isArray(c)) {
      const arr = c as unknown as { 0?: number; 1?: number }
      return { x: snapSymCoord(arr[0] ?? 0), y: snapSymCoord(arr[1] ?? 0) }
    }
    const {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      xFlags,
      yFlags,
      x,
      y,
      ...rest
    } = c as {
      xFlags?: unknown
      yFlags?: unknown
      x?: number
      y?: number
    } & Record<string, unknown>
    return { ...rest, x: snapSymCoord(x ?? 0), y: snapSymCoord(y ?? 0) }
  })
  return { ...e, coords: cleanedCoords }
}

// Flatten a nested xmap `{symbol, object}` line-decor element into the
// OCAD-shaped flat records that OCAD-sourced `line-elements` already use.
// One xmap element can expand to multiple OCAD elements (a compound point
// symbol with an inner disc + outer ring + nested sub-elements).
//
// Element types (from `symbol-element-types.ts`):
//   1 Line, 2 Area, 3 Circle (ring), 4 Dot (filled disc).
//
// Coord y is FLIPPED to match OCD-native element convention (y-up). OCD-
// sourced elements are stored y-up here (symbol-internal offsets, not
// object coordinates — those get flipped separately). Xmap-sourced elements
// arrive y-down; flip so both dialects agree. The xmap writer's
// `ocadElementToXmapElement` re-flips on the reverse path (`y: -coordY(c)`).
//
// The OCAD-emitted `flags` byte packs cap+join style:
//   bit 0 (0x01) = round cap (capStyle == 1)
//   bit 2 (0x04) = miter/round join (joinStyle == 1)
// Xmap stores these as separate `capStyle`/`joinStyle` fields on the nested
// lineSymbol; re-pack them here so a line element round-trips its style
// through the OCD writer's `flags` decode.
function flattenXmapLineDecorElement(el: unknown): unknown[] {
  if (!el || typeof el !== 'object') return []
  const e = el as {
    symbol?: {
      pointSymbol?: {
        innerColor?: unknown
        innerRadius?: number
        outerColor?: unknown
        outerWidth?: number
        elements?: unknown[]
      }
      lineSymbol?: {
        color?: unknown
        lineWidth?: number
        capStyle?: number
        joinStyle?: number
      }
      areaSymbol?: { color?: unknown; innerColor?: unknown }
    }
    object?: { coords?: Array<{ x?: number; y?: number } | [number?, number?]> }
  }
  const sym = e.symbol
  if (!sym) return []
  const rawCoords = e.object?.coords ?? []
  const anchor = rawCoords[0]
  const anchorX = snapSymCoord(
    Array.isArray(anchor) ? (anchor[0] ?? 0) : (anchor?.x ?? 0),
  )
  const anchorYSrc = snapSymCoord(
    Array.isArray(anchor) ? (anchor[1] ?? 0) : (anchor?.y ?? 0),
  )
  const anchorY = -anchorYSrc

  const out: unknown[] = []
  if (sym.pointSymbol) {
    const ps = sym.pointSymbol
    const innerRadius = Number(ps.innerRadius ?? 0)
    if (innerRadius > 0 && isRealColor(ps.innerColor)) {
      out.push({
        type: 4,
        flags: 0,
        color: ps.innerColor,
        lineWidth: 0,
        diameter: innerRadius * 2,
        numberCoords: 1,
        coords: [{ x: anchorX, y: anchorY }],
      })
    }
    const outerWidth = Number(ps.outerWidth ?? 0)
    if (outerWidth > 0 && isRealColor(ps.outerColor)) {
      out.push({
        type: 3,
        flags: 0,
        color: ps.outerColor,
        lineWidth: outerWidth,
        diameter: innerRadius * 2 + outerWidth,
        numberCoords: 1,
        coords: [{ x: anchorX, y: anchorY }],
      })
    }
    for (const sub of ps.elements ?? [])
      out.push(...flattenXmapLineDecorElement(sub))
    return out
  }
  if (sym.lineSymbol) {
    const coords = rawCoords.map(mapAndRoundYFlippedCoord)
    const cap = sym.lineSymbol.capStyle ?? 0
    const join = sym.lineSymbol.joinStyle ?? 0
    const flags = (cap === 1 ? 0x01 : 0) | (join === 1 ? 0x04 : 0)
    return [
      {
        type: 1,
        flags,
        color: sym.lineSymbol.color,
        lineWidth: sym.lineSymbol.lineWidth ?? 0,
        diameter: 0,
        numberCoords: coords.length,
        coords,
      },
    ]
  }
  if (sym.areaSymbol) {
    const coords = rawCoords.map(mapAndRoundYFlippedCoord)
    return [
      {
        type: 2,
        flags: 0,
        color: sym.areaSymbol.color ?? sym.areaSymbol.innerColor,
        lineWidth: 0,
        diameter: 0,
        numberCoords: coords.length,
        coords,
      },
    ]
  }
  return []
}

// Symbol-internal element coords land in OCAD as integers (whole 0.01mm
// units); OMap keeps them as float. Round to integer to match — object
// geometry precision lives elsewhere.
//
// SNAP to a 5-unit grid too: OCAD-written and Mapper-written files for the
// same source symbol frequently disagree on rounding direction for half-
// integers (e.g. kura 111 Small depression y=14 vs y=13, 113.1 y=±21 vs
// y=±22, 115 y=-21 vs y=-22). Both encoders picked a legal integer from
// the same underlying fractional geometry; snapping to a coarser grid
// (0.05mm) collapses the disagreements without a visually meaningful loss
// — 0.05mm is below any orienteering-map perceptual threshold at typical
// map scales (1:10000 = 0.5m on the ground).
function snapSymCoord(v: number): number {
  const step = 5
  return Math.round(v / step) * step
}
function mapAndRoundYFlippedCoord(
  c: { x?: number; y?: number } | [number?, number?],
): { x: number; y: number } {
  const x = Array.isArray(c) ? (c[0] ?? 0) : (c?.x ?? 0)
  const y = Array.isArray(c) ? (c[1] ?? 0) : (c?.y ?? 0)
  return { x: snapSymCoord(x), y: -snapSymCoord(y) }
}

function isRealColor(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'number') return v >= 0
  return typeof v === 'string' && v.length > 0
}

// Flatten a single OMap `midSymbol`/`startSymbol`/`endSymbol`/`dashSymbol`
// (a nested xmap point-symbol) into the flat `*SymElements` array shape used
// by OCD-sourced `line-elements`. Reuses `flattenXmapLineDecorElement` by
// synthesising an outer `{symbol, object}` wrapper positioned at the origin.
function flattenXmapDecorSymbol(sub: unknown): unknown[] {
  if (!sub || typeof sub !== 'object') return []
  return flattenXmapLineDecorElement({
    symbol: sub,
    object: { coords: [{ x: 0, y: 0 }] },
  })
}

// Nest an OCAD flat pattern element into the xmap-shape `{symbol, object}`
// record OMap emits inside `point-pattern-fill.pattern.symbol.pointSymbol.elements`.
// Y coord is FLIPPED: OCAD element coords are y-up here; xmap-nested elements
// are y-down. The xmap writer's `ocadElementsToXmapPointSymbol` re-flips on
// the reverse path (`y: -coordY(c)`).
// The `symbol.id` field is deliberately omitted — Mapper writes per-export
// negative counters (`-110`, `-111`, ...) that carry no meaning and would
// diff every export. `canonicaliseInnerElement` strips it from OMap-native
// side too.
function nestOcadPatternElement(el: unknown): unknown {
  if (!el || typeof el !== 'object') return null
  const e = el as {
    type?: number
    flags?: number
    color?: unknown
    lineWidth?: number
    diameter?: number
    coords?: Array<{ x?: number; y?: number } | [number?, number?]>
  }
  const coords = (e.coords ?? []).map(c => {
    const x = Array.isArray(c) ? (c[0] ?? 0) : (c?.x ?? 0)
    const y = Array.isArray(c) ? (c[1] ?? 0) : (c?.y ?? 0)
    return { x, y: -y }
  })
  const objectBase = { type: 0, symbol: 0, text: null, textBox: null, coords }
  if (e.type === 4) {
    return {
      symbol: {
        code: '',
        type: 1,
        isHidden: false,
        pointSymbol: {
          innerColor: e.color,
          innerRadius: (e.diameter ?? 0) / 2,
          outerColor: -1,
          outerWidth: 0,
          rotatable: false,
        },
      },
      object: objectBase,
    }
  }
  if (e.type === 3) {
    const lw = e.lineWidth ?? 0
    return {
      symbol: {
        code: '',
        type: 1,
        isHidden: false,
        pointSymbol: {
          innerColor: -1,
          innerRadius: ((e.diameter ?? 0) - lw) / 2,
          outerColor: e.color,
          outerWidth: lw,
          rotatable: false,
        },
      },
      object: objectBase,
    }
  }
  if (e.type === 1) {
    const flags = e.flags ?? 0
    return {
      symbol: {
        code: '',
        type: 2,
        isHidden: false,
        lineSymbol: {
          color: e.color,
          lineWidth: e.lineWidth ?? 0,
          capStyle: flags & 0x01 ? 1 : 0,
          joinStyle: flags & 0x04 ? 1 : 0,
        },
      },
      object: { ...objectBase, type: 1 },
    }
  }
  if (e.type === 2) {
    return {
      symbol: {
        code: '',
        type: 4,
        isHidden: false,
        // OMap-native elements emit only `innerColor` on the areaSymbol; the
        // `color` field is OCAD-writer-facing and OMap side omits it.
        areaSymbol: { innerColor: e.color },
      },
      // OMap encodes area sub-elements with `object.type: 1` (Mapper's line-
      // shaped object type used for closed polygons), not the fill-shaped
      // `type: 2` you'd expect. Match the convention.
      object: { ...objectBase, type: 1 },
    }
  }
  return null
}

// Strip fields that differ between dialects on an OMap-native inner element:
// - `symbol.id` (ephemeral Mapper counter)
// - `symbol.{point,line,area}Symbol` reduced to just the fields OCD side emits
// - `object.pattern` (default-empty position/rotation OMap emits everywhere)
// - `object.coords[i].flags` (OMap raw flag byte; OCD-side elements have
//   nothing — see `stripPointElementXyFlags` for the mirror).
function canonicaliseInnerElement(el: unknown): unknown {
  if (!el || typeof el !== 'object') return el
  const e = el as {
    symbol?: {
      id?: unknown
      pointSymbol?: Record<string, unknown>
      lineSymbol?: Record<string, unknown>
      areaSymbol?: Record<string, unknown>
    } & Record<string, unknown>
    object?: { coords?: unknown[]; pattern?: unknown } & Record<string, unknown>
  }
  if (!e.symbol) return el
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _id, pointSymbol, lineSymbol, areaSymbol, ...restSym } = e.symbol
  const cleanSym: Record<string, unknown> = { ...restSym }
  if (pointSymbol) cleanSym.pointSymbol = normaliseInnerPointSymbol(pointSymbol)
  if (lineSymbol) cleanSym.lineSymbol = normaliseInnerLineSymbol(lineSymbol)
  if (areaSymbol) cleanSym.areaSymbol = normaliseInnerAreaSymbol(areaSymbol)
  let restObj: unknown = e.object
  if (e.object && typeof e.object === 'object') {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { pattern: _pat, coords, ...rest } = e.object
    const cleanedCoords = Array.isArray(coords)
      ? coords.map(c => {
          if (!c || typeof c !== 'object' || Array.isArray(c)) return c
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { flags, ...crest } = c as { flags?: unknown } & Record<
            string,
            unknown
          >
          return crest
        })
      : coords
    restObj =
      cleanedCoords !== undefined ? { ...rest, coords: cleanedCoords } : rest
  }
  return { ...e, symbol: cleanSym, object: restObj }
}

// Reduce a nested line/area/point symbol to the minimal shape both dialects
// emit. OMap's writer serialises ~20 default line-symbol fields verbatim
// (`breakLength: 100`, `segmentLength: 400`, etc.) onto inner elements; the
// OCD-side flattener emits only the fields it actually uses.
function normaliseInnerLineSymbol(
  ls: Record<string, unknown>,
): Record<string, unknown> {
  return {
    color: ls.color,
    lineWidth: ls.lineWidth ?? 0,
    capStyle: ls.capStyle ?? 0,
    joinStyle: ls.joinStyle ?? 0,
  }
}
function normaliseInnerAreaSymbol(
  as: Record<string, unknown>,
): Record<string, unknown> {
  return { innerColor: as.innerColor ?? as.color }
}
function normaliseInnerPointSymbol(
  ps: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    innerColor: ps.innerColor ?? -1,
    innerRadius: ps.innerRadius ?? 0,
    outerColor: ps.outerColor ?? -1,
    outerWidth: ps.outerWidth ?? 0,
    rotatable: !!ps.rotatable,
  }
  if (Array.isArray(ps.elements) && ps.elements.length > 0) {
    out.elements = ps.elements.map(canonicaliseInnerElement)
  }
  return out
}

// Canonicalise a pattern-symbol node to the shape both dialects agree on.
// Strips Mapper's ephemeral private ids (`symbol.id: -N` counters that change
// per export) and fills in the defaults Mapper always writes onto its outer
// pointSymbol (`rotatable: true`, `innerRadius: 100` for multi-element
// container symbols) so the OCD-sourced form matches without special-casing.
function canonicaliseOuterPatternSymbol(sym: unknown): unknown {
  if (!sym || typeof sym !== 'object') return sym
  const s = sym as {
    id?: unknown
    code?: unknown
    type?: unknown
    isHidden?: unknown
    pointSymbol?: {
      innerColor?: unknown
      innerRadius?: number
      outerColor?: unknown
      outerWidth?: number
      rotatable?: unknown
      elements?: unknown[]
    }
  }
  const ps = s.pointSymbol
  const isMultiElement = Array.isArray(ps?.elements) && ps!.elements!.length > 0
  const canonPs = ps
    ? {
        ...ps,
        // OMap always sets rotatable=true on the outer pattern point-symbol,
        // independent of whether the pattern actually rotates (that lives on
        // `pattern.rotatable`). Match the convention.
        rotatable: true,
        // Multi-element container pointSymbols get a Mapper-convention 100-unit
        // innerRadius even though nothing paints — normalise both dialects.
        innerRadius: isMultiElement ? 100 : (ps?.innerRadius ?? 0),
        // Strip ephemeral Mapper counter ids off inner elements too.
        elements: isMultiElement
          ? (ps!.elements as unknown[]).map(canonicaliseInnerElement)
          : ps?.elements,
      }
    : ps
  const out: Record<string, unknown> = {
    code: s.code ?? '',
    type: s.type ?? 1,
    isHidden: s.isHidden ?? false,
    pointSymbol: canonPs,
  }
  // Drop `id` — it's Mapper's private symbol counter (`-77`, `-114`, ...)
  // that changes every export and carries no meaning.
  return out
}

// Canonicalise an OCAD-sourced `structure-fill` layer into the OMap-shape
// `point-pattern-fill` the OCD writer's `encodePatternStructure` consumes.
// Nests the flat `elements` array under `pattern.symbol.pointSymbol.elements`
// and preserves rotatability + clipping-mode fields.
//
// mode=2 (OCAD shifted-rows) is emitted as TWO `point-pattern-fill` layers
// so `isShiftedRows` in the OCD writer detects it correctly on the return
// path. Single-disc-at-origin patterns are LIFTED to the outer pointSymbol
// (innerColor + innerRadius, empty elements[]) to match OMap's convention
// for that shape — the OCD writer's `extractPatternElements` reads either.
export function structureFillToPointPattern(layer: RenderLayer): RenderLayer[] {
  const l = layer as {
    type?: string
    colorId?: unknown
    width?: number
    height?: number
    angle?: number
    mode?: number
    symbolWidth?: number
    symbolHeight?: number
    elements?: unknown[]
    noClipping?: number
    structDraw?: number
    rotatable?: boolean
    // OMap-native pass-through (normaliser branch below).
    pattern?: Record<string, unknown>
  }
  // OMap-native point-pattern-fill: strip the ephemeral symbol id and
  // normalise `pattern.symbol` to the canonical shape. Also strip the
  // OMap-writer-emitted `pattern.color` — that field duplicates the layer's
  // top-level `colorId`, and OMap's writer derives it from that, so it's
  // guaranteed-redundant. Leaving it caused a one-cycle drift on
  // omap→gitmap→omap round-trips: source had no `pattern.color`, xmap write
  // added it as OMap's default, next gitmap read saw it.
  if (l.type === 'point-pattern-fill' && l.pattern) {
    const p = l.pattern as { symbol?: unknown; color?: unknown } & Record<
      string,
      unknown
    >
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { color, symbol, ...rest } = p
    return [
      {
        ...l,
        pattern: { ...rest, symbol: canonicaliseOuterPatternSymbol(symbol) },
      } as unknown as RenderLayer,
    ]
  }
  if (l.type !== 'structure-fill') return [layer]
  const flatElements = l.elements ?? []
  const width = l.symbolWidth ?? l.width ?? 0
  const height = l.symbolHeight ?? l.height ?? 0
  const angleRad = ((l.angle ?? 0) * Math.PI) / 180
  const noClipping = l.noClipping ?? 0
  const rotatable = !!l.rotatable
  // Single-disc-at-origin lift.
  let outerInner: { color: unknown; radius: number } | undefined
  let nestedElements: unknown[] = []
  let topColorId: unknown = -1
  const soleDisc =
    flatElements.length === 1
      ? (flatElements[0] as {
          type?: number
          color?: unknown
          lineWidth?: number
          diameter?: number
          coords?: Array<{ x?: number; y?: number } | [number?, number?]>
        })
      : undefined
  const atOrigin = (c: unknown): boolean => {
    if (!c) return false
    const cx = Array.isArray(c) ? (c[0] ?? 0) : ((c as { x?: number })?.x ?? 0)
    const cy = Array.isArray(c) ? (c[1] ?? 0) : ((c as { y?: number })?.y ?? 0)
    return cx === 0 && cy === 0
  }
  if (
    soleDisc?.type === 4 &&
    (soleDisc.lineWidth ?? 0) === 0 &&
    Array.isArray(soleDisc.coords) &&
    soleDisc.coords.length === 1 &&
    atOrigin(soleDisc.coords[0])
  ) {
    outerInner = { color: soleDisc.color, radius: (soleDisc.diameter ?? 0) / 2 }
    topColorId = soleDisc.color
  } else {
    nestedElements = flatElements.map(nestOcadPatternElement).filter(Boolean)
  }
  // Mode=2 (shifted-rows) doubles OCAD's `structHeight` into the OMap
  // `lineSpacing`, and the second pattern's `lineOffset` equals `structHeight`.
  // This mirrors the OMap writer's `structures` path so `isShiftedRows` and
  // `structHeight = patterns[1].lineOffset` come out right on the round-trip.
  const shifted = l.mode === 2
  const lineSpacing = shifted ? height * 2 : height
  const pointDistance = width
  // OMap's reader sets both `layer.width` and `layer.height` to
  // `pointDistance || lineSpacing` — a symmetric cache. The asymmetric
  // tile info (e.g. 208 Boulder Field's 300×333 tile) lives in
  // `pattern.pointDistance` + `pattern.lineSpacing`. Match the convention.
  const layerSize = pointDistance
  const makePattern = ({
    lineOffset,
    offsetAlongLine,
  }: {
    lineOffset: number
    offsetAlongLine: number
  }): RenderLayer =>
    ({
      type: 'point-pattern-fill',
      colorId: topColorId,
      width: layerSize,
      height: layerSize,
      angle: l.angle ?? 0,
      pattern: {
        type: 2,
        angle: angleRad,
        lineSpacing,
        pointDistance,
        lineOffset,
        offsetAlongLine,
        lineWidth: 0,
        rotatable,
        noClipping,
        symbol: canonicaliseOuterPatternSymbol({
          code: '',
          type: 1,
          isHidden: false,
          pointSymbol: outerInner
            ? {
                innerColor: outerInner.color,
                innerRadius: outerInner.radius,
                outerColor: -1,
                outerWidth: 0,
                rotatable,
              }
            : {
                elements: nestedElements,
                innerColor: -1,
                innerRadius: 0,
                outerColor: -1,
                outerWidth: 0,
                rotatable,
              },
        }),
      },
    }) as unknown as RenderLayer
  const first = makePattern({ lineOffset: 0, offsetAlongLine: 0 })
  if (shifted) {
    const second = makePattern({
      lineOffset: height,
      offsetAlongLine: pointDistance / 2,
    })
    return [first, second]
  }
  return [first]
}

// Convert an OMap-native `line-symbols` render layer into the OCAD-flat
// `line-elements` shape. Preserves all mid/start/end/dashSymbol decorations
// by flattening each nested xmap tree into OCD-style element records. The
// resulting layer is what OCD-sourced maps emit directly, so both dialects
// agree on the canonical form; the xmap writer's `buildXmapLineSymbol`
// already rebuilds the nested tree from `primSymElements` via
// `ocadElementsToXmapPointSymbol`, so the reverse path works without change.
//
// Deliberately omits `mainLength`/`endLength`/`primSymDist`/`nPrimSym` —
// these duplicate the primary stroke's `segmentLength`/`endLength`/
// `midSymbolDistance`/`midSymbolsPerSpot`, which the writers already use
// as the primary source. Storing them here too creates a per-reader-default
// diff (OCAD carries the actual mainLength; OMap emits its 400 default).
export function lineSymbolsToLineElements(layer: RenderLayer): RenderLayer[] {
  const l = layer as {
    type?: string
    lineSymbol?: {
      midSymbol?: unknown
      startSymbol?: unknown
      endSymbol?: unknown
      dashSymbol?: unknown
    }
  }
  if (l.type !== 'line-symbols' || !l.lineSymbol) return [layer]
  const ls = l.lineSymbol
  const primSymElements = ls.midSymbol
    ? flattenXmapDecorSymbol(ls.midSymbol)
    : []
  const startSymElements = ls.startSymbol
    ? flattenXmapDecorSymbol(ls.startSymbol)
    : []
  const endSymElements = ls.endSymbol
    ? flattenXmapDecorSymbol(ls.endSymbol)
    : []
  const cornerSymElements = ls.dashSymbol
    ? flattenXmapDecorSymbol(ls.dashSymbol)
    : []
  // Drop entirely if no sub-symbol carries visible geometry — OMap emits
  // `line-symbols` on any line with a lineSymbol block (e.g. butlers-bush
  // 202.4 Cliff, where lineSymbol has only `minimumLength: 60`) but OCD
  // never emits a layer for that. The OCD writer's `useSymbolFlags` path
  // gates on the presence of sub-symbols, so dropping is safe.
  if (
    primSymElements.length === 0 &&
    startSymElements.length === 0 &&
    endSymElements.length === 0 &&
    cornerSymElements.length === 0
  ) {
    return []
  }
  return [
    {
      type: 'line-elements',
      primSymElements,
      cornerSymElements,
      startSymElements,
      endSymElements,
    } as unknown as RenderLayer,
  ]
}

// Strip redundant rhythm fields from any `line-elements` layer — see
// `lineSymbolsToLineElements` for rationale. Both OCD-sourced (via its
// reader) and OMap-sourced (via the flattener above) reach this filter.
//
// Also strips xFlags/yFlags from element coords: OCD-sourced elements have
// them (decoded from stored flag byte), OMap-sourced ones don't (the OMap
// reader doesn't run `normaliseOmapFlags` on symbol-internal element coords).
// Removing them lets both dialects agree on the coord shape; Bezier / dash
// info lives on the object coords + primary stroke where it matters.
export function stripLineElementsRedundancy(layer: RenderLayer): RenderLayer {
  const l = layer as { type?: string } & Record<string, unknown>
  if (l.type !== 'line-elements') return layer
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    mainLength,
    endLength,
    primSymDist,
    nPrimSym,
    ...rest
  } = l as Record<string, unknown> & {
    mainLength?: unknown
    endLength?: unknown
    primSymDist?: unknown
    nPrimSym?: unknown
  }
  for (const key of [
    'primSymElements',
    'startSymElements',
    'endSymElements',
    'cornerSymElements',
  ]) {
    const arr = rest[key]
    if (Array.isArray(arr)) rest[key] = arr.map(stripPointElementXyFlags)
  }
  return rest as unknown as RenderLayer
}

// An OCAD line symbol emits a phantom `stroke` layer with `colorId=-1, width=0`
// as a placeholder for the visible primary, when the whole visible geometry
// lives in a companion `double-line`. OMap doesn't emit that placeholder —
// once we've folded the double-line into the same stroke, the phantom is
// redundant. Drop it so both dialects agree.
//
// Guarded to only fire on line-typed symbols with a companion `double-line`
// (or its canonical `stroke.borders` form). Fill/hatch/pattern symbols that
// use a colorId=-1 marker for their own reasons stay untouched.
export function isPhantomStroke(layer: RenderLayer): boolean {
  const l = layer as { type?: string; colorId?: unknown; width?: number }
  if (l.type !== 'stroke') return false
  const idInvalid =
    l.colorId === -1 || l.colorId === null || l.colorId === undefined
  return idInvalid && (!l.width || l.width === 0)
}

// OCAD `double-line` is a solo layer describing a "casing" line — a central
// fill with coloured borders. OMap encodes the same visual as a `stroke`
// carrying a `borders: [...]` array. Rewrite the OCAD form to match OMap so
// gitmap holds a single canonical shape. The OCD writer's `deriveDoubleLine`
// already reconstructs the OCAD `dbl*` fields from a bordered stroke, so this
// is symmetric.
//
// Geometry (verified on paired maps): `shift = borderWidth / 2`. Where the
// left/right colours and widths match (near-universal), a single symmetric
// borders[] entry suffices; asymmetric cases emit two entries.
export function doubleLineToStroke(layer: RenderLayer): RenderLayer {
  const l = layer as {
    type?: string
    flags?: number
    leftColorId?: unknown
    rightColorId?: unknown
    fillColorId?: unknown
    centerWidth?: number
    leftWidth?: number
    rightWidth?: number
    dashLength?: number
    breakLength?: number
  }
  if (l.type !== 'double-line') return layer
  const symmetric =
    l.leftColorId === l.rightColorId &&
    (l.leftWidth ?? 0) === (l.rightWidth ?? 0)
  const dashLength = l.dashLength ?? 0
  const breakLength = l.breakLength ?? 0
  const makeBorder = (color: unknown, width: number) => ({
    color,
    width,
    shift: width / 2,
    dashed: dashLength > 0,
    dashLength,
    breakLength,
  })
  const borders = symmetric
    ? [makeBorder(l.leftColorId, l.leftWidth ?? 0)]
    : [
        makeBorder(l.leftColorId, l.leftWidth ?? 0),
        makeBorder(l.rightColorId, l.rightWidth ?? 0),
      ]
  // OCAD gates the centre fill on `dblFlags & 1`: flags=0 means "no fill"
  // regardless of the `dblFillColor` value (index 0 is a real palette slot,
  // typically illustration-white). Preserve the flag semantic — a stroke with
  // colorId=-1 signals "structural stroke, don't paint the centre" to the
  // OCD writer's `deriveDoubleLine` and the xmap writer's stroke serialiser.
  const hasFill = ((l.flags ?? 0) & 1) !== 0
  return {
    type: 'stroke',
    colorId: hasFill ? (l.fillColorId ?? -1) : -1,
    width: l.centerWidth ?? 0,
    joinStyle: 1,
    capStyle: 0,
    borders,
  } as unknown as RenderLayer
}

// Both dialects describe the same casing, but a border's `shift` (offset from
// the main line) arrives differently: `doubleLineToStroke` sets it to
// borderWidth/2 (the verified geometry the OCD writer reconstructs from) for an
// OCAD double-line, while an OMap-native bordered stroke carries the xmap
// `<border>` shift — which Mapper omits, so it reads back as 0. Normalise every
// stroke border to borderWidth/2 so the two sources converge. Writer-only: the
// in-memory model (and thus rendering) is untouched.
export function canonicaliseBorderShift(layer: RenderLayer): RenderLayer {
  const l = layer as {
    type?: string
    borders?: Array<{ width?: number; shift?: number }>
  }
  if (l.type !== 'stroke' || !Array.isArray(l.borders)) return layer
  return {
    ...layer,
    borders: l.borders.map(b => ({ ...b, shift: (b.width ?? 0) / 2 })),
  } as unknown as RenderLayer
}

// OCAD stores a structure/point-pattern's geometry at integer resolution (0.01
// mm), while Mapper's xmap keeps sub-integer precision (e.g. a pattern element
// coord `-93.6` vs OCAD's `-94`, `lineSpacing 399.6` vs `400`). Snap the pattern
// tree's geometry to the OCAD grid — the same lossy-to-OCAD canonicalisation
// already applied to rotation and CMYK — so the OCD-synthesised and OMap-native
// patterns converge. Angles (radians) are left untouched. Writer-only.
export function canonicalisePointPatternGeometry(
  layer: RenderLayer,
): RenderLayer {
  const l = layer as { type?: string; pattern?: unknown }
  if (l.type !== 'point-pattern-fill' || !l.pattern) return layer
  return {
    ...layer,
    pattern: roundGeometryToOcadGrid(l.pattern, ''),
  } as RenderLayer
}
function roundGeometryToOcadGrid(node: unknown, key: string): unknown {
  if (typeof node === 'number') {
    return key === 'angle' || key === 'rotation' ? node : Math.round(node)
  }
  if (Array.isArray(node)) return node.map(v => roundGeometryToOcadGrid(v, key))
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      out[k] = roundGeometryToOcadGrid(v, k)
    }
    return out
  }
  return node
}

// OCAD stores line widths at integer resolution; Mapper keeps sub-integer (a
// 112.5 stroke vs OCAD's 113, a 67.5 vs 68). Snap a stroke's width to the OCAD
// grid — the same lossy-to-OCAD rule as rotation/CMYK/pattern geometry — so the
// two sources converge. Writer-only. (Does NOT touch borders: their width is
// already integer here, and shift = width/2 which the OCD writer reconstructs
// from.)
export function canonicaliseStrokeWidth(layer: RenderLayer): RenderLayer {
  const l = layer as {
    type?: string
    width?: number
    startOffset?: number
    endOffset?: number
  }
  if (l.type !== 'stroke') return layer
  const out = { ...layer } as Record<string, unknown>
  if (typeof l.width === 'number') out.width = Math.round(l.width)
  // OCAD stores decoration offsets as whole units; OMap keeps sub-unit precision
  // (74.7 vs 75). Snap to the OCAD grid so both sources agree.
  if (typeof l.startOffset === 'number')
    out.startOffset = Math.round(l.startOffset)
  if (typeof l.endOffset === 'number') out.endOffset = Math.round(l.endOffset)
  return out as RenderLayer
}

// OCAD stores a point disc/ring as an integer-diameter element, so its radius
// lands on a 0.5 grid; OMap keeps sub-unit precision (16.7 vs 16.5). Snap the
// radius so both sources agree.
export function canonicalisePointRadius(layer: RenderLayer): RenderLayer {
  const l = layer as { type?: string; radius?: number }
  if (l.type !== 'point-fill' && l.type !== 'point-stroke') return layer
  if (typeof l.radius !== 'number') return layer
  return { ...layer, radius: Math.round(l.radius * 2) / 2 } as RenderLayer
}

// When my `doubleLineToStroke` transform runs on an OCAD line with both a
// visible primary stroke AND a double-line, it produces two strokes: the
// primary (infill, no borders) and a secondary (double-line-centre + borders).
// OMap merges the same visual into ONE stroke with borders, using the
// primary's color/width and grafting the borders across.
//
// Fire only when both are present AND the primary is a visible non-borders
// stroke — otherwise leaves the pair alone (e.g. 509 Railway keeps two
// distinct strokes because neither has borders).
export function mergePrimaryStrokeWithBorders(
  layers: RenderLayer[],
): RenderLayer[] {
  const strokeIdx: number[] = []
  for (let i = 0; i < layers.length; i++) {
    if ((layers[i] as { type?: string }).type === 'stroke') strokeIdx.push(i)
  }
  if (strokeIdx.length !== 2) return layers
  const primary = layers[strokeIdx[0]] as {
    type: string
    colorId?: unknown
    width?: number
    borders?: unknown[]
  } & Record<string, unknown>
  const secondary = layers[strokeIdx[1]] as {
    type: string
    borders?: unknown[]
    colorId?: unknown
  }
  const primaryValid =
    primary.colorId !== undefined &&
    primary.colorId !== null &&
    primary.colorId !== -1 &&
    !Array.isArray(primary.borders)
  const secondaryHasBorders =
    Array.isArray(secondary.borders) && secondary.borders.length > 0
  if (!primaryValid || !secondaryHasBorders) return layers
  const merged = { ...primary, borders: secondary.borders }
  const out = layers.slice()
  out[strokeIdx[0]] = merged as unknown as RenderLayer
  out.splice(strokeIdx[1], 1)
  return out
}

// Stable canonical order for render layers. Both readers emit the same set
// of layer types but in dialect-specific order (OCD: stroke → line-elements
// → double-line; OMap: stroke → borders-carrier-stroke → line-elements).
// Sort by role: visible geometry first (fill/hatch/pattern/stroke/point-*),
// then symbol-decoration meta (line-elements, text, border-symbol).
// Within a group, keep the original order so multi-stroke ordering (the
// z-index that actually paints) is preserved.
const LAYER_ORDER_GROUPS: Record<string, number> = {
  fill: 1,
  'hatch-fill': 2,
  'point-pattern-fill': 3,
  'structure-fill': 3,
  stroke: 4,
  'point-fill': 5,
  'point-stroke': 6,
  'point-elements': 7,
  text: 8,
  'line-elements': 9,
  'line-symbols': 9,
  'border-symbol': 10,
  'double-line': 4,
}
export function canonicalLayerOrder(a: RenderLayer, b: RenderLayer): number {
  const ga = LAYER_ORDER_GROUPS[(a as { type: string }).type] ?? 99
  const gb = LAYER_ORDER_GROUPS[(b as { type: string }).type] ?? 99
  return ga - gb
}

// Strip phantom `stroke.borders` entries — borders with an invalid color
// (-1 / null / empty) render nothing. OMap emits these on many area
// symbols (e.g. butlers-bush 201/301/302 area strokes with a phantom
// {color:-1, width:15, shift:7}). Dropping them matches the OCD side
// (which never emits phantoms) without losing visible geometry.
export function stripPhantomBorders(layer: RenderLayer): RenderLayer {
  const l = layer as { type?: string; borders?: unknown[] } & Record<
    string,
    unknown
  >
  if (l.type !== 'stroke' || !Array.isArray(l.borders)) return layer
  const kept = l.borders.filter(b => {
    const c = (b as { color?: unknown })?.color
    if (c === -1 || c === null || c === undefined) return false
    return !(typeof c === 'string' && c.length === 0)
  })
  if (kept.length === l.borders.length) return layer
  const out: Record<string, unknown> = { ...l }
  if (kept.length === 0) delete out.borders
  else out.borders = kept
  return out as unknown as RenderLayer
}

// Normalise an OCD `frame: true` stroke — surfaced from OCAD's `frColor` /
// `frWidth` fields — into the same shape OMap emits for the same stroke:
// drop the `frame` marker (the OCD writer's `pickMainStroke` still leaves
// non-dashed non-primary strokes for `frameFields` to pick up without it)
// and fill in OMap's default `joinStyle: 1, capStyle: 0` so both dialects
// agree.
export function canonicaliseFrameStroke(layer: RenderLayer): RenderLayer {
  const l = layer as { type?: string; frame?: boolean } & Record<
    string,
    unknown
  >
  if (l.type !== 'stroke' || !l.frame) return layer
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { frame, ...rest } = l
  return {
    ...rest,
    joinStyle: (rest.joinStyle as number | undefined) ?? 1,
    capStyle: (rest.capStyle as number | undefined) ?? 0,
  } as unknown as RenderLayer
}

// A `point-fill`/`point-stroke` layer whose colour id is invalid (< 0 or unset)
// renders nothing — the SVG renderer's `isValidColorId` gate returns null. The
// OMap reader emits such phantom layers (e.g. a disc with colorId -1) where the
// OCAD reader emits none, so dropping them canonicalises the layer set without
// changing what's drawn.
export function isPhantomFillLayer(layer: RenderLayer): boolean {
  const l = layer as { type?: string; colorId?: unknown; color?: unknown }
  if (l.type !== 'point-fill' && l.type !== 'point-stroke') return false
  const id = l.colorId ?? l.color
  if (id === null || id === undefined) return true
  if (typeof id === 'number') return id < 0
  if (typeof id === 'string') return id.length === 0
  return true
}

// Replace a `border-symbol` layer (an OCAD-style "area with a paired border
// line" reference) with the referenced line symbol's stroke inlined. Matches
// OMap's convention for symbols like 301 Uncrossable body of water: OMap
// emits `[fill, stroke]` (border inlined) where OCD emits `[fill, border-symbol]`
// (border referenced). The OCD writer's `synthesize-symbols` path allocates
// a synthetic 990.x line for an area-with-stroke without a border-symbol,
// so round-trip stays visually equivalent (adds a small symbol-count noise
// that mapper-parity's critical-field assertions ignore).
//
// EXCEPTION: skip dereference when the target's canonical code starts with
// "990." — those are synthesised borders from a previous OCD-write cycle.
// Preserving the reference lets the OCD writer's `synthesize-symbols` reuse
// the existing 990.x symbol rather than allocating a NEW one every cycle
// (drift observed: bottle-lake grew 990.10 → 990.1.10 → ... over cycles).
export function dereferenceBorderSymbol(
  layer: RenderLayer,
  symbolsById: Map<string | number, MapSymbol>,
): RenderLayer {
  const l = layer as { type?: string; symbolId?: unknown }
  if (l.type !== 'border-symbol') return layer
  const ref = symbolsById.get(l.symbolId as string | number)
  if (ref && typeof ref.code === 'string' && ref.code.startsWith('990.')) {
    return layer
  }
  const refStroke = (ref?.layers || []).find(
    (r): r is RenderLayer => (r as { type?: string }).type === 'stroke',
  ) as
    | {
        colorId?: unknown
        width?: number
        capStyle?: number
        joinStyle?: number
      }
    | undefined
  if (!refStroke) return layer
  return {
    type: 'stroke',
    colorId: refStroke.colorId,
    width: refStroke.width ?? 0,
    joinStyle: refStroke.joinStyle ?? 0,
    capStyle: refStroke.capStyle ?? 0,
  } as unknown as RenderLayer
}
