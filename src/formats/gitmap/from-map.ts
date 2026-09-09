import crypto from 'node:crypto'
import type { MapColor, MapObject, MapSymbol, RenderLayer } from '../../map/model.js'
import { snapRotationToOcadGrid } from '../codecs/index.js'
import { canonicalSymbolCode } from '../../util/symbol-code.js'

function toGitmapColor(color: MapColor) {
  return {
    id: stableColorId(color),
    order: color.sourceId ?? color.id,
    name: color.name || '',
    // Screen colour as an integer [r, g, b] (0–255), matching cmyk's array shape.
    rgb: rgbToArray(color.rgb),
    // OCAD-side rendering uses CMYK, not RGB — persist it so a gitmap → ocd
    // round-trip preserves ink density. OCAD stores CMYK as whole percentages,
    // so snap to that grid (2 dp): an OCD-sourced colour is already quantised
    // while an OMap-sourced copy keeps half-percent values — snapping matches.
    cmyk: roundTuple(color.cmyk, 2),
    opacity: color.opacity,
    // Paint priority (higher = drawn on top). Distinct from `order` (palette
    // index): the two diverge in OCAD maps where list order ≠ draw order.
    renderOrder: color.renderOrder ?? 0,
  }
}

function roundTuple(tuple: unknown, dp: number): unknown {
  if (!Array.isArray(tuple)) return tuple
  const f = 10 ** dp
  return tuple.map(v => (typeof v === 'number' ? Math.round(v * f) / f : v))
}

// Normalise a model RGB (a CSS `rgb(r,g,b)` string, or an [r,g,b] array in 0–255
// or 0–1) to a canonical integer [r, g, b] triple (0–255).
function rgbToArray(rgb: unknown): [number, number, number] | undefined {
  if (typeof rgb === 'string') {
    const m = rgb.match(/-?\d+(?:\.\d+)?/g)
    if (!m || m.length < 3) return undefined
    return m.slice(0, 3).map(n => Math.round(Number(n))) as [number, number, number]
  }
  if (Array.isArray(rgb) && rgb.length >= 3) {
    const max = Math.max(rgb[0], rgb[1], rgb[2])
    const scale = max <= 1 ? 255 : 1
    return rgb.slice(0, 3).map(v => Math.round(Number(v) * scale)) as [number, number, number]
  }
  return undefined
}

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
function canonicalSymbolType(
  originalType: string | undefined,
  canonLayers: readonly RenderLayer[],
): string | undefined {
  const hasBorder = canonLayers.some(l => l.type === 'border-symbol')
  const hasFill = canonLayers.some(
    l => l.type === 'fill' || l.type === 'hatch-fill'
      || l.type === 'point-pattern-fill' || l.type === 'structure-fill',
  )
  const hasStroke = canonLayers.some(l => l.type === 'stroke')
  const hasLineGeometry = canonLayers.some(
    l => l.type === 'stroke' || l.type === 'line-elements' || l.type === 'line-symbols',
  )
  // Area-with-border (border-symbol reference OR its post-dereference `stroke`
  // form): both dialects should serialise as `combined` so the OMap writer's
  // `combined_symbol` path fires and preserves the borderSym on OCD round-trip.
  if (hasFill && (hasBorder || hasStroke)
      && (originalType === 'area' || originalType === 'combined')) {
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
    type?: number; color?: unknown; lineWidth?: number; diameter?: number;
    coords?: unknown[]; flags?: number;
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
    return { type: 'point-fill', colorId: e.color, radius: diameter / 2 } as unknown as RenderLayer
  }
  if (e.type === 3 && lineWidth > 0 && diameter > 0) {
    return {
      type: 'point-stroke', colorId: e.color,
      radius: (diameter - lineWidth) / 2, width: lineWidth,
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
function canonicalisePointElementsLayer(layer: RenderLayer): RenderLayer[] {
  const l = layer as { type?: string; elements?: unknown[] }
  if (l.type !== 'point-elements' || !Array.isArray(l.elements)) return [layer]
  if (l.elements.length === 1) {
    const extracted = pointElementToLayer(l.elements[0])
    if (extracted) return [extracted]
  }
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
  // OMap's opinionated split: extract each leading disc/ring-at-origin as
  // a typed layer, but stop before the last remaining element — OMap keeps
  // at least one element in the residual `point-elements`. Rule verified
  // across paired maps:
  //   301.5 [disc, ring]         → point-fill + point-elements (ring stays)
  //   307.3 [ring, other]        → point-stroke + point-elements (other)
  //   417   [disc, ring, disc]   → point-fill + point-stroke + point-elements
  //   526   [ring, other]        → point-stroke + point-elements
  // Each type (disc/ring) is extracted at most once — a second occurrence
  // stays in the residual.
  const extras: RenderLayer[] = []
  const seenTypes = new Set<string>()
  let splitIndex = 0
  while (splitIndex < canonical.length - 1) {
    const ex = pointElementToLayer(canonical[splitIndex])
    if (!ex) break
    const t = (ex as { type: string }).type
    if (seenTypes.has(t)) break
    seenTypes.add(t)
    extras.push(ex)
    splitIndex++
  }
  if (extras.length > 0) {
    return [...extras, { ...layer, elements: canonical.slice(splitIndex) } as RenderLayer]
  }
  return [{ ...layer, elements: canonical } as RenderLayer]
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
      xFlags, yFlags, x, y, ...rest
    } = c as { xFlags?: unknown; yFlags?: unknown; x?: number; y?: number } & Record<string, unknown>
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
        innerColor?: unknown; innerRadius?: number;
        outerColor?: unknown; outerWidth?: number;
        elements?: unknown[];
      };
      lineSymbol?: {
        color?: unknown; lineWidth?: number;
        capStyle?: number; joinStyle?: number;
      };
      areaSymbol?: { color?: unknown; innerColor?: unknown };
    };
    object?: { coords?: Array<{ x?: number; y?: number } | [number?, number?]> };
  }
  const sym = e.symbol
  if (!sym) return []
  const rawCoords = e.object?.coords ?? []
  const anchor = rawCoords[0]
  const anchorX = snapSymCoord(Array.isArray(anchor) ? (anchor[0] ?? 0) : (anchor?.x ?? 0))
  const anchorYSrc = snapSymCoord(Array.isArray(anchor) ? (anchor[1] ?? 0) : (anchor?.y ?? 0))
  const anchorY = -anchorYSrc

  const out: unknown[] = []
  if (sym.pointSymbol) {
    const ps = sym.pointSymbol
    const innerRadius = Number(ps.innerRadius ?? 0)
    if (innerRadius > 0 && isRealColor(ps.innerColor)) {
      out.push({
        type: 4, flags: 0, color: ps.innerColor,
        lineWidth: 0, diameter: innerRadius * 2,
        numberCoords: 1, coords: [{ x: anchorX, y: anchorY }],
      })
    }
    const outerWidth = Number(ps.outerWidth ?? 0)
    if (outerWidth > 0 && isRealColor(ps.outerColor)) {
      out.push({
        type: 3, flags: 0, color: ps.outerColor,
        lineWidth: outerWidth, diameter: innerRadius * 2 + outerWidth,
        numberCoords: 1, coords: [{ x: anchorX, y: anchorY }],
      })
    }
    for (const sub of ps.elements ?? []) out.push(...flattenXmapLineDecorElement(sub))
    return out
  }
  if (sym.lineSymbol) {
    const coords = rawCoords.map(mapAndRoundYFlippedCoord)
    const cap = sym.lineSymbol.capStyle ?? 0
    const join = sym.lineSymbol.joinStyle ?? 0
    const flags = (cap === 1 ? 0x01 : 0) | (join === 1 ? 0x04 : 0)
    return [{
      type: 1, flags, color: sym.lineSymbol.color,
      lineWidth: sym.lineSymbol.lineWidth ?? 0, diameter: 0,
      numberCoords: coords.length, coords,
    }]
  }
  if (sym.areaSymbol) {
    const coords = rawCoords.map(mapAndRoundYFlippedCoord)
    return [{
      type: 2, flags: 0,
      color: sym.areaSymbol.color ?? sym.areaSymbol.innerColor,
      lineWidth: 0, diameter: 0,
      numberCoords: coords.length, coords,
    }]
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
    type?: number; flags?: number; color?: unknown; lineWidth?: number;
    diameter?: number; coords?: Array<{ x?: number; y?: number } | [number?, number?]>;
  }
  const coords = (e.coords ?? []).map(c => {
    const x = Array.isArray(c) ? (c[0] ?? 0) : (c?.x ?? 0)
    const y = Array.isArray(c) ? (c[1] ?? 0) : (c?.y ?? 0)
    return { x, y: -y }
  })
  const objectBase = { type: 0, symbol: 0, text: null, textBox: null, coords }
  if (e.type === 4) {
    return {
      symbol: { code: '', type: 1, isHidden: false,
        pointSymbol: {
          innerColor: e.color, innerRadius: (e.diameter ?? 0) / 2,
          outerColor: -1, outerWidth: 0, rotatable: false,
        },
      },
      object: objectBase,
    }
  }
  if (e.type === 3) {
    const lw = e.lineWidth ?? 0
    return {
      symbol: { code: '', type: 1, isHidden: false,
        pointSymbol: {
          innerColor: -1, innerRadius: ((e.diameter ?? 0) - lw) / 2,
          outerColor: e.color, outerWidth: lw, rotatable: false,
        },
      },
      object: objectBase,
    }
  }
  if (e.type === 1) {
    const flags = e.flags ?? 0
    return {
      symbol: { code: '', type: 2, isHidden: false,
        lineSymbol: {
          color: e.color, lineWidth: e.lineWidth ?? 0,
          capStyle: (flags & 0x01) ? 1 : 0,
          joinStyle: (flags & 0x04) ? 1 : 0,
        },
      },
      object: { ...objectBase, type: 1 },
    }
  }
  if (e.type === 2) {
    return {
      symbol: { code: '', type: 4, isHidden: false,
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
      id?: unknown;
      pointSymbol?: Record<string, unknown>;
      lineSymbol?: Record<string, unknown>;
      areaSymbol?: Record<string, unknown>;
    } & Record<string, unknown>;
    object?: { coords?: unknown[]; pattern?: unknown } & Record<string, unknown>;
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
        const { flags, ...crest } = c as { flags?: unknown } & Record<string, unknown>
        return crest
      })
      : coords
    restObj = cleanedCoords !== undefined ? { ...rest, coords: cleanedCoords } : rest
  }
  return { ...e, symbol: cleanSym, object: restObj }
}

// Reduce a nested line/area/point symbol to the minimal shape both dialects
// emit. OMap's writer serialises ~20 default line-symbol fields verbatim
// (`breakLength: 100`, `segmentLength: 400`, etc.) onto inner elements; the
// OCD-side flattener emits only the fields it actually uses.
function normaliseInnerLineSymbol(ls: Record<string, unknown>): Record<string, unknown> {
  return {
    color: ls.color,
    lineWidth: ls.lineWidth ?? 0,
    capStyle: ls.capStyle ?? 0,
    joinStyle: ls.joinStyle ?? 0,
  }
}
function normaliseInnerAreaSymbol(as: Record<string, unknown>): Record<string, unknown> {
  return { innerColor: as.innerColor ?? as.color }
}
function normaliseInnerPointSymbol(ps: Record<string, unknown>): Record<string, unknown> {
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
    id?: unknown; code?: unknown; type?: unknown; isHidden?: unknown;
    pointSymbol?: {
      innerColor?: unknown; innerRadius?: number;
      outerColor?: unknown; outerWidth?: number;
      rotatable?: unknown; elements?: unknown[];
    };
  }
  const ps = s.pointSymbol
  const isMultiElement = Array.isArray(ps?.elements) && ps!.elements!.length > 0
  const canonPs = ps ? {
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
  } : ps
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
function structureFillToPointPattern(layer: RenderLayer): RenderLayer[] {
  const l = layer as {
    type?: string;
    colorId?: unknown;
    width?: number; height?: number; angle?: number;
    mode?: number; symbolWidth?: number; symbolHeight?: number;
    elements?: unknown[];
    noClipping?: number; structDraw?: number; rotatable?: boolean;
    // OMap-native pass-through (normaliser branch below).
    pattern?: Record<string, unknown>;
  }
  // OMap-native point-pattern-fill: strip the ephemeral symbol id and
  // normalise `pattern.symbol` to the canonical shape. Also strip the
  // OMap-writer-emitted `pattern.color` — that field duplicates the layer's
  // top-level `colorId`, and OMap's writer derives it from that, so it's
  // guaranteed-redundant. Leaving it caused a one-cycle drift on
  // omap→gitmap→omap round-trips: source had no `pattern.color`, xmap write
  // added it as OMap's default, next gitmap read saw it.
  if (l.type === 'point-pattern-fill' && l.pattern) {
    const p = l.pattern as { symbol?: unknown; color?: unknown } & Record<string, unknown>
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { color, symbol, ...rest } = p
    return [{
      ...l,
      pattern: { ...rest, symbol: canonicaliseOuterPatternSymbol(symbol) },
    } as unknown as RenderLayer]
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
  const soleDisc = flatElements.length === 1
    ? flatElements[0] as {
        type?: number; color?: unknown; lineWidth?: number; diameter?: number;
        coords?: Array<{ x?: number; y?: number } | [number?, number?]>;
      }
    : undefined
  const atOrigin = (c: unknown): boolean => {
    if (!c) return false
    const cx = Array.isArray(c) ? (c[0] ?? 0) : ((c as { x?: number })?.x ?? 0)
    const cy = Array.isArray(c) ? (c[1] ?? 0) : ((c as { y?: number })?.y ?? 0)
    return cx === 0 && cy === 0
  }
  if (
    soleDisc?.type === 4
    && (soleDisc.lineWidth ?? 0) === 0
    && Array.isArray(soleDisc.coords)
    && soleDisc.coords.length === 1
    && atOrigin(soleDisc.coords[0])
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
  const makePattern = (
    { lineOffset, offsetAlongLine }: { lineOffset: number; offsetAlongLine: number }
  ): RenderLayer => ({
    type: 'point-pattern-fill',
    colorId: topColorId,
    width: layerSize, height: layerSize,
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
        code: '', type: 1, isHidden: false,
        pointSymbol: outerInner
          ? {
            innerColor: outerInner.color, innerRadius: outerInner.radius,
            outerColor: -1, outerWidth: 0, rotatable,
          }
          : {
            elements: nestedElements,
            innerColor: -1, innerRadius: 0,
            outerColor: -1, outerWidth: 0, rotatable,
          },
      }),
    },
  } as unknown as RenderLayer)
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
function lineSymbolsToLineElements(layer: RenderLayer): RenderLayer[] {
  const l = layer as {
    type?: string;
    lineSymbol?: {
      midSymbol?: unknown; startSymbol?: unknown; endSymbol?: unknown;
      dashSymbol?: unknown;
    };
  }
  if (l.type !== 'line-symbols' || !l.lineSymbol) return [layer]
  const ls = l.lineSymbol
  const primSymElements = ls.midSymbol ? flattenXmapDecorSymbol(ls.midSymbol) : []
  const startSymElements = ls.startSymbol ? flattenXmapDecorSymbol(ls.startSymbol) : []
  const endSymElements = ls.endSymbol ? flattenXmapDecorSymbol(ls.endSymbol) : []
  const cornerSymElements = ls.dashSymbol ? flattenXmapDecorSymbol(ls.dashSymbol) : []
  // Drop entirely if no sub-symbol carries visible geometry — OMap emits
  // `line-symbols` on any line with a lineSymbol block (e.g. butlers-bush
  // 202.4 Cliff, where lineSymbol has only `minimumLength: 60`) but OCD
  // never emits a layer for that. The OCD writer's `useSymbolFlags` path
  // gates on the presence of sub-symbols, so dropping is safe.
  if (
    primSymElements.length === 0 && startSymElements.length === 0
    && endSymElements.length === 0 && cornerSymElements.length === 0
  ) {
    return []
  }
  return [{
    type: 'line-elements',
    primSymElements,
    cornerSymElements,
    startSymElements,
    endSymElements,
  } as unknown as RenderLayer]
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
function stripLineElementsRedundancy(layer: RenderLayer): RenderLayer {
  const l = layer as { type?: string } & Record<string, unknown>
  if (l.type !== 'line-elements') return layer
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    mainLength, endLength, primSymDist, nPrimSym,
    ...rest
  } = l as Record<string, unknown> & {
    mainLength?: unknown; endLength?: unknown; primSymDist?: unknown; nPrimSym?: unknown;
  }
  for (const key of ['primSymElements', 'startSymElements', 'endSymElements', 'cornerSymElements']) {
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
function isPhantomStroke(layer: RenderLayer): boolean {
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
function doubleLineToStroke(layer: RenderLayer): RenderLayer {
  const l = layer as {
    type?: string; flags?: number;
    leftColorId?: unknown; rightColorId?: unknown;
    fillColorId?: unknown; centerWidth?: number;
    leftWidth?: number; rightWidth?: number;
    dashLength?: number; breakLength?: number;
  }
  if (l.type !== 'double-line') return layer
  const symmetric =
    l.leftColorId === l.rightColorId && (l.leftWidth ?? 0) === (l.rightWidth ?? 0)
  const dashLength = l.dashLength ?? 0
  const breakLength = l.breakLength ?? 0
  const makeBorder = (color: unknown, width: number) => ({
    color, width, shift: width / 2,
    dashed: dashLength > 0,
    dashLength,
    breakLength,
  })
  const borders = symmetric
    ? [makeBorder(l.leftColorId, l.leftWidth ?? 0)]
    : [makeBorder(l.leftColorId, l.leftWidth ?? 0), makeBorder(l.rightColorId, l.rightWidth ?? 0)]
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

// When my `doubleLineToStroke` transform runs on an OCAD line with both a
// visible primary stroke AND a double-line, it produces two strokes: the
// primary (infill, no borders) and a secondary (double-line-centre + borders).
// OMap merges the same visual into ONE stroke with borders, using the
// primary's color/width and grafting the borders across.
//
// Fire only when both are present AND the primary is a visible non-borders
// stroke — otherwise leaves the pair alone (e.g. 509 Railway keeps two
// distinct strokes because neither has borders).
function mergePrimaryStrokeWithBorders(layers: RenderLayer[]): RenderLayer[] {
  const strokeIdx: number[] = []
  for (let i = 0; i < layers.length; i++) {
    if ((layers[i] as { type?: string }).type === 'stroke') strokeIdx.push(i)
  }
  if (strokeIdx.length !== 2) return layers
  const primary = layers[strokeIdx[0]] as {
    type: string; colorId?: unknown; width?: number; borders?: unknown[];
  } & Record<string, unknown>
  const secondary = layers[strokeIdx[1]] as {
    type: string; borders?: unknown[]; colorId?: unknown;
  }
  const primaryValid = primary.colorId !== undefined
    && primary.colorId !== null
    && primary.colorId !== -1
    && !Array.isArray(primary.borders)
  const secondaryHasBorders = Array.isArray(secondary.borders) && secondary.borders.length > 0
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
  'fill': 1,
  'hatch-fill': 2,
  'point-pattern-fill': 3,
  'structure-fill': 3,
  'stroke': 4,
  'point-fill': 5,
  'point-stroke': 6,
  'point-elements': 7,
  'text': 8,
  'line-elements': 9,
  'line-symbols': 9,
  'border-symbol': 10,
  'double-line': 4,
}
function canonicalLayerOrder(a: RenderLayer, b: RenderLayer): number {
  const ga = LAYER_ORDER_GROUPS[(a as { type: string }).type] ?? 99
  const gb = LAYER_ORDER_GROUPS[(b as { type: string }).type] ?? 99
  return ga - gb
}

// Strip phantom `stroke.borders` entries — borders with an invalid color
// (-1 / null / empty) render nothing. OMap emits these on many area
// symbols (e.g. butlers-bush 201/301/302 area strokes with a phantom
// {color:-1, width:15, shift:7}). Dropping them matches the OCD side
// (which never emits phantoms) without losing visible geometry.
function stripPhantomBorders(layer: RenderLayer): RenderLayer {
  const l = layer as { type?: string; borders?: unknown[] } & Record<string, unknown>
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
function canonicaliseFrameStroke(layer: RenderLayer): RenderLayer {
  const l = layer as { type?: string; frame?: boolean } & Record<string, unknown>
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
function isPhantomFillLayer(layer: RenderLayer): boolean {
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
function dereferenceBorderSymbol(
  layer: RenderLayer,
  symbolsById: Map<string | number, MapSymbol>,
): RenderLayer {
  const l = layer as { type?: string; symbolId?: unknown }
  if (l.type !== 'border-symbol') return layer
  const ref = symbolsById.get(l.symbolId as string | number)
  if (ref && typeof ref.code === 'string' && ref.code.startsWith('990.')) {
    return layer
  }
  const refStroke = (ref?.renderLayers || []).find(
    (r): r is RenderLayer => (r as { type?: string }).type === 'stroke',
  ) as { colorId?: unknown; width?: number; capStyle?: number; joinStyle?: number } | undefined
  if (!refStroke) return layer
  return {
    type: 'stroke',
    colorId: refStroke.colorId,
    width: refStroke.width ?? 0,
    joinStyle: refStroke.joinStyle ?? 0,
    capStyle: refStroke.capStyle ?? 0,
  } as unknown as RenderLayer
}

function toGitmapSymbol(
  symbol: MapSymbol,
  colorIds: Map<string | number, string>,
  symbolIds: Map<string | number, string> = new Map(),
  symbolsById: Map<string | number, MapSymbol> = new Map(),
) {
  const layers = symbol.renderLayers || []
  // Only drop phantom strokes when the symbol also has a `double-line`
  // (or already-canonicalised `stroke.borders`): the phantom's sole job
  // is to mark "the primary is invisible; visible geometry lives in the
  // companion". Without that companion, a colorId=-1 stroke may be
  // load-bearing (e.g. cell placeholders).
  const hasDoubleLineCompanion = layers.some(l => {
    const t = (l as { type?: string }).type
    if (t === 'double-line') return true
    if (t !== 'stroke') return false
    const borders = (l as { borders?: unknown[] }).borders
    return Array.isArray(borders) && borders.length > 0
  })
  const canonLayers = mergePrimaryStrokeWithBorders(
    layers
      .filter(layer => !isPhantomFillLayer(layer))
      .filter(layer => !(hasDoubleLineCompanion && isPhantomStroke(layer)))
      .flatMap(canonicalisePointElementsLayer)
      .map(doubleLineToStroke)
      .map(canonicaliseFrameStroke)
      .map(stripPhantomBorders)
      .map(l => dereferenceBorderSymbol(l, symbolsById))
      .flatMap(lineSymbolsToLineElements)
      .map(stripLineElementsRedundancy)
      .flatMap(structureFillToPointPattern)
      .sort(canonicalLayerOrder),
  )
  return {
    id: stableSymbolId(symbol),
    order: symbol.sourceId ?? symbol.id,
    code: canonicalSymbolCode(symbol.code) || undefined,
    name: symbol.name,
    // Derive type from CANONICAL layers, not raw — my transforms can
    // collapse `combined` into a plain `line` (e.g. via
    // `mergePrimaryStrokeWithBorders`), and gitmap should reflect that.
    type: canonicalSymbolType(symbol.type, canonLayers),
    // Omit boolean fields that equal their default so a semantic toggle
    // shows up in `git diff` as a real field add, not a value swap.
    hidden: symbol.hidden ? true : undefined,
    rotatable: symbol.rotatable || undefined,
    // Text typography lives once, in the `text` render layer's `text` object
    // (no duplicate top-level fontSize / per-layer fontSize+fontFamily).
    textSymbol: toJsonSafe(symbol.textSymbol),
    layers: canonLayers.map(layer => renderLayerToGitmap(layer, colorIds, symbolIds)),
  }
}

function toGitmapObject(
  object: MapObject,
  symbolIds: Map<string | number, string>,
  partId = 'part_main',
  // Negate object-coordinate Y so an OCAD-sourced (y-up) map is stored in
  // gitmap's canonical visual (y-down) space — matching omap output and the
  // SVG exporter's `getVisualCoordinateTransform`. Only object coordinates
  // are flipped, exactly as the omap writer's `flipY` does; symbol geometry
  // is left untouched. Without this an ocd→gitmap conversion stores coords
  // upside-down vs every omap-sourced gitmap, so a diff between them reports
  // 100% of the map as changed.
  flipY = false,
  // Canonical z-order rank (the object's index in the map's render order).
  // Replaces the raw source-file object id as `sourceId`, so the SAME map from
  // OCD vs OMAP serialises identically — the source formats number objects
  // differently, but their z-order is the same, so the rank is canonical.
  zRank?: number,
) {
  const symbolId = symbolIds.get(object.symbolId) || String(object.symbolId)
  const rings = ringsToJson(object.coordinates || [], flipY)
  return {
    id: stableObjectId(object, symbolId, partId, flipY),
    // Render order, as a canonical dense rank rather than the format-specific
    // source id (falls back to the raw id when no rank is supplied). The symbol
    // is referenced by `symbolId` (which is code-derived, e.g. sym_101, so the
    // code is already readable in a diff — no separate symbolCode needed).
    order: zRank ?? object.id,
    partId,
    symbolId,
    type: object.type,
    // The outer boundary; interior rings (holes) go in `holes`. Ring structure
    // is explicit, so no positional `hole` coord flag is stored.
    coordinates: rings.coordinates,
    holes: rings.holes,
    // Omit default/empty fields so the same object serialises identically no
    // matter which reader produced it (one format emits `text:""`/`rotation:0`/
    // a zero pattern, another omits them). The id hash already normalises these
    // to their defaults, so omitting them here changes bytes, not identity.
    text: object.text || undefined,
    rotation: snapRotationToOcadGrid(object.rotation) || undefined,
    hidden: object.hidden ? true : undefined,
    // Omit default alignment (0 = left / baseline): the OMap reader emits it
    // explicitly while the OCAD reader leaves it undefined, so dropping the
    // default makes the same label serialise identically. Non-default alignment
    // is preserved.
    hAlign: object.hAlign || undefined,
    vAlign: object.vAlign || undefined,
    textBox: object.textBox,
    pattern: cleanPattern(object.pattern),
    objectString: object.objectString,
    objectStringType: object.objectStringType,
  }
}

// A pattern that is all-defaults (no rotation, origin at 0,0) carries no
// information — one format emits it explicitly, another omits it. Drop it so
// they match. The rotation is snapped to OCAD's 0.1° grid (like object
// rotation), since an OCD-sourced pattern angle is already quantised while an
// OMap-sourced copy keeps full float precision.
function cleanPattern(pattern: unknown): unknown {
  if (!pattern || typeof pattern !== 'object') return undefined
  const p = pattern as { rotation?: number; origin?: { x?: number; y?: number } }
  const rotation = snapRotationToOcadGrid(p.rotation)
  const ox = p.origin?.x || 0
  const oy = p.origin?.y || 0
  if (rotation === 0 && ox === 0 && oy === 0) return undefined
  return { ...(pattern as object), rotation: rotation || undefined }
}

// Fields to drop when canonicalising a `stroke` render layer, so an OCD- and an
// OMap-sourced copy of the same line serialise identically. The OCAD reader
// emits `lineStyle` (a packed cap+join byte that `capStyle`/`joinStyle` already
// carry, and that the SVG renderer ignores) and gates zero offsets to
// undefined; the OMap reader omits `lineStyle` but always emits the zero
// defaults. Dropping `lineStyle` + the defaults reconciles both. Non-default
// values are kept (a stroke that genuinely offsets or hides its mid-symbol).
function strokeCanonicalDrops(layer: RenderLayer): ReadonlySet<string> {
  if ((layer as { type?: string }).type !== 'stroke') return EMPTY_DROP
  const l = layer as Record<string, unknown>
  const drop = new Set<string>(['lineStyle'])
  if (!l.minimumMidSymbolCount) drop.add('minimumMidSymbolCount')
  if (l.showAtLeastOneSymbol === true || l.showAtLeastOneSymbol === undefined) {
    drop.add('showAtLeastOneSymbol')
  }
  if (!l.startOffset) drop.add('startOffset')
  if (!l.endOffset) drop.add('endOffset')
  // Mid-symbol placement fields (`segmentLength` / `midSymbolsPerSpot` /
  // `midSymbolDistance`) only matter when the stroke actually has mid-symbol
  // elements. Both readers emit them regardless, with different defaults
  // (OCAD leaves segmentLength undefined or copies mainLength; OMap always
  // emits `400`). When no `primSymElements` array is present, drop them.
  const hasMidSymbols =
    Array.isArray(l.primSymElements) && (l.primSymElements as unknown[]).length > 0
  // Top-level `endLength` is an OCAD-only slot for a special "last dash"
  // length; OMap doesn't emit it at all. Drop whenever a dash is present
  // (its vocab collapse in `canonicaliseDash` doesn't carry endLength
  // anyway) OR when it's an orphan (no dash and no mid-symbol; e.g. 509.2
  // Tramway where OMap emits `endLength: 150` as dead data).
  const dashObj = l.dash as { mainLength?: number; mainGap?: number; secGap?: number } | undefined
  const isOrphan = !dashObj && !hasMidSymbols
  if (!l.endLength || dashObj || isOrphan) {
    drop.add('endLength')
  }
  if (!hasMidSymbols) {
    drop.add('segmentLength')
    if (l.midSymbolsPerSpot === 1 || l.midSymbolsPerSpot === undefined) {
      drop.add('midSymbolsPerSpot')
    }
    if (!l.midSymbolDistance) drop.add('midSymbolDistance')
    // `minimumMidSymbolCount` gates whether Mapper draws mid-symbols on short
    // segments; if the stroke has no mid-symbol geometry to place, the field
    // is dead data. OMap emits values (2, 3, 5) on many symbols where OCD
    // omits it (e.g. butlers-bush 309 / 416 / 532). Drop it when there are
    // no mid-symbol elements.
    drop.add('minimumMidSymbolCount')
  }
  return drop
}

const EMPTY_DROP: ReadonlySet<string> = new Set()

// Canonicalise a stroke's `dash` sub-object. The two readers emit the same
// dash pattern with different vocabularies:
//   OCD  {mainLength, mainGap, secGap, endLength, endGap}
//   OMap {dashLength, breakLength, dashesInGroup, inGroupBreakLength}
// Both reduce to `{dashLength, breakLength, [dashesInGroup>1], [inGroupBreakLength]}`.
//
// OCD decoding follows three cases, discriminated by `mainGap` and `secGap`:
//   - `mainGap` set  → 2-dash group. `mainLength = 2·dashLength + inGroupBreakLength`
//     so `dashLength = (mainLength - secGap) / 2`, `breakLength = mainGap`,
//     `inGroupBreakLength = secGap`. (E.g. 337 stairway: 337=2·150+37.)
//   - `mainGap` zero, `secGap` set → 1-dash groups back-to-back with `secGap`
//     between. `mainLength = dashLength + secGap` so `dashLength = mainLength - secGap`,
//     `breakLength = secGap`. (E.g. 106 ruined earth wall: 200 = 165 + 35.)
//   - `secGap` zero → plain repeat, `dashLength = mainLength`, `breakLength = mainGap`.
//
// `endLength`/`endGap` mirror `mainLength`/`secGap` (OCD-only redundancy for
// terminal dashes) and are dropped by `strokeCanonicalDrops`. OMap's
// `inGroupBreakLength` is emitted even when `dashesInGroup=1` — dead data
// in that case, dropped.
function canonicaliseDash(dash: unknown): unknown {
  if (!dash || typeof dash !== 'object') return dash
  const source = dash as Record<string, unknown>
  const num = (k: string): number | undefined => {
    const v = source[k]
    return typeof v === 'number' ? v : undefined
  }
  const mainLength = num('mainLength')
  if (mainLength !== undefined) {
    const mainGap = num('mainGap') ?? 0
    const secGap = num('secGap') ?? 0
    if (secGap > 0 && mainGap > 0) {
      return {
        dashLength: (mainLength - secGap) / 2,
        breakLength: mainGap,
        dashesInGroup: 2,
        inGroupBreakLength: secGap,
      }
    }
    if (secGap > 0) {
      return { dashLength: mainLength - secGap, breakLength: secGap }
    }
    return { dashLength: mainLength, breakLength: mainGap }
  }
  const output: Record<string, unknown> = {}
  const dashesInGroup = num('dashesInGroup') ?? 1
  for (const [k, v] of Object.entries(source)) {
    if (k === 'inGroupBreakLength' && dashesInGroup <= 1) continue
    if (k === 'dashesInGroup' && v === 1) continue
    output[k] = v
  }
  return output
}

// Nested `text.text.*` keys to drop when they equal their default. The OCD
// reader emits the full OCAD text-symbol block (`wordSpace: 100`,
// `verticalAlignment: 0`, `indentFirst: 0`, `indentOther: 0`) verbatim; the
// OMap reader omits any field the mapper hasn't touched. Dropping the OCD
// defaults reconciles them without touching semantic values (`alignment`,
// `lineSpace`, etc. flow through untouched).
// Snap a mm font size to OCAD's storage grid (whole tenths of point). OCAD
// files store fontSize as `rawTenthsOfPoint` (integer); the reader converts
// with `× 25.4 / 720`. OMap stores mm directly, so the same visual "6pt"
// symbol can end up as 2.046 (OCD) vs 2.063 (OMap file, if Mapper stored
// 5.85 pt). Snap both to the coarser tenths-of-pt integer grid so they
// coincide — 1/72 in ≈ 0.35 mm at 1pt, so <0.05mm difference isn't
// visible on paper maps.
function snapFontSizeMm(mm: number): number {
  const tenthsOfPt = Math.round((mm * 720) / 25.4)
  return Number(((tenthsOfPt * 25.4) / 720).toFixed(3))
}

function canonicaliseTextBody(text: unknown): unknown {
  if (!text || typeof text !== 'object') return text
  const source = text as Record<string, unknown>
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === 'wordSpace' && value === 100) continue
    if (key === 'verticalAlignment' && value === 0) continue
    if (key === 'indentFirst' && value === 0) continue
    if (key === 'indentOther' && value === 0) continue
    if (key === 'fontSize' && typeof value === 'number') {
      output[key] = snapFontSizeMm(value)
      continue
    }
    // OMap stores horizontal text alignment on the OBJECT (`hAlign`), not on
    // the text symbol; OCD emits `alignment` on the symbol here as its
    // default. Drop it — either it's the neutral 0 (left/none, OMap's
    // implicit default) or it's non-zero and redundant with per-object
    // hAlign that the OMap side reads. Symbol-level alignment doesn't
    // survive the OMap-native round-trip anyway.
    if (key === 'alignment') continue
    // `lineSpace` between the two readers uses different arithmetic (OCAD
    // stores a percent-of-fontsize, OMap stores a Qt-based mm-ish value)
    // and no single conversion recovers both — 916 8pt shows OCD 1.2 vs
    // OMap 1.044 for the same visual spacing. Drop it: the OCD writer's
    // symbol-body reads it back from the primary `text` block with a
    // sensible default when absent.
    if (key === 'lineSpace') continue
    output[key] = value
  }
  return output
}

function renderLayerToGitmap(
  layer: RenderLayer,
  colorIds: Map<string | number, string>,
  symbolIds: Map<string | number, string> = new Map(),
) {
  const output: Record<string, unknown> = {}
  const drop = strokeCanonicalDrops(layer)
  const layerType = (layer as { type?: string }).type

  Object.entries(layer).forEach(([key, value]) => {
    if (value === undefined) return
    if (drop.has(key)) return
    if (key === 'colorId' || key === 'color') {
      output[key] = colorIds.get(value as string | number) || value
      return
    }
    // `border-symbol.symbolId` points to another map symbol. OCD stores the
    // referenced symbol's raw symNum (e.g. `301004`); OMap stores its own
    // internal id (e.g. `75`). Both resolve to the same real symbol
    // (`code: 301.4`), so remap through the canonical gitmap symbol id.
    if (layerType === 'border-symbol' && key === 'symbolId') {
      output[key] = symbolIds.get(value as string | number) || value
      return
    }
    if (layerType === 'text' && key === 'text') {
      output[key] = remapColors(toJsonSafe(canonicaliseTextBody(value)), colorIds)
      return
    }
    // Text typography is authoritative in the nested `text` object; drop the
    // duplicated per-layer fontSize / fontFamily.
    if (layerType === 'text' && (key === 'fontSize' || key === 'fontFamily')) {
      return
    }
    if (layerType === 'stroke' && key === 'dash') {
      output[key] = toJsonSafe(canonicaliseDash(value))
      return
    }
    if (key === 'elements' && Array.isArray(value)) {
      output[key] = value.map(elementToGitmap.bind(null, colorIds))
      return
    }
    if (
      [
        'primSymElements',
        'cornerSymElements',
        'startSymElements',
        'endSymElements',
      ].includes(key) &&
      Array.isArray(value)
    ) {
      output[key] = value.map(elementToGitmap.bind(null, colorIds))
      return
    }
    // Deep-remap color references inside nested structures such as
    // `pattern.symbol.pointSymbol.innerColor` — otherwise the raw
    // integer color ID leaks into gitmap and gitmap-read can no
    // longer resolve it against the (string-keyed) colors table.
    output[key] = remapColors(toJsonSafe(value), colorIds)
  })

  return output
}

// Keys that hold color-id references anywhere in the symbol tree.
const COLOR_ID_KEYS = new Set([
  'color', 'colorId',
  'innerColor', 'outerColor',
  'fillColor', 'leftColor', 'rightColor',
  'hatchColor',
])

function remapColors(
  node: unknown,
  colorIds: Map<string | number, string>,
): unknown {
  if (Array.isArray(node)) {
    return node.map(child => remapColors(child, colorIds))
  }
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (COLOR_ID_KEYS.has(k) && (typeof v === 'number' || typeof v === 'string')) {
      out[k] = colorIds.get(v as string | number) ?? v
    } else {
      out[k] = remapColors(v, colorIds)
    }
  }
  return out
}

function elementToGitmap(colorIds: Map<string | number, string>, element) {
  const output: Record<string, unknown> = {}
  Object.entries(element).forEach(([key, value]) => {
    if (value === undefined) return
    if (key === 'color') {
      output[key] = colorIds.get(value as string | number) || value
      return
    }
    if (key === 'coords') {
      // Element (icon primitive) coords use the same compact `[x, y]` tuple form
      // as object coordinates (see elementCoordToJson).
      output[key] = (value as unknown[]).map(elementCoordToJson)
      return
    }
    // XMap-style element.symbol carries a full nested symbol tree
    // (areaSymbol / lineSymbol / pointSymbol) with its own color
    // references — recurse via remapColors, not toJsonSafe, so those
    // integer ids get lifted to the PanMap string ids.
    output[key] = remapColors(toJsonSafe(value), colorIds)
  })
  return output
}

function coordinatesToJson(coordinates: unknown[], flipY = false): unknown[] {
  return coordinates.map(coord => coordToJson(coord, flipY))
}

// Split flat model coordinates into explicit rings. A multi-ring area marks its
// ring boundaries with the hole bit (yFlags 0x02) on the LAST coord of each ring
// that a hole follows (Mapper's isHolePoint). Emit the first ring as the outer
// boundary and the rest as `holes`; the boundary is now structural, so the
// `hole` flag is not written on any tuple. A single-ring object (line, simple
// area, point, text) yields just `coordinates` with no `holes`.
function ringsToJson(
  coordinates: unknown[],
  flipY = false,
): { coordinates: unknown[]; holes?: unknown[][] } {
  const rings: unknown[][] = [[]]
  coordinates.forEach((coord, i) => {
    rings[rings.length - 1].push(coord)
    const yF = (coord as { yFlags?: number }).yFlags ?? 0
    if ((yF & 0x02) && i < coordinates.length - 1) rings.push([])
  })
  const [outer, ...inner] = rings
  const out: { coordinates: unknown[]; holes?: unknown[][] } = {
    coordinates: coordinatesToJson(outer, flipY),
  }
  if (inner.length) out.holes = inner.map(ring => coordinatesToJson(ring, flipY))
  return out
}

// Element (icon primitive) coord as a compact tuple `[x, y]` / `[x, y, flags]`,
// the same shape as object coords. Unlike an object, an icon primitive is a
// single shape that isn't ring-split, so `hole` stays a valid semantic flag here
// (an icon area primitive can carry a hole boundary). Element coords are
// symbol-internal (y-up), so they are never Y-flipped.
function elementCoordToJson(coord: unknown): unknown {
  const src = coord as { 0?: number; 1?: number; x?: number; y?: number; xFlags?: number; yFlags?: number }
  const isTuple = Array.isArray(coord)
  const x = cleanNumber(isTuple ? src[0] : src.x)
  const y = cleanNumber(isTuple ? src[1] : src.y)
  const flags = semanticCoordFlags(src.xFlags ?? 0, src.yFlags ?? 0, true)
  return flags ? [x, y, flags] : [x, y]
}

/**
 * Serialise a coordinate as a compact tuple.
 *
 * Plain vertex: `[x, y]`. A vertex carrying path flags: `[x, y, flags]`, where
 * `flags` is an object of SEMANTIC boolean keys — `control` (a Bézier control
 * point), `corner`, `dash`. Hole-ring boundaries are structural (see
 * `ringsToJson`), not a coord flag. The OCAD-shaped xFlags/yFlags bytes are
 * translated to these on write and back on read; the raw OMap byte is not stored.
 */
function coordToJson(coord: unknown, flipY = false): unknown {
  const src = coord as {
    0?: number; 1?: number; x?: number; y?: number;
    xFlags?: number; yFlags?: number;
  }
  const isTuple = Array.isArray(coord)
  const x = cleanNumber(isTuple ? src[0] : src.x)
  const rawY = cleanNumber(isTuple ? src[1] : src.y)
  // Negate for the visual (y-down) space; avoid -0 so serialisation is stable.
  const y = flipY && rawY !== 0 ? -rawY : rawY
  const flags = semanticCoordFlags(src.xFlags ?? 0, src.yFlags ?? 0)
  return flags ? [x, y, flags] : [x, y]
}

// OCAD flag bytes → semantic flags. xFlags 0x01/0x02 are the two Bézier control
// points (both -> `control`; cp1 vs cp2 is recovered by position on read).
// yFlags: 0x01 corner, 0x02 hole, 0x08 dash point. Object coords pass
// `includeHole = false` — their hole rings are structural (outer `coordinates` +
// `holes`); element (icon) coords pass `true`, since a primitive isn't ring-split.
function semanticCoordFlags(
  xF: number, yF: number, includeHole = false,
): Record<string, true> | undefined {
  const f: Record<string, true> = {}
  if (xF & 0x03) f.control = true
  if (yF & 0x01) f.corner = true
  if (includeHole && (yF & 0x02)) f.hole = true
  if (yF & 0x08) f.dash = true
  return Object.keys(f).length ? f : undefined
}

function toJsonSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toJsonSafe)
  // Round scalars to the shared 3-dp grid (as coordinates are). The two readers
  // reach render-layer sizes/angles by different arithmetic — OCAD from integer
  // tenths, OMap from radians/µm — so the same value lands as `90` vs
  // `90.0002…` or `1.058` vs `1.0583333…`. Rounding makes them serialise
  // identically; integers pass through untouched.
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : Number(value.toFixed(3))
  }
  if (!value || typeof value !== 'object') return value

  const output: Record<string, unknown> = {}
  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
    if (child === undefined || typeof child === 'function') return
    output[key] = toJsonSafe(child)
  })
  return output
}

function stableColorId(color: MapColor): string {
  // Include a stable disambiguator so duplicate-named color slots
  // (port-hills has 6 different "Green" entries used at different
  // render orders) don't collapse into one gitmap id. Renumber via
  // sourceId when present, else id — either is stable across a
  // single map's serialisation.
  const base = slug(color.name || String(color.id)) || String(color.id)
  const disc = color.sourceId ?? color.id
  return `color_${base}_${disc}`
}

function stableSymbolId(symbol: MapSymbol): string {
  const code = canonicalSymbolCode(symbol.code) || String(symbol.sourceId ?? symbol.id)
  return `sym_${slug(code)}`
}

function stableObjectId(
  object: MapObject,
  symbolId?: string,
  partId = 'part_main',
  flipY = false,
): string {
  return `obj_${hashObject({
    partId,
    symbolId: symbolId || object.symbolId,
    type: object.type,
    // Hash the SAME (possibly y-flipped) coords that get serialised, so the
    // id identifies the geometry as actually stored.
    coordinates: coordinatesToIdentityJson(object.coordinates || [], flipY),
    text: object.text || '',
    rotation: snapRotationToOcadGrid(object.rotation),
  })}`
}

function coordinatesToIdentityJson(coordinates: unknown[], flipY = false): unknown[] {
  return coordinates.map(coord => {
    const src = coord as { 0?: number; 1?: number; x?: number; y?: number }
    const isTuple = Array.isArray(coord)
    if (!isTuple && (!coord || typeof coord !== 'object' || !('x' in src))) {
      return coord
    }
    const rawY = cleanNumber(isTuple ? src[1] : src.y)
    return {
      x: cleanNumber(isTuple ? src[0] : src.x),
      y: flipY && rawY !== 0 ? -rawY : rawY,
    }
  })
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function hashObject(value: unknown): string {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(toJsonSafe(value)))
    .digest('hex')
    .slice(0, 12)
}

function cleanNumber(value: unknown): number {
  const number = Number(value)
  return Number.isInteger(number) ? number : Number(number.toFixed(3))
}

export {
  toGitmapColor,
  toGitmapSymbol,
  toGitmapObject,
  stableColorId,
  stableSymbolId,
  stableObjectId,
  coordinatesToJson,
}
