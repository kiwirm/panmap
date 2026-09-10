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
} from '../../../panmap/model.js'
import TdPoly from '../../ocad/reader/decode/td-poly.js'
import { parseNotes } from '../../extensions.js'
import { boundsForCoords, type FlaggedCoord } from '../../../panmap/coord.js'
import { normaliseOmapFlags } from '../codecs/index.js'
import type {
  OmapColor,
  OmapCoord,
  OmapFile,
  OmapObject,
  OmapSymbol,
} from '../native.js'

/**
 * Converts a parsed OpenOrienteering Mapper XMap/OMap document into the
 * Panmap model.
 */
function omapFileToMap(xmapFile: OmapFile): Panmap {
  const symbolsById = xmapFile.symbols.reduce((symbols, symbol) => {
    symbols[symbol.id] = symbol
    return symbols
  }, {})

  const notesText = extractNotesText(xmapFile.extras?.notes)
  const { userText, extensions } = parseNotes(notesText)
  const view = extractView(xmapFile.extras?.view)
  const print = extractPrint(xmapFile.extras?.print)
  const templates = extractTemplates(xmapFile.extras?.templates)
  const georeferencing = extractGeoreferencing(xmapFile.extras?.georeferencing)

  return new Panmap({
    sourceFormat: 'xmap',
    sourceFile: xmapFile,
    metadata: {},
    colors: xmapFile.colors.map(toMapColor),
    symbols: xmapFile.symbols.map(symbol => toMapSymbol(symbol, symbolsById)),
    objects: xmapFile.objects.map((object, index) =>
      toMapObject(object, index, symbolsById)
    ),
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
    if (orientation === 'portrait' || orientation === 'landscape') fmt.orientation = orientation
    if (hOverlap !== undefined) fmt.hOverlap = hOverlap
    if (vOverlap !== undefined) fmt.vOverlap = vOverlap
    if (dims) {
      const w = numberAttr(dims['@_width'])
      const h = numberAttr(dims['@_height'])
      if (w !== undefined && h !== undefined) fmt.dimensions = { width: w, height: h }
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
  const items = ensureArray(r.template).map(extractTemplate).filter((t): t is MapTemplate => !!t)
  const firstFront = numberAttr(r['@_first_front_template'])
  const defaultsRaw = r.defaults as Record<string, unknown> | undefined
  const templates: MapTemplates = { items }
  if (firstFront !== undefined) templates.firstFrontTemplate = firstFront
  if (defaultsRaw) {
    const defaults: NonNullable<MapTemplates['defaults']> = {}
    const use = defaultsRaw['@_use_meters_per_pixel']
    if (use === 'true' || use === 'false') defaults.useMetersPerPixel = use === 'true'
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

function extractTransformations(raw: unknown): MapTemplateTransformations | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: MapTemplateTransformations = {}
  const dirty = r['@_adjustment_dirty']
  if (dirty === 'true' || dirty === 'false') out.adjustmentDirty = dirty === 'true'
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
  if (typeof param === 'string' || typeof param === 'number') out.parameter = String(param)
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

function extractCrsSpec(raw: unknown): { language: string; value: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const language = r['@_language']
  const value = r['#text']
  if (typeof language !== 'string' || typeof value !== 'string') return undefined
  return { language, value }
}

function pointFromAttrs(r: Record<string, unknown>): { x: number; y: number } | undefined {
  const x = numberAttr(r['@_x'])
  const y = numberAttr(r['@_y'])
  if (x === undefined || y === undefined) return undefined
  return { x, y }
}

function rectFromAttrs(r: Record<string, unknown>):
  { left: number; top: number; width: number; height: number } | undefined {
  const left = numberAttr(r['@_left'])
  const top = numberAttr(r['@_top'])
  const width = numberAttr(r['@_width'])
  const height = numberAttr(r['@_height'])
  if (left === undefined || top === undefined || width === undefined || height === undefined)
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

function toMapColor(color: OmapColor) {
  // xmap/read.ts already normalises RGB into 0–255 bytes via
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

function toMapSymbol(symbol: OmapSymbol, symbolsById: Record<number, OmapSymbol>) {
  // Rotatable is an outer-element attribute in xmap (`<point_symbol
  // rotatable="true">` / `<text_symbol rotatable="true">`) but doesn't
  // survive the render-layer flatten cleanly — expose it as a top-level
  // Panmap field so `isRotatable` in synth doesn't need to walk
  // `native.xmap.raw`.
  const rotatable = !!(
    symbol.pointSymbol?.rotatable
    || symbol.textSymbol?.rotatable
    // Area symbols can be rotatable when any of their patterns are —
    // the OCAD flags-bit is set if *any* pattern rotates. Layers still
    // carry per-pattern `rotatable` for finer-grained rendering; the
    // top-level flag is purely for the OCAD flag byte.
    || symbol.areaSymbol?.patterns?.some(p => !!p.rotatable)
  )
  return {
    id: symbol.id,
    sourceId: symbol.id,
    code: symbol.code,
    name: symbol.name,
    type: symbolTypeName(symbol),
    hidden: !!symbol.isHidden,
    rotatable,
    fontSize: symbol.textSymbol && symbol.textSymbol.fontSize,
    layers: symbolToRenderLayers(symbol, symbolsById),
  }
}

/**
 * @param {OmapSymbol} symbol
 * @returns {import('../../../panmap/map').RenderLayer[]}
 */
function symbolToRenderLayers(
  symbol: OmapSymbol,
  symbolsById: Record<number, OmapSymbol>,
  seen = new Set<number>()
): RenderLayer[] {
  if (seen.has(symbol.id)) return []
  seen.add(symbol.id)

  if (symbol.combinedSymbol?.parts?.length) {
    // Special case — "area + line-ref" combined: the OCAD-style
    // "area with border" idiom. Reconstruct a `border-symbol` render
    // layer instead of flattening the border line's strokes into the
    // area, so ocd → xmap → ocd preserves `borderSym` losslessly.
    const parts = symbol.combinedSymbol.parts
    if (parts.length === 2) {
      const [a, b] = parts
      const aSym = a.symbol
      // Treat as OCAD's "area with borderSym" idiom when the referenced
      // part is line-shaped — either a plain line symbol OR a combined
      // symbol whose parts are all lines (e.g. Mapper's own idiom for
      // a "solid outline" that internally splits main-line + border-
      // line). Refs that contain an area part (like 521.2 → canopy
      // combined) don't map to a borderSym slot; Mapper emits them
      // as a plain area, so we do too. Refs to plain areas drop as well.
      const refSym = b.symbolRef !== undefined ? symbolsById[b.symbolRef] : undefined
      const refIsLine = refSym ? isEffectivelyLine(refSym, symbolsById) : false
      if (
        aSym?.areaSymbol
        && !aSym.lineSymbol
        && !aSym.pointSymbol
        && !aSym.textSymbol
        && b.symbolRef !== undefined
        && !b.symbol
      ) {
        const areaLayers = symbolToRenderLayers(aSym, symbolsById, seen)
        if (refIsLine) {
          // Line ref → OCAD borderSym reference. Preserves visually.
          return [
            ...areaLayers,
            { type: 'border-symbol', symbolId: b.symbolRef } as RenderLayer,
          ]
        }
        // Non-line ref (referenced symbol is area or combined) — Mapper
        // emits these to OCD as a plain area, dropping the ref. Match
        // that so the round-trip doesn't pick up phantom fills / lines
        // from the nested tree.
        return areaLayers
      }
    }
    return parts.flatMap(part => {
      const partSymbol = part.symbol
        || (part.symbolRef !== undefined ? symbolsById[part.symbolRef] : undefined)
      return partSymbol ? symbolToRenderLayers(partSymbol, symbolsById, seen) : []
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
          }
        : undefined,
      // Persist join / cap so OCAD's `lineStyle` byte can be
      // recovered. xmap encoding: join_style 0=miter, 1=round, 2=bevel;
      // cap_style 0=flat, 1=round, 2=square. OCAD `lineStyle` packs
      // them into one byte: bit 0 = round join, bit 2 = round cap.
      joinStyle: (symbol.lineSymbol as { joinStyle?: number }).joinStyle,
      capStyle: (symbol.lineSymbol as { capStyle?: number }).capStyle,
      // Dash bookkeeping used to compute OCAD's `mainLength`,
      // `endLength`, and `nPrimSym` — even non-dashed lines carry a
      // `segment_length` used for mid-symbol placement.
      segmentLength: (symbol.lineSymbol as { segmentLength?: number }).segmentLength,
      endLength: (symbol.lineSymbol as { endLength?: number }).endLength,
      midSymbolsPerSpot: (symbol.lineSymbol as { midSymbolsPerSpot?: number }).midSymbolsPerSpot,
      midSymbolDistance: (symbol.lineSymbol as { midSymbolDistance?: number }).midSymbolDistance,
      minimumMidSymbolCount: (symbol.lineSymbol as { minimumMidSymbolCount?: number }).minimumMidSymbolCount,
      showAtLeastOneSymbol: (symbol.lineSymbol as { showAtLeastOneSymbol?: boolean }).showAtLeastOneSymbol,
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
        ? symbol.lineSymbol.borders.map((b: {
            color: number; width: number; shift: number;
            dashed?: boolean; dashLength?: number; breakLength?: number;
          }) => ({
            color: b.color,
            width: b.width,
            shift: b.shift,
            dashed: b.dashed,
            dashLength: b.dashLength,
            breakLength: b.breakLength,
          }))
        : undefined,
    },
    symbol.lineSymbol &&
      (symbol.lineSymbol.dashSymbol ||
        symbol.lineSymbol.midSymbol ||
        symbol.lineSymbol.startSymbol ||
        symbol.lineSymbol.endSymbol) && {
        type: 'line-symbols',
        lineSymbol: symbol.lineSymbol,
      },
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
              pattern.color >= 0
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
          }))
      : []),
    ...(symbol.areaSymbol && symbol.areaSymbol.patterns
      ? symbol.areaSymbol.patterns
          .filter(pattern => pattern.type !== 1 && pattern.symbol)
          .map(pattern => ({
            type: 'point-pattern-fill',
            colorId:
              pattern.symbol?.pointSymbol?.innerColor ??
              pattern.symbol?.areaSymbol?.innerColor ??
              pattern.symbol?.lineSymbol?.color,
            width: Math.max(pattern.pointDistance || pattern.lineSpacing || 1, 1),
            height: Math.max(pattern.pointDistance || pattern.lineSpacing || 1, 1),
            angle: pattern.angle ? (pattern.angle * 180) / Math.PI : 0,
            pattern,
          }))
      : []),
    // Preserve inner disc / outer ring even when the color is
    // "invisible" (-1) as long as a real radius or width was set —
    // xmap uses these zero-visibility structs to encode hit-box radii
    // and structural markers, and dropping them here loses data that
    // won't survive a write. Renderers (SVG, OCAD synth) gate on
    // color validity themselves, so they still won't paint anything.
    symbol.pointSymbol &&
      symbol.pointSymbol.innerRadius > 0 && {
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
      },
    },
  ].filter(Boolean) as RenderLayer[]
}

function toMapObject(
  object: OmapObject,
  index: number,
  symbolsById: Record<number, OmapSymbol>
) {
  const symbol = symbolsById[object.symbol]
  const coordinates = mapCoords(object.coords)

  return {
    ...object,
    id: index + 1,
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

function symbolTypeName(symbol) {
  if (symbol.textSymbol) return 'text'
  if (symbol.pointSymbol) return 'point'
  if (symbol.areaSymbol) return 'area'
  if (symbol.lineSymbol) return 'line'
  if (symbol.combinedSymbol) return 'combined'
  return 'unknown'
}

function objectTypeName(object, symbol, symbolsById?: Record<number, unknown>) {
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
    const child = part.symbol ?? (part.symbolRef !== undefined ? symbolsById[part.symbolRef] : undefined)
    return child ? isEffectivelyLine(child, symbolsById, seen) : false
  })
}

function hasAreaVariant(symbol, symbolsById?: Record<number, unknown>): boolean {
  if (symbol.areaSymbol) return true
  if (!symbol.combinedSymbol?.parts) return false
  return symbol.combinedSymbol.parts.some(part => {
    const s = part.symbol ?? (symbolsById && part.symbolRef !== undefined ? symbolsById[part.symbolRef] : null)
    return s ? hasAreaVariant(s, symbolsById) : false
  })
}

/** Bounds including the object's textBox extent if present. */
function getBounds(coordinates: ArrayLike<number>[], object: { textBox?: { width: number; height: number } | null }) {
  const base = boundsForCoords(coordinates)
  if (!base) return null
  if (object.textBox) {
    base.max[0] = Math.max(base.max[0], base.min[0] + object.textBox.width)
    base.max[1] = Math.max(base.max[1], base.min[1] + object.textBox.height)
  }
  return base
}

export default omapFileToMap
