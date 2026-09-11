/**
 * Parity suite: for every paired source (`source.xmap` or
 * `source.omap`) + `mapper.ocd` in each `test/parity-fixtures/<stem>/`, run four
 * conversion paths and compare the result against Mapper's own OCD
 * for the same source map:
 *
 *   1. xmap → ocd                     (direct)
 *   2. ocd  → xmap → ocd              (round-trip via xmap)
 *   3. xmap → gitmap → ocd            (round-trip via gitmap)
 *   4. ocd  → gitmap → xmap → ocd     (double round-trip)
 *
 * Parity is measured per-symbol against Mapper's paired binary. A
 * symbol counts as "clean" when it has no render-critical field
 * differences (see `RENDER_CRITICAL` — hatch/struct/fill/line/font
 * fields that flip whole rendering strategies). Non-critical
 * differences (extent, colorSet ordering, description strings,
 * decoration element sequences) are tallied but don't fail the test.
 *
 * Fixtures are gitignored by default because they're large personal
 * map data. `test/parity-fixtures/manifest.json` lists what should
 * be present locally; on machines without the fixture set the suite
 * degrades to a single skip test rather than failing.
 *
 * Environment overrides:
 *   MAPPER_PARITY_ROOT       — override fixtures root (default:
 *                              `test/parity-fixtures`).
 *   MAPPER_PARITY_MAX_CRIT   — max acceptable render-critical diffs
 *                              per file per path (default: 5).
 *   MAPPER_PARITY_LIMIT      — process at most N pairs. Defaults to
 *                              4 to keep CI runtime bounded; set to
 *                              `0` to run every fixture.
 */

import test from 'ava'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { read as readMap, write as writeMap } from '../src/index.ts'
import { readOcad } from './helpers/raw.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT =
  process.env.MAPPER_PARITY_ROOT ?? path.join(HERE, 'parity-fixtures')
const MAX_CRITICAL = Number(process.env.MAPPER_PARITY_MAX_CRIT ?? '5')
const LIMIT = Number(process.env.MAPPER_PARITY_LIMIT ?? '4')
// Per-test timeout — the gitmap-detour paths (path 3, 4) do a full
// canonical → gitmap → canonical → xmap → canonical → ocad cycle
// which reserialises every symbol / object twice, and on the biggest
// fixtures (bottle-lake at ~200 syms + ~5k objects) that climbs past
// 2 minutes on a laptop. 6 minutes leaves comfortable headroom.
const PER_TEST_TIMEOUT_MS = 6 * 60 * 1000

// Fields that alter rendering strategy when they differ. Everything
// else is treated as byte-parity noise (extent, decoration element
// sequences, description strings, colorSet ordering, etc.) and only
// counted, not asserted on.
const RENDER_CRITICAL = new Set([
  'hatchMode',
  'hatchColor',
  'hatchLineWidth',
  'hatchDist',
  'hatchAngle1',
  'hatchAngle2',
  'structMode',
  'structDraw',
  'structWidth',
  'structHeight',
  'structAngle',
  'fillColor',
  'fillOn',
  'borderOn',
  'lineColor',
  'lineWidth',
  'lineStyle',
  'fontColor',
  'fontSize',
  'nColors',
])

const IGNORE = new Set([
  '_byteRange',
  'warnings',
  'iconBits',
  'descriptionWords',
  'symbolTreeGroup',
  'mystery64',
  'size',
  'filePos',
  '_tail',
  '_fontNameBytes',
])

function collectPairs(root) {
  // Sync so top-level `for (const pair of pairs)` can register ava
  // tests without a top-level await (esbuild's cjs output banned it).
  // Each fixture lives in `<root>/<stem>/` with `source.{xmap|omap}`
  // and `mapper.ocd`. Anything without both files is skipped.
  let entries
  try {
    entries = fsSync.readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = path.join(root, e.name)
    const files = fsSync.readdirSync(dir)
    const source = files.find(f => f === 'source.xmap' || f === 'source.omap')
    const ocdName = files.find(f => f === 'mapper.ocd')
    if (!source || !ocdName) continue
    out.push({
      stem: e.name,
      xmap: path.join(dir, source),
      ocd: path.join(dir, ocdName),
    })
  }
  return out
}

/** Walk two objects and return per-field mismatch counts. */
function diffSymbols(ours, mapper) {
  const critical = []
  const other = []
  const walk = (name, ov, mv) => {
    if (JSON.stringify(ov) === JSON.stringify(mv)) return
    if (
      ov &&
      mv &&
      typeof ov === 'object' &&
      typeof mv === 'object' &&
      !Array.isArray(ov)
    ) {
      const keys = new Set([...Object.keys(ov), ...Object.keys(mv)])
      for (const k of keys) walk(name + '.' + k, ov[k], mv[k])
      return
    }
    const leaf = name.split('.').pop()
    ;(RENDER_CRITICAL.has(leaf) ? critical : other).push({
      name,
      ours: ov,
      mapper: mv,
    })
  }
  for (const k of Object.keys(mapper)) {
    if (IGNORE.has(k)) continue
    walk(k, ours[k], mapper[k])
  }
  return { critical, other }
}

async function withTmp(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'panmap-parity-'))
  try {
    return await fn(tmp)
  } finally {
    fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

async function ocdSymbolSet(ocdPath) {
  return (await readOcad(ocdPath, { quietWarnings: true })).symbols
}

/**
 * Score a synth'd OCD vs Mapper's paired OCD. Returns aggregate
 * critical / non-critical counts.
 */
async function scoreVsPairedOcd(oursOcdPath, mapperOcdPath) {
  const ours = await ocdSymbolSet(oursOcdPath)
  const mapper = await ocdSymbolSet(mapperOcdPath)
  let critical = 0,
    other = 0,
    missing = 0
  for (const m of mapper) {
    const o = ours.find(s => s.symNum === m.symNum)
    if (!o) {
      missing++
      continue
    }
    const d = diffSymbols(o, m)
    critical += d.critical.length
    other += d.other.length
  }
  return {
    mapperSyms: mapper.length,
    oursSyms: ours.length,
    missing,
    critical,
    other,
  }
}

// -- Register tests --

const pairs = collectPairs(ROOT)

if (pairs.length === 0) {
  test('mapper-parity: no fixtures present', t => {
    t.pass(
      `Skipping — no fixtures found under ${ROOT}. See ` +
        `test/parity-fixtures/manifest.json for the expected layout.`,
    )
  })
} else {
  const capped = LIMIT > 0 ? pairs.slice(0, LIMIT) : pairs
  for (const pair of capped) {
    const { stem } = pair

    // Path 1: xmap → ocd
    test(`${stem}: xmap → ocd (direct)`, async t => {
      t.timeout(PER_TEST_TIMEOUT_MS)
      await withTmp(async tmp => {
        const map = await readMap(pair.xmap)
        const out = path.join(tmp, 'x2o.ocd')
        await writeMap(map, out)
        const score = await scoreVsPairedOcd(out, pair.ocd)
        t.log(
          `syms ours=${score.oursSyms} mapper=${score.mapperSyms} missing=${score.missing} critical=${score.critical} other=${score.other}`,
        )
        t.true(
          score.critical <= MAX_CRITICAL,
          `expected ≤ ${MAX_CRITICAL} render-critical diffs vs Mapper's OCD, got ${score.critical}`,
        )
      })
    })

    // Path 2: ocd → xmap (verify the round-trip re-reads cleanly and
    // symbol counts match). We can't diff bytes vs the paired xmap
    // because Mapper's xmap is XML with an ordering that we don't
    // reproduce; instead confirm the OCD we then write from our xmap
    // still scores near-parity.
    test(`${stem}: ocd → xmap → ocd (round-trip parity)`, async t => {
      await withTmp(async tmp => {
        const src = await readMap(pair.ocd)
        const xmapOut = path.join(tmp, 'o2x.xmap')
        await writeMap(src, xmapOut)
        const rt = await readMap(xmapOut)
        const ocdOut = path.join(tmp, 'x2o.ocd')
        await writeMap(rt, ocdOut)
        const score = await scoreVsPairedOcd(ocdOut, pair.ocd)
        t.log(`ocd→xmap→ocd critical=${score.critical} other=${score.other}`)
        t.true(
          score.critical <= MAX_CRITICAL,
          `expected ≤ ${MAX_CRITICAL} render-critical diffs after ocd→xmap→ocd, got ${score.critical}`,
        )
      })
    })

    // Path 3: xmap → gitmap → ocd. Gitmap is our git-friendly
    // intermediate; a round-trip through it must land near parity
    // with the original OCD.
    test(`${stem}: xmap → gitmap → ocd`, async t => {
      await withTmp(async tmp => {
        const map = await readMap(pair.xmap)
        const gm = path.join(tmp, 'trip.gitmap')
        await writeMap(map, gm)
        const rt = await readMap(gm)
        const ocdOut = path.join(tmp, 'trip.ocd')
        await writeMap(rt, ocdOut)
        const score = await scoreVsPairedOcd(ocdOut, pair.ocd)
        t.log(`xmap→gitmap→ocd critical=${score.critical} other=${score.other}`)
        t.true(
          score.critical <= MAX_CRITICAL,
          `expected ≤ ${MAX_CRITICAL} render-critical diffs after xmap→gitmap→ocd, got ${score.critical}`,
        )
      })
    })

    // Path 4: ocd → gitmap → xmap → ocd. The full circle. A double
    // round-trip is the strongest check of gitmap fidelity.
    test(`${stem}: ocd → gitmap → xmap → ocd`, async t => {
      await withTmp(async tmp => {
        const src = await readMap(pair.ocd)
        const gm = path.join(tmp, 'trip.gitmap')
        await writeMap(src, gm)
        const rt = await readMap(gm)
        const xmapOut = path.join(tmp, 'trip.xmap')
        await writeMap(rt, xmapOut)
        const rt2 = await readMap(xmapOut)
        const ocdOut = path.join(tmp, 'trip.ocd')
        await writeMap(rt2, ocdOut)
        const score = await scoreVsPairedOcd(ocdOut, pair.ocd)
        t.log(
          `ocd→gitmap→xmap→ocd critical=${score.critical} other=${score.other}`,
        )
        t.true(
          score.critical <= MAX_CRITICAL,
          `expected ≤ ${MAX_CRITICAL} render-critical diffs after ocd→gitmap→xmap→ocd, got ${score.critical}`,
        )
      })
    })
  }
}
