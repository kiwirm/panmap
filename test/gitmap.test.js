/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'ava'
import {
  read as readMap,
  ocad,
  gitmap,
  mapToSvg,
} from '../src/index.ts'
const readOcad = ocad.readRaw
const ocadFileToMap = ocad.toMap
const readGitmap = gitmap.read
const writeGitmap = gitmap.write

test('can write and read a GitMap package deterministically', async (/** @type {ExecutionContext} */ t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitmap-'))
  const first = path.join(tmp, 'first.gitmap')
  const second = path.join(tmp, 'second.gitmap')
  const ocadFile = await readOcad(path.join('test', 'data', 'basic-1.ocd'))
  const map = ocadFileToMap(ocadFile)

  await writeGitmap(map, first)
  await writeGitmap(map, second)

  const files = ['gitmap.json', 'colors.ndjson', 'symbols.ndjson', 'parts.json', 'objects.ndjson']
  for (const file of files) {
    t.is(
      await fs.readFile(path.join(first, file), 'utf-8'),
      await fs.readFile(path.join(second, file), 'utf-8'),
      `${file} should be deterministic`
    )
  }

  const roundTrip = await readGitmap(first)
  t.is(roundTrip.sourceFormat, 'gitmap')
  t.is(roundTrip.objects.length, map.objects.length)
  t.is(roundTrip.symbols.length, map.symbols.length)
  t.is(mapToSvg(roundTrip).tagName, 'svg')
})

test('readMap supports GitMap package directories', async (/** @type {ExecutionContext} */ t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitmap-'))
  const directory = path.join(tmp, 'map.gitmap')
  const ocadFile = await readOcad(path.join('test', 'data', 'basic-1.ocd'))

  await writeGitmap(ocadFileToMap(ocadFile), directory)

  const map = await readMap(directory)
  t.is(map.sourceFormat, 'gitmap')
  t.true(map.objects.length > 0)
})

test('GitMap preserves Mapper source symbols and coordinate flags', async (/** @type {ExecutionContext} */ t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitmap-'))
  const directory = path.join(tmp, 'map.gitmap')
  const xmap = `<?xml version="1.0" encoding="UTF-8"?>
<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">
  <colors count="1">
    <color priority="0" name="Black"><rgb method="custom" r="0" g="0" b="0" /></color>
  </colors>
  <barrier version="6" required="0.6.0">
    <symbols count="1" id="test">
      <symbol type="2" id="10" code="501.0" name="Path">
        <line_symbol color="0" line_width="100" />
      </symbol>
    </symbols>
    <parts count="1" current="0">
      <part name="default part">
        <objects count="1">
          <object type="1" symbol="10">
            <coords count="2">
              <coord x="0" y="0" flags="0" />
              <coord x="1000" y="0" flags="1" />
            </coords>
          </object>
        </objects>
      </part>
    </parts>
  </barrier>
</map>`
  const map = await readMap(xmap)

  await writeGitmap(map, directory)

  const symbolsText = await fs.readFile(path.join(directory, 'symbols.ndjson'), 'utf-8')
  const symbols = symbolsText.trim().split('\n').map(line => JSON.parse(line))
  const object = JSON.parse(
    (await fs.readFile(path.join(directory, 'objects.ndjson'), 'utf-8')).trim()
  )
  const roundTrip = await readGitmap(directory)

  t.is(symbols[0].code, '501.0')
  // Coords are always emitted in `{x, y, ...nonZeroFlags}` form.
  // Zero-flag coord has no flag properties; non-zero flag survives.
  t.deepEqual(object.coordinates[0], { x: 0, y: 0 })
  t.is(object.coordinates[1].omapFlags, 1)
  t.is(roundTrip.objects[0].coordinates[0].omapFlags ?? 0, 0)
  t.is(roundTrip.objects[0].coordinates[1].omapFlags, 1)
})
