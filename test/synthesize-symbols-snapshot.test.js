// Snapshot tests for OCAD `synthesizeSymbols` — Phase A safety net for
// the render-layer classifier refactor. Reads a non-OCAD fixture,
// converts to canonical Map, runs the OCAD symbol synthesis path, and
// compares the resulting record array against a golden file.
// Re-generate with UPDATE_SYNTH_SNAPSHOTS=1 after intentional changes.

import test from 'ava'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readOmap } from "./helpers/omap.js"
import omapFileToMap from '../src/formats/omap/to-map.ts'
import { synthesizeSymbols } from '../src/formats/ocad/synthesize/symbols.ts'

import { fixtureFile } from './helpers/fixtures.js'
const SNAPSHOTS_DIR = fileURLToPath(new URL('./snapshots/synthesize/', import.meta.url))
const UPDATE = process.env.UPDATE_SYNTH_SNAPSHOTS === '1'

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true })
}

// Buffers and typed arrays don't JSON-stringify usefully; iconBits in
// particular is a 484-byte zero-filled buffer that would dominate the
// snapshot. Replace them with a compact marker so real classification
// differences stay visible.
function replacer(_key, value) {
  if (value && typeof value === 'object') {
    if (value.type === 'Buffer' && Array.isArray(value.data)) {
      return `<Buffer len=${value.data.length}>`
    }
    if (ArrayBuffer.isView(value)) {
      return `<${value.constructor.name} len=${value.byteLength}>`
    }
    if (Buffer.isBuffer?.(value)) {
      return `<Buffer len=${value.length}>`
    }
  }
  return value
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
        `Re-run with UPDATE_SYNTH_SNAPSHOTS=1 to accept.`,
    )
    return
  }
  t.pass(`${snapshotName} matches`)
}

async function readMapFromXmap(fixture) {
  const xml = await fs.readFile(fixtureFile(fixture), 'utf-8')
  const xmap = await readOmap(xml)
  return omapFileToMap(xmap)
}

// Small deterministic xmap fixture — forces the from-scratch OCAD
// synthesis path (source !== 'ocad'), unlike OCAD-sourced maps which
// pass raw symbol records straight through.
const XMAP_FIXTURES = ['ara-c122f2d.xmap']

for (const fixture of XMAP_FIXTURES) {
  test(`synthesizeSymbols snapshot: ${fixture}`, async t => {
    const map = await readMapFromXmap(fixture)
    const records = synthesizeSymbols(map.symbols, map.colors, map.sourceFormat)
    const json = JSON.stringify(records, replacer, 2) + '\n'
    await compareOrWrite(t, `${fixture}.json`, json)
  })
}
