import Panmap from '../../../panmap/model.js'
import type {
  MapCrs,
  MapCrsGeographic,
  MapCrsProjected,
  MapPrint,
  MapTemplate,
  MapTemplateTransform,
  MapTemplateTransformations,
  MapTemplates,
  MapView,
  RenderLayer,
  MapSpotColor,
} from '../../../panmap/model.js'
import type {
  RenderElement,
  DecorationWrapper,
} from '../../../panmap/render-layers.js'
import TdPoly from '../../ocad/reader/decode/td-poly.js'
import { parseNotes } from '../../codecs/index.js'
import { boundsForCoords, type FlaggedCoord } from '../../../panmap/coord.js'
import { normaliseOmapFlags } from '../codecs/index.js'
import {
  flattenXmapDecorSubtree,
  normalisePointElementsYUp,
} from './flatten-line-decor.js'
import type {
  OmapAreaPattern,
  OmapColor,
  OmapCoord,
  OmapFile,
  OmapObject,
  OmapPointSymbol,
  OmapSymbol,
} from '../native.js'

// Extract Mapper-authored wrapper metadata from a decoration sub-symbol
// (mid_symbol / start_symbol / end_symbol / dash_symbol on a line, or
// the outer wrapper of a pattern stamp). Returns undefined for symbols
// without a `pointSymbol` (untypical shapes) or when every field is at
// Mapper's default so the round-trip's writer defaults suffice.
function extractDecorationWrapper(
  sub: { pointSymbol?: OmapPointSymbol } | undefined | null,
): DecorationWrapper | undefined {
  const ps = sub?.pointSymbol
  if (!ps) return undefined
  return {
    innerRadius: ps.innerRadius,
    innerColor: ps.innerColor ?? undefined,
    outerWidth: ps.outerWidth,
    outerColor: ps.outerColor ?? undefined,
    rotatable: ps.rotatable,
  }
}

/**
 * Converts a parsed OpenOrienteering Mapper XMap/OMap document into the
 * Panmap model.
 */
function omapFileToMap(xmapFile: OmapFile): Panmap {
  const symbolsById = xmapFile.symbols.reduce(
    (symbols, symbol) => {
      symbols[symbol.id] = symbol
      return symbols
    },
    {} as Record<number, OmapSymbol>,
  )

  const notesText = extractNotesText(xmapFile.extras?.notes)
  const { userText, extensions } = parseNotes(notesText)
  const view = extractView(xmapFile.extras?.view)
  const print = extractPrint(xmapFile.extras?.print)
  const templates = extractTemplates(xmapFile.extras?.templates)
  const georeferencing = extractGeoreferencing(xmapFile.extras?.georeferencing)

  // Parts activate only for genuine multi-part maps; a single part keeps the
  // pre-parts behaviour (no `parts`, no per-object `partId`) so output is
  // byte-identical. First part is `part_main` (matches gitmap's default).
  const multiPart = xmapFile.parts.length > 1
  const partIds = xmapFile.parts.map((_, i) =>
    i === 0 ? 'part_main' : `part_${i}`,
  )
  const parts = multiPart
    ? xmapFile.parts.map((part, i) => ({ id: partIds[i], name: part.name }))
    : undefined
  let objIndex = 0
  const objects = xmapFile.parts.flatMap((part, i) =>
    part.objects.map(object =>
      toMapObject(
        object,
        objIndex++,
        symbolsById,
        multiPart ? partIds[i] : undefined,
      ),
    ),
  )

  return new Panmap({
    metadata: {},
    // A DEDICATED separation record (its `name` IS the separation name)
    // isn't a palette colour — route it to `spotColors` so the palette
    // matches an OCD-sourced copy of the same map. A palette colour
    // merely TAGGED with a separation stays in the palette.
    colors: paletteColors(xmapFile.colors).map(toMapColor),
    spotColors: spotColorsFromXmap(xmapFile.colors),
    symbols: xmapFile.symbols.map(symbol => toMapSymbol(symbol, symbolsById)),
    objects,
    parts,
    warnings: [],
    view,
    print,
    templates,
    georeferencing,
    extensions,
    notes: userText,
  })
}

/**
 * Parse an xmap `<view>` subtree (as delivered by `collectExtras`) into
 * a `MapView`. Only `map_view` position + zoom are carried
 * across — grid config, per-layer visibility, and any per-part display
 * flags stay lossy until we model them.
 *
 * Xmap stores `position_x`/`position_y` in µm (1/1000 mm) and its Y
 * axis is paper-down; the Panmap `MapView.center` is in mm using
 * OCAD's y-up frame, so flip Y here.
 */
function extractView(raw: unknown): MapView | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const mapView = (raw as Record<string, unknown>).map_view
  if (!mapView || typeof mapView !== 'object') return undefined
  const attrs = mapView as Record<string, unknown>
  const x = numberAttr(attrs['@_position_x'])
  const y = numberAttr(attrs['@_position_y'])
  const zoom = numberAttr(attrs['@_zoom'])
  const rotation = numberAttr(attrs['@_rotation'])
  const view: MapView = {}
  if (x !== undefined && y !== undefined) {
    view.center = { x: x / 1000, y: -y / 1000 }
  }
  if (zoom !== undefined) view.zoom = zoom
  if (rotation !== undefined) view.rotation = rotation
  return Object.keys(view).length ? view : undefined
}

function numberAttr(v: unknown): number | undefined {
  if (v == null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function extractPrint(raw: unknown): MapPrint | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const print: MapPrint = {}
  const scale = numberAttr(r['@_scale'])
  const resolution = numberAttr(r['@_resolution'])
  const mode = r['@_mode']
  if (scale !== undefined) print.scale = scale
  if (resolution !== undefined) print.resolution = resolution
  if (typeof mode === 'string') print.mode = mode
  const pf = r.page_format
  if (pf && typeof pf === 'object') {
    const pfr = pf as Record<string, unknown>
    const paperSize = pfr['@_paper_size']
    const orientation = pfr['@_orientation']
    const hOverlap = numberAttr(pfr['@_h_overlap'])
    const vOverlap = numberAttr(pfr['@_v_overlap'])
    const dims = pfr.dimensions as Record<string, unknown> | undefined
    const pageRect = pfr.page_rect as Record<string, unknown> | undefined
    const fmt: NonNullable<MapPrint['pageFormat']> = {}
    if (typeof paperSize === 'string') fmt.paperSize = paperSize
    if (orientation === 'portrait' || orientation === 'landscape')
      fmt.orientation = orientation
    if (hOverlap !== undefined) fmt.hOverlap = hOverlap
    if (vOverlap !== undefined) fmt.vOverlap = vOverlap
    if (dims) {
      const w = numberAttr(dims['@_width'])
      const h = numberAttr(dims['@_height'])
      if (w !== undefined && h !== undefined)
        fmt.dimensions = { width: w, height: h }
    }
    if (pageRect) {
      const rect = rectFromAttrs(pageRect)
      if (rect) fmt.pageRect = rect
    }
    if (Object.keys(fmt).length) print.pageFormat = fmt
  }
  const pa = r.print_area
  if (pa && typeof pa === 'object') {
    const rect = rectFromAttrs(pa as Record<string, unknown>)
    if (rect) print.printArea = rect
  }
  return Object.keys(print).length ? print : undefined
}

function extractTemplates(raw: unknown): MapTemplates | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const items = ensureArray(r.template)
    .map(extractTemplate)
    .filter((t): t is MapTemplate => !!t)
  const firstFront = numberAttr(r['@_first_front_template'])
  const defaultsRaw = r.defaults as Record<string, unknown> | undefined
  const templates: MapTemplates = { items }
  if (firstFront !== undefined) templates.firstFrontTemplate = firstFront
  if (defaultsRaw) {
    const defaults: NonNullable<MapTemplates['defaults']> = {}
    const use = defaultsRaw['@_use_meters_per_pixel']
    if (use === 'true' || use === 'false')
      defaults.useMetersPerPixel = use === 'true'
    const mpp = numberAttr(defaultsRaw['@_meters_per_pixel'])
    const dpi = numberAttr(defaultsRaw['@_dpi'])
    const sc = numberAttr(defaultsRaw['@_scale'])
    if (mpp !== undefined) defaults.metersPerPixel = mpp
    if (dpi !== undefined) defaults.dpi = dpi
    if (sc !== undefined) defaults.scale = sc
    if (Object.keys(defaults).length) templates.defaults = defaults
  }
  return items.length || templates.defaults || firstFront !== undefined
    ? templates
    : undefined
}

function extractTemplate(raw: unknown): MapTemplate | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const template: MapTemplate = {}
  const type = r['@_type']
  const open = r['@_open']
  const name = r['@_name']
  const path = r['@_path']
  const relpath = r['@_relpath']
  if (typeof type === 'string') template.type = type
  if (open === 'true' || open === 'false') template.open = open === 'true'
  if (typeof name === 'string') template.name = name
  if (typeof path === 'string') template.path = path
  if (typeof relpath === 'string') template.relpath = relpath
  const trans = extractTransformations(r.transformations)
  if (trans) template.transformations = trans
  return template
}

function extractTransformations(
  raw: unknown,
): MapTemplateTransformations | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: MapTemplateTransformations = {}
  const dirty = r['@_adjustment_dirty']
  if (dirty === 'true' || dirty === 'false')
    out.adjustmentDirty = dirty === 'true'
  const pp = numberAttr(r['@_passpoints'])
  if (pp !== undefined) out.passpoints = pp
  for (const t of ensureArray(r.transformation)) {
    const parsed = extractTransform(t)
    if (!parsed) continue
    const role = (t as Record<string, unknown>)['@_role']
    if (role === 'active') out.active = parsed
    else if (role === 'other') out.other = parsed
  }
  for (const m of ensureArray(r.matrix)) {
    const role = (m as Record<string, unknown>)['@_role']
    const values = ensureArray((m as Record<string, unknown>).element)
      .map(e => numberAttr((e as Record<string, unknown>)['@_value']))
      .filter((v): v is number => v !== undefined)
    if (role === 'map_to_template') out.mapToTemplate = values
    else if (role === 'template_to_map') out.templateToMap = values
    else if (role === 'template_to_map_other') out.templateToMapOther = values
  }
  return Object.keys(out).length ? out : undefined
}

function extractTransform(raw: unknown): MapTemplateTransform | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const t: MapTemplateTransform = {}
  const x = numberAttr(r['@_x'])
  const y = numberAttr(r['@_y'])
  const sx = numberAttr(r['@_scale_x'])
  const sy = numberAttr(r['@_scale_y'])
  const rot = numberAttr(r['@_rotation'])
  if (x !== undefined) t.x = x
  if (y !== undefined) t.y = y
  if (sx !== undefined) t.scaleX = sx
  if (sy !== undefined) t.scaleY = sy
  if (rot !== undefined) t.rotation = rot
  return Object.keys(t).length ? t : undefined
}

function ensureArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return []
  return Array.isArray(v) ? v : [v]
}

function extractGeoreferencing(raw: unknown): MapCrs | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const crs: MapCrs = {}
  const scale = numberAttr(r['@_scale'])
  if (scale !== undefined) crs.scale = scale
  const aux = numberAttr(r['@_auxiliary_scale_factor'])
  if (aux !== undefined) crs.auxiliaryScaleFactor = aux
  const grid = numberAttr(r['@_grid_scale_factor'])
  if (grid !== undefined) crs.gridScaleFactor = grid
  const dec = numberAttr(r['@_declination'])
  if (dec !== undefined) crs.declination = dec
  const gri = numberAttr(r['@_grivation'])
  if (gri !== undefined) crs.grivation = gri
  const rp = r.ref_point as Record<string, unknown> | undefined
  if (rp) {
    const point = pointFromAttrs(rp)
    if (point) crs.refPoint = point
  }
  const proj = extractProjectedCrs(r.projected_crs)
  if (proj) crs.projected = proj
  const geo = extractGeographicCrs(r.geographic_crs)
  if (geo) crs.geographic = geo
  return Object.keys(crs).length ? crs : undefined
}

function extractProjectedCrs(raw: unknown): MapCrsProjected | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const id = r['@_id']
  if (typeof id !== 'string') return undefined
  const out: MapCrsProjected = { id }
  const spec = extractCrsSpec(r.spec)
  if (spec) out.spec = spec
  const param = r.parameter
  if (typeof param === 'string' || typeof param === 'number')
    out.parameter = String(param)
  const rp = r.ref_point as Record<string, unknown> | undefined
  if (rp) {
    const point = pointFromAttrs(rp)
    if (point) out.refPoint = point
  }
  return out
}

function extractGeographicCrs(raw: unknown): MapCrsGeographic | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const id = r['@_id']
  if (typeof id !== 'string') return undefined
  const out: MapCrsGeographic = { id }
  const spec = extractCrsSpec(r.spec)
  if (spec) out.spec = spec
  const rp = r.ref_point_deg as Record<string, unknown> | undefined
  if (rp) {
    const lat = numberAttr(rp['@_lat'])
    const lon = numberAttr(rp['@_lon'])
    if (lat !== undefined && lon !== undefined) out.refPointDeg = { lat, lon }
  }
  return out
}

function extractCrsSpec(
  raw: unknown,
): { language: string; value: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const language = r['@_language']
  const value = r['#text']
  if (typeof language !== 'string' || typeof value !== 'string')
    return undefined
  return { language, value }
}

function pointFromAttrs(
  r: Record<string, unknown>,
): { x: number; y: number } | undefined {
  const x = numberAttr(r['@_x'])
  const y = numberAttr(r['@_y'])
  if (x === undefined || y === undefined) return undefined
  return { x, y }
}

function rectFromAttrs(
  r: Record<string, unknown>,
): { left: number; top: number; width: number; height: number } | undefined {
  const left = numberAttr(r['@_left'])
  const top = numberAttr(r['@_top'])
  const width = numberAttr(r['@_width'])
  const height = numberAttr(r['@_height'])
  if (
    left === undefined ||
    top === undefined ||
    width === undefined ||
    height === undefined
  )
    return undefined
  return { left, top, width, height }
}

function extractNotesText(notes: unknown): string {
  if (notes == null) return ''
  if (typeof notes === 'string') return notes
  if (typeof notes === 'object') {
    const record = notes as Record<string, unknown>
    if (typeof record['#text'] === 'string') return record['#text']
  }
  return ''
}

/**
 * Indices of the records that exist only to define a print separation.
 *
 * Two conditions, both required:
 *   • the display name IS the separation name — an ordinary palette
 *     colour tagged with a separation ("Black 100%" → "Black") fails
 *     this and stays in the palette;
 *   • the record sits in the contiguous run at the END of the list,
 *     where Mapper appends dedicated definitions (hillmorton: 41–47).
 *
 * The tail condition is load-bearing. kura-tawhiti has a genuine palette
 * colour named "Black" tagged with separation "Black" at priority 2,
 * with ordinary colours after it; name-equality alone would drop it and
 * leave the palette one short of the OCD-sourced copy.
 */
function spotDefinitionIndices(colors: OmapColor[]): Set<number> {
  const out = new Set<number>()
  for (let i = colors.length - 1; i >= 0; i--) {
    const c = colors[i]
    if (!c.spotName || c.spotName !== c.name) break
    out.add(i)
  }
  return out
}

/** The drawing palette: every colour record that isn't a dedicated
 *  separation definition. */
function paletteColors(colors: OmapColor[]): OmapColor[] {
  const spots = spotDefinitionIndices(colors)
  return colors.filter((_, i) => !spots.has(i))
}

/** Collect every separation named anywhere in the palette — dedicated
 *  record or inline tag — in first-seen order. */
function spotColorsFromXmap(colors: OmapColor[]): MapSpotColor[] {
  const seen = new Set<string>()
  const out: MapSpotColor[] = []
  for (const c of colors) {
    if (!c.spotName || seen.has(c.spotName)) continue
    seen.add(c.spotName)
    out.push({
      name: c.spotName,
      cmyk: c.cmyk,
      rgb: c.rgb ? `rgb(${c.rgb.r}, ${c.rgb.g}, ${c.rgb.b})` : undefined,
    })
  }
  return out
}

function toMapColor(color: OmapColor) {
  // reader/decode.ts already normalises RGB into 0–255 bytes via
  // rgbValuesToBytes / cmykFractionToRgb — no further scaling needed.
  const rgb = color.rgb || { r: 0, g: 0, b: 0 }
  return {
    id: color.priority,
    sourceId: color.priority,
    name: color.name,
    rgb: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`,
    cmyk: color.cmyk,
    opacity: color.opacity,
    renderOrder: color.priority,
    sourceColor: color,
  }
}

function toMapSymbol(
  symbol: OmapSymbol,
  symbolsById: Record<number, OmapSymbol>,
) {
  // Rotatable is an outer-element attribute in xmap (`<point_symbol
  // rotatable="true">` / `<text_symbol rotatable="true">`) but doesn't
  // survive the render-layer flatten cleanly — expose it as a top-level
  // Panmap field so `isRotatable` in synth doesn't need to walk
  // `native.xmap.raw`.
  const rotatable = !!(
    symbol.pointSymbol?.rotatable ||
    symbol.textSymbol?.rotatable ||
    // Area symbols can be rotatable when any of their patterns are —
    // the OCAD flags-bit is set if *any* pattern rotates. Layers still
    // carry per-pattern `rotatable` for finer-grained rendering; the
    // top-level flag is purely for the OCAD flag byte.
    symbol.areaSymbol?.patterns?.some(p => !!p.rotatable)
  )
  return {
    id: symbol.id,
    sourceId: symbol.id,
    code: symbol.code,
    name: symbol.name,
    type: symbolTypeName(symbol),
    hidden: !!symbol.isHidden,
    protected: symbol.isProtected || undefined,
    rotatable,
    fontSize: symbol.textSymbol && symbol.textSymbol.fontSize,
    // XMap-only per-symbol payloads that don't have a natural home on
    // the render layers. Preserved through the direct round-trip only;
    // dropped at gitmap-serialize time so OCD-vs-OMap convergence
    // stays intact.
    textSymbol: symbol.textSymbol?.iconText
      ? {
          fontSize: symbol.textSymbol.fontSize,
          iconText: symbol.textSymbol.iconText,
        }
      : undefined,
    areaSymbol: (symbol.areaSymbol as { minArea?: number })?.minArea
      ? { minArea: (symbol.areaSymbol as { minArea: number }).minArea }
      : undefined,
    layers: symbolToRenderLayers(symbol, symbolsById),
  }
}

/**
 * @param {OmapSymbol} symbol
 * @returns {import('../../../panmap/model').RenderLayer[]}
 */
/**
 * Build canonical `point-pattern-fill` layers from an xmap area
 * symbol's `<pattern>` list.
 *
 * XMap expresses OCAD's "shifted rows" (brick-bond) layout as a PAIR of
 * `<pattern>` records: identical spacing and stamp, with the second
 * offset by half a tile in both axes. The canonical model carries that
 * as a single layer with `shiftedRows: true` (the same shape the OCD
 * reader produces from `structMode=2`), so collapse the pair here.
 *
 * `noClipping` is per-`<pattern>` in xmap but a single value per symbol
 * in OCD. On a collapsed pair, keep the strongest (max) value — OCD
 * can only carry one, and Mapper writes 0 on the first sub-pattern with
 * the real value on the second.
 */
function pointPatternLayersFromXmap(
  patterns: OmapAreaPattern[] | undefined,
): RenderLayer[] {
  const stamps = (patterns ?? []).filter(p => p.type !== 1 && p.symbol)
  const out: RenderLayer[] = []
  for (let i = 0; i < stamps.length; i++) {
    const p = stamps[i]
    const next = stamps[i + 1]
    const paired = next ? isShiftedRowsPair(p, next) : false
    const lineSpacing = p.lineSpacing || p.pointDistance || 1
    const elements = flattenXmapDecorSubtree(p.symbol) as RenderElement[]
    out.push({
      type: 'point-pattern-fill',
      // Dominant ink of the stamp. The OCD reader derives this from the
      // stamp's elements (lowest colour slot), so do the same rather
      // than reading the xmap wrapper's own colour — a wrapper with
      // `inner_color="-1"` (208 Boulder field) would otherwise report
      // -1 where the OCD side reports the boulders' black.
      colorId:
        elements.length > 0
          ? (elements[0] as { color?: unknown }).color
          : (p.symbol?.pointSymbol?.innerColor ??
            p.symbol?.areaSymbol?.innerColor ??
            p.symbol?.lineSymbol?.color),
      // `width` is spacing ALONG a row (xmap `point_distance`),
      // `height` between rows (xmap `line_spacing`). A shifted-rows pair
      // shares one row pitch but the tile spans BOTH rows, matching the
      // OCD reader's `structHeight * 2`.
      width: Math.max(p.pointDistance || 1, 1),
      height: Math.max(paired ? lineSpacing : lineSpacing, 1),
      // XMap stores angles in radians; the model uses degrees.
      angle: p.angle ? (p.angle * 180) / Math.PI : 0,
      shiftedRows: paired,
      rowOffset: p.lineOffset || 0,
      columnOffset: p.offsetAlongLine || 0,
      // `no_clipping` is per-`<pattern>` in xmap but a single value per
      // symbol in OCD. Mapper writes the real value on the SECOND record
      // of a shifted-rows pair (its own renderer reads that one), with 0
      // on the first. Take the maximum across the pair so the writer can
      // put the value back where Mapper puts it — first-only-take would
      // silently drop the flag on every shifted-rows fill.
      noClipping: Math.max(
        p.noClipping ?? 0,
        paired ? (next?.noClipping ?? 0) : 0,
      ),
      rotatable: p.rotatable ?? false,
      // Preserve wrapper metadata for the stamp — Mapper writes real
      // inner_radius on the outer `<point_symbol>` even when the
      // rendered content is compound (kura-tawhiti 208 boulder-field
      // has inner_radius=1200 on the outer, wrapping 9 triangle
      // elements). Without this the writer collapses to the hardcoded
      // 1000 default.
      stampWrapper: extractDecorationWrapper(
        p.symbol as { pointSymbol?: OmapPointSymbol } | undefined,
      ),
      // The stamp, flattened to the same icon-primitive array shape
      // `point-elements` and `line-elements` use.
      elements: elements as RenderLayer['elements'],
    } as RenderLayer)
    if (paired) i++ // consume the second half of the pair
  }
  return out
}

/** Two `<pattern>` records form one shifted-rows layout when they share
 *  spacing and the second sits half a tile away in both axes. */
function isShiftedRowsPair(a: OmapAreaPattern, b: OmapAreaPattern): boolean {
  const ls = a.lineSpacing
  const pd = a.pointDistance
  if (!ls || !pd) return false
  if (a.lineSpacing !== b.lineSpacing || a.pointDistance !== b.pointDistance) {
    return false
  }
  const dRow = Math.abs(
    (((((b.lineOffset ?? 0) - (a.lineOffset ?? 0)) % ls) + ls) % ls) - ls / 2,
  )
  const dCol = Math.abs(
    (((((b.offsetAlongLine ?? 0) - (a.offsetAlongLine ?? 0)) % pd) + pd) % pd) -
      pd / 2,
  )
  return dRow <= 1 && dCol <= 1
}

function symbolToRenderLayers(
  symbol: OmapSymbol,
  symbolsById: Record<number, OmapSymbol>,
  seen = new Set<number>(),
): RenderLayer[] {
  if (seen.has(symbol.id)) return []
  seen.add(symbol.id)

  // XMap element XML stores point-symbol element coords y-DOWN, but
  // the canonical model contract is y-UP (matching OCD binary +
  // flatten-line-decor.ts's already-flipped output). Normalise the
  // nested `{symbol, object}` tree once up front so downstream
  // consumers (both writers, SVG render, gitmap canonicalise) all
  // see the same orientation. Called exactly once per xmap symbol
  // — the layers array below can then reference the elements without
  // further mutation.
  //
  // Area-symbol `<pattern>` stamps get the same y-up treatment, but via
  // `flattenXmapDecorSubtree` in `pointPatternLayersFromXmap` (which
  // negates as it flattens) — doing it here as well would double-flip.
  normalisePointElementsYUp(symbol.pointSymbol?.elements)

  if (symbol.combinedSymbol?.parts?.length) {
    const parts = symbol.combinedSymbol.parts
    // Special case — "area + line-ref" combined: the OCAD-style
    // "area with border" idiom. Reconstruct a `border-symbol` render
    // layer instead of flattening the border line's strokes into the
    // area, so ocd → xmap → ocd preserves `borderSym` losslessly.
    // Handles both the "inline area + ref" shape and the "ref area +
    // ref line" shape (kura-tawhiti / orua-paeroa 301 Uncrossable
    // body of water is two refs: fill area + border line).
    if (parts.length === 2) {
      // OCAD's "area with borderSym" idiom shows up in xmap as a
      // <combined_symbol parts="2"> pairing an area part with a
      // line-symbol reference. The line may be part 1 or part 2 —
      // kura-tawhiti's 301 has area first, 302 has line first —
      // so try both orderings.
      const tryAreaBorderPair = (
        areaPart: (typeof parts)[number],
        linePart: (typeof parts)[number],
      ) => {
        const areaSym =
          areaPart.symbol ||
          (areaPart.symbolRef !== undefined
            ? symbolsById[areaPart.symbolRef]
            : undefined)
        const lineRef = linePart.symbolRef
        if (lineRef === undefined || linePart.symbol) return null
        const lineSym = symbolsById[lineRef]
        if (!lineSym || !isEffectivelyLine(lineSym, symbolsById)) return null
        if (
          !areaSym?.areaSymbol ||
          areaSym.lineSymbol ||
          areaSym.pointSymbol ||
          areaSym.textSymbol
        ) {
          return null
        }
        const areaLayers = symbolToRenderLayers(areaSym, symbolsById, seen)
        return [
          ...areaLayers,
          { type: 'border-symbol' as const, symbolId: lineRef },
        ] as RenderLayer[]
      }
      const [a, b] = parts
      const asAreaFirst = tryAreaBorderPair(a, b)
      if (asAreaFirst) return asAreaFirst
      const asLineFirst = tryAreaBorderPair(b, a)
      if (asLineFirst) return asLineFirst
    }
    // Pure-refs case that isn't area+line-ref (kura-tawhiti / orua-
    // paeroa 412 Cultivated land: two area refs stacked as a compound
    // area). Emit a `combined-refs` render layer AS WELL AS the
    // flattened per-part layers. Direct xmap writer prefers combined-
    // refs and re-emits `<combined_symbol>`; the OCD writer + gitmap
    // canonicaliser drop combined-refs and keep only the flattened
    // layers so both OCD-sourced siblings and gitmap round-trips
    // converge on the same shape.
    if (
      parts.length >= 2 &&
      parts.every(p => !p.symbol && p.symbolRef !== undefined)
    ) {
      const flattened = parts.flatMap(part => {
        const partSymbol =
          part.symbolRef !== undefined ? symbolsById[part.symbolRef] : undefined
        return partSymbol
          ? symbolToRenderLayers(partSymbol, symbolsById, seen)
          : []
      })
      return [
        {
          type: 'combined-refs',
          refs: parts.map(p => p.symbolRef as number),
        },
        ...flattened,
      ]
    }
    return parts.flatMap(part => {
      const partSymbol =
        part.symbol ||
        (part.symbolRef !== undefined ? symbolsById[part.symbolRef] : undefined)
      return partSymbol
        ? symbolToRenderLayers(partSymbol, symbolsById, seen)
        : []
    })
  }

  return [
    symbol.lineSymbol && {
      type: 'stroke',
      colorId: symbol.lineSymbol.color,
      width: symbol.lineSymbol.lineWidth,
      dash: symbol.lineSymbol.dashed
        ? {
            dashLength: symbol.lineSymbol.dashLength,
            breakLength: symbol.lineSymbol.breakLength,
            dashesInGroup: symbol.lineSymbol.dashesInGroup,
            inGroupBreakLength: symbol.lineSymbol.inGroupBreakLength,
            // Only hoist `halfOuterDashes` when true; both readers
            // (OCD via derivation from `endLength ≈ mainLength / 2`;
            // OMap via this hoist) canonicalise to the same shape so
            // gitmap convergence isn't broken by attribute presence.
            halfOuterDashes:
              (symbol.lineSymbol as { halfOuterDashes?: boolean })
                .halfOuterDashes || undefined,
          }
        : undefined,
      // Persist join / cap so OCAD's `lineStyle` byte can be
      // recovered. xmap encoding: join_style 0=miter, 1=round, 2=bevel;
      // cap_style 0=flat, 1=round, 2=square, 3=pointed. OCAD `lineStyle`
      // packs them into one byte: bit 0 = round join, bit 2 = round cap.
      joinStyle: (symbol.lineSymbol as { joinStyle?: number }).joinStyle,
      capStyle: (symbol.lineSymbol as { capStyle?: number }).capStyle,
      // Pointed-cap length (only meaningful when capStyle=3, e.g. ISOM
      // 107 erosion gully). Now that the OCD reader stashes the equivalent
      // OCD field (`distFromStart`/`distToEnd` on pointed-cap lines) as
      // `pointedCapLength` too, hoisting on both sides no longer breaks
      // gitmap convergence — but only when the value is non-zero, since
      // the OCD reader also only emits it when present.
      pointedCapLength:
        (symbol.lineSymbol as { pointedCapLength?: number }).pointedCapLength ||
        undefined,
      // Dash bookkeeping used to compute OCAD's `mainLength`,
      // `endLength`, and `nPrimSym` — even non-dashed lines carry a
      // `segment_length` used for mid-symbol placement.
      segmentLength: (symbol.lineSymbol as { segmentLength?: number })
        .segmentLength,
      endLength: (symbol.lineSymbol as { endLength?: number }).endLength,
      midSymbolsPerSpot: (symbol.lineSymbol as { midSymbolsPerSpot?: number })
        .midSymbolsPerSpot,
      midSymbolDistance: (symbol.lineSymbol as { midSymbolDistance?: number })
        .midSymbolDistance,
      minimumMidSymbolCount: (
        symbol.lineSymbol as { minimumMidSymbolCount?: number }
      ).minimumMidSymbolCount,
      minimumMidSymbolCountWhenClosed: (
        symbol.lineSymbol as { minimumMidSymbolCountWhenClosed?: number }
      ).minimumMidSymbolCountWhenClosed,
      showAtLeastOneSymbol: (
        symbol.lineSymbol as { showAtLeastOneSymbol?: boolean }
      ).showAtLeastOneSymbol,
      // Preserve Mapper-authored line-symbol fields the OCD format
      // doesn't have. Without these on the stroke, an xmap → PanMap →
      // xmap round-trip drops the value and the writer emits its
      // default (0 / false / true) instead of what Mapper wrote.
      minimumLength: (symbol.lineSymbol as { minimumLength?: number })
        .minimumLength,
      // Hoist dash / break length at the stroke top level too — Mapper
      // stores per-symbol values for these attrs even on NON-dashed
      // lines (302.1 Small watercourse, 501.4 Vehicle track etc.), and
      // the `dash` sub-object is only populated when `dashed` is true.
      dashLength: (symbol.lineSymbol as { dashLength?: number }).dashLength,
      breakLength: (symbol.lineSymbol as { breakLength?: number }).breakLength,
      inGroupBreakLength: (symbol.lineSymbol as { inGroupBreakLength?: number })
        .inGroupBreakLength,
      midSymbolPlacement: (symbol.lineSymbol as { midSymbolPlacement?: number })
        .midSymbolPlacement,
      suppressDashSymbolAtEnds: (
        symbol.lineSymbol as { suppressDashSymbolAtEnds?: boolean }
      ).suppressDashSymbolAtEnds,
      scaleDashSymbol: (symbol.lineSymbol as { scaleDashSymbol?: boolean })
        .scaleDashSymbol,
      // Start / end offsets used for OCAD's `distFromStart` /
      // `distToEnd` fields — displace the whole line pattern
      // relative to the object endpoints.
      startOffset: (symbol.lineSymbol as { startOffset?: number }).startOffset,
      endOffset: (symbol.lineSymbol as { endOffset?: number }).endOffset,
      // Preserve xmap `<borders>` — these render as left/right parallel
      // strokes offset from the main line, and are what OCAD's
      // double-line fields encode. Without them, road symbols like
      // ISOM 502.x drop their outer borders when re-exported to OCAD.
      borders: symbol.lineSymbol.borders?.length
        ? symbol.lineSymbol.borders.map(
            (b: {
              color: number
              width: number
              shift: number
              dashed?: boolean
              dashLength?: number
              breakLength?: number
            }) => ({
              color: b.color,
              width: b.width,
              shift: b.shift,
              dashed: b.dashed,
              dashLength: b.dashLength,
              breakLength: b.breakLength,
            }),
          )
        : undefined,
    },
    // xmap-native line decorations (<mid_symbol>, <start_symbol>,
    // <end_symbol>, <dash_symbol>) flatten HERE — at read time — into
    // the canonical `line-elements` shape that OCD-sourced maps also
    // produce. Previously we stashed the raw xmap subtree on a
    // `line-symbols` layer and flattened at gitmap-write time, but that
    // let source-specific data leak into the model and gave the OMap
    // writer a private "prefer nativeSyms over canonical" fast path —
    // the model wasn't actually canonical. Flattening on read means
    // there's exactly one shape both writers consume.
    (() => {
      const ls = symbol.lineSymbol
      if (!ls) return undefined
      const primSymElements = ls.midSymbol
        ? flattenXmapDecorSubtree(ls.midSymbol)
        : []
      const startSymElements = ls.startSymbol
        ? flattenXmapDecorSubtree(ls.startSymbol)
        : []
      const endSymElements = ls.endSymbol
        ? flattenXmapDecorSubtree(ls.endSymbol)
        : []
      const cornerSymElements = ls.dashSymbol
        ? flattenXmapDecorSubtree(ls.dashSymbol)
        : []
      if (
        primSymElements.length === 0 &&
        startSymElements.length === 0 &&
        endSymElements.length === 0 &&
        cornerSymElements.length === 0
      ) {
        return undefined
      }
      const wrapperOf = (sub: unknown) =>
        extractDecorationWrapper(sub as { pointSymbol?: OmapPointSymbol })
      return {
        type: 'line-elements' as const,
        // Preserve Mapper-authored wrapper metadata on each sub-slot
        // (mid/start/end/dash). Mapper varies inner_radius across
        // fixtures (default 1000 for OCD-imported wrappers, 0 for
        // hand-authored xmap on lines like butlers-bush 104 Earth
        // bank). Without carrying these values, the direct xmap round-
        // trip collapses to the writer's hardcoded default.
        primSymWrapper: wrapperOf(ls.midSymbol),
        startSymWrapper: wrapperOf(ls.startSymbol),
        endSymWrapper: wrapperOf(ls.endSymbol),
        cornerSymWrapper: wrapperOf(ls.dashSymbol),
        // Same semantic-name placement fields as the OCD reader emits.
        // See `ocad/reader/to-panmap.ts` for rationale — duplicated on
        // line-elements only so the SVG renderer doesn't have to walk
        // sibling layers.
        spacing: ls.segmentLength || undefined,
        endOffset: ls.endLength || undefined,
        primSymElements,
        cornerSymElements,
        startSymElements,
        endSymElements,
      }
    })(),
    symbol.areaSymbol &&
      symbol.areaSymbol.innerColor >= 0 && {
        type: 'fill',
        colorId: symbol.areaSymbol.innerColor,
      },
    ...(symbol.areaSymbol && symbol.areaSymbol.patterns
      ? symbol.areaSymbol.patterns
          .filter(
            pattern =>
              pattern.type === 1 &&
              pattern.color !== undefined &&
              pattern.color >= 0,
          )
          .map(pattern => ({
            type: 'hatch-fill',
            colorId: pattern.color,
            spacing: pattern.lineSpacing,
            lineWidth: pattern.lineWidth,
            // XMap stores pattern angles in radians; the Panmap
            // model uses degrees (matches OCAD's `hatchAngle / 10`)
            // so the SVG exporter can pass the value straight to
            // SVG `rotate()`.
            angle: pattern.angle ? (pattern.angle * 180) / Math.PI : 0,
            // Preserve pattern-level `rotatable` — the OCAD area
            // symbol's rotatable flag comes from any pattern layer's
            // rotatability. Without this, symbols like ISOM 406.1
            // (vegetation with one-directional hatching) lose the
            // rotate-with-object bit and hatch angles no longer track
            // the object rotation.
            rotatable: (pattern as { rotatable?: boolean }).rotatable ?? false,
            // Xmap-only hatch offsets (Mapper's per-hatch `line_offset` /
            // `offset_along_line`) — used to phase-shift the second stripe
            // of a two-colour hatch (kura-tawhiti 512.3.1). Omit zeros so
            // OCD-sourced siblings converge on the same layer shape.
            lineOffset: pattern.lineOffset || undefined,
            offsetAlongLine: pattern.offsetAlongLine || undefined,
          }))
      : []),
    ...pointPatternLayersFromXmap(symbol.areaSymbol?.patterns),
    // Preserve inner disc / outer ring even when the color is
    // "invisible" (-1) as long as a real radius or width was set —
    // xmap uses these zero-visibility structs to encode hit-box radii
    // and structural markers, and dropping them here loses data that
    // won't survive a write. Renderers (SVG, OCAD synth) gate on
    // color validity themselves, so they still won't paint anything.
    // Emit `point-fill` whenever the source has a `<point_symbol>` so
    // an explicit `inner_radius="0"` (butlers-bush 110 etc) reaches the
    // writer as radius=0 rather than being dropped and defaulted to
    // Mapper's gizmo radius on output. Renderers gate on color validity
    // (invisible when innerColor=-1) so this doesn't cause spurious
    // painting.
    symbol.pointSymbol && {
      type: 'point-fill',
      colorId: symbol.pointSymbol.innerColor,
      radius: symbol.pointSymbol.innerRadius,
    },
    symbol.pointSymbol &&
      symbol.pointSymbol.outerWidth > 0 && {
        type: 'point-stroke',
        colorId: symbol.pointSymbol.outerColor,
        width: symbol.pointSymbol.outerWidth,
        radius: symbol.pointSymbol.innerRadius,
      },
    symbol.pointSymbol &&
      symbol.pointSymbol.elements &&
      symbol.pointSymbol.elements.length > 0 && {
        type: 'point-elements',
        elements: symbol.pointSymbol.elements,
      },
    symbol.textSymbol && {
      type: 'text',
      colorId: symbol.textSymbol.color,
      // Legacy top-level fields kept for back-compat with existing renderers.
      fontFamily: symbol.textSymbol.fontFamily,
      fontSize: symbol.textSymbol.fontSize,
      text: {
        fontFamily: symbol.textSymbol.fontFamily,
        fontSize: symbol.textSymbol.fontSize,
        fontWeight: symbol.textSymbol.bold ? 700 : 400,
        italic: symbol.textSymbol.italic ?? false,
        lineSpace: symbol.textSymbol.lineSpacing,
        paraSpace: symbol.textSymbol.paragraphSpacing,
        charSpace: symbol.textSymbol.characterSpacing,
        // Paragraph tab stops — OMap XMap serialises as
        // `<tabs count="N"><tab>V</tab>…</tabs>` (decoded on the raw
        // omap symbol at `decode.ts`); OCD reader populates the same
        // array from `nTabs`+`tabs[]`. Surface here so both source
        // formats reach the canonical `layer.text.tabs` slot.
        tabs: (symbol.textSymbol as { tabs?: number[] }).tabs,
        // Canonical `lineBelow` — Mapper's XMap emits `<line_below>`
        // as a child of `<text_symbol>` when the user has enabled it;
        // OCAD reader populates the same shape from `lb*` fields.
        // Presence in xmap implies `visible: true` (Mapper writes it
        // conditional on the flag).
        lineBelow: (
          symbol.textSymbol as {
            lineBelow?: {
              color?: number
              width?: number
              distance?: number
            }
          }
        ).lineBelow
          ? {
              visible: true,
              color: (symbol.textSymbol as { lineBelow: { color?: number } })
                .lineBelow.color,
              width: (symbol.textSymbol as { lineBelow: { width?: number } })
                .lineBelow.width,
              distance: (
                symbol.textSymbol as { lineBelow: { distance?: number } }
              ).lineBelow.distance,
            }
          : undefined,
      },
    },
  ].filter(Boolean) as RenderLayer[]
}

function toMapObject(
  object: OmapObject,
  index: number,
  symbolsById: Record<number, OmapSymbol>,
  partId?: string,
) {
  const symbol = symbolsById[object.symbol]
  const coordinates = mapCoords(object.coords)

  return {
    ...object,
    id: index + 1,
    partId,
    symbolId: object.symbol,
    type: objectTypeName(object, symbol, symbolsById),
    coordinates,
    text: object.text || undefined,
    rotation: object.rotation || 0,
    hidden: false,
    bounds: getBounds(coordinates, object),
    // Surface xmap-only object extras on the MapObject so the
    // writer no longer needs to peek into `native.xmap.raw` for them.
    hAlign: object.hAlign,
    vAlign: object.vAlign,
    textBox: object.textBox ?? undefined,
    pattern: object.pattern,
  }
}

// Attach the raw XMap flag byte as `omapFlags` on each coord, then
// let `normaliseOmapFlags` (map/coord.ts) translate the positional
// semantics into OCAD-style xFlags / yFlags in one pass. Keeping
// the raw value around lets xmap writers round-trip losslessly.
function mapCoords(coords: OmapCoord[]) {
  const out: TdPolyLike[] = []
  for (const c of coords) {
    const mapCoord = TdPoly.fromCoords(c.x, c.y) as TdPolyLike
    Object.defineProperty(mapCoord, 'omapFlags', {
      value: c.flags || 0,
      enumerable: true,
    })
    out.push(mapCoord)
  }
  normaliseOmapFlags(out as unknown as FlaggedCoord[])
  return out
}

type TdPolyLike = InstanceType<typeof TdPoly> & { omapFlags?: number }

function symbolTypeName(symbol: OmapSymbol): string {
  if (symbol.textSymbol) return 'text'
  if (symbol.pointSymbol) return 'point'
  if (symbol.areaSymbol) return 'area'
  if (symbol.lineSymbol) return 'line'
  if (symbol.combinedSymbol) return 'combined'
  return 'unknown'
}

function objectTypeName(
  object: OmapObject,
  symbol: OmapSymbol | undefined,
  symbolsById?: Record<number, OmapSymbol>,
): string {
  if (object.type === 0) return 'point'
  if (object.type === 4) return 'text'
  if (symbol && hasAreaVariant(symbol, symbolsById)) return 'area'
  if (symbol && symbol.pointSymbol) return 'point'
  return 'line'
}

/**
 * Recursively check whether a symbol behaves as a line symbol — either
 * a plain `<line_symbol>` or a `<combined_symbol>` whose every part is
 * itself effectively a line. Used to detect Mapper's "area + border
 * line" combined idiom vs "area combined with mixed content".
 */
function isEffectivelyLine(
  symbol: OmapSymbol,
  symbolsById: Record<number, OmapSymbol>,
  seen = new Set<number>(),
): boolean {
  if (!symbol) return false
  if (seen.has(symbol.id)) return false
  seen.add(symbol.id)
  if (symbol.areaSymbol || symbol.pointSymbol || symbol.textSymbol) return false
  if (symbol.lineSymbol) return true
  if (!symbol.combinedSymbol?.parts?.length) return false
  return symbol.combinedSymbol.parts.every(part => {
    const child =
      part.symbol ??
      (part.symbolRef !== undefined ? symbolsById[part.symbolRef] : undefined)
    return child ? isEffectivelyLine(child, symbolsById, seen) : false
  })
}

function hasAreaVariant(
  symbol: OmapSymbol,
  symbolsById?: Record<number, OmapSymbol>,
): boolean {
  if (symbol.areaSymbol) return true
  if (!symbol.combinedSymbol?.parts) return false
  return symbol.combinedSymbol.parts.some(part => {
    const s =
      part.symbol ??
      (symbolsById && part.symbolRef !== undefined
        ? symbolsById[part.symbolRef]
        : null)
    return s ? hasAreaVariant(s, symbolsById) : false
  })
}

/** Bounds including the object's textBox extent if present. */
function getBounds(
  coordinates: ArrayLike<number>[],
  object: { textBox?: { width: number; height: number } | null },
) {
  const base = boundsForCoords(coordinates)
  if (!base) return null
  if (object.textBox) {
    base.max[0] = Math.max(base.max[0], base.min[0] + object.textBox.width)
    base.max[1] = Math.max(base.max[1], base.min[1] + object.textBox.height)
  }
  return base
}

export default omapFileToMap
