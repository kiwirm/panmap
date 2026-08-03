import PanMap, {
  type MapColor,
  type MapCrs,
  type MapObject,
  type MapSymbol,
  type MapView,
  type RenderLayer,
} from '../../map/model.js'
import crsGrids from './internal/crs-grids.js'
import type OcadFile from './internal/ocad-file.js'
import type BaseSymbol from './internal/symbol.js'
import type { PointSymbolDef } from './internal/point-symbol.js'
import type { LineSymbolDef } from './internal/line-symbol.js'
import type { AreaSymbolDef } from './internal/area-symbol.js'
import type { TextSymbolDef } from './internal/text-symbol.js'
import type { TObject } from './internal/tobject.js'
import {
  PointSymbolType,
  LineSymbolType,
  AreaSymbolType,
  TextSymbolType,
} from './internal/symbol-types.js'
import { parseNotes } from '../extensions.js'
import { OCAD_NOTES_RECTYPE } from './notes.js'
import { ocadSymbolTypeName, ocadObjectTypeName } from './symbol-codec.js'

import { decodeLineStyle } from '../../util/line-style-codec.js'

/**
 * Convert the low-level OCAD file representation into the PanMap.
 *
 * PanMap is a lossy target — only cross-format fields are carried through.
 * OCAD-only fields (icon rasters, tree groups, framing, tab stops,
 * structure-fill geometry) do not survive a trip through PanMap.
 */
export default function ocadFileToMap(ocadFile: OcadFile): PanMap {
  const notesEntry = ocadFile.parameterStrings[OCAD_NOTES_RECTYPE]?.[0]
  const notesText = typeof notesEntry?._first === 'string' ? notesEntry._first : ''
  const { userText, extensions } = parseNotes(notesText)
  const view = extractView(ocadFile)
  const georeferencing = extractGeoreferencing(ocadFile)

  return new PanMap({
    sourceFormat: 'ocad',
    sourceFile: ocadFile,
    metadata: {
      version: ocadFile.header.version,
      subVersion: ocadFile.header.subVersion,
      subSubVersion: ocadFile.header.subSubVersion,
      currentFileVersion: ocadFile.header.currentFileVersion,
      parameterStrings: ocadFile.parameterStrings,
    },
    colors: toMapColors(ocadFile),
    symbols: ocadFile.symbols.map(toMapSymbol),
    objects: (ocadFile.objects as unknown as TObject[]).map(toMapObject),
    warnings: ocadFile.warnings,
    view,
    georeferencing,
    extensions,
    notes: userText,
  })
}

function toMapColors(ocadFile: OcadFile): MapColor[] {
  // Pull PanMap color fields from parameter strings directly so we get
  // opacity alongside CMYK — OcadFile.Color doesn't store opacity.
  const psByNumber: Record<number, Record<string, string>> = {}
  for (const ps of ocadFile.parameterStrings[9] || []) {
    const num = Number(ps.n)
    if (Number.isFinite(num)) psByNumber[num] = ps as Record<string, string>
  }

  const colors: MapColor[] = []
  // ocadFile.colors is sparse — indexed by color.number — so forEach is required.
  ocadFile.colors.forEach(color => {
    const ps = psByNumber[color.number]
    // OCAD stores CMYK as 0–100; PanMap model uses 0–1.
    const rawCmyk = color.cmyk
    const cmyk: [number, number, number, number] | undefined = rawCmyk
      ? [rawCmyk[0] / 100, rawCmyk[1] / 100, rawCmyk[2] / 100, rawCmyk[3] / 100]
      : undefined
    const opacityRaw = ps?.o
    const opacityNum = opacityRaw !== undefined ? Number(opacityRaw) : NaN
    const opacity = Number.isFinite(opacityNum) ? opacityNum : undefined
    colors[color.number] = {
      id: color.number,
      sourceId: color.number,
      name: color.name,
      rgb: color.rgb,
      cmyk,
      opacity,
      renderOrder: color.renderOrder,
      sourceColor: color,
    }
  })
  return colors
}

function toMapSymbol(symbol: BaseSymbol): MapSymbol {
  return {
    id: symbol.symNum,
    sourceId: symbol.symNum,
    code: symbol.number,
    name: symbol.description,
    type: ocadSymbolTypeName(symbol.type),
    hidden: symbol.isHidden(),
    // OCAD encodes rotatable as `flags & 1` on the raw symbol record;
    // hoist it onto the PanMap model so consumers don't need the raw.
    rotatable: (((symbol as { flags?: number }).flags ?? 0) & 1) !== 0,
    fontSize: (symbol as { fontSize?: number }).fontSize,
    renderLayers: symbolToRenderLayers(symbol),
  }
}

function symbolToRenderLayers(symbol: BaseSymbol): RenderLayer[] {
  switch (symbol.type) {
    case PointSymbolType: {
      const s = symbol as unknown as PointSymbolDef
      return s.elements?.length
        ? [{ type: 'point-elements', elements: s.elements }]
        : []
    }
    case LineSymbolType:
      return lineRenderLayers(symbol as unknown as LineSymbolDef)
    case AreaSymbolType:
      return areaRenderLayers(symbol as unknown as AreaSymbolDef)
    case TextSymbolType:
      return textRenderLayers(symbol as unknown as TextSymbolDef)
    default:
      return []
  }
}

function lineRenderLayers(s: LineSymbolDef): RenderLayer[] {
  const capJoin = decodeLineStyle(s.lineStyle)
  // Always emit a stroke layer for line symbols — even zero-width /
  // invisible ones — because OCAD's `lineStyle` byte (cap+join packed)
  // sits at the symbol level, not the per-stroke level, and other
  // metadata (mainLength/endLength, mid-symbol placement, offsets)
  // needs a carrier layer to survive the PanMap→xmap→PanMap trip.
  const layers: (RenderLayer | false | undefined)[] = [
    {
      type: 'stroke',
      // Zero-width lines are OCAD's "invisible main stroke" convention
      // (used to hang borders / mid-symbols off). Their `lineColor`
      // field is arbitrary in the OCD file (Mapper writes 0), but if we
      // pass it through as a real colorId it inflates the symbol's
      // color set. Force to -1 so downstream color counters skip it.
      colorId: s.lineWidth > 0 ? s.lineColor : -1,
      width: s.lineWidth,
      lineStyle: s.lineStyle,
      capStyle: capJoin.capStyle,
      joinStyle: capJoin.joinStyle,
      // mainLength / endLength on a non-dashed line control mid-symbol
      // placement in Mapper's rendering (segment_length attribute in
      // xmap). Preserving them here separately from `dash` lets the
      // adapter surface `segment_length` correctly for both dashed
      // and non-dashed lines that have mid-symbols.
      segmentLength: s.mainLength || undefined,
      endLength: s.endLength || undefined,
      // distFromStart / distToEnd = xmap `start_offset` / `end_offset`.
      // Preserving them lets ISOM 107 (erosion gully) etc. keep the
      // tapered-end appearance that Mapper's OCD encodes.
      startOffset: (s as { distFromStart?: number }).distFromStart || undefined,
      endOffset: (s as { distToEnd?: number }).distToEnd || undefined,
      // Mid-symbol placement fields — OCAD's `nPrimSym` / `primSymDist`
      // control how many mid-symbols per placement spot and how far
      // apart they are (double-tick fences, walls with two spikes).
      // Without these, ISOM 515 / 529 double-tick walls collapse to
      // a single-tick round-tripped rendering.
      midSymbolsPerSpot: (s as { nPrimSym?: number }).nPrimSym,
      midSymbolDistance: (s as { primSymDist?: number }).primSymDist,
      dash:
        s.mainGap || s.secGap
          ? {
              mainLength: s.mainLength,
              mainGap: s.mainGap,
              secGap: s.secGap,
              endLength: s.endLength,
              endGap: s.endGap,
            }
          : undefined,
    },
    hasLineElements(s) && {
      type: 'line-elements',
      mainLength: s.mainLength,
      endLength: s.endLength,
      primSymDist: s.primSymDist,
      nPrimSym: s.nPrimSym,
      primSymElements: s.primSymElements,
      cornerSymElements: s.cornerSymElements,
      startSymElements: s.startSymElements,
      endSymElements: s.endSymElements,
    },
    // OCAD "frame" fields (frColor / frWidth / frStyle) encode a wider
    // decoration stroke drawn under a dashed main line — used by
    // railways with a two-tone appearance (ara 509.1 dashed + wider
    // framing). XMap represents the same thing as a two-part combined
    // line symbol; surface as a PanMap stroke so the adapter emits
    // it and Mapper's OCD re-import re-attaches it as fr*.
    ((s as { frColor?: number; frWidth?: number }).frColor !== undefined
      && (s as { frWidth?: number }).frWidth !== undefined
      && (s as { frWidth?: number }).frWidth! > 0) && {
      type: 'stroke',
      colorId: (s as { frColor?: number }).frColor,
      width: (s as { frWidth?: number }).frWidth,
      lineStyle: (s as { frStyle?: number }).frStyle ?? 0,
      // Mark as the frame stroke so downstream synth can distinguish it
      // from a border-carrier stroke (both are "secondary" strokes).
      frame: true,
    },
    s.doubleLine?.dblMode ? {
      type: 'double-line',
      mode: s.doubleLine.dblMode,
      flags: s.doubleLine.dblFlags,
      fillColorId: s.doubleLine.dblFillColor,
      leftColorId: s.doubleLine.dblLeftColor,
      rightColorId: s.doubleLine.dblRightColor,
      centerWidth: s.doubleLine.dblWidth,
      leftWidth: s.doubleLine.dblLeftWidth,
      rightWidth: s.doubleLine.dblRightWidth,
      // Dashed borders (dblMode 2/3/4) carry the dash rhythm in
      // dblLength / dblGap. Preserve so extractBorders can put the
      // dash_length / break_length on each xmap `<border>`.
      dashLength: s.doubleLine.dblLength,
      breakLength: s.doubleLine.dblGap,
      lineStyle: s.lineStyle,
    } : undefined,
  ]
  return layers.filter(Boolean) as RenderLayer[]
}

function areaRenderLayers(s: AreaSymbolDef): RenderLayer[] {
  // OCAD packs area rotatability into the symbol's top-level `flags`
  // byte (bit 0). Xmap has no rotatable attribute on `<area_symbol>` —
  // it lives on each `<pattern rotatable="true">`. Propagate the bit
  // to every pattern layer so an ocd→xmap→ocd trip retains it.
  const areaRotatable = (((s as { flags?: number }).flags ?? 0) & 1) !== 0
  const layers: (RenderLayer | false | undefined | 0)[] = [
    s.fillOn && { type: 'fill', colorId: s.fillColor },
    s.hatchMode && {
      type: 'hatch-fill',
      colorId: s.hatchColor,
      spacing: s.hatchDist,
      lineWidth: s.hatchLineWidth,
      angle: s.hatchAngle1 / 10,
      rotatable: areaRotatable,
    },
    s.hatchMode === 2 && {
      type: 'hatch-fill',
      colorId: s.hatchColor,
      spacing: s.hatchDist,
      lineWidth: s.hatchLineWidth,
      angle: s.hatchAngle2 / 10,
      rotatable: areaRotatable,
    },
    s.structMode && {
      type: 'structure-fill',
      colorId: s.elements.length
        ? Math.min(...s.elements.map(e => e.color))
        : s.fillColor,
      width: s.structWidth,
      height: s.structHeight * (s.structMode === 2 ? 2 : 1),
      angle: s.structAngle / 10,
      mode: s.structMode,
      symbolWidth: s.structWidth,
      symbolHeight: s.structHeight,
      elements: s.elements,
      // OCAD structDraw byte packs clipping mode + rotate flag. The
      // low bits map to xmap `no_clipping` (0=clip, 1=don't clip if
      // fully inside, 2=don't clip if center inside). Preserve it so
      // the PanMap→xmap converter can round-trip clipping.
      noClipping: (s.structDraw ?? 0) & 0x03,
      structDraw: s.structDraw,
      rotatable: areaRotatable,
    },
    s.borderSym && { type: 'border-symbol', symbolId: s.borderSym },
  ]
  return layers.filter(Boolean) as RenderLayer[]
}

function textRenderLayers(s: TextSymbolDef): RenderLayer[] {
  // PanMap fontSize is stored in millimetres, matching the xmap reader
  // (which multiplies xmap's centi-mm on-disk values by MAP_UNIT_SCALE = 0.1).
  // OCAD stores font size as tenths of a point:
  //   1 pt = 25.4 / 72 mm  →  mm = ocadRaw × 25.4 / 720
  // Round-trips with symbol-bodies/text.ts' inverse `× 720 / 25.4`.
  const fontSize = (s.fontSize * 25.4) / 720
  return [
    {
      type: 'text',
      colorId: s.fontColor,
      fontFamily: s.fontName,
      fontSize,
      text: {
        fontFamily: s.fontName,
        fontSize,
        fontWeight: s.weight,
        italic: !!s.italic,
        charSpace: s.charSpace,
        wordSpace: s.wordSpace,
        lineSpace: s.lineSpace / 100,
        alignment: s.alignment & 0x03,
        verticalAlignment: (s.alignment >> 2) & 0x03,
        paraSpace: s.paraSpace,
        indentFirst: s.indentFirst,
        indentOther: s.indentOther,
      },
    },
  ]
}

function hasLineElements(s: LineSymbolDef): boolean {
  return [
    s.primSymElements,
    s.cornerSymElements,
    s.startSymElements,
    s.endSymElements,
  ].some(e => Array.isArray(e) && e.length > 0)
}

function toMapObject(object: TObject, index: number): MapObject {
  return {
    id: object.objIndex ? object.objIndex._index : index + 1,
    symbolId: object.sym,
    type: ocadObjectTypeName(object.objType),
    coordinates: object.coordinates,
    text: object.text,
    rotation: object.ang ? (object.ang / 10 / 180) * Math.PI : 0,
    // OCAD ObjectStatus (see Mapper's ocd_types.h):
    //   0 = Deleted (filtered out by the reader's index-block loop)
    //   1 = Normal
    //   2 = Hidden
    //   3 = DeletedForUndo
    // Only status === 2 marks a hidden object; the old `!!status` mapping
    // treated every normal object as hidden and blew away the OCAD→XMap
    // (and PanMap→anything) object list.
    hidden: object.objIndex?.status === 2,
    bounds: object.objIndex?.rc,
    objectString: object.objectString || undefined,
    objectStringType:
      object.nObjectString > 0 ? object.objectStringType ?? 0 : undefined,
  }
}

/**
 * Extract the PanMap view state from OCAD's 1030 parameter string.
 *
 * OCAD stores viewport centre in mm (paper units, y-up) as `x`/`y`, and
 * zoom as `z` (multiplier where ~1.0 ≈ 100%). Rotation isn't part of
 * this record — the `h` field is UI hatching, not view rotation.
 */
function extractView(ocadFile: OcadFile): MapView | undefined {
  const entry = ocadFile.parameterStrings[1030]?.[0]
  if (!entry) return undefined
  const x = numberValue((entry as Record<string, unknown>).x)
  const y = numberValue((entry as Record<string, unknown>).y)
  const z = numberValue((entry as Record<string, unknown>).z)
  const view: MapView = {}
  if (x !== undefined && y !== undefined) view.center = { x, y }
  if (z !== undefined) view.zoom = z
  return Object.keys(view).length ? view : undefined
}

function numberValue(v: unknown): number | undefined {
  if (v == null) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Read OCAD's 1039 map-setup record into a `MapCrs`.
 *
 * Field mapping (OCAD → PanMap):
 *   m → scale (denominator)
 *   x, y → projected.refPoint (in projected CRS units — metres for EPSG codes)
 *   a → grivation (grid-to-magnetic-north offset, degrees)
 *   i → projected.parameter (EPSG code via the crs-grids table); when
 *       resolvable, also sets `spec.language = "PROJ.4"` and
 *       `spec.value = "+init=epsg:<code>"` to match xmap's shape.
 *
 * OCAD has no field for true magnetic declination or paper-anchor
 * ref_point; those xmap concepts don't survive an OCAD trip.
 */
function extractGeoreferencing(ocadFile: OcadFile): MapCrs | undefined {
  const entry = ocadFile.parameterStrings[1039]?.[0] as Record<string, unknown> | undefined
  if (!entry) return undefined
  const crs: MapCrs = {}
  const scale = numberValue(entry.m)
  const x = numberValue(entry.x)
  const y = numberValue(entry.y)
  const a = numberValue(entry.a)
  const gridId = numberValue(entry.i)
  if (scale !== undefined) crs.scale = scale
  if (a !== undefined) crs.grivation = a
  if (gridId !== undefined || (x !== undefined && y !== undefined)) {
    const projected: NonNullable<MapCrs['projected']> = { id: 'EPSG' }
    if (x !== undefined && y !== undefined) projected.refPoint = { x, y }
    if (gridId !== undefined) {
      const match = crsGrids.find(([id]) => id === gridId)
      if (match) {
        const epsg = String(match[1])
        projected.parameter = epsg
        projected.spec = { language: 'PROJ.4', value: `+init=epsg:${epsg}` }
      }
    }
    crs.projected = projected
  }
  return Object.keys(crs).length ? crs : undefined
}
