import { escapeXmlAttr as escapeAttr } from '../../util/xml.js'
import { getColor } from './colors.js'
import { ocadPointElementToSvg, xmapPointSymbolToSvg } from './point-symbols.js'

function hatchPatternToSvg(id, layer, colors) {
  const spacing = Math.max(layer.spacing || 1, 1)
  const lineWidth = Math.max(layer.lineWidth || 1, 1)
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" patternTransform="rotate(${
    layer.angle || 0
  })" width="10" height="${spacing}"><rect x="0" y="0" width="10" height="${lineWidth}" fill="${escapeAttr(
    getColor(layer, colors),
  )}" /></pattern>`
}

function structurePatternToSvg(id, layer, colors) {
  const width = Math.max(layer.width || layer.symbolWidth || 1, 1)
  const height = Math.max(layer.height || layer.symbolHeight || 1, 1)
  const symbolWidth = Math.max(layer.symbolWidth || width, 1)
  const symbolHeight = Math.max(layer.symbolHeight || height, 1)
  const anchors = [[symbolWidth * 0.5, -symbolHeight * 0.5]]

  if (layer.mode === 2) {
    anchors.push([symbolWidth, -symbolHeight * 1.5])
    anchors.push([0, -symbolHeight * 1.5])
  }

  const content = anchors
    .flatMap(anchor =>
      (layer.elements || []).map(element =>
        ocadPointElementToSvg(element, anchor, colors, coord => coord),
      ),
    )
    .filter(Boolean)
    .join('\n')

  return `<pattern id="${id}" patternUnits="userSpaceOnUse" patternTransform="rotate(${
    layer.angle || 0
  })" width="${width}" height="${height}">${content}</pattern>`
}

function pointPatternToSvg(id, layer, colors) {
  const width = Math.max(layer.width || 1, 1)
  const height = Math.max(layer.height || width, 1)
  const pattern = layer.pattern || {}
  const content = pattern.symbol
    ? xmapPointSymbolToSvg(pattern.symbol, width / 2, height / 2, colors)
    : ''
  const translateX = pattern.offsetAlongLine || 0
  const translateY = pattern.lineOffset || 0
  const transforms = [
    translateX || translateY ? `translate(${translateX} ${translateY})` : '',
    layer.angle ? `rotate(${layer.angle})` : '',
  ].filter(Boolean)

  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${width}" height="${height}"${
    transforms.length ? ` patternTransform="${transforms.join(' ')}"` : ''
  }>${content}</pattern>`
}

export { hatchPatternToSvg, structurePatternToSvg, pointPatternToSvg }
