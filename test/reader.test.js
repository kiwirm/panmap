/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import { Buffer } from 'node:buffer'
import test from 'ava'
import { fixtureFile } from './helpers/fixtures.js'
import { readOcad } from './helpers/raw.js'

test('too small files can not be opened', async (/** @type {ExecutionContext} */ t) => {
  await t.throwsAsync(() => readOcad(Buffer.alloc(10)))
})

test('can open valid file', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcad(fixtureFile('basic-1.ocd'))
  t.is(map.header.version, 12, 'Version mismatch')
  t.is(map.header.subVersion, 0, 'Subversion mismatch')
  t.is(map.header.subSubVersion, 0, 'Subsubversion mismatch')
  t.is(map.header.symbolIndexBlock, 4164, 'First symbol index block')
  t.is(map.header.objectIndexBlock, 5196, 'First object index block')
})

test('can read symbols from file', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcad(fixtureFile('basic-1.ocd'))
  t.is(map.symbols.length, 289)
})

test('can read objects from file', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcad(fixtureFile('basic-1.ocd'))
  t.is(map.objects.length, 2)
})

test('can get CRS', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcad(fixtureFile('basic-1.ocd'))
  const crs = map.getCrs()
  t.is(crs.easting, 316000)
  t.is(crs.northing, 6404000)
  t.is(crs.scale, 15000)
  t.is(crs.code, 3006)
  t.is(crs.catalog, 'EPSG')
})

test('can convert to projected CRS', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcad(fixtureFile('basic-1.ocd'))
  const crs = map.getCrs()
  t.deepEqual(crs.toProjectedCoord([0, 0]), [316000, 6404000])
})

test('can convert to map coord', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcad(fixtureFile('basic-1.ocd'))
  const crs = map.getCrs()
  t.deepEqual(crs.toMapCoord([316000, 6404000]), [0, 0])
})
