import { escapeXmlAttr as escapeAttr } from '../../util/xml.js'
import type {
  HatchLayer,
  PointPatternLayer,
  RenderElement,
} from '../../panmap/render-layers.js'
import { getColor, type ColorLookup } from './colors.js'
import { ocadPointElementToSvg } from './point-symbols.js'

function hatchPatternToSvg(
  id: string,
  layer: HatchLayer,
  colors: ColorLookup,
): string {
  const spacing = Math.max(layer.spacing || 1, 1)
  const lineWidth = Math.max(layer.lineWidth || 1, 1)
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" patternTransform="rotate(${
    layer.angle || 0
  })" width="10" height="${spacing}"><rect x="0" y="0" width="10" height="${lineWidth}" fill="${escapeAttr(
    getColor(layer, colors),
  )}" /></pattern>`
}

/**
 * Tiled stamp pattern. `width` is the spacing along a row, `height`
 * between rows; `shiftedRows` offsets alternate rows by half a tile.
 * `elements` is the stamp, in the flat icon-primitive shape.
 */
function pointPatternToSvg(
  id: string,
  layer: PointPatternLayer,
  colors: ColorLookup,
): string {
  const width = Math.max(layer.width || 1, 1)
  const height = Math.max(layer.height || width, 1)
  const elements = (layer.elements as RenderElement[]) || []
  // One stamp per tile, centred. A shifted-rows layout repeats the stamp
  // half a tile across on the alternate row, so the SVG tile spans both
  // rows and carries the extra anchors.
  const anchors: number[][] = layer.shiftedRows
    ? [
        [width * 0.5, -height * 0.25],
        [width, -height * 0.75],
        [0, -height * 0.75],
      ]
    : [[width * 0.5, -height * 0.5]]
  const content = anchors
    .flatMap(anchor =>
      elements.map(element =>
        ocadPointElementToSvg(element, anchor, colors, coord => coord),
      ),
    )
    .filter(Boolean)
    .join('\n')
  const translateX = layer.columnOffset || 0
  const translateY = layer.rowOffset || 0
  const transforms = [
    translateX || translateY ? `translate(${translateX} ${translateY})` : '',
    layer.angle ? `rotate(${layer.angle})` : '',
  ].filter(Boolean)
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${width}" height="${height}"${
    transforms.length ? ` patternTransform="${transforms.join(' ')}"` : ''
  }>${content}</pattern>`
}

export { hatchPatternToSvg, pointPatternToSvg }
