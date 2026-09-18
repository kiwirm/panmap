/**
 * Cross-format parity: `.ocd` (Mapper-authored) → PanMap → `.xmap`
 * (regen) — compared semantically against the Mapper-authored `.xmap`
 * of the same revision.
 *
 * Where the round-trip tests (`omap-roundtrip`, `roundtrip`) prove the
 * writer + reader are inverses on their own output, this test proves the
 * writer's output matches an INDEPENDENT ground-truth: Mapper's own
 * ocd→xmap export for the same map. Every mismatch is either a real
 * cross-format writer bug or a documented feature-parity gap.
 *
 * Direction covered here matches mapwall's real workflow (import .ocd,
 * export .omap for club distribution). The reverse direction
 * (`xmap-to-ocd-parity`) exists as a sibling test.
 *
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import test from 'ava'
import fs from 'node:fs/promises'
import { XMLParser } from 'fast-xml-parser'
import readOcad from '../src/formats/ocad/reader/decode/index.ts'
import ocadFileToMap from '../src/formats/ocad/reader/to-panmap.ts'
import { mapToOmapXml } from './helpers/omap.js'
import { fixtureFile } from './helpers/fixtures.js'
import { parityScore } from './helpers/parity-score.js'

// Every fixture pair where both a `.ocd` and `.xmap` of the same
// revision exist. Foreign / smoke fixtures without a paired xmap
// (basic-1, double-line, jarnvag, myggfritt, tahunanui) can't run
// this test — they only exercise the OCD side.
const FIXTURES = [
  { name: 'ara', ocd: 'ara-c122f2d.ocd', xmap: 'ara-c122f2d.xmap' },
  {
    name: 'bottle-lake-bc98714',
    ocd: 'bottle-lake-bc98714.ocd',
    xmap: 'bottle-lake-bc98714.xmap',
  },
  {
    name: 'butlers-bush',
    ocd: 'butlers-bush-bdc004d.ocd',
    xmap: 'butlers-bush-bdc004d.xmap',
  },
  {
    name: 'castle-hill-village',
    ocd: 'castle-hill-village-22e8154.ocd',
    xmap: 'castle-hill-village-22e8154.xmap',
  },
  {
    name: 'hillmorton',
    ocd: 'hillmorton-6275ebc.ocd',
    xmap: 'hillmorton-6275ebc.xmap',
  },
  {
    name: 'kura-tawhiti',
    ocd: 'kura-tawhiti-0b613b2.ocd',
    xmap: 'kura-tawhiti-0b613b2.xmap',
  },
  {
    name: 'laidmore',
    ocd: 'laidmore-0f52898.ocd',
    xmap: 'laidmore-0f52898.xmap',
  },
  {
    name: 'leithfield',
    ocd: 'leithfield-69f0423.ocd',
    xmap: 'leithfield-69f0423.xmap',
  },
  {
    name: 'lincoln-university',
    ocd: 'lincoln-university-d44e8ce.ocd',
    xmap: 'lincoln-university-d44e8ce.xmap',
  },
  {
    name: 'nga-puna-wai-canterbury-park',
    ocd: 'nga-puna-wai-canterbury-park-beba671.ocd',
    xmap: 'nga-puna-wai-canterbury-park-beba671.xmap',
  },
  {
    name: 'orua-paeroa',
    ocd: 'orua-paeroa-bf353d6.ocd',
    xmap: 'orua-paeroa-bf353d6.xmap',
  },
  {
    name: 'rangiora',
    ocd: 'rangiora-7545c63.ocd',
    xmap: 'rangiora-7545c63.xmap',
  },
  {
    name: 'university-of-canterbury',
    ocd: 'university-of-canterbury-f3dd92a.ocd',
    xmap: 'university-of-canterbury-f3dd92a.xmap',
  },
  {
    name: 'woodend',
    ocd: 'woodend-4a10570.ocd',
    xmap: 'woodend-4a10570.xmap',
  },
]

// Same XML-attribute-level diff pattern as `omap-source-parity.test.js`;
// see that file for detailed rationale. Attribute names ignored across
// the board (writer conventions vs Mapper's) — `@id` because sym-num
// renumbering is intentional, `@name` because cosmetic display text,
// `@code` normalised in `symbolsByCode` (Mapper's "101" vs our "101.0").
const IGNORED_ATTRS = new Set(['@id', '@name', '@code'])

// Element defaults Mapper omits but our writer emits. Skipping these
// avoids reporting "we said `color=-1` where Mapper said nothing" —
// semantically equivalent, since Mapper's reader treats an omitted
// attribute as the default.
const OMITTABLE_DEFAULTS = new Map([
  ['line_symbol.mid_symbol_placement', '0'],
  ['line_symbol.suppress_dash_symbol_at_ends', 'false'],
  ['line_symbol.dashed', 'false'],
  ['line_symbol.mid_symbols_per_spot', '1'],
  ['line_symbol.mid_symbol_distance', '0'],
  ['point_symbol.rotatable', 'false'],
  ['text_symbol.rotatable', 'false'],
  ['symbol.code', ''],
  ['symbol.name', ''],
])

function parseXml(xml) {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    removeNSPrefix: true,
    allowBooleanAttributes: true,
    processEntities: true,
    preserveOrder: false,
  }).parse(xml)
}

function findSymbolsContainer(node) {
  if (!node || typeof node !== 'object') return null
  if (node.symbols) return node.symbols
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        const f = findSymbolsContainer(item)
        if (f) return f
      }
    } else if (typeof v === 'object' && v !== null) {
      const f = findSymbolsContainer(v)
      if (f) return f
    }
  }
  return null
}

function symbolsByCode(root) {
  const c = findSymbolsContainer(root)
  const arr = Array.isArray(c?.symbol) ? c.symbol : c?.symbol ? [c.symbol] : []
  const by = new Map()
  for (const s of arr) {
    const code = String(s?.['@code'] ?? '')
    if (!code) continue
    const key = code.replace(/\.0$/, '')
    if (!by.has(key)) by.set(key, s)
  }
  return by
}

const COMPARED_CHILDREN = new Set([
  'line_symbol',
  'point_symbol',
  'area_symbol',
  'text_symbol',
  'combined_symbol',
  'element',
  'mid_symbol',
  'start_symbol',
  'end_symbol',
  'dash_symbol',
  'corner_symbol',
  'border',
  'pattern',
  'symbol',
])

function diffNode(expected, actual, path, parentTag, out) {
  out.comparisons = (out.comparisons || 0) + 1
  if (expected == null && actual == null) return
  if (typeof expected !== 'object' || typeof actual !== 'object') {
    if (String(expected) !== String(actual)) {
      out.push({ path, expected, actual })
    }
    return
  }
  const allKeys = new Set([
    ...Object.keys(expected || {}),
    ...Object.keys(actual || {}),
  ])
  for (const key of allKeys) {
    if (key.startsWith('@')) {
      if (IGNORED_ATTRS.has(key)) continue
      const attrName = key.slice(1)
      const expVal = expected?.[key]
      const actVal = actual?.[key]
      const defaultKey = `${parentTag}.${attrName}`
      if (expVal === undefined) {
        if (OMITTABLE_DEFAULTS.get(defaultKey) === String(actVal)) continue
        out.push({
          path: `${path}[@${attrName}]`,
          expected: '(omitted)',
          actual: actVal,
        })
      } else if (actVal === undefined) {
        if (OMITTABLE_DEFAULTS.get(defaultKey) === String(expVal)) continue
        out.push({
          path: `${path}[@${attrName}]`,
          expected: expVal,
          actual: '(omitted)',
        })
      } else if (String(expVal) !== String(actVal)) {
        out.push({
          path: `${path}[@${attrName}]`,
          expected: expVal,
          actual: actVal,
        })
      }
      continue
    }
    if (!COMPARED_CHILDREN.has(key)) continue
    const expChildren = toArray(expected?.[key])
    const actChildren = toArray(actual?.[key])
    if (expChildren.length !== actChildren.length) {
      out.push({
        path: `${path}.${key}[]`,
        expected: `${expChildren.length} node(s)`,
        actual: `${actChildren.length} node(s)`,
      })
    }
    const n = Math.max(expChildren.length, actChildren.length)
    for (let i = 0; i < n; i++) {
      diffNode(
        expChildren[i] ?? null,
        actChildren[i] ?? null,
        `${path}.${key}[${i}]`,
        key,
        out,
      )
    }
  }
}

function toArray(v) {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

function formatDiff(mismatches) {
  const groups = new Map()
  for (const m of mismatches) {
    const symbolPath = m.path.match(/^<symbol [^>]+>/)?.[0] ?? '<root>'
    if (!groups.has(symbolPath)) groups.set(symbolPath, [])
    groups
      .get(symbolPath)
      .push(
        `  ${m.path.slice(symbolPath.length + 1) || '(this node)'}: expected=${JSON.stringify(
          m.expected,
        )} actual=${JSON.stringify(m.actual)}`,
      )
  }
  const lines = []
  for (const [sym, entries] of groups) {
    lines.push(sym)
    lines.push(...entries.slice(0, 6))
    if (entries.length > 6)
      lines.push(`  … ${entries.length - 6} more mismatches in this symbol`)
  }
  return lines.join('\n')
}

for (const { name, ocd, xmap } of FIXTURES) {
  test(`ocd→xmap ground-truth parity: ${name}`, async t => {
    // Ground truth: Mapper's own .xmap for this map revision.
    const groundTruthXml = await fs.readFile(fixtureFile(xmap), 'utf-8')
    // Panmap's conversion: read the .ocd, run through the model, write xmap.
    const map = ocadFileToMap(await readOcad(await fs.readFile(fixtureFile(ocd))))
    const regen = await mapToOmapXml(map)

    const expected = parseXml(groundTruthXml)
    const actual = parseXml(regen)

    const expectedByCode = symbolsByCode(expected)
    const actualByCode = symbolsByCode(actual)

    const mismatches = []
    for (const code of expectedByCode.keys()) {
      if (!actualByCode.has(code)) {
        mismatches.push({
          path: `<symbol ${code}>`,
          expected: '(present)',
          actual: '(missing)',
        })
      }
    }
    for (const code of actualByCode.keys()) {
      if (!expectedByCode.has(code)) {
        mismatches.push({
          path: `<symbol ${code}>`,
          expected: '(missing)',
          actual: '(present)',
        })
      }
    }
    for (const [code, expSymbol] of expectedByCode) {
      const actSymbol = actualByCode.get(code)
      if (!actSymbol) continue
      diffNode(expSymbol, actSymbol, `<symbol ${code}>`, 'symbol', mismatches)
    }

    if (mismatches.length === 0) {
      t.pass()
      return
    }
    t.fail(
      `${parityScore({
        mismatches,
        symbolCount: expectedByCode.size,
        fieldCount: mismatches.comparisons,
        what: "panmap's ocd→xmap conversion",
        against: "Mapper's own ocd→xmap",
      })}\n${formatDiff(
        mismatches.slice(0, 500),
      )}`,
    )
  })
}
