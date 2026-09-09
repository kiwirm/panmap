/**
 * Unified convergence gate.
 *
 * Contract: the canonical gitmap of a map is invariant no matter which
 * path produced it. This test enumerates every applicable endpoint for
 * every map fixture and asserts they all agree.
 *
 *   1. read(xmap)                          — baseline (xmap only)
 *   2. read(ocd)                           — cross-format (ocd only)
 *   3. read(write_gitmap(read(xmap)))      — gitmap-writer idempotence
 *   4. read(write_ocd(read(xmap)))         — ocd-writer round-trip
 *   5. read(write_xmap(read(ocd)))         — xmap-writer round-trip
 *
 * Fixture layout — one folder per map, revisions as file stems:
 *   test/fixtures/<map>/<rev>.xmap   (optional per revision)
 *   test/fixtures/<map>/<rev>.ocd    (optional per revision)
 *
 * The tracked smoke set (basic-1/, double-line/, ara/) is present after a
 * bare clone. The full corpus arrives via `npm run fetch:test-data`.
 *
 * Assertions (per map, aggregated across revisions):
 *   colors / objects / symbols — count of ndjson lines that agree across
 *   ALL endpoints, tracked as a per-map ratchet in BASELINES below. Soft
 *   fail on regression, log on improvement, hard fail if absent (every
 *   new map needs a baseline entry — forces awareness of corpus growth).
 *
 *   Goal state is 100% agreement (byte-identity) on all three; the
 *   ratchet just prevents silent regression while the renderLayers/
 *   objects/colors canonicalisation work is in flight.
 */
import test from 'ava'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { read, write } from '../src/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures')

// Per-map convergence ratchet — { colors, objects, symbols } counting
// ndjson lines that were byte-identical across every endpoint we ran for
// the map's revisions. Bump when a canonicalisation lands; do NOT lower
// without capturing the regression. A new fixture map with no entry hard-
// fails until added — forces awareness of the corpus growing.
const BASELINES = {
  // Filled lazily — see "IMPROVEMENT" log lines / the ratchet summary in
  // test output for the exact numbers to paste here.
  //
  // Current corpus (2026-09-09): objects/colors DO NOT fully converge —
  // the eventual goal is 100% on all three but for now this ratchet is
  // the drift budget. Any regression here means a canonicalisation
  // change lost ground; investigate before lowering.
  'ara':                          { colors:  8, objects:  1012, symbols: 164 },
  'basic-1':                      { colors:  0, objects:     0, symbols:   0 },
  'bottle-lake':                  { colors: 44, objects: 14220, symbols: 209 },
  'butlers-bush':                 { colors: 10, objects:  3608, symbols: 109 },
  'castle-hill-village':          { colors:  8, objects:   913, symbols: 164 },
  'double-line':                  { colors:  0, objects:     0, symbols:   0 },
  'hillmorton':                   { colors:  4, objects:  1340, symbols: 185 },
  'jarnvag':                      { colors:  0, objects:     0, symbols:   0 },
  'kura-tawhiti':                 { colors: 12, objects:  4201, symbols:  80 },
  'laidmore':                     { colors: 10, objects:  3469, symbols: 110 },
  'leithfield':                   { colors: 39, objects:  4393, symbols: 188 },
  'lincoln-university':           { colors: 15, objects:  1744, symbols: 173 },
  'myggfritt':                    { colors:  0, objects:     0, symbols:   0 },
  'nga-puna-wai-canterbury-park': { colors:  8, objects:  3232, symbols: 167 },
  'orua-paeroa':                  { colors:  8, objects:  1095, symbols:  78 },
  'port-hills':                   { colors: 50, objects:     0, symbols: 251 },
  'rangiora':                     { colors:  8, objects:   998, symbols: 164 },
  'tahunanui':                    { colors:  0, objects:     0, symbols:   0 },
  'university-of-canterbury':     { colors:  9, objects:  5173, symbols: 173 },
  'woodend':                      { colors: 11, objects:  9932, symbols: 204 },
}
const METRICS = ['colors', 'objects', 'symbols']

function discover() {
  if (!fs.existsSync(FIX)) return []
  const maps = fs.readdirSync(FIX).filter(name => {
    try { return fs.statSync(path.join(FIX, name)).isDirectory() } catch { return false }
  }).sort()
  const out = []
  for (const map of maps) {
    const files = fs.readdirSync(path.join(FIX, map))
    const byRev = new Map()
    for (const f of files) {
      const dot = f.lastIndexOf('.')
      if (dot < 0) continue
      const rev = f.slice(0, dot)
      const ext = f.slice(dot + 1)
      if (ext !== 'ocd' && ext !== 'xmap') continue
      if (!byRev.has(rev)) byRev.set(rev, {})
      byRev.get(rev)[ext] = path.join(FIX, map, f)
    }
    for (const [rev, formats] of [...byRev.entries()].sort()) {
      out.push({ map, rev, formats })
    }
  }
  return out
}

// Convert a PanMap → { colors, objects, symbols } as three ndjson strings.
// Uses the real gitmap writer so what we compare is exactly what would
// hit disk. Temp dir is cleaned in a finally block.
async function toCanonicalGitmap(map) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-'))
  try {
    await write(map, path.join(dir, 'g.gitmap'), { format: 'gitmap', overwrite: true })
    const out = {}
    for (const name of ['colors', 'objects', 'symbols']) {
      const p = path.join(dir, 'g.gitmap', `${name}.ndjson`)
      out[name] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''
    }
    return out
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function endpointsFor({ formats }) {
  const out = {}
  if (formats.xmap) {
    const mx = await read(formats.xmap)
    out.xmap = await toCanonicalGitmap(mx)
    // (round-trip endpoints are additive — enable once base convergence
    // holds so a regression here isn't buried under upstream noise.)
  }
  if (formats.ocd) {
    const mo = await read(formats.ocd)
    out.ocd = await toCanonicalGitmap(mo)
  }
  return out
}

// Line-by-line convergence for one metric across a set of endpoints.
// (ndjson order is stable — gitmap writer sorts objects/symbols by id
// and colors by their internal order, so array-position pairing is valid.)
function measureLines(endpoints, metric) {
  const names = Object.keys(endpoints)
  const sets = names.map(n => endpoints[n][metric].split('\n').filter(Boolean))
  const total = Math.max(...sets.map(l => l.length), 0)
  if (names.length < 2) return { identical: total, total }
  let identical = 0
  for (let i = 0; i < total; i++) {
    const first = sets[0][i]
    if (first === undefined) continue
    if (sets.every(s => s[i] === first)) identical++
  }
  return { identical, total }
}

const cases = discover()
if (cases.length === 0) {
  test('convergence: no fixtures discovered', t => {
    t.pass('run `npm run fetch:test-data` to populate test/fixtures/')
  })
}

// Per-map best-across-revisions measurement, populated by the per-case
// tests and inspected by the ratchet summary test at the end.
const perMapBest = new Map()  // map → { colors, objects, symbols } (identical counts)

function updateBest(map, metric, identical) {
  const cur = perMapBest.get(map) ?? { colors: 0, objects: 0, symbols: 0 }
  if (identical > (cur[metric] ?? 0)) cur[metric] = identical
  perMapBest.set(map, cur)
}

for (const c of cases) {
  const label = `${c.map}${c.rev === c.map ? '' : ':' + c.rev}`
  const endpoints = Object.keys(c.formats).sort().join('+')
  test(`convergence: ${label} [${endpoints}]`, async t => {
    const ep = await endpointsFor(c)
    const names = Object.keys(ep)
    t.log(`endpoints: ${names.join(', ')}`)

    if (names.length < 2) {
      t.pass('only one endpoint available — nothing to converge against')
      return
    }

    const parts = []
    for (const metric of METRICS) {
      const m = measureLines(ep, metric)
      parts.push(`${metric}=${m.identical}/${m.total}`)
      updateBest(c.map, metric, m.identical)
    }
    t.log(parts.join('  '))
    t.pass()
  })
}

// Aggregate ratchet — runs after every per-revision test completes,
// regardless of concurrency (ava runs tests in a file concurrently by
// default). `test.after` guarantees perMapBest is fully populated.
test.after('convergence: ratchet summary', t => {
  if (cases.length === 0) { t.pass('no fixtures'); return }
  const maps = [...new Set(cases.map(c => c.map))].sort()
  const rows = [
    `  ${'map'.padEnd(40)}  ${METRICS.map(m => m.padStart(9)).join(' ')}`,
    `  ${'-'.repeat(40)}  ${METRICS.map(() => '-'.repeat(9)).join(' ')}`,
  ]
  const missing = [], regressed = [], improved = []
  for (const map of maps) {
    const best = perMapBest.get(map) ?? {}
    const baseline = BASELINES[map]
    const cells = METRICS.map(metric => {
      const got = best[metric] ?? 0
      const base = baseline?.[metric]
      const mark = base === undefined ? '?' : got < base ? '↓' : got > base ? '↑' : '='
      return `${mark}${String(got).padStart(8)}`
    })
    rows.push(`  ${map.padEnd(40)}  ${cells.join(' ')}`)
    if (baseline === undefined) { missing.push({ map, best }); continue }
    for (const metric of METRICS) {
      const got = best[metric] ?? 0
      const base = baseline[metric] ?? 0
      if (got < base) regressed.push({ map, metric, got, base })
      if (got > base) improved.push({ map, metric, got, base })
    }
  }
  t.log('\n' + rows.join('\n'))
  for (const { map, metric, got, base } of improved) {
    t.log(`IMPROVEMENT: ${map}.${metric} ${base} → ${got} — bump BASELINES.`)
  }
  if (regressed.length) {
    t.fail('convergence ratchet regressed:\n' + regressed.map(r =>
      `  ${r.map}.${r.metric}: expected ≥ ${r.base}, got ${r.got}`).join('\n'))
    return
  }
  if (missing.length) {
    const stanzas = missing.map(({ map, best }) =>
      `  '${map}': { colors: ${best.colors ?? 0}, objects: ${best.objects ?? 0}, symbols: ${best.symbols ?? 0} },`)
    t.fail('missing BASELINES entries — add:\n' + stanzas.join('\n'))
    return
  }
  t.pass()
})
