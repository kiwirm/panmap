import { coordEach } from '@turf/meta'
import { featureCollection } from '@turf/helpers'
import Bezier from 'bezier-js'
import transformFeatures from '../map/transform.js'
import {
  LineElementType,
  AreaElementType,
  CircleElementType,
  DotElementType,
} from '../formats/ocad/native/symbol-element-types.js'
import TdPoly from '../formats/ocad/reader/decode/td-poly.js'
import { isFirstBezier, isSecondBezier, isFirstHolePoint } from '../map/coord.js'

const defaultOptions = {
  applyCrs: true,
  generateSymbolElements: true,
  exportHidden: false,
  coordinatePrecision: 6,
}

export default mapToGeoJson

/**
 * @typedef {import("geojson").Geometry} Geometry
 */
/**
 * @template {Geometry} TGeometry
 * @template {Object} TProperties
 * @typedef {import("geojson").FeatureCollection<TGeometry, TProperties>} FeatureCollection<TGeometry, TProperties>
 */
/**
 * @template {Geometry} TGeometry
 * @template {Object} TProperties
 * @typedef {import("geojson").Feature<TGeometry, TProperties>} Feature<TGeometry, TProperties>
 */

/**
 * @typedef {object} TransformFeaturesOptions
 * @property {boolean=} generateSymbolElements
 * @property {boolean=} exportHidden
 * @property {number[]=} includeSymbols
 *
 * @typedef {object} MapToGeoJsonOptionsProps
 * @property {boolean=} applyCrs transform coordinates to the file's geographic coordinates (default: `true`)
 * @property {number=} coordinatePrecision number of digits after the decimal point (default: `6`)
 *
 * @typedef {TransformFeaturesOptions & MapToGeoJsonOptionsProps} MapToGeoJsonOptions
 */

/**
 * @typedef {Object} MapObjectProperties
 * @property {number|string} id
 * @property {number|string} symbolId
 * @property {string} type
 * @property {string|undefined} text
 * @property {number|undefined} rotation
 * @property {boolean} hidden
 * @property {number|undefined} objectIndex
 * @property {number|undefined} sym
 * @property {number|undefined} otp
 * @property {boolean|undefined} unicode
 * @property {number|undefined} ang
 * @property {number|undefined} col
 * @property {number|undefined} lineWidth
 * @property {number|undefined} diamFlags
 * @property {number|undefined} serverObjectId
 * @property {number|undefined} height
 * @property {number|undefined} creationDate
 * @property {number|undefined} multirepresentationId
 * @property {number|undefined} modificationDate
 * @property {number|undefined} nItem
 * @property {number|undefined} nText
 * @property {number|undefined} nObjectString
 * @property {number|undefined} nDatabaseString
 * @property {number|undefined} objectStringType
 * @property {number|undefined} res1
 * @property {string|undefined} objectString
 * @property {string|undefined} databaseString
 */

/**
 * @typedef {Object} ElementProperties
 * @property {string} element
 * @property {number|string} parentId
 */

/**
 * Given a `Panmap` object, returns a GeoJSON `FeatureCollection`.
 *
 * @param {import("./map")} map
 * @param {MapToGeoJsonOptions=} options
 * @returns {FeatureCollection<Geometry, MapObjectProperties>}
 */
function mapToGeoJson(map, options) {
  options = { ...defaultOptions, ...options }

  const features = transformFeatures(
    map,
    mapObjectToGeoJson,
    createElement,
    options
  )
  const result = featureCollection(features)

  if (options.applyCrs && map.getCrs()) {
    applyCrs(result, map.getCrs())
  }

  coordEach(result, c => {
    c[0] = formatNum(c[0], options.coordinatePrecision)
    c[1] = formatNum(c[1], options.coordinatePrecision)
  })

  return result
}

/**
 * @param {MapToGeoJsonOptions} options
 * @param {Record<number|string, import('./map').MapSymbol>} symbols
 * @param {import('./map').MapObject} object
 * @param {number} i
 * @returns {Feature<Geometry, MapObjectProperties>[]}
 */
const mapObjectToGeoJson = (options, symbols, object, i) => {
  const symbol = symbols[object.symbolId]
  if (!symbol || (!options.exportHidden && symbol.hidden)) return

  /** @type Geometry */
  let geometry
  switch (object.type) {
    case 'point':
      geometry = {
        type: 'Point',
        coordinates: object.coordinates[0].slice(),
      }
      break
    case 'line':
      geometry = {
        type: 'LineString',
        coordinates: extractCoords(object.coordinates).map(c => c.slice()),
      }
      break
    case 'area':
      geometry = {
        type: 'Polygon',
        coordinates: coordinatesToRings(object.coordinates),
      }
      break
    case 'text':
    case 'line-text': {
      const fontSize =
        symbol.fontSize ||
        (symbol.textSymbol && symbol.textSymbol.fontSize) ||
        null
      if (!fontSize)
        throw new Error(`Text object's symbol is not a text symbol`)

      const lineHeight = (Number(fontSize) / 10) * 0.352778 * 100
      const anchorCoord = [
        object.coordinates[0][0],
        object.coordinates[0][1] + lineHeight,
      ]

      geometry = {
        type: 'Point',
        coordinates: anchorCoord,
      }
      break
    }
    default:
      return
  }

  return [
    {
      type: 'Feature',
      properties: getProperties(object),
      id: i + 1,
      geometry,
    },
  ]
}

const extractCoords = (coords: TdPoly[]): TdPoly[] => {
  const cs: TdPoly[] = []
  let lastC: TdPoly | undefined
  let cp1: TdPoly | undefined
  let cp2: TdPoly | undefined

  for (let i = 0; i < coords.length; i++) {
    const c = coords[i]

    if (isFirstBezier(c)) {
      cp1 = c
    } else if (isSecondBezier(c)) {
      cp2 = c
    } else if (cp1 && cp2) {
      const l = cp2.sub(cp1).vLength()
      const bezier = new Bezier([lastC, cp1, cp2, c].flat())
      const bezierCoords = bezier
        .getLUT(Math.round(l / 2))
        .map(bc => TdPoly.fromCoords(bc.x, bc.y))
      cs.push.apply(cs, bezierCoords.slice(1))
      cp1 = cp2 = undefined
      lastC = c
    } else {
      cs.push(c)
      lastC = c
    }
  }

  return cs
}

/**
 * @param {import('./map').MapSymbol} symbol
 * @param {string} name
 * @param {number} index
 * @param {import('../formats/ocad/reader/decode/symbol-element')} element
 * @param {TdPoly} c
 * @param {number} angle
 * @param {TransformFeaturesOptions} options
 * @param {import('./map').MapObject} object
 * @param {number} objectId
 * @returns {Feature<Geometry, ElementProperties>}
 */
const createElement = (
  symbol,
  name,
  index,
  element,
  c,
  angle,
  options,
  object,
  objectId
) => {
  /** @type Geometry */
  let geometry
  const coords = extractCoords(element.coords)
  const rotatedCoords = angle ? coords.map(lc => lc.rotate(angle)) : coords
  const translatedCoords = rotatedCoords.map(lc => lc.add(c))

  switch (element.type) {
    case LineElementType:
      geometry = {
        type: 'LineString',
        coordinates: translatedCoords,
      }
      break
    case AreaElementType:
      geometry = {
        type: 'Polygon',
        coordinates: coordinatesToRings(translatedCoords),
      }
      break
    case CircleElementType:
    case DotElementType:
      geometry = {
        type: 'Point',
        coordinates: translatedCoords[0],
      }
      break
  }

  return {
    type: 'Feature',
    properties: {
      element: `${symbol.id}-${name}-${index}`,
      parentId: object.id || objectId + 1,
    },
    id: ++options.idCount,
    geometry,
  }
}

const applyCrs = (featureCollection, crs) => {
  coordEach(featureCollection, coord => {
    const crsCoord = crs.toProjectedCoord(coord)

    coord[0] = crsCoord[0]
    coord[1] = crsCoord[1]
  })
}

function formatNum(num, digits) {
  const pow = Math.pow(10, digits === undefined ? 6 : digits)
  return Math.round(num * pow) / pow
}

const coordinatesToRings = coordinates => {
  const rings: any[][] = []
  let currentRing: any[] = []
  rings.push(currentRing)
  for (let i = 0; i < coordinates.length; i++) {
    const c = coordinates[i]
    if (isFirstHolePoint(c)) {
      currentRing.push(currentRing[0].slice())
      currentRing = []
      rings.push(currentRing)
    }

    currentRing.push(c.slice())
  }

  currentRing.push(currentRing[0].slice())

  return rings
}


/**
 * GeoJSON properties for a map object. Panmap fields only —
 * OCAD-specific aliases (`sym`/`otp`/`col`/…) are no longer emitted
 * now that the source-format sidecar is gone.
 *
 * @param {import('./map').MapObject} object
 * @returns {MapObjectProperties}
 */
function getProperties(object) {
  return {
    id: object.id,
    symbolId: object.symbolId,
    type: object.type,
    text: object.text,
    rotation: object.rotation,
    hidden: object.hidden,
    objectString: object.objectString,
    objectStringType: object.objectStringType,
  }
}
