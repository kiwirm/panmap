// XMap round-trip safety net: fixture → to-map → from-map → parse.
// After each cycle, assert structural properties that must survive:
// symbol/object/colour counts and identity, and that a second cycle is
// byte-identical to the first (idempotence).

import test from 'ava'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readOmap } from "./helpers/omap.js"
import omapFileToMap from '../src/formats/omap/to-map.ts'
import { mapToOmapXml } from "./helpers/omap.js"
import { fixtureFile } from './helpers/fixtures.js'

async function roundTrip(fixture) {
  const originalXml = await fs.readFile(fixtureFile(fixture), 'utf-8')
  const originalFile = await readOmap(originalXml)
  const originalMap = omapFileToMap(originalFile)

  const rewrittenXml = await mapToOmapXml(originalMap)
  const rewrittenFile = await readOmap(rewrittenXml)
  const rewrittenMap = omapFileToMap(rewrittenFile)

  // A second cycle should be byte-identical if the writer is idempotent.
  const twiceXml = await mapToOmapXml(rewrittenMap)

  return { originalMap, rewrittenMap, rewrittenXml, twiceXml }
}

function summariseSymbolIds(map) {
  return map.symbols.map((s) => String(s.id)).sort()
}
function summariseObjectSymbols(map) {
  return map.objects.map((o) => String(o.symbolId)).sort()
}
function summariseColourNames(map) {
  return map.colors.filter(Boolean).map((c) => c.name).sort()
}

const FIXTURES = [
  'ara-c122f2d.xmap',
  'butlers-bush-bdc004d.xmap',
]

for (const fixture of FIXTURES) {
  test(`xmap round-trip preserves counts and identities: ${fixture}`, async t => {
    const { originalMap, rewrittenMap } = await roundTrip(fixture)

    t.is(rewrittenMap.colors.filter(Boolean).length,
      originalMap.colors.filter(Boolean).length,
      'colour count',
    )
    t.is(rewrittenMap.symbols.length, originalMap.symbols.length, 'symbol count')
    t.is(rewrittenMap.objects.length, originalMap.objects.length, 'object count')

    t.deepEqual(summariseColourNames(rewrittenMap), summariseColourNames(originalMap),
      'colour names preserved')
    t.deepEqual(summariseSymbolIds(rewrittenMap), summariseSymbolIds(originalMap),
      'symbol ids preserved')
    t.deepEqual(summariseObjectSymbols(rewrittenMap), summariseObjectSymbols(originalMap),
      'each object still points at the same symbol id')
  })

  test(`xmap writer is idempotent: ${fixture}`, async t => {
    const { rewrittenXml, twiceXml } = await roundTrip(fixture)
    t.is(twiceXml, rewrittenXml,
      'a second write of the same canonical Map produces the same XML')
  })
}
