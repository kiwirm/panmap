/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'ava'
import { coordEach } from '@turf/meta'
import { ocad, mapToGeoJson } from '../src/index.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function readOcadMap(fixture) {
  return ocad.read(path.join(__dirname, 'data', fixture))
}

test('can convert GeoJSON', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcadMap('basic-1.ocd')
  const geoJson = mapToGeoJson(map)

  t.is('FeatureCollection', geoJson.type)
  t.is(2, geoJson.features.length)

  const triangleFeature = geoJson.features[0]
  t.is('Feature', triangleFeature.type)
  t.is('Polygon', triangleFeature.geometry.type)
  if (triangleFeature.geometry.type !== 'Polygon') t.fail('Expected Polygon')
  else {
    const coords = triangleFeature.geometry.coordinates
    t.is(1, coords.length)
    t.is(4, coords[0].length)
  }

  const rectangleFeature = geoJson.features[1]
  t.is('Feature', rectangleFeature.type)
  t.is('LineString', rectangleFeature.geometry.type)
  if (rectangleFeature.geometry.type !== 'LineString')
    t.fail('Expected LineString')
  else {
    const coords = rectangleFeature.geometry.coordinates
    t.is(5, coords.length)
  }
})

test('can apply CRS to GeoJSON', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcadMap('basic-1.ocd')
  const geoJson = mapToGeoJson(map)
  const crs = /** @type {{ easting: number, northing: number }} */ (map.getCrs())

  coordEach(geoJson, c => {
    t.truthy(
      Math.abs(c[0] - crs.easting) < 4000 &&
        Math.abs(c[1] - crs.northing) < 4000
    )
  })
})

test('can convert limited number of objects', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcadMap('basic-1.ocd')
  const geoJson = mapToGeoJson(map, {
    objects: /** @type {any} */ (map.objects.slice(0, 1)),
  })

  t.is('FeatureCollection', geoJson.type)
  t.is(1, geoJson.features.length)

  const triangleFeature = geoJson.features[0]
  t.is('Feature', triangleFeature.type)
  t.is('Polygon', triangleFeature.geometry.type)
  if (triangleFeature.geometry.type !== 'Polygon') t.fail('Expected Polygon')
  else {
    const coords = triangleFeature.geometry.coordinates
    t.is(1, coords.length)
    t.is(4, coords[0].length)
  }
})

test('can filter symbols', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcadMap('basic-1.ocd')
  let geoJson = mapToGeoJson(map, { includeSymbols: [709003] })
  t.is(1, geoJson.features.length)
  geoJson = mapToGeoJson(map, { includeSymbols: [709004] })
  t.is(0, geoJson.features.length)
})
