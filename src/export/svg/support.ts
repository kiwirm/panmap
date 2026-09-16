import type Panmap from '../../panmap/model.js'
import type { MapObject, MapSymbol } from '../../panmap/model.js'
import { getSymbolsById } from './colors.js'
import { canRenderObjectLayer, supportedLayerTypes } from './dispatch.js'

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

function getUnsupportedReasons(
  object: MapObject,
  symbol: MapSymbol | undefined,
): string[] {
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

export { getMapSvgRenderSupport }
