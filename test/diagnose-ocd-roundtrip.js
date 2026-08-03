// Diagnostic — where does the ocd→xmap→ocd path lose parity?
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { read as readMap, write as writeMap, ocad } from '../src/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = process.argv[2] ?? 'ara-c122f2d'
const FIELD = process.argv[3] // optional: filter to symbols with this field diff
const dir = path.join(HERE, 'parity-fixtures', FIX)
const OCD = path.join(dir, 'mapper.ocd')

const IGNORE = new Set([
  '_byteRange', 'warnings', 'iconBits', 'descriptionWords',
  'symbolTreeGroup', 'mystery64', 'size', 'filePos', '_tail',
  '_fontNameBytes',
])
const RENDER_CRITICAL = new Set([
  'hatchMode', 'hatchColor', 'hatchLineWidth', 'hatchDist',
  'hatchAngle1', 'hatchAngle2',
  'structMode', 'structDraw', 'structWidth', 'structHeight', 'structAngle',
  'fillColor', 'fillOn',
  'borderOn',
  'lineColor', 'lineWidth', 'lineStyle',
  'fontColor', 'fontSize',
  'nColors',
])

function collectDiffs(name, ov, mv, out) {
  if (JSON.stringify(ov) === JSON.stringify(mv)) return
  if (ov && mv && typeof ov === 'object' && typeof mv === 'object' && !Array.isArray(ov)) {
    const keys = new Set([...Object.keys(ov), ...Object.keys(mv)])
    for (const k of keys) collectDiffs(name + '.' + k, ov[k], mv[k], out)
    return
  }
  out.push({ path: name, ours: ov, mapper: mv })
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'diag-'))
  const src = await readMap(OCD)
  const xmapOut = path.join(tmp, 't.xmap')
  await writeMap(src, xmapOut)
  const rt = await readMap(xmapOut)
  const ocdOut = path.join(tmp, 't.ocd')
  await writeMap(rt, ocdOut)

  const ours = (await ocad.readRaw(ocdOut, { quietWarnings: true })).symbols
  const mapper = (await ocad.readRaw(OCD, { quietWarnings: true })).symbols

  const tally = new Map()
  const symDiffs = []
  for (const m of mapper) {
    const o = ours.find(s => s.symNum === m.symNum)
    if (!o) continue
    const diffs = []
    for (const k of Object.keys(m)) {
      if (IGNORE.has(k)) continue
      collectDiffs(k, o[k], m[k], diffs)
    }
    for (const d of diffs) {
      const leaf = d.path.split('.').pop()
      const key = leaf
      tally.set(key, (tally.get(key) ?? 0) + 1)
    }
    const criticalDiffs = diffs.filter(d => RENDER_CRITICAL.has(d.path.split('.').pop()))
    if (criticalDiffs.length) {
      symDiffs.push({ symNum: m.symNum, otp: m.otp, description: m.description?.slice(0, 40), critical: criticalDiffs, all: diffs })
    }
  }

  const rows = [...tally].sort((a, b) => b[1] - a[1])
  console.log(`\n== Top diff fields (${FIX}) ==`)
  for (const [k, n] of rows.slice(0, 30)) {
    const marker = RENDER_CRITICAL.has(k) ? '*' : ' '
    console.log(` ${marker} ${n.toString().padStart(4)}  ${k}`)
  }

  console.log(`\n== ${symDiffs.length} symbols with critical diffs ==`)
  for (const s of symDiffs.slice(0, 20)) {
    const flt = FIELD
      ? s.critical.filter(d => d.path.includes(FIELD))
      : s.critical
    if (FIELD && !flt.length) continue
    console.log(`\nsym ${s.symNum} (otp=${s.otp}) "${s.description}"`)
    for (const d of flt.slice(0, 5)) {
      console.log(`  ${d.path}: ours=${JSON.stringify(d.ours)} mapper=${JSON.stringify(d.mapper)}`)
    }
  }

  fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}
main()
