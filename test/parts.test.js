/**
 * Multi-part maps. OMap groups objects under named <part> elements and gitmap
 * carries a partId per object + a parts[] manifest; OCAD has no parts. These
 * tests exercise the part-membership round-trip that has no corpus fixture.
 *
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'ava'
import { read, gitmap } from '../src/index.ts'

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">
  <colors count="1">
    <color priority="0" name="Black"><rgb method="custom" r="0" g="0" b="0" /></color>
  </colors>
  <barrier version="6" required="0.6.0">
    <symbols count="1" id="t">
      <symbol type="2" id="10" code="501.0" name="Path"><line_symbol color="0" line_width="100" /></symbol>
    </symbols>`

const lineObject = y =>
  `<object type="1" symbol="10"><coords><coord x="0" y="${y}"/><coord x="1000" y="${y}"/></coords></object>`

const MULTIPART = `${HEAD}
    <parts count="2" current="0">
      <part name="Alpha"><objects count="1">${lineObject(0)}</objects></part>
      <part name="Beta"><objects count="1">${lineObject(1000)}</objects></part>
    </parts>
  </barrier>
</map>`

const SINGLE = `${HEAD}
    <parts count="1" current="0">
      <part name="default part"><objects count="1">${lineObject(0)}</objects></part>
    </parts>
  </barrier>
</map>`

test('multi-part OMap → model exposes parts + per-object partId', async (/** @type {ExecutionContext} */ t) => {
  const map = await read(MULTIPART)
  t.is(map.parts?.length, 2)
  t.deepEqual(
    map.parts.map(p => p.name),
    ['Alpha', 'Beta'],
  )
  t.deepEqual(
    map.parts.map(p => p.id),
    ['part_main', 'part_1'],
  )
  t.is(map.objects.length, 2)
  t.deepEqual(
    new Set(map.objects.map(o => o.partId)),
    new Set(['part_main', 'part_1']),
  )
})

test('single-part OMap keeps parts/partId undefined (behaviour unchanged)', async (/** @type {ExecutionContext} */ t) => {
  const map = await read(SINGLE)
  t.is(map.parts, undefined)
  t.true(map.objects.every(o => o.partId === undefined))
})

test('parts survive an OMap → OMap round-trip', async (/** @type {ExecutionContext} */ t) => {
  const map = await read(MULTIPART)
  const { write: writeMap } = await import('../src/index.ts')
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'parts-'))
  const out = path.join(tmp, 'm.xmap')
  await writeMap(map, out)
  const xml = await fs.readFile(out, 'utf-8')
  t.true(xml.includes('<parts count="2"'), 'emits two parts')
  t.true(
    xml.includes('<part name="Alpha">') && xml.includes('<part name="Beta">'),
  )

  const rt = await read(out)
  t.is(rt.parts?.length, 2)
  t.deepEqual(
    rt.parts.map(p => p.name),
    ['Alpha', 'Beta'],
  )
  t.is(rt.objects.filter(o => o.partId === 'part_main').length, 1)
  t.is(rt.objects.filter(o => o.partId === 'part_1').length, 1)
})

test('parts survive an OMap → gitmap → model round-trip', async (/** @type {ExecutionContext} */ t) => {
  const map = await read(MULTIPART)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'parts-gm-'))
  const pkg = path.join(tmp, 'm.gitmap')
  await gitmap.write(map, pkg, { overwrite: true })

  const objectsNdjson = await fs.readFile(
    path.join(pkg, 'objects.ndjson'),
    'utf-8',
  )
  t.true(
    objectsNdjson.includes('"partId":"part_1"'),
    'objects.ndjson carries the real partId',
  )

  const back = await read(pkg)
  t.is(back.parts?.length, 2)
  t.deepEqual(
    back.parts.map(p => p.name),
    ['Alpha', 'Beta'],
  )
  t.deepEqual(
    new Set(back.objects.map(o => o.partId)),
    new Set(['part_main', 'part_1']),
  )
})
