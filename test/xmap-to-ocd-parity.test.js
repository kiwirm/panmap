/**
 * Cross-format parity: `.xmap` (Mapper-authored) → PanMap → `.ocd`
 * (regen) — compared semantically against the Mapper-authored `.ocd`
 * of the same revision.
 *
 * Sibling of `ocd-to-xmap-parity.test.js` (covers the reverse
 * direction). See that file for the pattern rationale — every mismatch
 * here is either a real cross-format writer bug or a documented
 * feature-parity gap on the OCD writer's side.
 *
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import test from 'ava'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readOmap } from './helpers/omap.js'
import omapFileToMap from '../src/formats/omap/reader/to-panmap.ts'
import readOcad from '../src/formats/ocad/reader/decode/index.ts'
import writeOcad from '../src/formats/ocad/writer/index.ts'
import { fixtureFile } from './helpers/fixtures.js'
import { parityScore } from './helpers/parity-score.js'

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

// Same OcadFile-record diff as ocad-source-parity.test.js — see there
// for the rationale on ignored fields (derived / positional / UI-hint
// metadata that Mapper stores but doesn't affect rendering).
const IGNORED_FIELDS = new Set([
  '_indexRecord',
  '_byteRange',
  '_res',
  '_tail',
  'icon',
  'iconBits',
  'symNum',
  'extent',
  'size',
  'filePos',
  'preferredDrawingTool',
  'status',
  'minSym',
  // borderSym references a paired line-symbol helper. Both panmap and
  // Mapper synthesise these helpers with their own numbering — Mapper
  // uses base+offset (e.g. 301.0 → 301.4), we use a global 99xxxx range.
  // Both are functionally correct references, just different sym-nums.
  'borderSym',
])

const IGNORED_SUBOBJECT_FIELDS = new Map([
  [
    'decrease',
    new Set([
      'decMode',
      'decSymbolSize',
      'decSymbolDistance',
      'decSymbolWidth',
      '_decLast',
    ]),
  ],
  [
    'doubleLine',
    new Set([
      'dblFillColor',
      'dblLeftColor',
      'dblRightColor',
      'dblBackgroundColor',
    ]),
  ],
])

function diffValue(expected, actual, path, out) {
  out.comparisons = (out.comparisons || 0) + 1
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (expected !== actual) out.push({ path, expected, actual })
    return
  }
  if (typeof expected !== typeof actual) {
    out.push({ path, expected, actual })
    return
  }
  if (expected == null || actual == null) {
    if (expected !== actual) out.push({ path, expected, actual })
    return
  }
  if (typeof expected !== 'object') {
    if (expected !== actual) out.push({ path, expected, actual })
    return
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    out.push({
      path,
      expected: Array.isArray(expected)
        ? `array[${expected.length}]`
        : typeof expected,
      actual: Array.isArray(actual) ? `array[${actual.length}]` : typeof actual,
    })
    return
  }
  if (Array.isArray(expected)) {
    if (expected.length !== actual.length) {
      out.push({
        path: `${path}.length`,
        expected: expected.length,
        actual: actual.length,
      })
    }
    const n = Math.min(expected.length, actual.length)
    for (let i = 0; i < n; i++) {
      diffValue(expected[i], actual[i], `${path}[${i}]`, out)
    }
    return
  }
  const parentKey = path.match(/\.([a-zA-Z]+)$/)?.[1]
  const subIgnores = parentKey ? IGNORED_SUBOBJECT_FIELDS.get(parentKey) : null
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue
    if (subIgnores?.has(key)) continue
    const expChild = expected[key]
    const actChild = actual[key]
    if (
      typeof expChild === 'object' &&
      expChild !== null &&
      !Array.isArray(expChild)
    ) {
      diffValue(expChild, actChild, `${path}.${key}`, out)
    } else if (Array.isArray(expChild)) {
      diffValue(expChild, actChild, `${path}.${key}`, out)
    } else {
      diffValue(expChild, actChild, `${path}.${key}`, out)
    }
  }
}

function symbolsBySymNum(ocadFile) {
  const map = new Map()
  for (const s of ocadFile.symbols ?? []) {
    if (s?.symNum !== undefined) map.set(s.symNum, s)
  }
  return map
}

function symbolLabel(s) {
  const num = s?.symNum ?? '?'
  const name = s?.description ?? s?.name ?? ''
  return name ? `${num} (${name})` : String(num)
}

function formatDiff(mismatches) {
  const groups = new Map()
  for (const m of mismatches) {
    const symMatch = m.path.match(/^<symbol [^>]+>/)
    const key = symMatch ? symMatch[0] : '<root>'
    if (!groups.has(key)) groups.set(key, [])
    groups
      .get(key)
      .push(
        `  ${m.path.slice(key.length + 1) || '(this node)'}: expected=${JSON.stringify(
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
  test(`xmap→ocd ground-truth parity: ${name}`, async t => {
    const xmapSrc = await fs.readFile(fixtureFile(xmap), 'utf-8')
    const map = omapFileToMap(await readOmap(xmapSrc))

    const tmp = path.join(
      os.tmpdir(),
      `panmap-${process.pid}-${Date.now()}.ocd`,
    )
    try {
      await writeOcad(map, tmp)
      const regenFile = await readOcad(await fs.readFile(tmp))
      const groundFile = await readOcad(await fs.readFile(fixtureFile(ocd)))

      const groundBy = symbolsBySymNum(groundFile)
      const regBy = symbolsBySymNum(regenFile)

      const mismatches = []
      // Synthetic 99xxxx border-helper symbols (Mapper uses base+offset,
      // we use a global 99xxxx range) show up as extra/missing symbols
      // that pair up 1-to-1 in each fixture. Neither side is wrong — the
      // functional reference is preserved (see `borderSym` in ignore list)
      // — so exclude them from the presence-diff too.
      const isBorderHelper = num => num >= 990000 && num < 1000000
      const isMapperBorderHelper = (num, other) => {
        // Mapper's border-helper convention: `base + N` where `N` is a
        // small suffix and `base` (e.g. 301000) is a real area symbol.
        const base = Math.floor(num / 1000) * 1000
        if (base === num) return false
        return other.has(base) && !other.has(num)
      }
      for (const num of groundBy.keys()) {
        if (regBy.has(num)) continue
        if (isMapperBorderHelper(num, regBy)) continue
        mismatches.push({
          path: `<symbol ${symbolLabel(groundBy.get(num))}>`,
          expected: '(present)',
          actual: '(missing)',
        })
      }
      for (const num of regBy.keys()) {
        if (groundBy.has(num)) continue
        if (isBorderHelper(num)) continue
        mismatches.push({
          path: `<symbol ${symbolLabel(regBy.get(num))}>`,
          expected: '(missing)',
          actual: '(present)',
        })
      }
      for (const [num, ground] of groundBy) {
        const reg = regBy.get(num)
        if (!reg) continue
        diffValue(ground, reg, `<symbol ${symbolLabel(ground)}>`, mismatches)
      }

      if (mismatches.length === 0) {
        t.pass()
        return
      }
      t.fail(
        `${parityScore({
          mismatches,
          symbolCount: groundBy.size,
          fieldCount: mismatches.comparisons,
          what: "panmap's xmap→ocd conversion",
          against: "Mapper's own xmap→ocd",
        })}\n${formatDiff(
          mismatches.slice(0, 500),
        )}`,
      )
    } finally {
      await fs.unlink(tmp).catch(() => {})
    }
  })
}
