// Snapshot tests for mapToSvg — a safety net for the svg.ts split refactor.
// Reads a fixture, converts to canonical Map, renders SVG, and compares
// against a golden file. On first run (or after intentional changes)
// re-generate with UPDATE_SVG_SNAPSHOTS=1.

import test from 'ava'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { XMLSerializer } from '@xmldom/xmldom'
import readOcad from '../src/formats/ocad/reader/decode/index.ts'
import ocadFileToMap from '../src/formats/ocad/reader/to-panmap.ts'
import { readOmap } from "./helpers/omap.js"
import omapFileToMap from '../src/formats/omap/reader/to-panmap.ts'
import mapToSvg from '../src/export/svg/index.ts'
import { fixtureFile } from './helpers/fixtures.js'

const serializer = new XMLSerializer()
const svgString = (map) => serializer.serializeToString(mapToSvg(map))

const SNAPSHOTS_DIR = fileURLToPath(new URL('./snapshots/svg/', import.meta.url))
const UPDATE = process.env.UPDATE_SVG_SNAPSHOTS === '1'

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
    // On divergence, write a `.actual` file next to the golden so a human
    // can diff them without having to re-run with UPDATE.
    await fs.writeFile(`${filename}.actual`, actual, 'utf-8')
    t.fail(
      `snapshot ${snapshotName} diverged (${actual.length} vs expected ${expected.length} bytes). ` +
        `Wrote actual output to ${filename}.actual for diffing. ` +
        `Re-run with UPDATE_SVG_SNAPSHOTS=1 to accept.`,
    )
    return
  }
  t.pass(`${snapshotName} matches`)
}

async function readMapFromOcad(fixture) {
  const buffer = await fs.readFile(fixtureFile(fixture))
  const ocadFile = await readOcad(buffer)
  return ocadFileToMap(ocadFile)
}

async function readMapFromXmap(fixture) {
  const xml = await fs.readFile(fixtureFile(fixture), 'utf-8')
  const xmap = await readOmap(xml)
  return omapFileToMap(xmap)
}

// Small, deterministic fixtures. Larger ones (bottle-lake, port-hills)
// take too long for a fast snapshot suite; we're guarding refactors, not
// exhaustively validating rendering.
const OCAD_FIXTURES = ['basic-1.ocd', 'double-line.ocd']
const XMAP_FIXTURES = ['ara-c122f2d.xmap']

for (const fixture of OCAD_FIXTURES) {
  test(`svg snapshot: ${fixture}`, async t => {
    const map = await readMapFromOcad(fixture)
    const svg = svgString(map)
    await compareOrWrite(t, `${fixture}.svg`, svg)
  })
}

for (const fixture of XMAP_FIXTURES) {
  test(`svg snapshot: ${fixture}`, async t => {
    const map = await readMapFromXmap(fixture)
    const svg = svgString(map)
    await compareOrWrite(t, `${fixture}.svg`, svg)
  })
}
