/**
 * XMap XML emitter — `Panmap` → XML string.
 *
 * The write path splits into two files: `from-map.ts` converts a
 * `MapSymbol` / `MapObject` into an intermediate XMap
 * record, and this file walks the map and serializes those records
 * (plus map-level chrome — colours, notes, georeferencing, parts) to
 * XMap XML.
 */
import fs from 'node:fs/promises'
import { XMLBuilder } from 'fast-xml-parser'
import { ATTR_PREFIX, MAP_UNIT_SCALE } from '../native.js'
import type Panmap from '../../../panmap/model.js'
import type {
  MapColor,
  MapCrs,
  MapObject,
  MapPart,
  MapPrint,
  MapSymbol,
  MapTemplates,
  MapView,
} from '../../../panmap/model.js'
import type {
  OmapAreaPattern,
  OmapAreaSymbol,
  OmapCombinedSymbol,
  OmapLineBorder,
  OmapLineSymbol,
  OmapObject,
  OmapPointSymbol,
  OmapTextSymbol,
} from '../native.js'
import { formatNotes } from '../../extensions.js'
import { coordinatesForOmap } from '../codecs/index.js'
import { needsYFlip } from '../../codecs/index.js'
import { escapeXmlAttr as xmlAttr } from '../../../util/xml.js'
import {
  toOmapSymbol,
  colorIdMap,
  symbolIdMap,
  omapObjectType,
} from './from-panmap.js'
import type { RawOmapSymbol } from './from-panmap.js'

/** XMap pattern / text symbol shapes as they actually appear in parsed
 *  records — the strict interfaces omit optional fields the writer emits. */
type RawOmapPattern = OmapAreaPattern & { noClipping?: number }
type RawOmapTextSymbol = OmapTextSymbol & { iconText?: string }

const extrasBuilder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
  // Without this, XMLBuilder collapses `attr="true"`/`"false"` to a
  // value-less boolean attribute (`<el open>`), which is lossy round-trip.
  suppressBooleanAttributes: false,
})

async function writeOmap(map: Panmap, filename: string): Promise<void> {
  await fs.writeFile(filename, mapToOmapXml(map), 'utf-8')
}

function mapToOmapXml(map: Panmap): string {
  const colorIds = colorIdMap(map.colors.filter(Boolean))
  const symbolIds = symbolIdMap(map.symbols)
  // Objects reference symbols by string id, but OMAP requires unique
  // numeric ids per symbol *instance*. When two panmap symbols share a
  // string id (e.g. two variants of ISOM 201.2 collapsed by
  // `stableSymbolId`), route object references to a *visible* variant
  // if one exists — otherwise every object bound to the hidden variant
  // silently disappears (see red-zone 401: "Open land" hidden, "Open
  // land, dominant" visible; both share sym_401).
  const objectSymbolIds = new Map<string | number, number>()
  const isSymbolHidden = (s: MapSymbol): boolean =>
    !!(s as { hidden?: boolean }).hidden
  for (const symbol of map.symbols) {
    if (isSymbolHidden(symbol)) continue
    if (objectSymbolIds.has(symbol.id)) continue
    const n = symbolIds.get(symbol)
    if (n !== undefined) objectSymbolIds.set(symbol.id, n)
  }
  // Fall back to any (including hidden) for ids that have no visible
  // variant, so objects can still reference their symbol.
  for (const symbol of map.symbols) {
    if (objectSymbolIds.has(symbol.id)) continue
    const n = symbolIds.get(symbol)
    if (n !== undefined) objectSymbolIds.set(symbol.id, n)
  }
  const flipY = needsYFlip(map.sourceFormat, 'omap')

  const mapAttrs = mapAttributes()
  const barrierAttrs = barrierAttributes()

  const notesText = formatNotes(map.notes, map.extensions)
  const viewXml = renderViewFromCanonical(map.view)
  const printXml = renderPrintFromCanonical(map.print)
  const templatesXml = renderTemplatesFromCanonical(map.templates)
  const georefXml = renderGeoreferencingFromCanonical(map.georeferencing)

  // Extras emitted under <map> (after <colors>, before <barrier>) follow
  // the order Mapper uses: georeferencing, notes, templates, view, print.
  const mapExtras = [
    georefXml,
    notesText ? renderExtra('notes', notesText) : '',
    templatesXml,
    viewXml,
    printXml,
  ].filter(Boolean)

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<map ${mapAttrs}>`,
    colorsToXml(map.colors.filter(Boolean), colorIds),
    ...mapExtras,
    `<barrier ${barrierAttrs}>`,
    symbolsToXml(map.symbols, symbolIds, colorIds),
    partsToXml(map.objects, map.parts, objectSymbolIds, flipY),
    '</barrier>',
    '</map>',
    '',
  ]
    .filter(s => s !== '')
    .join('\n')
}

function mapAttributes(): string {
  return formatAttributes({
    xmlns: 'http://openorienteering.org/apps/mapper/xml/v2',
    version: '9',
  })
}

function barrierAttributes(): string {
  return formatAttributes({ version: '6', required: '0.6.0' })
}

function formatAttributes(attrs: Record<string, string>): string {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}="${attr(String(v))}"`)
    .join(' ')
}

function renderExtra(tag: string, value: unknown): string {
  if (value === undefined || value === null) return ''
  return extrasBuilder.build({ [tag]: value }).trimEnd()
}

function renderGeoreferencingFromCanonical(crs: MapCrs | undefined): string {
  if (!crs) return ''
  const attrs: string[] = []
  if (crs.scale !== undefined) attrs.push(`scale="${crs.scale}"`)
  if (crs.gridScaleFactor !== undefined) attrs.push(`grid_scale_factor="${crs.gridScaleFactor}"`)
  if (crs.auxiliaryScaleFactor !== undefined) attrs.push(`auxiliary_scale_factor="${crs.auxiliaryScaleFactor}"`)
  if (crs.declination !== undefined) attrs.push(`declination="${crs.declination}"`)
  if (crs.grivation !== undefined) attrs.push(`grivation="${crs.grivation}"`)
  const parts: string[] = [`<georeferencing${attrs.length ? ' ' + attrs.join(' ') : ''}>`]
  if (crs.refPoint) {
    parts.push(`  <ref_point x="${crs.refPoint.x}" y="${crs.refPoint.y}"/>`)
  }
  if (crs.projected) {
    const p = crs.projected
    parts.push(`  <projected_crs id="${xmlAttr(p.id)}">`)
    if (p.spec) {
      parts.push(`    <spec language="${xmlAttr(p.spec.language)}">${p.spec.value}</spec>`)
    }
    if (p.parameter !== undefined) parts.push(`    <parameter>${p.parameter}</parameter>`)
    if (p.refPoint) {
      parts.push(`    <ref_point x="${p.refPoint.x}" y="${p.refPoint.y}"/>`)
    }
    parts.push(`  </projected_crs>`)
  }
  if (crs.geographic) {
    const g = crs.geographic
    parts.push(`  <geographic_crs id="${xmlAttr(g.id)}">`)
    if (g.spec) {
      parts.push(`    <spec language="${xmlAttr(g.spec.language)}">${g.spec.value}</spec>`)
    }
    if (g.refPointDeg) {
      parts.push(`    <ref_point_deg lat="${g.refPointDeg.lat}" lon="${g.refPointDeg.lon}"/>`)
    }
    parts.push(`  </geographic_crs>`)
  }
  parts.push('</georeferencing>')
  return parts.join('\n')
}

function renderTemplatesFromCanonical(templates: MapTemplates | undefined): string {
  if (!templates) return ''
  const items = templates.items ?? []
  const rootAttrs: string[] = [`count="${items.length}"`]
  if (templates.firstFrontTemplate !== undefined) {
    rootAttrs.push(`first_front_template="${templates.firstFrontTemplate}"`)
  }
  const parts: string[] = [`<templates ${rootAttrs.join(' ')}>`]
  for (const t of items) {
    const attrs: string[] = []
    if (t.type !== undefined) attrs.push(`type="${xmlAttr(t.type)}"`)
    if (t.open !== undefined) attrs.push(`open="${t.open}"`)
    if (t.name !== undefined) attrs.push(`name="${xmlAttr(t.name)}"`)
    if (t.path !== undefined) attrs.push(`path="${xmlAttr(t.path)}"`)
    if (t.relpath !== undefined) attrs.push(`relpath="${xmlAttr(t.relpath)}"`)
    if (!t.transformations) {
      parts.push(`  <template ${attrs.join(' ')}/>`)
      continue
    }
    parts.push(`  <template ${attrs.join(' ')}>`)
    const tr = t.transformations
    const trAttrs: string[] = []
    if (tr.adjustmentDirty !== undefined) trAttrs.push(`adjustment_dirty="${tr.adjustmentDirty}"`)
    if (tr.passpoints !== undefined) trAttrs.push(`passpoints="${tr.passpoints}"`)
    parts.push(`    <transformations${trAttrs.length ? ' ' + trAttrs.join(' ') : ''}>`)
    if (tr.active) parts.push(renderTransform('active', tr.active))
    if (tr.other) parts.push(renderTransform('other', tr.other))
    parts.push(renderMatrix('map_to_template', tr.mapToTemplate))
    parts.push(renderMatrix('template_to_map', tr.templateToMap))
    parts.push(renderMatrix('template_to_map_other', tr.templateToMapOther))
    parts.push('    </transformations>')
    parts.push('  </template>')
  }
  if (templates.defaults) {
    const d = templates.defaults
    const dAttrs: string[] = []
    if (d.useMetersPerPixel !== undefined) dAttrs.push(`use_meters_per_pixel="${d.useMetersPerPixel}"`)
    if (d.metersPerPixel !== undefined) dAttrs.push(`meters_per_pixel="${d.metersPerPixel}"`)
    if (d.dpi !== undefined) dAttrs.push(`dpi="${d.dpi}"`)
    if (d.scale !== undefined) dAttrs.push(`scale="${d.scale}"`)
    parts.push(`  <defaults${dAttrs.length ? ' ' + dAttrs.join(' ') : ''}/>`)
  }
  parts.push('</templates>')
  return parts.join('\n')
}

function renderTransform(role: string, t: NonNullable<MapTemplates['items'][number]['transformations']>['active']): string {
  const attrs: string[] = [`role="${role}"`]
  if (t?.x !== undefined) attrs.push(`x="${t.x}"`)
  if (t?.y !== undefined) attrs.push(`y="${t.y}"`)
  if (t?.scaleX !== undefined) attrs.push(`scale_x="${t.scaleX}"`)
  if (t?.scaleY !== undefined) attrs.push(`scale_y="${t.scaleY}"`)
  if (t?.rotation !== undefined) attrs.push(`rotation="${t.rotation}"`)
  return `      <transformation ${attrs.join(' ')}/>`
}

function renderMatrix(role: string, values: number[] | undefined): string {
  if (!values || values.length === 0) {
    return `      <matrix role="${role}" n="0" m="0"/>`
  }
  const n = Math.round(Math.sqrt(values.length))
  const dim = n * n === values.length ? n : 1
  const rows = [`      <matrix role="${role}" n="${dim}" m="${dim}">`]
  for (const v of values) rows.push(`        <element value="${v}"/>`)
  rows.push('      </matrix>')
  return rows.join('\n')
}

function renderPrintFromCanonical(print: MapPrint | undefined): string {
  if (!print) return ''
  const attrs: string[] = []
  if (print.scale !== undefined) attrs.push(`scale="${print.scale}"`)
  if (print.resolution !== undefined) attrs.push(`resolution="${print.resolution}"`)
  if (print.mode !== undefined) attrs.push(`mode="${xmlAttr(print.mode)}"`)
  const openTag = `<print${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  const parts: string[] = [openTag]
  const pf = print.pageFormat
  if (pf) {
    const pfAttrs: string[] = []
    if (pf.paperSize !== undefined) pfAttrs.push(`paper_size="${xmlAttr(pf.paperSize)}"`)
    if (pf.orientation !== undefined) pfAttrs.push(`orientation="${pf.orientation}"`)
    if (pf.hOverlap !== undefined) pfAttrs.push(`h_overlap="${pf.hOverlap}"`)
    if (pf.vOverlap !== undefined) pfAttrs.push(`v_overlap="${pf.vOverlap}"`)
    parts.push(`  <page_format${pfAttrs.length ? ' ' + pfAttrs.join(' ') : ''}>`)
    if (pf.dimensions) {
      parts.push(`    <dimensions width="${pf.dimensions.width}" height="${pf.dimensions.height}"/>`)
    }
    if (pf.pageRect) {
      parts.push(`    <page_rect left="${pf.pageRect.left}" top="${pf.pageRect.top}" width="${pf.pageRect.width}" height="${pf.pageRect.height}"/>`)
    }
    parts.push(`  </page_format>`)
  }
  if (print.printArea) {
    parts.push(`  <print_area left="${print.printArea.left}" top="${print.printArea.top}" width="${print.printArea.width}" height="${print.printArea.height}"/>`)
  }
  parts.push('</print>')
  return parts.join('\n')
}

/**
 * Serialise a `MapView` into an xmap `<view><map_view/></view>`
 * subtree. Canonical `center` is OCAD-y-up mm; xmap needs y-down µm.
 */
function renderViewFromCanonical(view: MapView | undefined): string {
  if (!view) return ''
  const attrs: string[] = []
  if (view.zoom !== undefined) attrs.push(`zoom="${view.zoom}"`)
  if (view.rotation !== undefined) attrs.push(`rotation="${view.rotation}"`)
  if (view.center) {
    attrs.push(`position_x="${Math.round(view.center.x * 1000)}"`)
    attrs.push(`position_y="${Math.round(-view.center.y * 1000)}"`)
  }
  return `<view>\n  <map_view${attrs.length ? ' ' + attrs.join(' ') : ''}/>\n</view>`
}

function colorsToXml(colors: MapColor[], colorIds: Map<string | number, number>): string {
  return block(
    `colors count="${colors.length}"`,
    colors
      .slice()
      .sort((a, b) => (a.renderOrder ?? 0) - (b.renderOrder ?? 0))
      .map(color => {
        const rgb = parseRgb(color.rgb)
        // Use Panmap cmyk when present (both OCAD and XMap sources carry
        // it); fall back to recomputing from RGB only when absent.
        const cmyk = color.cmyk
          ? { c: color.cmyk[0], m: color.cmyk[1], y: color.cmyk[2], k: color.cmyk[3] }
          : rgbToCmyk(rgb)
        const opacity = color.opacity ?? 1
        return [
          `  <color priority="${attr(colorIds.get(color.id) || 0)}" name="${attr(color.name || '')}" c="${cmyk.c}" m="${cmyk.m}" y="${cmyk.y}" k="${cmyk.k}" opacity="${opacity}">`,
          '    <cmyk method="custom"/>',
          `    <rgb method="custom" r="${rgb.r / 255}" g="${rgb.g / 255}" b="${rgb.b / 255}" />`,
          '  </color>',
        ].join('\n')
      })
  )
}

function symbolsToXml(
  symbols: MapSymbol[],
  symbolIds: Map<MapSymbol, number>,
  colorIds: Map<string | number, number>
): string {
  return block(
    `symbols count="${symbols.length}" id="panmap"`,
    symbols
      .slice()
      .sort((a, b) => String(a.code || a.id).localeCompare(String(b.code || b.id)))
      .map(symbol => symbolToXml(symbol, symbolIds, colorIds))
  )
}

function symbolToXml(
  symbol: MapSymbol,
  symbolIds: Map<MapSymbol, number>,
  colorIds: Map<string | number, number>
): string {
  const targetId = symbolIds.get(symbol) ?? Number(symbol.sourceId) ?? 0
  const synthetic = toOmapSymbol(symbol, targetId, colorIds)
  return indent(xmapSymbolToXml(synthetic, targetId), 2)
}

function partsToXml(
  objects: MapObject[],
  parts: MapPart[] | undefined,
  symbolIds: Map<string | number, number>,
  flipY: boolean
): string {
  const renderPart = (name: string, partObjects: MapObject[]): string => {
    const visible = partObjects.filter(object => !object.hidden)
    const objectsXml = block(
      `objects count="${visible.length}"`,
      visible.map(object => objectToXml(object, symbolIds, flipY))
    )
    return [
      `  <part name="${attr(name)}">`,
      indent(objectsXml, 4),
      '  </part>',
    ].join('\n')
  }

  if (parts && parts.length > 1) {
    const firstId = parts[0].id
    return block(
      `parts count="${parts.length}" current="0"`,
      parts.map(part =>
        renderPart(
          part.name ?? 'default part',
          objects.filter(object => (object.partId ?? firstId) === part.id)
        )
      )
    )
  }

  return block('parts count="1" current="0"', [
    renderPart('default part', objects),
  ])
}

function objectToXml(
  object: MapObject,
  symbolIds: Map<string | number, number>,
  flipY: boolean
): string {
  const coordinates = coordinatesForOmap(
    object.coordinates || [],
  )

  // Base attributes
  let objAttrs = `type="${omapObjectType(object)}" symbol="${attr(symbolIds.get(object.symbolId) || 0)}"`
  if (object.rotation) objAttrs += ` rotation="${object.rotation}"`
  if (object.hAlign !== undefined) objAttrs += ` h_align="${attr(object.hAlign)}"`
  if (object.vAlign !== undefined) objAttrs += ` v_align="${attr(object.vAlign)}"`

  const lines = [
    `  <object ${objAttrs}>`,
    `    <coords count="${coordinates.length}">`,
    ...coordinates.map(coord => coordToXml(coord, flipY)),
    '    </coords>',
  ]

  if (object.text) lines.push(`    <text>${text(object.text)}</text>`)

  if (object.textBox) {
    lines.push(
      `    <size width="${attr(dim(object.textBox.width))}" height="${attr(dim(object.textBox.height))}" />`
    )
  }
  if (object.pattern) {
    const p = object.pattern
    let patternStr = `    <pattern`
    if (p.rotation !== undefined) patternStr += ` rotation="${attr(p.rotation)}"`
    if (p.origin) {
      patternStr +=
        `>\n      <coord x="${attr(dim(p.origin.x))}" y="${attr(dim(p.origin.y))}" />\n    </pattern>`
    } else {
      patternStr += ' />'
    }
    lines.push(patternStr)
  }

  lines.push('  </object>')
  return lines.join('\n')
}

function coordToXml(coord, flipY = false): string {
  const flagAttr = coord.flags !== undefined ? ` flags="${attr(coord.flags)}"` : ''
  return `      <coord x="${dim(coord[0])}" y="${dim(flipY ? -coord[1] : coord[1])}"${flagAttr}/>`
}

function block(name: string, children: string[]): string {
  const tag = name.split(/\s+/, 1)[0]
  if (!children.length) return `  <${name}/>`
  return [`  <${name}>`, children.join('\n'), `  </${tag}>`].join('\n')
}

function indent(value: string, spaces: number): string {
  const padding = ' '.repeat(spaces)
  return value
    .split('\n')
    .map(line => `${padding}${line}`)
    .join('\n')
}

function dim(value: number): number {
  return cleanNumber(value / MAP_UNIT_SCALE)
}

function cleanNumber(value: number): number {
  return Number.isInteger(value) ? value : Number(value.toFixed(3))
}

// The XMap serialiser escapes `"` inside text content as well as attributes,
// so both `attr` and `text` here map through the attribute escaper.

function attr(value: unknown): string {
  return xmlAttr(value)
}

function text(value: string): string {
  return xmlAttr(value)
}

function parseRgb(value: string | undefined) {
  const match = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(value || '')
  if (!match) return { r: 0, g: 0, b: 0 }
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
  }
}

function rgbToCmyk(rgb: { r: number; g: number; b: number }) {
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const k = 1 - Math.max(r, g, b)
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 1 }
  return {
    c: cleanNumber((1 - r - k) / (1 - k)),
    m: cleanNumber((1 - g - k) / (1 - k)),
    y: cleanNumber((1 - b - k) / (1 - k)),
    k: cleanNumber(k),
  }
}
function xmapSymbolToXml(symbol: RawOmapSymbol, id?: number): string {
  const attrs = [
    `type="${attr(symbol.type ?? 0)}"`,
    id !== undefined ? `id="${attr(id)}"` : '',
    symbol.code !== undefined ? `code="${attr(symbol.code)}"` : '',
    symbol.name !== undefined ? `name="${attr(symbol.name)}"` : '',
    // Round-trip Mapper's UI-hide flag. Only emit when true so the
    // XML stays clean for the (much more common) unhidden case.
    symbol.isHidden ? `is_hidden="true"` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const children = [
    symbol.pointSymbol && xmapPointSymbolToXml(symbol.pointSymbol),
    symbol.lineSymbol && xmapLineSymbolToXml(symbol.lineSymbol),
    symbol.areaSymbol && xmapAreaSymbolToXml(symbol.areaSymbol),
    symbol.textSymbol && xmapTextSymbolToXml(symbol.textSymbol),
    symbol.combinedSymbol && xmapCombinedSymbolToXml(symbol.combinedSymbol),
  ].filter(Boolean) as string[]

  if (!children.length) return `<symbol ${attrs}/>`
  return [`<symbol ${attrs}>`, ...children.map(child => indent(child, 2)), '</symbol>'].join('\n')
}

function xmapPointSymbolToXml(symbol: OmapPointSymbol): string {
  const elements = symbol.elements || []
  if (!elements.length) {
    return `<point_symbol${attrs({
      rotatable: symbol.rotatable ? 'true' : undefined,
      inner_radius: dim(symbol.innerRadius || 0),
      inner_color: symbol.innerColor ?? -1,
      outer_width: dim(symbol.outerWidth || 0),
      outer_color: symbol.outerColor ?? -1,
      elements: 0,
    })}/>`
  }

  return [
    `<point_symbol${attrs({
      rotatable: symbol.rotatable ? 'true' : undefined,
      inner_radius: dim(symbol.innerRadius || 0),
      inner_color: symbol.innerColor ?? -1,
      outer_width: dim(symbol.outerWidth || 0),
      outer_color: symbol.outerColor ?? -1,
      elements: elements.length,
    })}>`,
    ...elements.map(element =>
      indent(
        [
          '<element>',
          element.symbol ? indent(xmapSymbolToXml(element.symbol, undefined), 2) : '',
          element.object ? indent(xmapObjectToXml(element.object), 2) : '',
          '</element>',
        ]
          .filter(Boolean)
          .join('\n'),
        2
      )
    ),
    '</point_symbol>',
  ].join('\n')
}

function xmapLineSymbolToXml(symbol: OmapLineSymbol): string {
  const children = [
    ...(symbol.borders && symbol.borders.length ? [xmapLineBordersToXml(symbol.borders)] : []),
    symbol.dashSymbol && xmapNestedSymbolXml('dash_symbol', symbol.dashSymbol),
    symbol.midSymbol && xmapNestedSymbolXml('mid_symbol', symbol.midSymbol),
    symbol.startSymbol && xmapNestedSymbolXml('start_symbol', symbol.startSymbol),
    symbol.endSymbol && xmapNestedSymbolXml('end_symbol', symbol.endSymbol),
  ].filter(Boolean) as string[]
  const open = `<line_symbol${attrs({
    color: symbol.color ?? -1,
    line_width: dim(symbol.lineWidth || 0),
    minimum_length: dim(symbol.minimumLength || 0),
    join_style: symbol.joinStyle ?? 0,
    cap_style: symbol.capStyle ?? 0,
    start_offset: dim(symbol.startOffset || 0),
    end_offset: dim(symbol.endOffset || 0),
    dashed: boolAttr(symbol.dashed),
    segment_length: dim(symbol.segmentLength ?? 400),
    end_length: dim(symbol.endLength || 0),
    show_at_least_one_symbol: symbol.showAtLeastOneSymbol === false ? 'false' : 'true',
    minimum_mid_symbol_count: symbol.minimumMidSymbolCount ?? 0,
    minimum_mid_symbol_count_when_closed:
      symbol.minimumMidSymbolCountWhenClosed ?? 0,
    dash_length: dim(symbol.dashLength || 400),
    break_length: dim(symbol.breakLength || 100),
    dashes_in_group: symbol.dashesInGroup ?? 1,
    in_group_break_length: dim(symbol.inGroupBreakLength || 50),
    mid_symbols_per_spot: symbol.midSymbolsPerSpot ?? 1,
    mid_symbol_distance: dim(symbol.midSymbolDistance || 0),
    mid_symbol_placement: symbol.midSymbolPlacement,
    suppress_dash_symbol_at_ends: boolAttr(symbol.suppressDashSymbolAtEnds),
    scale_dash_symbol: symbol.scaleDashSymbol === false ? 'false' : undefined,
  })}`

  if (!children.length) return `${open}/>`
  return [`${open}>`, ...children.map(child => indent(child, 2)), '</line_symbol>'].join('\n')
}

function xmapLineBordersToXml(borders: OmapLineBorder[]): string {
  return [
    '<borders>',
    ...borders.map(border => {
      const b = border as OmapLineBorder & {
        dashed?: boolean; dashLength?: number; breakLength?: number;
      }
      return `  <border${attrs({
        color: b.color ?? -1,
        width: dim(b.width || 0),
        shift: dim(b.shift || 0),
        dashed: boolAttr(b.dashed),
        dash_length: b.dashLength !== undefined ? dim(b.dashLength) : undefined,
        break_length: b.breakLength !== undefined ? dim(b.breakLength) : undefined,
      })}/>`
    }),
    '</borders>',
  ].join('\n')
}

function xmapAreaSymbolToXml(symbol: OmapAreaSymbol): string {
  const patterns = symbol.patterns || []
  if (!patterns.length) {
    return `<area_symbol${attrs({
      inner_color: symbol.innerColor ?? -1,
      min_area: 0,
      patterns: 0,
    })}/>`
  }

  return [
    `<area_symbol${attrs({
      inner_color: symbol.innerColor ?? -1,
      min_area: 0,
      patterns: patterns.length,
    })}>`,
    ...patterns.map(pattern => indent(xmapPatternToXml(pattern), 2)),
    '</area_symbol>',
  ].join('\n')
}

function xmapPatternToXml(pattern: RawOmapPattern): string {
  const children = pattern.symbol
    ? [indent(xmapSymbolToXml(pattern.symbol, undefined), 2)]
    : []
  const open = `<pattern${attrs({
    type: pattern.type ?? 0,
    angle: pattern.angle ?? 0,
    // no_clipping is a numeric enum (0/1/2), not a bool
    no_clipping: pattern.noClipping,
    rotatable: boolAttr(pattern.rotatable),
    line_spacing: dim(pattern.lineSpacing || 0),
    line_offset: dim(pattern.lineOffset || 0),
    offset_along_line: dim(pattern.offsetAlongLine || 0),
    point_distance: dim(pattern.pointDistance || 0),
    color: pattern.color,
    line_width: pattern.lineWidth !== undefined ? dim(pattern.lineWidth) : undefined,
  })}`
  if (!children.length) return `${open}/>`
  return [`${open}>`, ...children, '</pattern>'].join('\n')
}

function xmapTextSymbolToXml(symbol: RawOmapTextSymbol): string {
  return [
    `<text_symbol${attrs({
      icon_text: symbol.iconText || '',
      rotatable: boolAttr(symbol.rotatable),
    })}>`,
    `  <font${attrs({
      family: symbol.fontFamily || 'Arial',
      // Internal fontSize is millimetres (see OMAP reader + OCAD
      // reader/writer contract). XMap serialises font size as µm
      // (1/1000 mm), so multiply by 1000 rather than the coord-unit
      // ×10 that `dim` applies.
      size: cleanNumber((symbol.fontSize || 0) * 1000),
      bold: boolAttr(symbol.bold),
      italic: boolAttr(symbol.italic),
    })}/>`,
    `  <text${attrs({
      color: symbol.color ?? -1,
      line_spacing: symbol.lineSpacing ?? 1,
      paragraph_spacing: symbol.paragraphSpacing ?? 0,
      character_spacing: symbol.characterSpacing ?? 0,
    })}/>`,
    '</text_symbol>',
  ].join('\n')
}

function xmapCombinedSymbolToXml(symbol: OmapCombinedSymbol): string {
  const parts = symbol.parts || []
  return [
    `<combined_symbol parts="${parts.length}">`,
    ...parts.map(part => {
      if (part.symbol) {
        return indent(
          ['<part private="true">', indent(xmapSymbolToXml(part.symbol, undefined), 2), '</part>'].join('\n'),
          2
        )
      }
      return `  <part symbol="${attr(part.symbolRef)}"/>`
    }),
    '</combined_symbol>',
  ].join('\n')
}

function xmapNestedSymbolXml(tag: string, symbol: RawOmapSymbol): string {
  return [`<${tag}>`, indent(xmapSymbolToXml(symbol, undefined), 2), `</${tag}>`].join('\n')
}

function xmapObjectToXml(object: OmapObject): string {
  const coordinates = object.coords || []
  const lines = [
    `<object${attrs({
      type: object.type,
      symbol: object.symbol,
      rotation: object.rotation,
      h_align: object.hAlign,
      v_align: object.vAlign,
    })}>`,
    `  <coords count="${coordinates.length}">`,
    ...coordinates.map((coord) => `    <coord${attrs({
      x: dim(coord.x || 0),
      y: dim(coord.y || 0),
      flags: coord.flags,
    })}/>`),
    '  </coords>',
  ]
  if (object.text) lines.push(`  <text>${text(object.text)}</text>`)
  lines.push('</object>')
  return lines.join('\n')
}

function attrs(values: Record<string, unknown>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ` ${key}="${attr(value)}"`)
    .join('')
}

function boolAttr(value: unknown): string | undefined {
  return value === undefined ? undefined : value ? 'true' : 'false'
}

export { writeOmap }
export default writeOmap
