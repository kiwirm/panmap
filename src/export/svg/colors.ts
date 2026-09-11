import { LINE_ELEMENT_LAYER_KEYS } from '../../panmap/coord.js'
import { cmykFractionToRgb } from '../../util/cmyk-to-rgb.js'

function opacityAttr(layer) {
  return layer.opacity === undefined ? '' : ` opacity="${layer.opacity}"`
}

function getSymbolsById(map) {
  return map.symbols.reduce((symbols, symbol) => {
    symbols[symbol.id] = symbol
    return symbols
  }, {})
}

function getColorsById(map) {
  return map.colors.reduce((colors, color) => {
    if (color) colors[color.id] = normaliseColorRgb(color)
    return colors
  }, {})
}

// Recover from source files that carry `<rgb method="custom" r=0 g=0 b=0/>`
// on a colour whose CMYK is not black. Mapper (and Purple Pen and OOM
// itself) recompute the on-screen RGB from CMYK in that case; do the
// same so a colour like "Green 45%" doesn't paint pure black just
// because the file's custom RGB slot was never populated.
const RGB_BLACK = 'rgb(0, 0, 0)'
function normaliseColorRgb(color) {
  if (color.rgb !== RGB_BLACK) return color
  const cmyk = color.cmyk
  if (!Array.isArray(cmyk) || cmyk.length < 4) return color
  const nonBlack = cmyk[0] > 0 || cmyk[1] > 0 || cmyk[2] > 0
  const notFullK = (cmyk[3] || 0) < 1
  if (!nonBlack || !notFullK) return color
  const rgb = cmykFractionToRgb(cmyk[0], cmyk[1], cmyk[2], cmyk[3])
  return { ...color, rgb: `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` }
}

function getColor(layer, colors) {
  return colors[layer.colorId] ? colors[layer.colorId].rgb : 'rgb(0, 0, 0)'
}

/**
 * A color id can be either a numeric OCAD-style id (>= 0 means "set")
 * or a Panmap string id from a gitmap-remapped Map. Rejects
 * null / undefined / negative numbers ("no color"); accepts any
 * non-empty string.
 */
function isValidColorId(id: unknown): boolean {
  if (id === null || id === undefined) return false
  if (typeof id === 'number') return id >= 0
  if (typeof id === 'string') return id.length > 0
  return false
}

function getColorOrder(layer, colors) {
  if (colors[layer.colorId]) return colors[layer.colorId].renderOrder

  const colorIds: unknown[] = []
  if (Array.isArray(layer.elements)) {
    layer.elements.forEach(element => colorIds.push(element.color))
  }
  LINE_ELEMENT_LAYER_KEYS.forEach(key => {
    if (key === 'secSymElements') return
    if (Array.isArray(layer[key])) {
      layer[key].forEach(element => colorIds.push(element.color))
    }
  })

  const orders = colorIds
    .map(colorId => {
      const key = colorId as string | number
      return colors[key] ? colors[key].renderOrder : null
    })
    .filter(order => order !== null)

  return orders.length ? Math.max(...orders) : 0
}

/**
 * Resolve a primitive's render order. Every SVG primitive knows the
 * colour it paints in; that colour's `renderOrder` is the canonical
 * paint depth (Mapper's colour priority). When the colour isn't
 * resolvable (e.g. `colorId = -1` on an intentionally-invisible slot
 * used for composition), fall back to the containing layer's derived
 * order so the primitive at least paints somewhere sensible.
 *
 * Kept as one function so every renderer path (`pointElementToSvg`,
 * `xmapPointSymbolToSvg`, `lineSymbolsLayerToSvg`) resolves orders
 * with the exact same fallback logic — bugs like "green ring paints
 * under white halo because they were joined in one string" reduce to
 * "every primitive resolved with the same helper".
 */
function orderFor(colorId: unknown, layer, colors): number {
  const key = colorId as string | number
  if (colors[key]) return colors[key].renderOrder
  return getColorOrder(layer, colors)
}

function getElementColorOrder(element, colors) {
  return colors[element.color] ? colors[element.color].renderOrder : 0
}

export {
  opacityAttr,
  getSymbolsById,
  getColorsById,
  getColor,
  isValidColorId,
  getColorOrder,
  orderFor,
  getElementColorOrder,
}
