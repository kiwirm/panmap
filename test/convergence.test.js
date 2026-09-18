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
 *   ratchet just prevents silent regression while the layers/
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

// Per-map convergence ratchet — { colors, objects, symbols } counting records
// byte-identical across every endpoint we ran for the map's revisions. Colours
// and symbols are matched by `id`; objects have no id (objects.ndjson is
// geometry-sorted), so they match on the whole line. Bump when a canonicalisation lands;
// do NOT lower without capturing the regression. A new fixture map with no entry
// hard-fails until added — forces awareness of the corpus growing.
const BASELINES = {
  // Filled lazily — see "IMPROVEMENT" log lines / the ratchet summary in
  // test output for the exact numbers to paste here.
  //
  // Current corpus (2026-09-17): colors are CLOSED — 100% on every map,
  // held by this ratchet. Objects and symbols do not fully converge yet;
  // the eventual goal is 100% on all three but for now this is the drift
  // budget. Any regression here means a canonicalisation change lost
  // ground; investigate before lowering.
  //
  // One deliberate decrease is recorded here: butlers-bush.objects went
  // 6817 → 6812 when coordinate rounding moved to half-away-from-zero (how
  // OCAD stores half units). The same change took castle-hill-village
  // 1940 → 2107 and ara to 100% — net +177.
  //
  // butlers-bush's residue is source divergence, verified rather than
  // assumed: 164 of its 165 unpaired objects differ by exactly dx=1, the
  // two files placing the same vertex 0.01 mm apart. The count barely moved
  // across the rounding change (~160 → 165), so these are not half-unit
  // cases that a rounding rule could reconcile.
  ara: { colors: 33, objects: 1190, symbols: 180 },
  'basic-1': { colors: 0, objects: 0, symbols: 0 },
  'bottle-lake': { colors: 44, objects: 15443, symbols: 205 },
  'butlers-bush': { colors: 33, objects: 6812, symbols: 184 },
  'castle-hill-village': { colors: 33, objects: 2107, symbols: 178 },
  'double-line': { colors: 0, objects: 0, symbols: 0 },
  hillmorton: { colors: 41, objects: 1914, symbols: 190 },
  jarnvag: { colors: 0, objects: 0, symbols: 0 },
  'kura-tawhiti': { colors: 37, objects: 4892, symbols: 170 },
  laidmore: { colors: 33, objects: 6912, symbols: 183 },
  leithfield: { colors: 39, objects: 5669, symbols: 191 },
  'lincoln-university': { colors: 43, objects: 3420, symbols: 189 },
  myggfritt: { colors: 0, objects: 0, symbols: 0 },
  'nga-puna-wai-canterbury-park': { colors: 33, objects: 3883, symbols: 183 },
  'orua-paeroa': { colors: 33, objects: 1481, symbols: 167 },
  'port-hills': { colors: 50, objects: 1, symbols: 255 },
  rangiora: { colors: 33, objects: 1727, symbols: 180 },
  tahunanui: { colors: 0, objects: 0, symbols: 0 },
  'university-of-canterbury': { colors: 37, objects: 9099, symbols: 189 },
  woodend: { colors: 35, objects: 10437, symbols: 200 },
}
const METRICS = ['colors', 'objects', 'symbols']

// Maps excluded from every parity/convergence suite. The fixture corpus
// is fetched (`npm run fetch:test-data`), so deleting the files locally
// wouldn't stick — exclude by name here instead, with the reason.
//
//   port-hills — the source pair is corrupt; its OCD and XMap disagree
//   about the map's own content, so neither can serve as ground truth
//   and its numbers were noise in every suite.
const EXCLUDED_MAPS = new Set(['port-hills'])

function discover() {
  if (!fs.existsSync(FIX)) return []
  const maps = fs
    .readdirSync(FIX)
    .filter(name => {
      if (name.startsWith('.')) return false // skip dotfiles / macOS ._ AppleDouble
      if (EXCLUDED_MAPS.has(name)) return false
      try {
        return fs.statSync(path.join(FIX, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
  const out = []
  for (const map of maps) {
    const files = fs.readdirSync(path.join(FIX, map))
    const byRev = new Map()
    for (const f of files) {
      if (f.startsWith('.')) continue // skip dotfiles / macOS ._ AppleDouble
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

// Convert a Panmap → { colors, objects, symbols } as three ndjson strings.
// Uses the real gitmap writer so what we compare is exactly what would
// hit disk. Temp dir is cleaned in a finally block.
async function toCanonicalGitmap(map) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-'))
  try {
    await write(map, path.join(dir, 'g.gitmap'), {
      format: 'gitmap',
      overwrite: true,
    })
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

// Per-metric convergence across endpoints, matched by record `id` (NOT array
// position). The two source formats can carry slightly different symbol/colour
// sets, so position-pairing misses a record that converged but landed at a
// shifted index. `total` is the union of match keys seen across endpoints;
// `identical` is the count present in EVERY endpoint with a byte-identical line.
function measureLines(endpoints, metric) {
  const names = Object.keys(endpoints)
  // Colours/symbols carry a stable `id` (the first key) — match on it so a
  // record that shifted position still pairs, and a regex is far cheaper than
  // JSON.parse across a 15k-record stream. Objects carry NO id (objects.ndjson
  // is geometry-sorted, not id-keyed), so they fall back to the whole line —
  // object convergence is measured as the count of byte-identical object lines.
  const idOf = line => {
    const m = /"id":"([^"]*)"/.exec(line)
    return m ? m[1] : line
  }
  const byId = names.map(n => {
    const m = new Map()
    for (const line of endpoints[n][metric].split('\n')) {
      if (line) m.set(idOf(line), line)
    }
    return m
  })
  const allIds = new Set()
  for (const m of byId) for (const id of m.keys()) allIds.add(id)
  // Denominator. For id-keyed metrics the union of ids is right: a symbol
  // present in one endpoint but not the other is a real difference and
  // belongs in the total.
  //
  // Objects have no id, so their "key" IS the whole line — which makes the
  // union double-count: one diverging object contributes TWO keys and zero
  // matches, so a map where every object differs by a single unit scored 0%
  // rather than 0-of-N, and the reported share was a distorted x/(2-x)
  // instead of x. Use the endpoint record count instead, which is the real
  // object count and makes the share linear.
  const isIdKeyed = metric !== 'objects'
  const total = isIdKeyed
    ? allIds.size
    : Math.max(...byId.map(m => m.size))
  if (names.length < 2) return { identical: total, total }
  let identical = 0
  for (const id of allIds) {
    const first = byId[0].get(id)
    if (first !== undefined && byId.every(m => m.get(id) === first)) identical++
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
const perMapBest = new Map() // map → { colors, objects, symbols } (identical counts)
// Denominator for each best count, so the summary can show a share
// rather than a bare number. A raw `colors: 8` reads like a pass; `20%
// (8/41)` reads like the gap it actually is.
const perMapTotal = new Map()

function updateBest(map, metric, identical, total) {
  const cur = perMapBest.get(map) ?? { colors: 0, objects: 0, symbols: 0 }
  if (identical > (cur[metric] ?? 0)) cur[metric] = identical
  perMapBest.set(map, cur)
  const tot = perMapTotal.get(map) ?? { colors: 0, objects: 0, symbols: 0 }
  if (total > (tot[metric] ?? 0)) tot[metric] = total
  perMapTotal.set(map, tot)
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
      updateBest(c.map, metric, m.identical, m.total)
    }
    t.log(parts.join('  '))
    t.pass()
  })
}

// Aggregate ratchet — runs after every per-revision test completes,
// regardless of concurrency (ava runs tests in a file concurrently by
// default). `test.after` guarantees perMapBest is fully populated.
test.after('convergence: ratchet summary', t => {
  if (cases.length === 0) {
    t.pass('no fixtures')
    return
  }
  const maps = [...new Set(cases.map(c => c.map))].sort()
  const rows = [
    `  ${'map'.padEnd(34)}  ${METRICS.map(m => m.padStart(15)).join(' ')}`,
    `  ${'-'.repeat(34)}  ${METRICS.map(() => '-'.repeat(15)).join(' ')}`,
  ]
  const missing = [],
    regressed = [],
    improved = []
  for (const map of maps) {
    const best = perMapBest.get(map) ?? {}
    const totals = perMapTotal.get(map) ?? {}
    const baseline = BASELINES[map]
    // Show the SHARE converged, not just the count. The ratchet compares
    // counts (a map can gain records between revisions), but a bare count
    // hides how far from done a metric is — `colors 8` looks settled until
    // you see it's 8 of 41.
    const cells = METRICS.map(metric => {
      const got = best[metric] ?? 0
      const total = totals[metric] ?? 0
      const base = baseline?.[metric]
      const mark =
        base === undefined ? '?' : got < base ? '↓' : got > base ? '↑' : '='
      const pct = total ? `${Math.round((got / total) * 100)}%` : '—'
      return `${mark}${`${pct} ${got}/${total}`.padStart(14)}`
    })
    rows.push(`  ${map.padEnd(34)}  ${cells.join(' ')}`)
    if (baseline === undefined) {
      missing.push({ map, best })
      continue
    }
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
    t.fail(
      'convergence ratchet regressed:\n' +
        regressed
          .map(
            r => `  ${r.map}.${r.metric}: expected ≥ ${r.base}, got ${r.got}`,
          )
          .join('\n'),
    )
    return
  }
  if (missing.length) {
    const stanzas = missing.map(
      ({ map, best }) =>
        `  '${map}': { colors: ${best.colors ?? 0}, objects: ${best.objects ?? 0}, symbols: ${best.symbols ?? 0} },`,
    )
    t.fail('missing BASELINES entries — add:\n' + stanzas.join('\n'))
    return
  }
  t.pass()
})
