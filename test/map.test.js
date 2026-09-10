/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import test from 'ava'
import { read as readMap, write as writeMap, Map } from '../src/index.ts'
import { fixtureFile } from './helpers/fixtures.js'
import { readOcad, ocadFileToMap } from './helpers/raw.js'

test('can normalize OCAD file to canonical Map', async (/** @type {ExecutionContext} */ t) => {
  const ocadFile = await readOcad(fixtureFile('basic-1.ocd'))
  const map = ocadFileToMap(ocadFile)

  t.true(map instanceof Map)
  t.is(map.sourceFormat, 'ocad')
  t.is(map.sourceFile, ocadFile)
  t.is(map.metadata.version, 12)
  t.is(map.objects.length, ocadFile.objects.length)
  t.is(map.symbols.length, ocadFile.symbols.length)
  t.is(map.colors.filter(Boolean).length, ocadFile.colors.filter(Boolean).length)
  t.deepEqual(map.getBounds(), ocadFile.getBounds())

  const object = map.objects[0]
  t.is(object.symbolId, ocadFile.objects[0].sym)
  t.not(object.id, undefined)
  t.truthy(object.type)
  t.is(object.coordinates, ocadFile.objects[0].coordinates)

  const symbol = map.symbols[0]
  t.is(symbol.id, ocadFile.symbols[0].symNum)
  t.truthy(symbol.type)
  t.is(symbol.name, ocadFile.symbols[0].description)
  t.true(Array.isArray(symbol.renderLayers))
})

test('readMap returns canonical Map for OCAD input', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(fixtureFile('basic-1.ocd'))

  t.true(map instanceof Map)
  t.is(map.sourceFormat, 'ocad')
  t.is(map.objects.length, 2)
  t.is(map.symbols.length, 289)
})

test('writeMap structurally round-trips OCAD-backed maps', async (/** @type {ExecutionContext} */ t) => {
  // The OCAD writer now rebuilds the file in a canonical layout (header,
  // symbols, symbol-index blocks, objects, object-index blocks, strings,
  // string-index blocks). Bytes won't match the source — see
  // test/ocad-writer.test.js for full structural round-trip coverage on
  // real-world fixtures. This is a smoke check that the basic path works.
  const source = fixtureFile('basic-1.ocd')
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocad-writer-'))
  const output = path.join(tmp, 'basic-1.ocd')
  const map = await readMap(source)

  await writeMap(map, output)

  const reread = await readMap(output)
  t.is(reread.symbols.length, map.symbols.length)
  t.is(reread.objects.length, map.objects.length)
  t.is(reread.sourceFormat, 'ocad')
})

test('OCAD symbols expose shared render layers', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(fixtureFile('basic-1.ocd'))
  const areaSymbol = map.symbols.find(symbol =>
    symbol.renderLayers.some(layer => layer.type === 'fill')
  )
  const lineSymbol = map.symbols.find(symbol =>
    symbol.renderLayers.some(layer => layer.type === 'stroke')
  )

  t.truthy(areaSymbol)
  t.truthy(lineSymbol)
  t.true(areaSymbol.renderLayers.some(layer => layer.type === 'fill'))
  t.true(lineSymbol.renderLayers.some(layer => layer.type === 'stroke'))
})
