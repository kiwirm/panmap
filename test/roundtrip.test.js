/**
 * Round-trip idempotence — the canonical-form safety net.
 *
 * GitMap is a canonical representation: the same map must serialise to the same
 * bytes no matter how it got there. That makes a format's writer and reader an
 * INVERSE PAIR on the canonical projection — `read(write(M))` must gitmap-
 * serialise identically to `M`. If a writer applies a transform (e.g. OCAD's
 * hole-flag shift, or the Y-flip) that its reader doesn't exactly undo, the
 * second gitmap drifts and this test fails.
 *
 * This is the mechanical guard against the class of "read/write drift" bug where
 * one direction of a paired transform is added or changed without the other.
 * (It would have caught a spurious hole-flag back-shift in the OCAD reader: that
 * introduced off-by-one yFlags, so the round-tripped objects.ndjson no longer
 * matched.)
 *
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'ava'
import { read, gitmap, write } from '../src/index.ts'
import { fixtureFile } from './helpers/fixtures.js'

// Read `file`, serialise to a gitmap package, and return the raw bytes of each
// package file. Comparing bytes (not parsed objects) is the point: gitmap is
// defined by its serialisation, so byte-equality is the canonical-form contract.
async function gitmapFiles(map) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-'))
  const pkg = path.join(dir, 'm.gitmap')
  await gitmap.write(map, pkg, { overwrite: true })
  const readFile = name => fs.readFile(path.join(pkg, name), 'utf-8')
  return {
    objects: await readFile('objects.ndjson'),
    symbols: await readFile('symbols.ndjson'),
    colors: await readFile('colors.ndjson'),
  }
}

// M -> gitmap(G0); M -> native format F -> read back -> gitmap(G1).
// A format whose writer/reader are true inverses yields G0 === G1.
async function roundTrip(file, format) {
  const m0 = await read(file)
  const before = await gitmapFiles(m0)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-'))
  const out = path.join(dir, `out.${format}`)
  await write(m0, out)
  const m1 = await read(out)
  const after = await gitmapFiles(m1)
  return { before, after }
}

const FIXTURES = [
  { name: 'basic-1', file: fixtureFile('basic-1.ocd'), format: 'ocd' },
  { name: 'bottle-lake', file: fixtureFile('bottle-lake-5c6c8e6.xmap'), format: 'xmap' },
]

for (const { name, file, format } of FIXTURES) {
  // Geometry is fully canonical today: object coordinates and flags survive a
  // format round-trip byte-for-byte. This assertion is the guard — any change
  // that makes a writer/reader pair non-inverse on geometry (a hole-flag shift,
  // a Y-flip regression, a coordinate-precision drift) turns it red.
  test(`objects.ndjson is stable across a ${format} round-trip (${name})`, async (/** @type {ExecutionContext} */ t) => {
    const { before, after } = await roundTrip(file, format)
    t.is(after.objects, before.objects)
  })

  // Symbols are NOT yet canonical: the readers speak different render-layer
  // dialects and the writers don't reproduce them, so even a same-format
  // round-trip drifts (OCD ~19 lines, XMAP ~105). This is a KNOWN gap (the
  // symbol renderLayers dialect — see the gitmap spec's roadmap) — promote to
  // `test(...)` with a byte assertion once the render-layer model is
  // canonicalised, and this becomes the regression guard for that work.
  test.todo(`symbols.ndjson stable across a ${format} round-trip (${name}) — pending symbol canonicalisation`)
}

// End-to-end guard for the hole-flag codec on REAL holed data: bottle-lake has
// hundreds of multi-ring areas. A full OCD write applies the forward shift and
// the read must apply the exact inverse, so every hole flag must land on the
// same coord index it started on. (Before the reader inverse existed, all 235
// interior hole flags walked one coord forward per round-trip.)
test('OCD write→read preserves every area hole-flag position (bottle-lake)', async (/** @type {ExecutionContext} */ t) => {
  const HOLE = 0x02
  const m0 = await read(fixtureFile('bottle-lake-5c6c8e6.xmap'))
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-'))
  const ocd = path.join(dir, 'm.ocd')
  await write(m0, ocd)
  const m1 = await read(ocd)

  const holeIdx = obj => (obj.coordinates || [])
    .map((c, i) => ((c.yFlags ?? 0) & HOLE) ? i : -1)
    .filter(i => i >= 0)

  let interiorHoles = 0
  const n = Math.min(m0.objects.length, m1.objects.length)
  for (let k = 0; k < n; k++) {
    const a = m0.objects[k].coordinates || []
    if (a.length !== (m1.objects[k].coordinates || []).length) continue
    const before = holeIdx(m0.objects[k])
    const after = holeIdx(m1.objects[k])
    t.deepEqual(after, before, `object ${k} hole-flag positions`)
    interiorHoles += before.filter(i => i < a.length - 1).length
  }
  // Guard against the assertion passing vacuously — the fixture must actually
  // contain interior holes for this to be meaningful.
  t.true(interiorHoles > 100, `expected many interior holes, saw ${interiorHoles}`)
})
