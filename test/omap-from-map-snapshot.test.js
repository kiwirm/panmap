// Snapshot tests for `mapToOmapXml` — Phase A safety net for the
// render-layer classifier refactor. Reads an OCAD fixture, converts to
// canonical Map, emits XMap XML, and compares byte-for-byte against a
// golden file. The existing xmap-roundtrip test only checks counts and
// idempotence — it wouldn't catch a change that shifts how layers get
// classified as long as the shape survives a re-parse.
// Re-generate with UPDATE_XMAP_SNAPSHOTS=1 after intentional changes.

import test from 'ava'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readOcad from '../src/formats/ocad/read.ts'
import ocadFileToMap from '../src/formats/ocad/to-map.ts'
import { readOmap } from "./helpers/omap.js"
import omapFileToMap from '../src/formats/omap/to-map.ts'
import { mapToOmapXml } from "./helpers/omap.js"

const SNAPSHOTS_DIR = fileURLToPath(new URL('./snapshots/xmap/', import.meta.url))
const DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url))
const UPDATE = process.env.UPDATE_XMAP_SNAPSHOTS === '1'

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

async function compareOrWrite(t, snapshotName, actual) {
  await ensureDir(SNAPSHOTS_DIR)
  const filename = path.join(SNAPSHOTS_DIR, snapshotName)

  let expected
  try {
    expected = await fs.readFile(filename, 'utf-8')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  if (UPDATE || expected === undefined) {
    await fs.writeFile(filename, actual, 'utf-8')
    t.pass(`wrote snapshot ${snapshotName} (${actual.length} bytes)`)
    return
  }

  if (actual !== expected) {
    await fs.writeFile(`${filename}.actual`, actual, 'utf-8')
    t.fail(
      `snapshot ${snapshotName} diverged (${actual.length} vs expected ${expected.length} bytes). ` +
        `Wrote actual output to ${filename}.actual for diffing. ` +
        `Re-run with UPDATE_XMAP_SNAPSHOTS=1 to accept.`,
    )
    return
  }
  t.pass(`${snapshotName} matches`)
}

async function readMapFromOcad(fixture) {
  const buffer = await fs.readFile(path.join(DATA_DIR, fixture))
  const ocadFile = await readOcad(buffer)
  return ocadFileToMap(ocadFile)
}

async function readMapFromXmap(fixture) {
  const xml = await fs.readFile(path.join(DATA_DIR, fixture), 'utf-8')
  const xmap = await readOmap(xml)
  return omapFileToMap(xmap)
}

// Small deterministic fixtures. OCAD sources exercise the full
// synthesis path (canonical → xmap); an xmap source exercises the
// pass-through path where native.xmap bags are consumed.
const OCAD_FIXTURES = ['basic-1.ocd', 'double-line.ocd']
const XMAP_FIXTURES = ['ara-c122f2d.xmap']

for (const fixture of OCAD_FIXTURES) {
  test(`mapToOmapXml snapshot: ${fixture}`, async t => {
    const map = await readMapFromOcad(fixture)
    const xml = await mapToOmapXml(map)
    await compareOrWrite(t, `${fixture}.xmap`, xml)
  })
}

for (const fixture of XMAP_FIXTURES) {
  test(`mapToOmapXml snapshot: ${fixture}`, async t => {
    const map = await readMapFromXmap(fixture)
    const xml = await mapToOmapXml(map)
    await compareOrWrite(t, `${fixture}.xmap`, xml)
  })
}
