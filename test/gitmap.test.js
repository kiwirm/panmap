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
import { fixtureFile } from './helpers/fixtures.js'
const readOcad = ocad.readRaw
const ocadFileToMap = ocad.toMap
const readGitmap = gitmap.read
const writeGitmap = gitmap.write

test('can write and read a GitMap package deterministically', async (/** @type {ExecutionContext} */ t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gitmap-'))
  const first = path.join(tmp, 'first.gitmap')
  const second = path.join(tmp, 'second.gitmap')
  const ocadFile = await readOcad(fixtureFile('basic-1.ocd'))
  const map = ocadFileToMap(ocadFile)

  await writeGitmap(map, first)
  await writeGitmap(map, second)

  const files = ['manifest.json', 'colors.ndjson', 'symbols.ndjson', 'objects.ndjson']
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
  const ocadFile = await readOcad(fixtureFile('basic-1.ocd'))

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
            <coords count="4">
              <coord x="0" y="0" flags="1" />
              <coord x="100" y="100" />
              <coord x="200" y="100" />
              <coord x="300" y="0" flags="0" />
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

  // Canonical symbol code: OCAD's variant-zero suffix ".0" collapses to "501"
  // (OMap already writes it that way), so an OCD- and OMap-sourced copy agree.
  t.is(symbols[0].code, '501')
  // v2 coords are compact tuples: a plain vertex is `[x, y]`; the two Bézier
  // control points carry a semantic `{ control: true }` third element (the raw
  // OCAD xFlags 1/2 and the OMap curve-start byte are not stored).
  t.deepEqual(object.coordinates[0], [0, 0])
  t.deepEqual(object.coordinates[1][2], { control: true })
  t.deepEqual(object.coordinates[2][2], { control: true })
  t.true(object.coordinates.every(c => c.length === 2 || (c[2] && c[2].omapFlags === undefined)))
  // The semantic flags reconstruct to OCAD's cp1/cp2 xFlags on read (control
  // points come in pairs: first is cp1 = 0x01, second is cp2 = 0x02).
  t.is(roundTrip.objects[0].coordinates[1].xFlags, 1)
  t.is(roundTrip.objects[0].coordinates[2].xFlags, 2)
})
