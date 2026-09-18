import Panmap, {
  type MapColor,
  type MapSpotColor,
  type MapCrs,
  type MapObject,
  type MapSymbol,
  type MapView,
  type RenderLayer,
} from '../../../panmap/model.js'
import crsGrids from '../native/crs-grids.js'
import { cmykFractionToRgb } from '../../../util/cmyk-to-rgb.js'
import { deriveGeographic } from './decode/geographic.js'
import {
  shiftHoleFlagsFromOcad,
  canonicalTextAnchor,
  ocadAngleToRadians,
  unpackOcadTextAlign,
  ocadFontSizeToMm,
} from '../codecs/index.js'
import type OcadFile from '../native/ocad-file.js'
import type BaseSymbol from './decode/symbol.js'
import type { PointSymbolDef } from './decode/point-symbol.js'
import type { LineSymbolDef } from './decode/line-symbol.js'
import type { AreaSymbolDef } from './decode/area-symbol.js'
import type { TextSymbolDef } from './decode/text-symbol.js'
import type { TObject } from './decode/tobject.js'
import {
  PointSymbolType,
  LineSymbolType,
  AreaSymbolType,
  TextSymbolType,
} from '../native/symbol-types.js'
import { parseNotes } from '../../codecs/index.js'
import { OCAD_NOTES_RECTYPE } from '../notes.js'
import { ocadSymbolTypeName, ocadObjectTypeName } from './symbol-codec.js'

import { decodeLineStyle } from '../codecs/line-style.js'

/**
 * Convert the low-level OCAD file representation into the Panmap.
 *
 * Panmap is a lossy target — only cross-format fields are carried through.
 * OCAD-only fields (icon rasters, tree groups, framing, tab stops,
 * structure-fill geometry) do not survive a trip through Panmap.
 */
export default function ocadFileToMap(ocadFile: OcadFile): Panmap {
  const notesEntry = ocadFile.parameterStrings[OCAD_NOTES_RECTYPE]?.[0]
  const notesText =
    typeof notesEntry?._first === 'string' ? notesEntry._first : ''
  const { userText, extensions } = parseNotes(notesText)
  const view = extractView(ocadFile)
  const georeferencing = extractGeoreferencing(ocadFile)

  // OCAD stores text alignment on the SYMBOL; OMap (and the SVG renderer) read
  // it per-OBJECT. Build a symNum→hAlign lookup so text objects can carry the
  // alignment their symbol defines, matching OMap and rendering centre/right
  // labels correctly (the renderer uses object.hAlign, not the symbol's).
  const textHAlign = new Map<number, number>()
  for (const symbol of ocadFile.symbols) {
    const alignment = (symbol as { alignment?: number }).alignment
    if (alignment === undefined) continue
    const h = alignment & 0x03 // OCAD HAlign: 0 left, 1 centre, 2 right, 3 justified
    textHAlign.set((symbol as { symNum: number }).symNum, h === 3 ? 1 : h)
  }

  return new Panmap({
    metadata: {
      version: ocadFile.header.version,
      subVersion: ocadFile.header.subVersion,
      subSubVersion: ocadFile.header.subSubVersion,
      currentFileVersion: ocadFile.header.currentFileVersion,
      parameterStrings: ocadFile.parameterStrings,
    },
    colors: toMapColors(ocadFile),
    spotColors: toSpotColors(ocadFile),
    symbols: ocadFile.symbols.map(toMapSymbol),
    objects: (ocadFile.objects as unknown as TObject[]).map((object, i) =>
      toMapObject(object, i, textHAlign),
    ),
    warnings: ocadFile.warnings,
    view,
    georeferencing,
    extensions,
    notes: userText,
  })
}

function toMapColors(ocadFile: OcadFile): MapColor[] {
  // Pull Panmap color fields from parameter strings directly so we get
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
    // OCAD stores CMYK as 0–100; Panmap model uses 0–1.
    const rawCmyk = color.cmyk
    const cmyk: [number, number, number, number] | undefined = rawCmyk
      ? [rawCmyk[0] / 100, rawCmyk[1] / 100, rawCmyk[2] / 100, rawCmyk[3] / 100]
      : undefined
    // OCAD colour parameter-string fields (record type 9):
    //   `o` = OVERPRINT flag (0/1) — a print-separation hint, not alpha
    //   `t` = transparency/tint as a PERCENT (0–100), the real opacity
    // This used to read `o` as opacity, which made every non-overprint
    // colour fully transparent (opacity 0) in the model. Nothing renders
    // from the model's opacity today so it wasn't visible on screen, but
    // it broke colour convergence everywhere except maps that happen to
    // set overprint on all colours (leithfield). Mapper's xmap writes
    // `opacity="1"`, so normalise OCD's percent to the same 0–1 scale.
    const tintRaw = ps?.t
    const tintNum = tintRaw !== undefined ? Number(tintRaw) : NaN
    const opacity = Number.isFinite(tintNum) ? tintNum / 100 : undefined
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

/**
 * OCAD parameter-string record 10 — the SPOT-COLOUR table (print
 * separations: "Process Black", "PMS299_Blue", …).
 *
 * These are NOT palette colours. Mapper's xmap proves the point by
 * carrying the same separations two different ways depending on how the
 * map was authored:
 *   • dedicated `<color>` records appended after the palette, each whose
 *     `name` equals its own `<namedcolor>` (hillmorton);
 *   • no dedicated records at all — an existing palette colour just
 *     carries a `<namedcolor>` naming the separation it prints on
 *     (butlers-bush, "Black 100%" → namedcolor "Black").
 * Both files describe the same ink set, so a separation can't be a
 * palette entry without the palette differing between two exports of
 * one map. They live in their own list instead.
 *
 * CMYK is stored 0–100 as in record 9; RGB isn't stored, so derive it
 * with the converter the xmap reader uses for `method="cmyk"` colours.
 */
function toSpotColors(ocadFile: OcadFile): MapSpotColor[] {
  const out: MapSpotColor[] = []
  // OCAD's table can hold redundant slots — butlers-bush lists "Green"
  // twice and kura-tawhiti lists both "Black" and "Green" twice, each
  // pair with identical CMYK. A separation is identified BY NAME
  // (Mapper's xmap references it as `<namedcolor>Green</namedcolor>`),
  // so a second slot with the same name isn't expressible there and
  // isn't a distinct ink here either. Keep first-seen.
  const seen = new Set<string>()
  for (const ps of ocadFile.parameterStrings[10] || []) {
    const row = ps as Record<string, string> & { _first?: string }
    const name = row._first
    if (!name || seen.has(name)) continue
    seen.add(name)
    const c = Number(row.c)
    const m = Number(row.m)
    const y = Number(row.y)
    const k = Number(row.k)
    if (![c, m, y, k].every(Number.isFinite)) continue
    const rgb = cmykFractionToRgb(c / 100, m / 100, y / 100, k / 100)
    out.push({
      name,
      cmyk: [c / 100, m / 100, y / 100, k / 100],
      rgb: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`,
    })
  }
  return out
}

// OCAD font size is tenths of a point; the canonical model uses millimetres.
function convertOcadFontSizeToMm(
  fontSize: number | undefined,
): number | undefined {
  return fontSize ? (fontSize * 25.4) / 720 : undefined
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
    // hoist it onto the Panmap model so consumers don't need the raw.
    rotatable: (((symbol as { flags?: number }).flags ?? 0) & 1) !== 0,
    // OCAD stores font size in tenths of a point; the model contract (and the
    // OMap reader) is millimetres. Convert here so a text symbol's top-level
    // fontSize matches cross-format (the text render layer already does this).
    fontSize: convertOcadFontSizeToMm(
      (symbol as { fontSize?: number }).fontSize,
    ),
    layers: symbolToRenderLayers(symbol),
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
  // needs a carrier layer to survive the Panmap→xmap→Panmap trip.
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
      // OCAD's `mainLength` field is dual-purpose: on dashed lines it
      // is the dash length; on lines with mid-symbol content it's the
      // placement spacing. Preserve both fields on the stroke so OCD →
      // OCD round-trip is exact; the OMap writer separately decides
      // whether to surface them as `segment_length` (mid-symbol
      // placement) or reset to Mapper's `4000` default (dash-only).
      segmentLength: s.mainLength || undefined,
      endLength: s.endLength || undefined,
      // OCD's `distFromStart` / `distToEnd` map to xmap `start_offset` /
      // `end_offset`. On pointed-cap lines (capStyle=3, ISOM 107 erosion
      // gully) they ALSO double as the taper length — Mapper writes the
      // same value into `pointed_cap_length` alongside `start_offset` /
      // `end_offset`, so mirror that duplication rather than move the
      // field.
      startOffset: (s as { distFromStart?: number }).distFromStart || undefined,
      endOffset: (s as { distToEnd?: number }).distToEnd || undefined,
      pointedCapLength:
        capJoin.capStyle === 3
          ? (s as { distFromStart?: number }).distFromStart || undefined
          : undefined,
      // Mid-symbol placement fields — OCAD's `nPrimSym` / `primSymDist`
      // control how many mid-symbols per placement spot and how far
      // apart they are (double-tick fences, walls with two spikes).
      // Without these, ISOM 515 / 529 double-tick walls collapse to
      // a single-tick round-tripped rendering.
      midSymbolsPerSpot: (s as { nPrimSym?: number }).nPrimSym,
      midSymbolDistance: (s as { primSymDist?: number }).primSymDist,
      dash: dashFromOcd(s),
    },
    hasLineElements(s) && {
      type: 'line-elements',
      // Semantic placement fields (both readers populate these). The
      // OCD-native `mainLength`/`endLength`/`nPrimSym`/`primSymDist`
      // used to live here directly; they're the same values as
      // stroke.segmentLength / stroke.endLength / stroke.midSymbolsPerSpot
      // / stroke.midSymbolDistance — canonical model exposes them under
      // Mapper's semantic names, duplicated onto line-elements only
      // where the SVG renderer needs them without walking siblings.
      spacing: s.mainLength || undefined,
      endOffset: s.endLength || undefined,
      primSymElements: s.primSymElements,
      cornerSymElements: s.cornerSymElements,
      startSymElements: s.startSymElements,
      endSymElements: s.endSymElements,
    },
    // OCAD "frame" fields (frColor / frWidth / frStyle) encode a wider
    // decoration stroke drawn under a dashed main line — used by
    // railways with a two-tone appearance (ara 509.1 dashed + wider
    // framing). XMap represents the same thing as a two-part combined
    // line symbol; surface as a Panmap stroke so the adapter emits
    // it and Mapper's OCD re-import re-attaches it as fr*.
    (s as { frColor?: number; frWidth?: number }).frColor !== undefined &&
      (s as { frWidth?: number }).frWidth !== undefined &&
      (s as { frWidth?: number }).frWidth! > 0 && {
        type: 'stroke',
        colorId: (s as { frColor?: number }).frColor,
        width: (s as { frWidth?: number }).frWidth,
        lineStyle: (s as { frStyle?: number }).frStyle ?? 0,
        // Mark as the frame stroke so downstream synth can distinguish it
        // from a border-carrier stroke (both are "secondary" strokes).
        frame: true,
      },
    s.doubleLine?.dblMode
      ? {
          type: 'double-line',
          mode: s.doubleLine.dblMode,
          flags: s.doubleLine.dblFlags,
          // `dblFillColor` is Mapper's slot for a DISTINCT third color
          // between the two borders (e.g. a road's orange fill vs its
          // border black). When it's 0 on disk that's the default-init
          // "no distinct fill" sentinel — the double-line's visible
          // interior is either painted by `lineColor` (the primary
          // stroke) or fully covered by the borders. Surfacing 0 as a
          // real colorId inflates the OCD writer's per-symbol color
          // set (`collect-symbol-colors.ts`) and Mapper's nColors then
          // disagrees. Same convention as extractBorders' `leftColor=0
          // + leftWidth=0` skip in the OMap writer.
          fillColorId: s.doubleLine.dblFillColor || undefined,
          // Same "0 = default-init sentinel" story for the border colors.
          // dblLeftWidth / dblRightWidth = 0 means the border isn't
          // rendered; the associated color slot is a leftover from a
          // stale double-line config and gets counted as a real color
          // by the OCD writer's per-symbol color set if we surface it.
          // Only surface when there's actual border width to paint.
          leftColorId:
            s.doubleLine.dblLeftWidth > 0
              ? s.doubleLine.dblLeftColor
              : undefined,
          rightColorId:
            s.doubleLine.dblRightWidth > 0
              ? s.doubleLine.dblRightColor
              : undefined,
          centerWidth: s.doubleLine.dblWidth,
          leftWidth: s.doubleLine.dblLeftWidth,
          rightWidth: s.doubleLine.dblRightWidth,
          // Dashed borders (dblMode 2/3/4) carry the dash rhythm in
          // dblLength / dblGap. Preserve so extractBorders can put the
          // dash_length / break_length on each xmap `<border>`.
          dashLength: s.doubleLine.dblLength,
          breakLength: s.doubleLine.dblGap,
          lineStyle: s.lineStyle,
        }
      : undefined,
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
      type: 'point-pattern-fill',
      colorId: s.elements.length
        ? Math.min(...s.elements.map(e => e.color))
        : s.fillColor,
      // Tile size: `width` along a row, `height` between rows. OCAD's
      // `structHeight` is the ROW PITCH, so for shifted rows (every
      // other row offset by half) the full tile is twice that.
      width: s.structWidth,
      height: s.structHeight * (s.structMode === 2 ? 2 : 1),
      angle: s.structAngle / 10,
      // OCAD `structMode` 2 = shifted rows ("brick bond"); xmap writes
      // the same layout as a pair of offset `<pattern>` records. The
      // canonical model carries the semantic flag and each writer
      // re-encodes in its own idiom.
      shiftedRows: s.structMode === 2,
      rowOffset: 0,
      columnOffset: 0,
      // OCAD structDraw byte packs a clipping-mode enum (low 2 bits)
      // that xmap surfaces as `no_clipping`. Canonical model keeps the
      // semantic value only — the raw byte would leak OCD-side state
      // that xmap doesn't share.
      noClipping: (s.structDraw ?? 0) & 0x03,
      rotatable: areaRotatable,
      elements: s.elements,
    },
    s.borderSym && { type: 'border-symbol', symbolId: s.borderSym },
  ]
  return layers.filter(Boolean) as RenderLayer[]
}

function textRenderLayers(s: TextSymbolDef): RenderLayer[] {
  // Panmap fontSize is stored in millimetres, matching the xmap reader
  // (which multiplies xmap's centi-mm on-disk values by MAP_UNIT_SCALE = 0.1).
  // OCAD stores font size as tenths of a point:
  //   1 pt = 25.4 / 72 mm  →  mm = ocadRaw × 25.4 / 720
  const fontSize = ocadFontSizeToMm(s.fontSize)
  const textAlign = unpackOcadTextAlign(s.alignment)
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
        alignment: textAlign.horizontal,
        verticalAlignment: textAlign.vertical,
        paraSpace: s.paraSpace,
        indentFirst: s.indentFirst,
        indentOther: s.indentOther,
        // Paragraph tab stops — a short + fixed-size (32-entry) array
        // in OCD. Preserve so an OCD→OCD round-trip on a text symbol
        // with tab-aligned columns (e.g. bottle-lake 801.4 "Left-aligned
        // italic 3pt", used for control descriptions with a tabular
        // layout) survives. Only emit `tabs` when there's at least one
        // — an empty array is Mapper's default and shows up as 0/[]
        // whether we surface it or not.
        tabs:
          typeof s.nTabs === 'number' && s.nTabs > 0 && Array.isArray(s.tabs)
            ? s.tabs.slice(0, s.nTabs)
            : undefined,
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

/**
 * Translate OCD's on-disk dash rhythm (`{mainLength, mainGap, secGap,
 * endLength, endGap}` on the line symbol) into the canonical model
 * shape (`{dashLength, breakLength, dashesInGroup, inGroupBreakLength,
 * halfOuterDashes}` — Mapper's semantic vocab, also what the OMap
 * reader produces natively). Keeping just one dash vocab in the model
 * avoids the source-format leak that let downstream consumers assume
 * OCD-native names.
 *
 * OCD encodes three cases, discriminated by `mainGap` and `secGap`:
 *   - `mainGap>0, secGap=0` → plain repeat.
 *       `dashLength = mainLength, breakLength = mainGap`.
 *   - `mainGap=0, secGap>0` → 1-dash pairs with `secGap` between.
 *       `mainLength = dashLength + secGap`, so `dashLength = mainLength - secGap`,
 *       `breakLength = secGap`. (E.g. 106 Ruined earth wall.)
 *   - `mainGap>0, secGap>0` → 2-dash group.
 *       `mainLength = 2·dashLength + secGap`, so `dashLength = (mainLength - secGap) / 2`,
 *       `breakLength = mainGap`, `dashesInGroup = 2`, `inGroupBreakLength = secGap`.
 *       (E.g. 337-stairway.)
 *
 * `halfOuterDashes` is derived from `endLength ≈ mainLength / 2` — but
 * ONLY when the line has no mid-symbol content. On a line with
 * `primSymElements`, OCAD's `endLength` field carries mid-symbol
 * placement rather than end-dash halving (butlers 106).
 */
function dashFromOcd(
  s: LineSymbolDef,
):
  | {
      dashLength: number
      breakLength: number
      dashesInGroup: number
      inGroupBreakLength: number
      halfOuterDashes?: true
    }
  | undefined {
  if (!s.mainGap && !s.secGap) return undefined
  const mainLength = s.mainLength || 0
  const mainGap = s.mainGap || 0
  const secGap = s.secGap || 0
  let dashLength: number
  let breakLength: number
  let dashesInGroup: number
  let inGroupBreakLength: number
  if (secGap > 0 && mainGap > 0) {
    dashLength = (mainLength - secGap) / 2
    breakLength = mainGap
    dashesInGroup = 2
    inGroupBreakLength = secGap
  } else if (secGap > 0) {
    dashLength = mainLength - secGap
    breakLength = secGap
    dashesInGroup = 1
    inGroupBreakLength = 0
  } else {
    dashLength = mainLength
    breakLength = mainGap
    dashesInGroup = 1
    inGroupBreakLength = 0
  }
  const halfOuter =
    s.mainLength > 0 &&
    !hasLineElements(s) &&
    Math.abs(s.endLength * 2 - s.mainLength) <= 1
      ? true
      : undefined
  return {
    dashLength,
    breakLength,
    dashesInGroup,
    inGroupBreakLength,
    ...(halfOuter ? { halfOuterDashes: halfOuter } : {}),
  }
}

/** Negate the y of each coord in place (OCAD y-up → canonical y-down),
 *  leaving x and the flag bytes untouched. */
function negateCoordsY<T>(coords: T[]): T[] {
  for (const c of coords) {
    if (Array.isArray(c)) c[1] = -c[1]
  }
  return coords
}

/** Negate the y of a bounding rect's corners in place so it stays consistent
 *  with the y-flipped coordinates (min/max resolve correctly either way). */
function flipRectY<T>(rc: T): T {
  if (rc) {
    for (const corner of Object.values(rc as Record<string, unknown>)) {
      if (Array.isArray(corner)) corner[1] = -corner[1]
    }
  }
  return rc
}

function toMapObject(
  object: TObject,
  index: number,
  textHAlign?: Map<number, number>,
): MapObject {
  const type = ocadObjectTypeName(object.objType)
  const angleRad = ocadAngleToRadians(object.ang)
  const isText = type === 'text' || type === 'line-text'
  // OCAD stores an AREA/combined object's angle as its fill-PATTERN rotation
  // (Mapper: `setPatternRotation`); a point/text object's angle is the object's
  // own rotation. Route it to the field OMap uses so the two agree — otherwise
  // OCAD-sourced areas drop the pattern rotation that OMap carries in `pattern`.
  const patternRotated = type === 'area' || type === 'combined'
  return {
    id: object.objIndex ? object.objIndex._index : index + 1,
    symbolId: object.sym,
    type,
    // Text objects: OCAD stores a single-anchor label as 5 coords (anchor + 4
    // box corners clockwise). The box is derived from font metrics and re-
    // snapped by Mapper on open, so it isn't canonical geometry — Mapper's own
    // importer keeps only the anchor (fillTextPathCoords), and OMap stores just
    // the anchor too. Reduce to it so OCD- and OMap-sourced text serialise
    // identically. (The SVG renderer reads only coordinates[0] for text.)
    //
    // Everything else: OCAD stores an area's hole-ring flag on the FIRST coord
    // of the new ring; canonical (and every consumer — SVG splitter, geojson,
    // diff) wants it on the LAST coord of the previous ring. Shift it back — the
    // exact inverse of the writer's `shiftHoleFlagsToOcad`. Without this, every
    // OCAD-sourced area hole is off by one coord, and each OCD round-trip walks
    // it forward again (measured: 235 interior hole flags on bottle-lake).
    // OCAD is the only y-up format; the canonical model is y-down (matching
    // omap/gitmap/svg). Negate y on the way in so every downstream consumer
    // sees one orientation — the OCAD writer flips back on the way out. In
    // place, like the hole-flag shift above (the model shares the array).
    coordinates: negateCoordsY(
      type === 'text'
        ? canonicalTextAnchor(object.coordinates)
        : shiftHoleFlagsFromOcad(object.coordinates),
    ),
    text: object.text,
    rotation: patternRotated ? 0 : angleRad,
    // Area/combined: the angle is the fill-pattern rotation; expose it on the
    // per-object `pattern` override (origin defaults to 0,0), matching OMap.
    pattern:
      patternRotated && angleRad
        ? { rotation: angleRad, origin: { x: 0, y: 0 } }
        : undefined,
    // Text alignment from the symbol (OCAD stores it there, OMap per-object).
    hAlign: isText ? textHAlign?.get(object.sym) : undefined,
    // OCAD ObjectStatus (see Mapper's ocd_types.h):
    //   0 = Deleted (filtered out by the reader's index-block loop)
    //   1 = Normal
    //   2 = Hidden
    //   3 = DeletedForUndo
    // Only status === 2 marks a hidden object; the old `!!status` mapping
    // treated every normal object as hidden and blew away the OCAD→XMap
    // (and Panmap→anything) object list.
    hidden: object.objIndex?.status === 2,
    bounds: flipRectY(object.objIndex?.rc),
    tag: object.objectString || undefined,
    tagType:
      object.nObjectString > 0 ? (object.objectStringType ?? 0) : undefined,
  }
}

/**
 * Extract the Panmap view state from OCAD's 1030 parameter string.
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
 * Field mapping (OCAD → Panmap):
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
  const entry = ocadFile.parameterStrings[1039]?.[0] as
    Record<string, unknown> | undefined
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

    // OCAD stores only the projected side; OMap also carries a geographic ref
    // point and a magnetic declination. Both are pure functions of the
    // projection at the projected ref point (OOMapper derives them the same
    // way), so reproduce them here to match OMap-sourced georef. Skipped when
    // the EPSG isn't in the offline proj4 table (never fabricated).
    const derived = deriveGeographic(projected.parameter, projected.refPoint)
    if (derived) {
      crs.geographic = {
        id: 'Geographic coordinates',
        spec: { language: 'PROJ.4', value: '+proj=latlong +datum=WGS84' },
        refPointDeg: {
          lat: round(derived.refPointDeg.lat, 8),
          lon: round(derived.refPointDeg.lon, 8),
        },
      }
      // declination = grivation (grid→magnetic) + meridian convergence
      // (true→grid). `a` is OCAD's grivation.
      if (a !== undefined)
        crs.declination = round(a + derived.convergenceDeg, 2)
    }
  }
  return Object.keys(crs).length ? crs : undefined
}

function round(value: number, dp: number): number {
  return Number(value.toFixed(dp))
}
