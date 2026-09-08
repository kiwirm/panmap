/**
 * Cross-format canonicalisation regression gate.
 *
 * For every paired `<base>.ocd` + `<base>.xmap` in `test/data/`, read both,
 * convert each symbol via the gitmap writer's `toGitmapSymbol`, and count
 * how many symbols come out byte-identical (with sorted-keys JSON) between
 * the OCD-sourced and OMap-sourced sides.
 *
 * Both sides matching means the gitmap serialisation is a truly canonical
 * form for that symbol — dropping any drift between the two dialects.
 *
 * Baselines below reflect the current identical count per pair. The test
 * fails on ANY regression (drop below baseline) and reminds you to bump
 * the baseline on an improvement — so this doubles as a ratchet: once a
 * pair hits 100%, we notice if it slips.
 *
 * The .xmap files are tracked in git; the .ocd files are gitignored
 * (`*.ocd` in `.gitignore`) so each dev supplies them locally via
 * `test/data/<base>.ocd`. Pairs with only one file present are skipped.
 */
import test from 'ava'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { read } from '../src/index.ts'
import { toGitmapSymbol, toGitmapColor, stableSymbolId } from '../src/formats/gitmap/from-map.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_ROOT = path.join(HERE, 'data')

// Current baseline: symbols where OCD-sourced and OMap-sourced gitmap
// serialisations are byte-identical (sorted-keys JSON), out of the shared
// set (symbols matched by canonical `code`). Bump when a canonicalisation
// closes a residual — do NOT lower without capturing the regression.
const BASELINES = {
  'ara-c122f2d':                          { shared: 180, identical: 180 },
  'bottle-lake-39f1e08':                  { shared: 209, identical: 209 },
  'bottle-lake-54f3d28':                  { shared: 209, identical: 209 },
  'bottle-lake-5c6c8e6':                  { shared: 209, identical: 209 },
  'bottle-lake-7f36fe7':                  { shared: 209, identical: 209 },
  'bottle-lake-bc98714':                  { shared: 209, identical: 209 },
  'butlers-bush-bdc004d':                 { shared: 196, identical: 170 },
  'castle-hill-village-22e8154':          { shared: 180, identical: 180 },
  'hillmorton-6275ebc':                   { shared: 190, identical: 185 },
  'kura-tawhiti-0b613b2':                 { shared: 177, identical: 157 },
  'laidmore-0f52898':                     { shared: 195, identical: 168 },
  'leithfield-69f0423':                   { shared: 195, identical: 195 },
  'lincoln-university-d44e8ce':           { shared: 189, identical: 189 },
  'nga-puna-wai-canterbury-park-beba671': { shared: 183, identical: 183 },
  'orua-paeroa-bf353d6':                  { shared: 174, identical: 154 },
  'port-hills-d302447':                   { shared: 262, identical: 262 },
  'rangiora-7545c63':                     { shared: 180, identical: 180 },
  'university-of-canterbury-f3dd92a':     { shared: 189, identical: 189 },
  'woodend-4a10570':                      { shared: 204, identical: 204 },
  'woodend-b5d4d39':                      { shared: 204, identical: 204 },
}

// Discover pairs sync so ava's top-level `test(...)` registration works
// without a top-level await (matches the mapper-parity suite's pattern).
function discoverPairs() {
  let files
  try { files = fs.readdirSync(DATA_ROOT) } catch { return [] }
  const bases = new Set()
  for (const f of files) {
    if (!f.endsWith('.ocd')) continue
    const base = f.slice(0, -4)
    if (files.includes(base + '.xmap')) bases.add(base)
  }
  return [...bases].sort()
}

function sortedKeys(v) {
  if (Array.isArray(v)) return v.map(sortedKeys)
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v).sort()) o[k] = sortedKeys(v[k])
    return o
  }
  return v
}
const canonicalJson = v => JSON.stringify(sortedKeys(v))

function toGitmapSymbols(map) {
  const colorIds = new Map(map.colors.map(c => [c.id, toGitmapColor(c).id]))
  const symbolIds = new Map()
  const used = new Map()
  for (const s of map.symbols) {
    const base = stableSymbolId(s)
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    symbolIds.set(s.id, n === 1 ? base : `${base}_v${n}`)
  }
  const symbolsById = new Map()
  for (const s of map.symbols) {
    symbolsById.set(s.id, s)
    if (s.sourceId !== undefined && s.sourceId !== s.id) symbolsById.set(s.sourceId, s)
  }
  return map.symbols.map(s => toGitmapSymbol(s, colorIds, symbolIds, symbolsById))
}

// Read + measure each pair only once — parallel tests share the same
// underlying promise via `measurementCache`. Reading a big .xmap (20 MB)
// can take multiple seconds so this is load-bearing for the aggregate
// summary test at the end.
const measurementCache = new Map()
function measurePair(base) {
  if (!measurementCache.has(base)) measurementCache.set(base, (async () => {
    const ocd = await read(path.join(DATA_ROOT, base + '.ocd'))
    const xmap = await read(path.join(DATA_ROOT, base + '.xmap'))
    const O = toGitmapSymbols(ocd)
    const X = toGitmapSymbols(xmap)
    const byCodeO = new Map(O.filter(s => s.code).map(s => [s.code, s]))
    const byCodeX = new Map(X.filter(s => s.code).map(s => [s.code, s]))
    const shared = []
    for (const [code] of byCodeO) if (byCodeX.has(code)) shared.push(code)
    let identical = 0
    for (const code of shared) {
      const o = byCodeO.get(code); const x = byCodeX.get(code)
      if (canonicalJson(o.renderLayers) === canonicalJson(x.renderLayers)) identical++
    }
    return { shared: shared.length, identical }
  })())
  return measurementCache.get(base)
}

const pairs = discoverPairs()

if (pairs.length === 0) {
  test('cross-format canonical: no pairs discovered in test/data/', t => {
    t.pass('no `<base>.ocd` + `<base>.xmap` pairs present — install locally to enable')
  })
}

for (const base of pairs) {
  test(`cross-format canonical: ${base}`, async t => {
    const { shared, identical } = await measurePair(base)
    const baseline = BASELINES[base]
    t.log(`shared=${shared}  identical=${identical}  (${((identical / shared) * 100).toFixed(1)}%)`)
    if (!baseline) {
      t.fail(
        `no baseline for '${base}' — add to BASELINES with the measured counts:\n`
        + `  '${base}': { shared: ${shared}, identical: ${identical} },`,
      )
      return
    }
    // Assert shared symbol count stays stable — a change here means the pair's
    // symbol set drifted (a new symbol added / removed) and needs review.
    t.is(shared, baseline.shared,
      `shared symbol count changed (expected ${baseline.shared}, got ${shared}) — pair drifted`,
    )
    // Ratchet: never regress below the recorded identical count.
    t.true(identical >= baseline.identical,
      `identical count regressed: expected ≥ ${baseline.identical}, got ${identical}`,
    )
    // Loud reminder when we've improved — bump the baseline so future
    // regressions get caught at the new higher watermark.
    if (identical > baseline.identical) {
      t.log(
        `IMPROVEMENT: identical went from ${baseline.identical} → ${identical}. `
        + `Bump BASELINES['${base}'].identical to ${identical}.`,
      )
    }
  })
}

// Aggregate line so CI logs give a one-glance summary of the whole suite.
test('cross-format canonical: aggregate summary', async t => {
  if (pairs.length === 0) { t.pass('no pairs'); return }
  const rows = []
  let sharedTotal = 0, identicalTotal = 0
  for (const base of pairs) {
    try {
      const { shared, identical } = await measurePair(base)
      sharedTotal += shared; identicalTotal += identical
      rows.push(`  ${base.padEnd(40)}  ${String(identical).padStart(4)}/${String(shared).padStart(4)}  ${((identical / shared) * 100).toFixed(1)}%`)
    } catch (e) {
      rows.push(`  ${base.padEnd(40)}  ERROR: ${e.message}`)
    }
  }
  t.log('\n' + rows.join('\n') + `\n  ${'TOTAL'.padEnd(40)}  ${String(identicalTotal).padStart(4)}/${String(sharedTotal).padStart(4)}  ${((identicalTotal / sharedTotal) * 100).toFixed(1)}%`)
  t.pass()
})

