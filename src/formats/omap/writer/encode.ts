/**
 * XMap record → XML string serialisers: turn the intermediate OmapSymbol /
 * OmapObject records (built by from-panmap.ts) into XMap XML. The write entry
 * (index.ts) walks the map and calls `xmapSymbolToXml` per symbol. Mirrors
 * OCAD's `writer/encode/` stage.
 */
import { cleanNumber } from '../../../util/number.js'
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
import type { RawOmapSymbol } from './from-panmap/index.js'
import { attr, attrs, boolAttr, dim, indent, text } from './xml.js'

export function xmapSymbolToXml(symbol: RawOmapSymbol, id?: number): string {
  const symbolAttrs = [
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

  if (!children.length) return `<symbol ${symbolAttrs}/>`
  return [
    `<symbol ${symbolAttrs}>`,
    ...children.map(child => indent(child, 2)),
    '</symbol>',
  ].join('\n')
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
          element.symbol
            ? indent(xmapSymbolToXml(element.symbol, undefined), 2)
            : '',
          element.object ? indent(xmapObjectToXml(element.object), 2) : '',
          '</element>',
        ]
          .filter(Boolean)
          .join('\n'),
        2,
      ),
    ),
    '</point_symbol>',
  ].join('\n')
}

function xmapLineSymbolToXml(symbol: OmapLineSymbol): string {
  const children = [
    ...(symbol.borders && symbol.borders.length
      ? [xmapLineBordersToXml(symbol.borders)]
      : []),
    symbol.dashSymbol && xmapNestedSymbolXml('dash_symbol', symbol.dashSymbol),
    symbol.midSymbol && xmapNestedSymbolXml('mid_symbol', symbol.midSymbol),
    symbol.startSymbol &&
      xmapNestedSymbolXml('start_symbol', symbol.startSymbol),
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
    show_at_least_one_symbol:
      symbol.showAtLeastOneSymbol === false ? 'false' : 'true',
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
  return [
    `${open}>`,
    ...children.map(child => indent(child, 2)),
    '</line_symbol>',
  ].join('\n')
}

function xmapLineBordersToXml(borders: OmapLineBorder[]): string {
  return [
    '<borders>',
    ...borders.map(border => {
      const b = border
      return `  <border${attrs({
        color: b.color ?? -1,
        width: dim(b.width || 0),
        shift: dim(b.shift || 0),
        dashed: boolAttr(b.dashed),
        dash_length: b.dashLength !== undefined ? dim(b.dashLength) : undefined,
        break_length:
          b.breakLength !== undefined ? dim(b.breakLength) : undefined,
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

function xmapPatternToXml(pattern: OmapAreaPattern): string {
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
    line_width:
      pattern.lineWidth !== undefined ? dim(pattern.lineWidth) : undefined,
  })}`
  if (!children.length) return `${open}/>`
  return [`${open}>`, ...children, '</pattern>'].join('\n')
}

function xmapTextSymbolToXml(symbol: OmapTextSymbol): string {
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
          [
            '<part private="true">',
            indent(xmapSymbolToXml(part.symbol, undefined), 2),
            '</part>',
          ].join('\n'),
          2,
        )
      }
      return `  <part symbol="${attr(part.symbolRef)}"/>`
    }),
    '</combined_symbol>',
  ].join('\n')
}

function xmapNestedSymbolXml(tag: string, symbol: RawOmapSymbol): string {
  return [
    `<${tag}>`,
    indent(xmapSymbolToXml(symbol, undefined), 2),
    `</${tag}>`,
  ].join('\n')
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
    ...coordinates.map(
      coord =>
        `    <coord${attrs({
          x: dim(coord.x || 0),
          y: dim(coord.y || 0),
          flags: coord.flags,
        })}/>`,
    ),
    '  </coords>',
  ]
  if (object.text) lines.push(`  <text>${text(object.text)}</text>`)
  lines.push('</object>')
  return lines.join('\n')
}
