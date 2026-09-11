import type { MapObject } from '../../panmap/model.js'
import type { TextLayer } from '../../panmap/render-layers.js'
import type { FlaggedCoord } from '../../panmap/coord.js'
import {
  escapeXmlAttr as escapeAttr,
  escapeXmlText as escapeText,
} from '../../util/xml.js'
import { getColor, opacityAttr, type ColorLookup } from './colors.js'
import type { Transform } from './path.js'

function textLayerToSvg(
  object: MapObject,
  layer: TextLayer,
  colors: ColorLookup,
  transform: Transform,
): string | null {
  const first = (object.coordinates as FlaggedCoord[])[0]
  const coord = first && transform(first)
  if (!coord || !object.text) return null

  // Object rotation is stored in radians, positive CCW in the source
  // format's y-up frame (OMAP + OCAD both). SVG's y-axis points DOWN,
  // so its `rotate()` is positive CW visually — apply the axis flip
  // by negating before converting to degrees.
  const rotation = object.rotation || 0
  const transformAttr = rotation
    ? ` transform="rotate(${(-rotation * 180) / Math.PI} ${coord[0]} ${coord[1]})"`
    : ''

  // Internal fontSize is millimetres. Map coordinates in the SVG
  // viewBox are 0.01mm units (100 units = 1mm). Multiply by 100 so
  // text renders at its true physical size relative to the map.
  const fontSize = ((layer.fontSize as number) || 0.12) * 100

  // Mapper text alignment: hAlign 0=left, 1=center, 2=right; vAlign
  // 0=baseline, 1=top, 2=middle, 3=bottom. Map to SVG text-anchor +
  // dominant-baseline so the anchor point sits where Mapper places it.
  const hAlign = object.hAlign
  const vAlign = object.vAlign
  const anchor = hAlign === 1 ? 'middle' : hAlign === 2 ? 'end' : 'start'
  const baseline =
    vAlign === 1
      ? 'hanging'
      : vAlign === 2
        ? 'central'
        : vAlign === 3
          ? 'text-after-edge'
          : 'alphabetic'
  const anchorAttr = anchor !== 'start' ? ` text-anchor="${anchor}"` : ''
  const baselineAttr =
    baseline !== 'alphabetic' ? ` dominant-baseline="${baseline}"` : ''

  // Newlines produce real line breaks. SVG's <text> collapses white-
  // space, so multi-line labels have to be split into one <tspan> per
  // line. Each line inherits x= from the parent <text> and steps down
  // by 1em (well — dy is relative to the previous line, so first line
  // uses 0 and subsequent lines use 1em).
  const lines = String(object.text).split(/\r\n?|\n/)
  const inner =
    lines.length === 1
      ? escapeText(lines[0])
      : lines
          .map(
            (line, i) =>
              `<tspan x="${coord[0]}"${i === 0 ? '' : ' dy="1em"'}>${escapeText(line)}</tspan>`,
          )
          .join('')

  return `<text x="${coord[0]}" y="${coord[1]}"${transformAttr} fill="${escapeAttr(
    getColor(layer, colors),
  )}" font-family="${escapeAttr(layer.fontFamily || 'Arial')}" font-size="${fontSize}"${anchorAttr}${baselineAttr}${opacityAttr(layer)}>${inner}</text>`
}

export { textLayerToSvg }
