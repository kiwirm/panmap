import type { MapSymbol, RenderLayer } from '../../../../panmap/model.js'
import { encodeOcadElementFlags } from '../../../ocad/codecs/element-flags.js'

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
    l => l.type === 'stroke' || l.type === 'line-elements',
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
      // TdPoly array-with-props from the OCAD reader. Preserve
      // xFlags/yFlags so `elementCoordToJson` can serialise bezier /
      // corner / dash markers (cliff tags, minimum-knoll curves).
      // Previously dropped, which turned OCAD-sourced curved icons into
      // straight polygons on any OCD→gitmap round-trip and broke the
      // convergence gate against xmap-sourced siblings.
      const arr = c as unknown as {
        0?: number
        1?: number
        xFlags?: number
        yFlags?: number
      }
      const out: { x: number; y: number; xFlags?: number; yFlags?: number } = {
        x: snapSymCoord(arr[0] ?? 0),
        y: snapSymCoord(arr[1] ?? 0),
      }
      if (arr.xFlags) out.xFlags = arr.xFlags
      if (arr.yFlags) out.yFlags = arr.yFlags
      return out
    }
    const { x, y, ...rest } = c as {
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
// Coord y is now canonicalised to y-UP at read time on BOTH sides (OCD
// reader → OCD binary is y-up natively; OMap reader → `flatten-line-decor.ts`
// / `normalisePointElementsYUp` negate y from xmap's y-down convention).
// This helper therefore preserves y verbatim — no more double-flip.
// The xmap writer's `ocadElementToXmapElement` continues to re-flip on the
// reverse path (`y: -coordY(c)`), and the equivalent negation lives on
// the pattern-symbol / point-symbol pass-through paths in `elements.ts`.
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
  const anchorY = snapSymCoord(
    Array.isArray(anchor) ? (anchor[1] ?? 0) : (anchor?.y ?? 0),
  )

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
    const coords = mapXmapCoordsToOcadElement(rawCoords)
    return [
      {
        type: 1,
        flags: encodeOcadElementFlags(
          sym.lineSymbol.capStyle,
          sym.lineSymbol.joinStyle,
        ),
        color: sym.lineSymbol.color,
        lineWidth: sym.lineSymbol.lineWidth ?? 0,
        diameter: 0,
        numberCoords: coords.length,
        coords,
      },
    ]
  }
  if (sym.areaSymbol) {
    const coords = mapXmapCoordsToOcadElement(rawCoords)
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
/**
 * Map an xmap-shape coord array into OCD-shape `{x, y, xFlags, yFlags}`
 * records, translating the xmap `flags` byte to OCD's xFlags/yFlags for
 * **icon element coords** (a stricter mapping than the object-coord
 * translation in `formats/omap/codecs/omap-flags.ts:normaliseOmapFlags`):
 *   • xmap 0x01 (CurveStart) on coord[N] → OCD
 *     coord[N+1].xFlags |= 0x01 (cp1) AND coord[N+2].xFlags |= 0x02 (cp2)
 *   • xmap 0x10 (HolePoint) is Mapper's sub-path terminator: it always
 *     appears on the LAST coord of an icon path and is implicit in
 *     OCD (which terminates paths at the end of the coord array).
 *     DROP it here — carrying yFlags=0x02 would produce a spurious
 *     `{hole:true}` semantic flag that OCD-sourced siblings don't emit
 *     (32 divergences on the corpus, e.g. 115 Prominent landform).
 *   • xmap 0x20 (DashPoint) on coord[N] → OCD coord[N].yFlags |= 0x01
 *     (**icon corner**, NOT `dash` (0x08) as in object coords). Mapper's
 *     xmap→OCD export writes DashPoint on icon element vertices where
 *     the OCAD side stores yFlags=0x01 (corner) — the two source paths
 *     must agree on the canonical semantic flag or gitmap convergence
 *     diverges (`{corner}` vs `{dash}` for the same icon vertex).
 * Without this translation, curved point-symbol icons (101.2/3/4
 * minimum-knoll contours, 110 elongated knoll etc.) render as straight-
 * edge polygon approximations after any xmap→gitmap→OCD round-trip.
 */
function mapXmapCoordsToOcadElement(
  rawCoords: Array<
    { x?: number; y?: number; flags?: number } | [number?, number?]
  >,
): Array<{ x: number; y: number; xFlags: number; yFlags: number }> {
  const flagsOf = (c: unknown): number => {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return 0
    return Number((c as { flags?: number }).flags ?? 0)
  }
  return rawCoords.map((c, i) => {
    const x = Array.isArray(c) ? (c[0] ?? 0) : (c?.x ?? 0)
    const y = Array.isArray(c) ? (c[1] ?? 0) : (c?.y ?? 0)
    let xFlags = 0
    let yFlags = 0
    if (i >= 1 && flagsOf(rawCoords[i - 1]) & 0x01) xFlags |= 0x01
    if (i >= 2 && flagsOf(rawCoords[i - 2]) & 0x01) xFlags |= 0x02
    const own = flagsOf(c)
    if (own & 0x20) yFlags |= 0x01
    return {
      x: snapSymCoord(x),
      y: snapSymCoord(y),
      xFlags,
      yFlags,
    }
  })
}

function isRealColor(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'number') return v >= 0
  return typeof v === 'string' && v.length > 0
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

// Strip redundant rhythm fields from any `line-elements` layer. Both
// dialects reach this filter — OCD-sourced from its reader, OMap-sourced
// from `formats/omap/reader/flatten-line-decor.ts` which flattens the
// xmap nested subtree into the canonical line-elements shape.
//
// Also strips xFlags/yFlags from element coords: OCD-sourced elements have
// them (decoded from stored flag byte), OMap-sourced ones don't (the OMap
// reader doesn't run `normaliseOmapFlags` on symbol-internal element coords).
// Removing them lets both dialects agree on the coord shape; Bezier / dash
// info lives on the object coords + primary stroke where it matters.
export function stripLineElementsRedundancy(layer: RenderLayer): RenderLayer {
  const l = layer as { type?: string } & Record<string, unknown>
  // Also strip phantom elements from point-pattern-fill.elements — same
  // OMap-only phantom preservation issue as line-elements.
  if (l.type === 'point-pattern-fill') {
    const arr = l.elements
    if (Array.isArray(arr)) {
      const filtered = arr.filter(el => !isPhantomElement(el))
      if (filtered.length !== arr.length) {
        return { ...l, elements: filtered } as unknown as RenderLayer
      }
    }
    return layer
  }
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
    if (Array.isArray(arr)) {
      // Drop phantom placeholder elements (invisible dot at origin with
      // no colour, diameter 0). The OMap reader emits these to preserve
      // xmap phantom point-symbol positions on the direct round-trip;
      // OCD side never produces them, so keeping them in gitmap breaks
      // OCD ↔ OMap convergence.
      const filtered = arr.filter(el => !isPhantomElement(el))
      rest[key] = filtered.map(stripPointElementXyFlags)
    }
  }
  return rest as unknown as RenderLayer
}

function isPhantomElement(el: unknown): boolean {
  if (!el || typeof el !== 'object') return false
  const e = el as {
    type?: number
    color?: unknown
    lineWidth?: number
    diameter?: number
  }
  return (
    e.type === 4 &&
    (e.color === -1 || e.color === null || e.color === undefined) &&
    !e.lineWidth &&
    !e.diameter
  )
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
