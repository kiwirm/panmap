/**
 * Canonical Map model.
 *
 * Designed as a superset of the three native formats (ocad, xmap, gitmap)
 * so converting between them is lossless. All content-carrying state has
 * Panmap fields (`view`, `print`, `templates`, `georeferencing`,
 * `extensions`, `notes`) and both OCAD and xmap readers/writers use
 * those fields directly. There is no format-specific escape hatch: if a
 * new xmap/ocad element matters, model it here.
 */

import { crsFromCanonical, type CrsView } from './crs.js'

/**
 * A single template map/image referenced by the main map. Templates
 * are background layers (raster/vector images or another map file)
 * displayed under the map for tracing. The `path`/`relpath` pair
 * points at the source file; the transformation matrix + `active`
 * transform position it on the paper.
 *
 * Fields mirror the xmap `<template>` element. OCAD stores templates
 * in parameter string 8 (not currently modelled end-to-end); the
 * Panmap shape is broad enough to hold both.
 */
export interface MapTemplate {
  type?: string
  open?: boolean
  name?: string
  path?: string
  relpath?: string
  transformations?: MapTemplateTransformations
}

export interface MapTemplateTransform {
  x?: number
  y?: number
  scaleX?: number
  scaleY?: number
  rotation?: number
}

export interface MapTemplateTransformations {
  adjustmentDirty?: boolean
  passpoints?: number
  active?: MapTemplateTransform
  other?: MapTemplateTransform
  /** Flat 3x3 row-major matrix; empty array = no matrix present. */
  mapToTemplate?: number[]
  templateToMap?: number[]
  templateToMapOther?: number[]
}

export interface MapTemplates {
  firstFrontTemplate?: number
  defaults?: {
    useMetersPerPixel?: boolean
    metersPerPixel?: number
    dpi?: number
    scale?: number
  }
  items: MapTemplate[]
}

/**
 * Coordinate reference system + real-world anchor for the map. Mirrors
 * xmap `<georeferencing>` — a top-level scale/declination block plus
 * (optionally) projected and geographic CRS descriptions.
 *
 * `scale` is the map scale denominator (1:scale). `declination` is the
 * magnetic declination in degrees; `grivation` is the meridian
 * convergence (grid-vs-true north). `refPoint` at the top level is
 * the paper-plane anchor in mm; per-CRS ref points are in that CRS's
 * native units (metres for projected EPSG codes, degrees for
 * geographic).
 *
 * OCAD stores similar data in parameter string 1039 (partially) and
 * a full-CRS record which panmap doesn't read/write yet — `MapCrs`
 * captures xmap semantics as the source of truth for now.
 */
export interface MapCrs {
  scale?: number
  auxiliaryScaleFactor?: number
  gridScaleFactor?: number
  declination?: number
  grivation?: number
  refPoint?: { x: number; y: number }
  projected?: MapCrsProjected
  geographic?: MapCrsGeographic
}

export interface MapCrsProjected {
  id: string
  spec?: { language: string; value: string }
  parameter?: string
  refPoint?: { x: number; y: number }
}

export interface MapCrsGeographic {
  id: string
  spec?: { language: string; value: string }
  refPointDeg?: { lat: number; lon: number }
}

export interface MapColor {
  id: number | string
  sourceId: number | string
  name: string
  rgb: string
  renderOrder: number
  /** CMYK components in [0, 1]. OCAD and XMap both store color in CMYK natively. */
  cmyk?: [number, number, number, number]
  /** Opacity in [0, 1]. */
  opacity?: number
  sourceColor?: unknown
}

export interface TextTypography {
  fontFamily?: string
  /** Font size in map units (mm). */
  fontSize?: number
  /** 400 = regular, 700 = bold. */
  fontWeight?: number
  italic?: boolean
  charSpace?: number
  wordSpace?: number
  /** Line spacing as a multiplier (1 = single-spaced). */
  lineSpace?: number
  /** 0 = left, 1 = center, 2 = right, 3 = justify. */
  alignment?: number
  /** 0 = bottom, 1 = middle, 2 = top. */
  verticalAlignment?: number
  paraSpace?: number
  indentFirst?: number
  indentOther?: number
}

/**
 * Common fields carried by every render-layer variant. Individual
 * layer types (defined in `./render-layers.ts`) extend this with
 * their own required / typed fields; the `[key: string]: unknown`
 * index signature lets format-specific extras stash themselves per
 * layer without changing the Panmap schema.
 */
export interface BaseRenderLayer {
  type: string
  colorId?: number | string
  symbolId?: number | string
  width?: number
  height?: number
  radius?: number
  /** Fallback font family for text layers; the `text` sub-object holds full typography. */
  fontFamily?: string
  /** Fallback font size for text layers; the `text` sub-object holds full typography. */
  fontSize?: number
  angle?: number
  spacing?: number
  lineWidth?: number
  opacity?: number
  elements?: unknown[]
  /** Whether this layer's decorations rotate with the parent object.
   *  Set by pattern layers (xmap `<pattern rotatable="true">`) and
   *  some sub-symbol shapes; walked by rotatability inference. */
  rotatable?: boolean
  /** Full typography for `type === "text"` layers. */
  text?: TextTypography
  [key: string]: unknown
}

/**
 * Canonical render layer — discriminated union over the known layer
 * types (fill / stroke / hatch-fill / structure-fill /
 * point-pattern-fill / border-symbol / double-line / line-elements /
 * line-symbols / point-fill / point-stroke / point-elements / text)
 * plus a catch-all for future/unknown types. Callers that
 * `switch (layer.type)` on a known value narrow to the typed
 * subtype; everything else keeps the permissive base.
 */
export type RenderLayer = import('./render-layers.js').RenderLayer

export interface MapSymbol {
  id: number | string
  sourceId: number | string
  code?: string
  name?: string
  type: string
  hidden: boolean
  /** Whether the symbol rotates with its object (OCAD flags bit 0; xmap `<point_symbol rotatable="true">` / `<text_symbol rotatable="true">` / any pattern with `rotatable="true"` on an area). */
  rotatable?: boolean
  fontSize?: number
  /** Format-native text-symbol payload (OCAD TextSymbol11 / XMap
   *  text_symbol). Only the fields consumed cross-format are typed
   *  here; format-specific extras fall through. */
  textSymbol?: { rotatable?: boolean }
  layers: RenderLayer[]
}

export interface MapObject {
  id: number | string
  symbolId: number | string
  type: string
  coordinates?: import('./coord.js').Coord[]
  text?: string
  rotation?: number
  hidden: boolean
  bounds?: unknown
  /** Text-object horizontal alignment override (xmap `h_align`). */
  hAlign?: number
  /** Text-object vertical alignment override (xmap `v_align`). */
  vAlign?: number
  /** Text-object bounding box in map units (xmap `<size>` element). */
  textBox?: { width: number; height: number }
  /** Area-pattern override placed on an individual object (xmap `<pattern>`). */
  pattern?: { rotation?: number; origin?: { x: number; y: number } }
  /** Per-object linked string used by course-setting / control description tools. */
  tag?: string
  /** Semantic type of `tag` (0=none, 1=course-setting, 4=db-link, etc.). */
  tagType?: number
}

/**
 * Persisted viewport state. Sits alongside the map bytes so opening a
 * file in a viewer/editor lands on the same view the author last saved.
 *
 * Coordinates are in mm on the paper plane, using OCAD's y-up frame
 * (xmap-sourced files convert y on read/write). `zoom` is a multiplier
 * where ~1.0 ≈ 100% (matches OCAD's 1030 `z` field; xmap's `map_view
 * zoom` uses the same magnitude, verified against Mapper-authored
 * fixtures). `rotation` is in radians, counter-clockwise.
 *
 * Grid and per-part display flags (xmap `<grid>` / `<map_view>` child
 * elements, OCAD's 1030 v/m/t/b/c/h/d fields) are not modelled
 * yet — they're not carried through cross-format conversion.
 */
export interface MapView {
  center?: { x: number; y: number }
  zoom?: number
  rotation?: number
}

/**
 * Persisted print/export settings — page format, resolution, and the
 * print area on paper. Values match xmap `<print>` semantics: `scale`
 * is the map scale denominator; `resolution` is DPI; `mode` is
 * "vector" | "raster" (Mapper's enum); rects are in mm on the paper
 * plane using OCAD's y-up frame.
 *
 * OCAD stores similar data in parameter strings 1031 and neighbours;
 * panmap doesn't read/write those yet, so ocad→xmap→ocad currently
 * loses the print settings for OCAD-sourced maps.
 */
export interface MapPrint {
  scale?: number
  resolution?: number
  mode?: string
  pageFormat?: {
    paperSize?: string
    orientation?: 'portrait' | 'landscape'
    hOverlap?: number
    vOverlap?: number
    dimensions?: { width: number; height: number }
    pageRect?: { left: number; top: number; width: number; height: number }
  }
  printArea?: { left: number; top: number; width: number; height: number }
}

export interface MapOptions {
  sourceFormat: string
  sourceFile?: unknown
  metadata?: Record<string, unknown>
  colors?: MapColor[]
  symbols?: MapSymbol[]
  objects?: MapObject[]
  warnings?: Array<string | Error>
  view?: MapView
  print?: MapPrint
  templates?: MapTemplates
  georeferencing?: MapCrs
  /** Arbitrary key/value metadata; see gitmap/extensions.md. */
  extensions?: Record<string, unknown>
  /** User-authored free text from the source format's map-notes field. */
  notes?: string
}

type Projection = (coord: number[]) => number[]
const identity: Projection = v => v

/**
 * Canonical, source-independent map representation used by converters.
 *
 * Source-specific parsers normalize into this class. All content is
 * modelled with Panmap fields (`view`, `print`, `templates`,
 * `georeferencing`, `extensions`, `notes`) — there is no format-specific
 * escape hatch. A new xmap/ocad element that matters gets modelled here.
 */
export default class Panmap {
  sourceFormat: string
  sourceFile?: unknown
  metadata: Record<string, unknown>
  colors: MapColor[]
  symbols: MapSymbol[]
  objects: MapObject[]
  warnings: Array<string | Error>
  /** Persisted viewport state (centre, zoom, rotation). See `MapView`. */
  view?: MapView
  /** Persisted print/export settings. See `MapPrint`. */
  print?: MapPrint
  /** Background template maps/images. See `MapTemplates`. */
  templates?: MapTemplates
  /** CRS + real-world anchor for the map. See `MapCrs`. */
  georeferencing?: MapCrs
  /** Arbitrary key/value metadata; see gitmap/extensions.md. */
  extensions: Record<string, unknown>
  /** User-authored free text from the source format's map-notes field. */
  notes: string

  constructor(options: MapOptions) {
    this.sourceFormat = options.sourceFormat
    this.sourceFile = options.sourceFile
    this.metadata = options.metadata ?? {}
    this.colors = options.colors ?? []
    this.symbols = options.symbols ?? []
    this.objects = options.objects ?? []
    this.warnings = options.warnings ?? []
    this.view = options.view
    this.print = options.print
    this.templates = options.templates
    this.georeferencing = options.georeferencing
    this.extensions = options.extensions ?? {}
    this.notes = options.notes ?? ''
  }

  /**
   * Coord-transformation view over `georeferencing`. Returns a `Crs`
   * with `easting`/`northing`/`scale`/`grivation` fields plus
   * `toProjectedCoord` / `toMapCoord` methods that translate between
   * map units (0.01 mm) and the projected CRS (metres for EPSG codes).
   * Returns `null` when the map has no georeferencing set.
   */
  getCrs(): CrsView | null {
    const g = this.georeferencing
    if (!g) return null
    const epsg = Number(g.projected?.parameter)
    return crsFromCanonical({
      easting: g.projected?.refPoint?.x ?? 0,
      northing: g.projected?.refPoint?.y ?? 0,
      scale: g.scale ?? 15000,
      grivation: g.grivation ?? 0,
      epsg: Number.isFinite(epsg) ? epsg : undefined,
    })
  }

  getBounds(projection: Projection = identity): [number, number, number, number] {
    const bounds: [number, number, number, number] = [
      Number.MAX_VALUE,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      -Number.MAX_VALUE,
    ]

    for (const object of this.objects) {
      const rect = getObjectRect(object)
      if (!rect) continue
      const [[x1, y1], [x2, y2]] = rect.map(projection)
      bounds[0] = Math.min(x1, x2, bounds[0])
      bounds[1] = Math.min(y1, y2, bounds[1])
      bounds[2] = Math.max(x1, x2, bounds[2])
      bounds[3] = Math.max(y1, y2, bounds[3])
    }

    if (bounds[0] === Number.MAX_VALUE) {
      for (const object of this.objects) {
        for (const coord of getObjectCoordinates(object)) {
          const [x, y] = projection(coord)
          bounds[0] = Math.min(x, bounds[0])
          bounds[1] = Math.min(y, bounds[1])
          bounds[2] = Math.max(x, bounds[2])
          bounds[3] = Math.max(y, bounds[3])
        }
      }
    }

    if (bounds[0] === Number.MAX_VALUE) return [0, 0, 100, 100]
    return bounds
  }
}

function getObjectRect(object: MapObject): [number[], number[]] | null {
  const source = object.bounds
  if (!source) return null
  const corners = Object.values(source as Record<string, number[]>)
  if (corners.length < 2) return null
  return [corners[0], corners[1]]
}

function getObjectCoordinates(object: MapObject): number[][] {
  const out: number[][] = []
  for (const coord of (object.coordinates ?? []) as unknown[]) {
    const pair = toXY(coord)
    if (pair) out.push(pair)
  }
  return out
}

function toXY(coord: unknown): number[] | null {
  if (Array.isArray(coord) && coord.length >= 2) {
    const x = Number(coord[0])
    const y = Number(coord[1])
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  }
  if (coord && typeof coord === 'object' && 'x' in coord && 'y' in coord) {
    const x = Number(coord.x)
    const y = Number(coord.y)
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  }
  return null
}
