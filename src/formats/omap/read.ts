import fs from 'node:fs'
import { XMLParser } from 'fast-xml-parser'
import { cmykFractionToRgb } from '../../cmyk-to-rgb.js'
import { ATTR_PREFIX, MAP_UNIT_SCALE } from './schema.js'

export interface OmapFile {
  colors: OmapColor[]
  symbols: OmapSymbol[]
  objects: OmapObject[]
  /**
   * Document-level extras captured verbatim from the parsed XML so writers
   * can round-trip sections we don't yet model (templates, georeferencing,
   * parts metadata > 1, notes, print parameters, view settings, etc.).
   *
   * The shape mirrors fast-xml-parser's parsed JSON; the writer hands it
   * back through XMLBuilder.
   */
  extras?: OmapExtras
}

export interface OmapExtras {
  /** Attributes on the root `<map>` element (e.g. version). */
  mapAttributes?: Record<string, string>
  /** Attributes on the inner `<barrier>` element (e.g. version, required). */
  barrierAttributes?: Record<string, string>
  /** Raw `<georeferencing>` subtree. */
  georeferencing?: unknown
  /** Raw `<notes>` subtree. */
  notes?: unknown
  /** Raw `<templates>` subtree. */
  templates?: unknown
  /** Raw `<view>` subtree. */
  view?: unknown
  /** Raw `<print>` subtree. */
  print?: unknown
  /** Raw `<parts>` subtree (multi-part documents); single-part is flattened. */
  parts?: unknown
}

export interface OmapColor {
  priority: number
  name: string
  rgb: OmapRgb | null
  /** CMYK components in [0, 1], from the `c`/`m`/`y`/`k` XML attributes. */
  cmyk?: [number, number, number, number]
  /** Per-color opacity in [0, 1], from the `opacity` XML attribute. */
  opacity?: number
}

export interface OmapRgb {
  r: number
  g: number
  b: number
}

export interface OmapCoord {
  x: number
  y: number
  flags?: number
}

export interface OmapSize {
  width: number
  height: number
}

export interface OmapPattern {
  rotation?: number
  origin?: OmapCoord
}

export interface OmapObject {
  type: number
  symbol: number
  rotation?: number
  hAlign?: number
  vAlign?: number
  coords: OmapCoord[]
  text: string | null
  textBox: OmapSize | null
  pattern?: OmapPattern
}

export interface OmapLineSymbol {
  color: number
  lineWidth: number
  minimumLength: number
  dashed: boolean
  dashLength: number
  breakLength: number
  dashesInGroup: number
  inGroupBreakLength: number
  endLength: number
  dashSymbol?: OmapSymbol
  segmentLength: number
  startOffset: number
  endOffset: number
  showAtLeastOneSymbol: boolean
  midSymbolsPerSpot: number
  minimumMidSymbolCount: number
  minimumMidSymbolCountWhenClosed: number
  suppressDashSymbolAtEnds: boolean
  scaleDashSymbol: boolean
  capStyle: number
  joinStyle: number
  midSymbol?: OmapSymbol
  midSymbolDistance: number
  midSymbolPlacement: number
  startSymbol?: OmapSymbol
  endSymbol?: OmapSymbol
  borders?: OmapLineBorder[]
}

export interface OmapLineBorder {
  color: number
  width: number
  shift: number
}

export interface OmapAreaPattern {
  type: number
  angle: number
  lineSpacing: number
  pointDistance: number
  lineOffset: number
  offsetAlongLine: number
  color?: number
  lineWidth: number
  rotatable: boolean
  symbol?: OmapSymbol
}

export interface OmapAreaSymbol {
  innerColor: number
  patterns?: OmapAreaPattern[]
}

export interface OmapPointElement {
  symbol?: OmapSymbol
  object?: OmapObject
}

export interface OmapPointSymbol {
  innerColor: number | null
  elements?: OmapPointElement[]
  innerRadius: number
  outerWidth: number
  outerColor: number | null
  rotatable: boolean
}

export interface OmapCombinedSymbol {
  parts: Array<{ symbol?: OmapSymbol; symbolRef?: number }>
}

export interface OmapTextSymbol {
  color: number
  fontFamily: string
  /** Font size in map units (mm). */
  fontSize: number
  bold: boolean
  italic: boolean
  /** Line spacing as a multiplier (1 = single-spaced). */
  lineSpacing?: number
  /** Paragraph spacing in map units. */
  paragraphSpacing?: number
  /** Character spacing in map units. */
  characterSpacing?: number
  rotatable?: boolean
  framing?: {
    color?: number
    mode?: number
    lineHalfWidth?: number
    shadowX?: number
    shadowY?: number
  }
  lineBelow?: {
    color?: number
    width?: number
    distance?: number
  }
}

export interface OmapSymbol {
  id: number
  code?: string
  name?: string
  type: number
  lineSymbol?: OmapLineSymbol
  areaSymbol?: OmapAreaSymbol
  pointSymbol?: OmapPointSymbol
  combinedSymbol?: OmapCombinedSymbol
  textSymbol?: OmapTextSymbol
}

async function readOmapFile(filename: string): Promise<OmapFile> {
  const xml = await fs.promises.readFile(filename, 'utf-8')
  return parseOmapXml(xml)
}

/** Parse XMap XML from a string or Buffer that already contains the document. */
function parseOmap(input: string | Buffer): OmapFile {
  const xml = Buffer.isBuffer(input) ? input.toString('utf-8') : input
  return parseOmapXml(xml)
}

function parseOmapXml(xml: string): OmapFile {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: true,
    allowBooleanAttributes: true,
    processEntities: true,
  })
  const root = parser.parse(xml)
  const map = root?.map ?? root?.Map ?? root
  const barriers = ensureArray(map?.barrier)

  let anonymousSymbolId = -1

  const colors = ensureArray(map?.colors?.color).map(color => {
    const c = parseNumber(color.c, NaN)
    const m = parseNumber(color.m, NaN)
    const y = parseNumber(color.y, NaN)
    const k = parseNumber(color.k, NaN)
    const cmykValid = [c, m, y, k].every(Number.isFinite)
    const opacity = parseNumber(color.opacity, NaN)
    return {
      priority: parseNumber(color.priority),
      name: color.name ?? '',
      rgb: parseRgb(color),
      cmyk: cmykValid ? ([c, m, y, k] as [number, number, number, number]) : undefined,
      opacity: Number.isFinite(opacity) ? opacity : undefined,
    }
  })

  function parseObject(node: Record<string, any> | undefined): any {
    if (!node) return undefined

    const sizeNode = node.size
    const patternNode = node.pattern

    return {
      type: parseNumber(node.type),
      symbol: parseNumber(node.symbol),
      rotation: node.rotation !== undefined ? Number(node.rotation) : undefined,
      hAlign: node.h_align !== undefined ? parseNumber(node.h_align) : undefined,
      vAlign: node.v_align !== undefined ? parseNumber(node.v_align) : undefined,
      coords: parseCoords(node),
      text: typeof node.text === 'string' ? node.text : null,
      textBox: sizeNode
        ? {
            width: parseDim(sizeNode.width),
            height: parseDim(sizeNode.height),
          }
        : null,
      pattern: patternNode
        ? {
            rotation:
              patternNode.rotation !== undefined
                ? Number(patternNode.rotation)
                : undefined,
            origin: patternNode.coord
              ? {
                  x: parseDim(patternNode.coord.x),
                  y: parseDim(patternNode.coord.y),
                }
              : undefined,
          }
        : undefined,
    }
  }

  function parseSymbolNode(symbol: Record<string, any>): any {
    const borders = symbol?.line_symbol?.borders?.border
      ? ensureArray(symbol.line_symbol.borders.border).map(border => ({
          color: parseNumber(border.color, -1),
          width: parseDim(border.width, 0),
          shift: parseDim(border.shift, 0),
          // Border-side dash spec — separate from the parent line's
          // dash. Mapper's dblMode=3 (BordersDashed) is triggered when
          // either border is dashed, not necessarily the main line.
          dashed: isTrue(border.dashed),
          dashLength: parseDim(border.dash_length, 0),
          breakLength: parseDim(border.break_length, 0),
        }))
      : undefined

    const lineSymbol = symbol?.line_symbol
      ? {
          color: parseNumber(symbol.line_symbol.color, -1),
          lineWidth: parseDim(symbol.line_symbol.line_width, 0),
          minimumLength: parseDim(symbol.line_symbol.minimum_length, 0),
          dashed: isTrue(symbol.line_symbol.dashed),
          dashLength: parseDim(symbol.line_symbol.dash_length, 4000),
          breakLength: parseDim(symbol.line_symbol.break_length, 1000),
          dashesInGroup: parseNumber(symbol.line_symbol.dashes_in_group, 1),
          inGroupBreakLength: parseDim(
            symbol.line_symbol.in_group_break_length,
            500
          ),
          endLength: parseDim(symbol.line_symbol.end_length, 0),
          dashSymbol: symbol.line_symbol?.dash_symbol?.symbol
            ? parseSymbolNode(symbol.line_symbol.dash_symbol.symbol)
            : undefined,
          segmentLength: parseDim(symbol.line_symbol.segment_length, 4000),
          startOffset: parseDim(symbol.line_symbol.start_offset, 0),
          endOffset: parseDim(symbol.line_symbol.end_offset, 0),
          showAtLeastOneSymbol:
            symbol.line_symbol.show_at_least_one_symbol === undefined
              ? true
              : isTrue(symbol.line_symbol.show_at_least_one_symbol),
          midSymbolsPerSpot: parseNumber(
            symbol.line_symbol.mid_symbols_per_spot,
            1
          ),
          minimumMidSymbolCount: parseNumber(
            symbol.line_symbol.minimum_mid_symbol_count,
            0
          ),
          minimumMidSymbolCountWhenClosed: parseNumber(
            symbol.line_symbol.minimum_mid_symbol_count_when_closed,
            0
          ),
          suppressDashSymbolAtEnds:
            symbol.line_symbol.suppress_dash_symbol_at_ends === undefined
              ? false
              : isTrue(symbol.line_symbol.suppress_dash_symbol_at_ends),
          scaleDashSymbol:
            symbol.line_symbol.scale_dash_symbol === undefined
              ? true
              : isTrue(symbol.line_symbol.scale_dash_symbol),
          capStyle: parseNumber(symbol.line_symbol.cap_style, 0),
          joinStyle: parseNumber(symbol.line_symbol.join_style, 0),
          midSymbol: symbol.line_symbol?.mid_symbol?.symbol
            ? parseSymbolNode(symbol.line_symbol.mid_symbol.symbol)
            : undefined,
          midSymbolDistance: parseDim(
            symbol.line_symbol.mid_symbol_distance,
            0
          ),
          midSymbolPlacement: parseNumber(
            symbol.line_symbol.mid_symbol_placement,
            0
          ),
          startSymbol: symbol.line_symbol?.start_symbol?.symbol
            ? parseSymbolNode(symbol.line_symbol.start_symbol.symbol)
            : undefined,
          endSymbol: symbol.line_symbol?.end_symbol?.symbol
            ? parseSymbolNode(symbol.line_symbol.end_symbol.symbol)
            : undefined,
          borders: borders?.length ? borders : undefined,
        }
      : undefined

    const patterns = symbol?.area_symbol?.pattern
      ? ensureArray(symbol.area_symbol.pattern).map(pattern => ({
          type: parseNumber(pattern.type, 0),
          angle: parseNumber(pattern.angle, 0),
          lineSpacing: parseDim(pattern.line_spacing, 0),
          pointDistance: parseDim(pattern.point_distance, 0),
          lineOffset: parseDim(pattern.line_offset, 0),
          offsetAlongLine: parseDim(pattern.offset_along_line, 0),
          color:
            pattern.color !== undefined ? parseNumber(pattern.color, -1) : undefined,
          lineWidth: parseDim(pattern.line_width, 0),
          rotatable: isTrue(pattern.rotatable),
          // Preserve xmap `no_clipping` (0/1/2) so the OCAD synth
          // can pack it into `structDraw`. 1 = "no clipping if
          // completely inside", 2 = "no clipping if center inside".
          noClipping: parseNumber(pattern.no_clipping, 0),
          symbol: pattern.symbol ? parseSymbolNode(pattern.symbol) : undefined,
        }))
      : undefined

    const areaSymbol = symbol?.area_symbol
      ? {
          innerColor: parseNumber(symbol.area_symbol.inner_color, -1),
          patterns: patterns?.length ? patterns : undefined,
        }
      : undefined

    const elements = ensureArray(symbol?.point_symbol?.element).map(el => ({
      symbol: el?.symbol ? parseSymbolNode(el.symbol) : undefined,
      object: parseObject(el?.object),
    }))

    const pointSymbol = symbol?.point_symbol
      ? {
          innerColor:
            symbol.point_symbol.inner_color !== undefined
              ? parseNumber(symbol.point_symbol.inner_color, -1)
              : null,
          elements: elements.length ? elements : undefined,
          innerRadius: parseDim(symbol.point_symbol.inner_radius, 0),
          outerWidth: parseDim(symbol.point_symbol.outer_width, 0),
          outerColor:
            symbol.point_symbol.outer_color !== undefined
              ? parseNumber(symbol.point_symbol.outer_color, -1)
              : null,
          rotatable: isTrue(symbol.point_symbol.rotatable),
        }
      : undefined

    const parts = ensureArray(symbol?.combined_symbol?.part)
      .map(part => {
        if (part?.symbol && typeof part.symbol === 'object') {
          return { symbol: parseSymbolNode(part.symbol) }
        }
        if (part?.symbol !== undefined) {
          return { symbolRef: parseNumber(part.symbol) }
        }
        return null
      })
      .filter(Boolean)

    return {
      id:
        symbol?.id !== undefined ? parseNumber(symbol.id) : anonymousSymbolId--,
      code: symbol.code,
      name: symbol.name,
      type: parseNumber(symbol.type),
      lineSymbol,
      areaSymbol,
      pointSymbol,
      combinedSymbol: parts.length ? { parts } : undefined,
      textSymbol: symbol?.text_symbol
        ? {
            fontFamily: symbol.text_symbol?.font?.family,
            fontSize: parseDim(symbol.text_symbol?.font?.size, 0),
            bold: isTrue(symbol.text_symbol?.font?.bold),
            italic: isTrue(symbol.text_symbol?.font?.italic),
            color:
              symbol.text_symbol?.text?.color !== undefined
                ? parseNumber(symbol.text_symbol.text.color, -1)
                : undefined,
            lineSpacing:
              symbol.text_symbol?.text?.line_spacing !== undefined
                ? parseNumber(symbol.text_symbol.text.line_spacing, 1)
                : undefined,
            paragraphSpacing:
              symbol.text_symbol?.text?.paragraph_spacing !== undefined
                ? parseDim(symbol.text_symbol.text.paragraph_spacing, 0)
                : undefined,
            characterSpacing:
              symbol.text_symbol?.text?.character_spacing !== undefined
                ? parseDim(symbol.text_symbol.text.character_spacing, 0)
                : undefined,
            rotatable: isTrue(symbol.text_symbol.rotatable),
            framing: symbol.text_symbol?.framing
              ? {
                  color:
                    symbol.text_symbol.framing.color !== undefined
                      ? parseNumber(symbol.text_symbol.framing.color, -1)
                      : undefined,
                  mode: parseNumber(symbol.text_symbol.framing.mode, 0),
                  lineHalfWidth: parseDim(
                    symbol.text_symbol.framing.line_half_width,
                    0
                  ),
                  shadowX: parseDim(
                    symbol.text_symbol.framing.shadow_x_offset,
                    0
                  ),
                  shadowY: parseDim(
                    symbol.text_symbol.framing.shadow_y_offset,
                    0
                  ),
                }
              : undefined,
            lineBelow: symbol.text_symbol?.line_below
              ? {
                  color:
                    symbol.text_symbol.line_below.color !== undefined
                      ? parseNumber(symbol.text_symbol.line_below.color, -1)
                      : undefined,
                  width: parseDim(symbol.text_symbol.line_below.width, 0),
                  distance: parseDim(
                    symbol.text_symbol.line_below.distance,
                    0
                  ),
                }
              : undefined,
          }
        : undefined,
    }
  }

  const symbolNodes = barriers
    .flatMap(barrier => ensureArray(barrier?.symbols?.symbol))
    .concat(ensureArray(map?.symbols?.symbol))
  const symbols = symbolNodes.map(symbol => parseSymbolNode(symbol))

  const parts = barriers
    .flatMap(barrier => ensureArray(barrier?.parts?.part))
    .concat(ensureArray(map?.parts?.part))
  const objectNodes = barriers
    .flatMap(barrier =>
      ensureArray(barrier?.symbols?.objects?.object).concat(
        ensureArray(barrier?.objects?.object)
      )
    )
    .concat(ensureArray(map?.objects?.object))
    .concat(parts.flatMap(part => ensureArray(part?.objects?.object)))
  const objects = objectNodes.map(obj => parseObject(obj)).filter(Boolean)

  const extras = collectExtras(xml)

  return { colors, symbols, objects, extras }
}

const RAW_PASSTHROUGH_KEYS = [
  'georeferencing',
  'notes',
  'templates',
  'view',
  'print',
]

/**
 * Re-parses the XML with attribute-distinguishing config so we can capture
 * arbitrary sections verbatim and round-trip them via XMLBuilder. Cheap:
 * fast-xml-parser is fast and xmap documents are small enough that paying
 * for a second parse to keep the rest of the codebase unchanged is fine.
 */
function collectExtras(xml: string): OmapExtras {
  // For extras we want raw string fidelity so the XMLBuilder round-trip
  // preserves attribute / text exactly. The main reader uses its own
  // parser with coercion enabled where it's convenient.
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ATTR_PREFIX,
    removeNSPrefix: true,
    allowBooleanAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: false,
    processEntities: true,
  })
  const root = stripWhitespaceTextNodes(parser.parse(xml))
  const mapNode = root?.map ?? root?.Map ?? root
  const barriers = ensureArray(mapNode?.barrier)

  const extras: OmapExtras = {}

  const mapAttrs = pluckAttrs(mapNode)
  if (Object.keys(mapAttrs).length) extras.mapAttributes = mapAttrs

  if (barriers.length === 1) {
    const attrs = pluckAttrs(barriers[0])
    if (Object.keys(attrs).length) extras.barrierAttributes = attrs
  }

  const sources = [mapNode, ...barriers].filter(Boolean)
  for (const key of RAW_PASSTHROUGH_KEYS) {
    for (const src of sources) {
      if (src && key in src && src[key] !== undefined) {
        extras[key] = src[key]
        break
      }
    }
  }

  // Multi-part documents: keep the full parts subtree so multi-part round-trips.
  const parts = mapNode?.parts ?? barriers[0]?.parts
  if (parts) {
    const partList = ensureArray(parts.part)
    if (partList.length > 1) extras.parts = parts
  }

  return extras
}

/**
 * Recursively drop `#text` properties whose value is purely whitespace.
 * fast-xml-parser keeps inter-element whitespace from pretty-printed XML;
 * that survives the read but XMLBuilder doesn't re-emit it, so the
 * round-trip otherwise diverges. Real text content (e.g. `<notes>Hi</notes>`)
 * is preserved verbatim because it has non-whitespace characters.
 */
function stripWhitespaceTextNodes<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map(stripWhitespaceTextNodes) as unknown as T
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '#text' && typeof v === 'string' && v.trim() === '') continue
    out[k] = stripWhitespaceTextNodes(v)
  }
  return out as unknown as T
}

type XmlNode = Record<string, unknown> | null | undefined
type XmlValue = unknown

function pluckAttrs(node: XmlNode): Record<string, string> {
  const out: Record<string, string> = {}
  if (!node || typeof node !== 'object') return out
  for (const [k, v] of Object.entries(node)) {
    if (k.startsWith(ATTR_PREFIX)) out[k.slice(ATTR_PREFIX.length)] = String(v)
  }
  return out
}

function ensureArray<T = unknown>(value: T | T[] | null | undefined): T[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function isTrue(value: XmlValue): boolean {
  return value === 'true' || value === true
}

function parseNumber(value: XmlValue, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function parseDim(value: XmlValue, fallback = 0): number {
  return parseNumber(value, fallback) * MAP_UNIT_SCALE
}

function parseCoords(node: Record<string, any> | undefined) {
  const coordNodes = ensureArray(node?.coords?.coord).concat(
    ensureArray(node?.coord)
  )
  if (coordNodes.length) {
    return coordNodes.map(coord => ({
      x: parseDim(coord.x),
      y: parseDim(coord.y),
      flags: coord.flags !== undefined ? parseNumber(coord.flags) : undefined,
    }))
  }

  const packedCoords =
    typeof node?.coords === 'string'
      ? node.coords
      : typeof node?.coords?.['#text'] === 'string'
      ? node.coords['#text']
      : null
  if (!packedCoords) return []

  return packedCoords
    .split(';')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => {
      const [xRaw, yRaw, flagsRaw] = entry.split(/\s+/)
      return {
        x: parseDim(xRaw),
        y: parseDim(yRaw),
        flags: flagsRaw !== undefined ? parseNumber(flagsRaw) : undefined,
      }
    })
}

function parseRgb(colorNode: Record<string, any> | undefined): { r: number; g: number; b: number } | null {
  const rgb = colorNode?.rgb
  const rgbMethod = String(rgb?.method ?? '').toLowerCase()
  if (rgb && rgbMethod === 'custom') {
    return rgbValuesToBytes(rgb.r, rgb.g, rgb.b)
  }

  const c = parseNumber(colorNode?.c, NaN)
  const m = parseNumber(colorNode?.m, NaN)
  const y = parseNumber(colorNode?.y, NaN)
  const k = parseNumber(colorNode?.k, NaN)
  if (
    Number.isFinite(c) &&
    Number.isFinite(m) &&
    Number.isFinite(y) &&
    Number.isFinite(k)
  ) {
    const rgb = cmykFractionToRgb(
      quantizeChannel(c),
      quantizeChannel(m),
      quantizeChannel(y),
      quantizeChannel(k)
    )
    return { r: rgb[0], g: rgb[1], b: rgb[2] }
  }

  return rgb ? rgbValuesToBytes(rgb.r, rgb.g, rgb.b) : null
}

function rgbValuesToBytes(
  r: XmlValue,
  g: XmlValue,
  b: XmlValue
): { r: number; g: number; b: number } {
  const values = [Number(r), Number(g), Number(b)]
  const scale = Math.max(...values) <= 1 ? 255 : 1
  return {
    r: toByte(values[0] * scale),
    g: toByte(values[1] * scale),
    b: toByte(values[2] * scale),
  }
}

function toByte(value: XmlValue): number {
  return Math.max(0, Math.min(255, Math.round(Number(value) || 0)))
}

function quantizeChannel(value: number): number {
  return Math.round(value * 100) / 100
}


export { parseOmapXml, parseOmap, readOmapFile }
