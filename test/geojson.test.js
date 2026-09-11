/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import test from 'ava'
import { coordEach } from '@turf/meta'
import { ocad, mapToGeoJson } from '../src/index.ts'
import { fixtureFile } from './helpers/fixtures.js'

async function readOcadMap(fixture) {
  return ocad.read(fixtureFile(fixture))
}

test('can convert GeoJSON', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcadMap('basic-1.ocd')
  const geoJson = mapToGeoJson(map)

  t.is(geoJson.type, 'FeatureCollection')
  t.is(geoJson.features.length, 2)

  const triangleFeature = geoJson.features[0]
  t.is(triangleFeature.type, 'Feature')
  t.is(triangleFeature.geometry.type, 'Polygon')
  if (triangleFeature.geometry.type !== 'Polygon') t.fail('Expected Polygon')
  else {
    const coords = triangleFeature.geometry.coordinates
    t.is(coords.length, 1)
    t.is(coords[0].length, 4)
  }

  const rectangleFeature = geoJson.features[1]
  t.is(rectangleFeature.type, 'Feature')
  t.is(rectangleFeature.geometry.type, 'LineString')
  if (rectangleFeature.geometry.type !== 'LineString')
    t.fail('Expected LineString')
  else {
    const coords = rectangleFeature.geometry.coordinates
    t.is(coords.length, 5)
  }
})

test('can apply CRS to GeoJSON', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcadMap('basic-1.ocd')
  const geoJson = mapToGeoJson(map)
  const crs = /** @type {{ easting: number, northing: number }} */ (
    map.getCrs()
  )

  coordEach(geoJson, c => {
    t.truthy(
      Math.abs(c[0] - crs.easting) < 4000 &&
        Math.abs(c[1] - crs.northing) < 4000,
    )
  })
})

test('can convert limited number of objects', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcadMap('basic-1.ocd')
  const geoJson = mapToGeoJson(map, {
    objects: /** @type {any} */ (map.objects.slice(0, 1)),
  })

  t.is(geoJson.type, 'FeatureCollection')
  t.is(geoJson.features.length, 1)

  const triangleFeature = geoJson.features[0]
  t.is(triangleFeature.type, 'Feature')
  t.is(triangleFeature.geometry.type, 'Polygon')
  if (triangleFeature.geometry.type !== 'Polygon') t.fail('Expected Polygon')
  else {
    const coords = triangleFeature.geometry.coordinates
    t.is(coords.length, 1)
    t.is(coords[0].length, 4)
  }
})

test('can filter symbols', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcadMap('basic-1.ocd')
  let geoJson = mapToGeoJson(map, { includeSymbols: [709003] })
  t.is(geoJson.features.length, 1)
  geoJson = mapToGeoJson(map, { includeSymbols: [709004] })
  t.is(geoJson.features.length, 0)
})
