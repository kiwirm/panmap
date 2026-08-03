// Diagnose xmap→gitmap→ocd path for a single fixture.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { read as readMap, write as writeMap, ocad } from '../src/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = process.argv[2] ?? 'port-hills-d302447'
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
  'fillColor', 'fillOn', 'borderOn', 'lineColor', 'lineWidth', 'lineStyle',
  'fontColor', 'fontSize', 'nColors',
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
const files = await fs.readdir(dir)
const xmapPath = path.join(dir, files.find(f => f === 'source.xmap' || f === 'source.omap'))
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'x2gm-'))
const map = await readMap(xmapPath)
const gm = path.join(tmp, 't.gitmap')
await writeMap(map, gm)
const rt = await readMap(gm)
const out = path.join(tmp, 't.ocd')
await writeMap(rt, out)
const ours = (await ocad.readRaw(out, { quietWarnings: true })).symbols
const mapper = (await ocad.readRaw(OCD, { quietWarnings: true })).symbols

const problems = []
for (const m of mapper) {
  const o = ours.find(s => s.symNum === m.symNum)
  if (!o) continue
  const diffs = []
  for (const k of Object.keys(m)) {
    if (IGNORE.has(k)) continue
    collectDiffs(k, o[k], m[k], diffs)
  }
  const crit = diffs.filter(d => RENDER_CRITICAL.has(d.path.split('.').pop()))
  if (crit.length) problems.push({ symNum: m.symNum, otp: m.otp, desc: m.description?.slice(0, 40), crit })
}

console.log(`${problems.length} symbols with critical diffs:\n`)
for (const p of problems.slice(0, 15)) {
  console.log(`sym ${p.symNum} (otp=${p.otp}) "${p.desc}"`)
  for (const d of p.crit.slice(0, 3)) {
    console.log(`  ${d.path}: ours=${JSON.stringify(d.ours)} mapper=${JSON.stringify(d.mapper)}`)
  }
}

fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}
main()
