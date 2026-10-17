/**
 * Ground-truth OCAD parity — the OCD analog of omap-source-parity.
 *
 * The convergence + roundtrip tests both compare panmap's output against
 * ITSELF (a second read cycle, or an OCD-serialised gitmap that came out
 * of the same reader). They don't catch a writer bug that drops or
 * mangles a symbol field in a way the reader can't tell was ever there.
 *
 * This test compares against the Mapper-authored source `.ocd` directly:
 *   src.ocd  --read-->  PanMap  --write-->  tmp.ocd  --read-->  regen
 * Then walks the parsed `OcadFile.symbols` array for both and reports
 * every field-level mismatch between the source symbol and its regen
 * twin (keyed by `symNum`). Failure output pinpoints "symbol 104.0
 * (Earth bank), lineWidth: expected=180 actual=140" rather than a whole-
 * file dump.
 *
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import test from 'ava'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readOcad from '../src/formats/ocad/reader/decode/index.ts'
import ocadFileToMap from '../src/formats/ocad/reader/to-panmap.ts'
import writeOcad from '../src/formats/ocad/writer/index.ts'
import { fixtureFile } from './helpers/fixtures.js'
import { parityScore } from './helpers/parity-score.js'

// Every .ocd fixture in the corpus (one per map's latest revision — a
// new revision of the same map exercises the same writer paths). The
// smoke set (basic-1, double-line) is present after a bare clone; the
// full club corpus arrives via `npm run fetch:test-data`.
const FIXTURES = [
  { name: 'basic-1', file: 'basic-1.ocd' },
  { name: 'double-line', file: 'double-line.ocd' },
  { name: 'ara', file: 'ara-c122f2d.ocd' },
  { name: 'bottle-lake-bc98714', file: 'bottle-lake-bc98714.ocd' },
  { name: 'butlers-bush', file: 'butlers-bush-bdc004d.ocd' },
  { name: 'castle-hill-village', file: 'castle-hill-village-22e8154.ocd' },
  { name: 'hillmorton', file: 'hillmorton-6275ebc.ocd' },
  { name: 'jarnvag', file: 'jarnvag.ocd' },
  { name: 'kura-tawhiti', file: 'kura-tawhiti-0b613b2.ocd' },
  { name: 'laidmore', file: 'laidmore-0f52898.ocd' },
  { name: 'leithfield', file: 'leithfield-69f0423.ocd' },
  { name: 'lincoln-university', file: 'lincoln-university-d44e8ce.ocd' },
  { name: 'myggfritt', file: 'myggfritt_byggnad2.ocd' },
  {
    name: 'nga-puna-wai-canterbury-park',
    file: 'nga-puna-wai-canterbury-park-beba671.ocd',
  },
  { name: 'orua-paeroa', file: 'orua-paeroa-bf353d6.ocd' },
  { name: 'rangiora', file: 'rangiora-7545c63.ocd' },
  { name: 'tahunanui', file: '202012_Tahunanui.ocd' },
  {
    name: 'university-of-canterbury',
    file: 'university-of-canterbury-f3dd92a.ocd',
  },
  { name: 'woodend', file: 'woodend-b5d4d39.ocd' },
]

// Symbol-record fields we never enforce. The writer intentionally re-emits
// some in a canonical form (e.g. sym-num renumbering, per-export negative
// icon IDs). These aren't rendering bugs — Mapper reads either form.
const IGNORED_FIELDS = new Set([
  // Derived / positional (recomputed on rewrite; not a rendering diff)
  '_indexRecord',
  '_byteRange', // where the record lives in the source buffer
  '_res',
  '_tail', // trailing padding bytes emitted by Mapper but not our writer
  'icon', // export-time raster preview; can differ or be omitted
  'iconBits', // raw raster bytes; same rationale as `icon`
  'symNum', // matched-on separately; a writer that renumbered ID isn't a bug
  'extent', // derived bounding-box size; recomputed each write
  'size', // total record size — derived from the content
  'filePos', // byte offset in the file
  // Mapper-only metadata that panmap does not model (UI hints /
  // toolbelt state; no rendering impact). Preserving them requires
  // either an OCD-only sidecar (leaks) or matching OMap-side support
  // that Mapper's XML doesn't clearly encode.
  'preferredDrawingTool', // UI toolbar selection
  'status', // Mapper symbol status/state
  // Line-symbol defaults where OCD's disk default (-1 for `minSym`)
  // and OMap's disk default (`show_at_least_one_symbol="true"` for
  // the same slot) are semantically opposite. Mapping to a single
  // canonical value breaks gitmap convergence one way or the other;
  // both defaults produce the same visual, so accept the raw-byte
  // diff and don't enforce it here.
  'minSym',
])

// Field names inside SUB-OBJECTS that we ignore (e.g. `doubleLine.*`,
// `decrease.*`). Same rationale as IGNORED_FIELDS but scoped so we
// only skip these in a specific context, not everywhere.
const IGNORED_SUBOBJECT_FIELDS = new Map([
  // `decrease.*` (line-width tapering along a line). Panmap doesn't
  // model this OCAD-only feature; the writer emits zero defaults.
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
  // `doubleLine.dbl*Color` when `dblMode=0` — Mapper stores leftover
  // colour values from a previous double-line config, but with mode=0
  // they don't render. Our writer emits 0 (no double-line layer created)
  // which is semantically equivalent.
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

// Structured child arrays / objects we DO recurse into. Anything else is a
// leaf comparison (===). Kept as an allow-list so a stray raw-buffer field
// doesn't try to deep-diff megabytes of Uint8Array.
const RECURSE_KEYS = new Set([
  'doubleLine',
  'decrease',
  'primSymElements',
  'secSymElements',
  'cornerSymElements',
  'startSymElements',
  'endSymElements',
  'elements',
  'coords',
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
  // Object / array
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
  // Plain object — walk only keys we care about.
  const parentKey = path.match(/\.([a-zA-Z]+)$/)?.[1]
  const subIgnores = parentKey ? IGNORED_SUBOBJECT_FIELDS.get(parentKey) : null
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)])
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue
    if (subIgnores?.has(key)) continue
    const expChild = expected[key]
    const actChild = actual[key]
    // Leaf primitives compare directly; nested arrays/objects recurse only
    // when they're in the RECURSE allow-list or when both sides are plain
    // objects (small structs like `doubleLine`).
    if (
      typeof expChild === 'object' &&
      expChild !== null &&
      !RECURSE_KEYS.has(key) &&
      !Array.isArray(expChild)
    ) {
      // Small nested struct — recurse.
      diffValue(expChild, actChild, `${path}.${key}`, out)
    } else if (Array.isArray(expChild) && !RECURSE_KEYS.has(key)) {
      // Unknown array — compare length only, skip contents.
      if (
        !Array.isArray(actChild) ||
        expChild.length !== (actChild ? actChild.length : 0)
      ) {
        out.push({
          path: `${path}.${key}`,
          expected: `array[${expChild.length}]`,
          actual: Array.isArray(actChild)
            ? `array[${actChild.length}]`
            : actChild,
        })
      }
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

for (const { name, file } of FIXTURES) {
  test(`ocd ground-truth parity: ${name}`, async t => {
    const src = fixtureFile(file)
    const srcFile = await readOcad(await fs.readFile(src))
    const map = ocadFileToMap(srcFile)

    const tmp = path.join(
      os.tmpdir(),
      `panmap-${process.pid}-${Date.now()}.ocd`,
    )
    try {
      await writeOcad(map, tmp)
      const regenFile = await readOcad(await fs.readFile(tmp))

      const srcBy = symbolsBySymNum(srcFile)
      const regBy = symbolsBySymNum(regenFile)

      const mismatches = []

      for (const num of srcBy.keys()) {
        if (!regBy.has(num)) {
          mismatches.push({
            path: `<symbol ${symbolLabel(srcBy.get(num))}>`,
            expected: '(present)',
            actual: '(missing)',
          })
        }
      }
      for (const num of regBy.keys()) {
        if (!srcBy.has(num)) {
          mismatches.push({
            path: `<symbol ${symbolLabel(regBy.get(num))}>`,
            expected: '(missing)',
            actual: '(present)',
          })
        }
      }
      for (const [num, src] of srcBy) {
        const reg = regBy.get(num)
        if (!reg) continue
        diffValue(src, reg, `<symbol ${symbolLabel(src)}>`, mismatches)
      }

      if (mismatches.length === 0) {
        t.pass()
        return
      }
      t.fail(
        `${parityScore({
          mismatches,
          symbolCount: srcBy.size,
          fieldCount: mismatches.comparisons,
          what: "panmap's regenerated ocd",
          against: 'the Mapper-authored source',
        })}\n${formatDiff(mismatches.slice(0, 40))}`,
      )
    } finally {
      await fs.unlink(tmp).catch(() => {})
    }
  })
}
