import type Panmap from '../../panmap/model.js'
import { getSymbolsById } from './colors.js'

const supportedLayerTypes = new Set([
  'stroke',
  'fill',
  'hatch-fill',
  'structure-fill',
  'line-elements',
  'double-line',
  'border-symbol',
  'line-symbols',
  'point-pattern-fill',
  'point-fill',
  'point-stroke',
  'point-elements',
  'text',
])

export interface UnsupportedRenderReason {
  symbolId: number | string
  objectId: number | string
  reason: string
  count: number
}

export interface MapSvgRenderSupport {
  direct: boolean
  objectCount: number
  supportedObjectCount: number
  unsupportedObjectCount: number
  unsupported: UnsupportedRenderReason[]
}

/**
 * Reports whether a map can be rendered directly from Panmap render layers.
 */
function getMapSvgRenderSupport(map: Panmap): MapSvgRenderSupport {
  const symbols = getSymbolsById(map)
  const unsupportedByKey: Record<string, UnsupportedRenderReason> = {}
  let supportedObjectCount = 0

  map.objects.forEach(object => {
    const symbol = symbols[object.symbolId]
    const reasons = getUnsupportedReasons(object, symbol)
    if (reasons.length === 0) {
      supportedObjectCount++
      return
    }

    reasons.forEach(reason => {
      const key = `${object.symbolId}:${reason}`
      if (!unsupportedByKey[key]) {
        unsupportedByKey[key] = {
          symbolId: object.symbolId,
          objectId: object.id,
          reason,
          count: 0,
        }
      }
      unsupportedByKey[key].count++
    })
  })

  const unsupported = Object.values(unsupportedByKey)

  return {
    direct: unsupported.length === 0,
    objectCount: map.objects.length,
    supportedObjectCount,
    unsupportedObjectCount: map.objects.length - supportedObjectCount,
    unsupported,
  }
}

function getUnsupportedReasons(object, symbol) {
  const reasons: string[] = []

  if (!symbol) return ['missing symbol']
  if (symbol.hidden || object.hidden) return []

  const layers = symbol.layers || []
  if (layers.length === 0) reasons.push('no render layers')

  layers.forEach(layer => {
    if (!supportedLayerTypes.has(layer.type)) {
      reasons.push(`unsupported layer ${layer.type}`)
    }
    if (!canRenderObjectLayer(object, layer)) {
      reasons.push(
        `layer ${layer.type} does not render object type ${object.type}`,
      )
    }
  })

  return Array.from(new Set(reasons))
}

function canRenderObjectLayer(object, layer) {
  switch (object.type) {
    case 'line':
      return (
        layer.type === 'stroke' ||
        layer.type === 'line-elements' ||
        layer.type === 'double-line' ||
        layer.type === 'line-symbols'
      )
    case 'area':
      return (
        layer.type === 'fill' ||
        layer.type === 'stroke' ||
        layer.type === 'hatch-fill' ||
        layer.type === 'structure-fill' ||
        layer.type === 'border-symbol' ||
        layer.type === 'point-pattern-fill'
      )
    case 'point':
      return (
        layer.type === 'point-fill' ||
        layer.type === 'point-stroke' ||
        layer.type === 'point-elements'
      )
    case 'text':
    case 'line-text':
      return layer.type === 'text'
    default:
      return false
  }
}

export { getMapSvgRenderSupport }
