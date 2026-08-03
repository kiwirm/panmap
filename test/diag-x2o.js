// xmap → ocd direct
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { read as readMap, write as writeMap, ocad } from '../src/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = process.argv[2] ?? 'ara-c122f2d'
const dir = path.join(HERE, 'parity-fixtures', FIX)
const OCD = path.join(dir, 'mapper.ocd')

const IGNORE = new Set([
  '_byteRange', 'warnings', 'iconBits', 'descriptionWords',
  'symbolTreeGroup', 'mystery64', 'size', 'filePos', '_tail',
  '_fontNameBytes',
])
const RENDER_CRITICAL = new Set([
  'hatchMode', 'hatchColor', 'hatchLineWidth', 'hatchDist',
  'hatchAngle1', 'hatchAngle2', 'structMode', 'structDraw',
  'structWidth', 'structHeight', 'structAngle',
  'fillColor', 'fillOn', 'borderOn', 'lineColor', 'lineWidth',
  'lineStyle', 'fontColor', 'fontSize', 'nColors',
])
function walk(name, ov, mv, out) {
  if (JSON.stringify(ov) === JSON.stringify(mv)) return
  if (ov && mv && typeof ov === 'object' && typeof mv === 'object' && !Array.isArray(ov)) {
    for (const k of new Set([...Object.keys(ov), ...Object.keys(mv)])) {
      walk(name + '.' + k, ov[k], mv[k], out)
    }
    return
  }
  out.push({ path: name, ours: ov, mapper: mv })
}
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'x2o-'))
  const files = await fs.readdir(dir)
  const xmapPath = path.join(dir, files.find(f => f === 'source.xmap' || f === 'source.omap'))
  const map = await readMap(xmapPath)
  const out = path.join(tmp, 't.ocd')
  await writeMap(map, out)
  const ours = (await ocad.readRaw(out, { quietWarnings: true })).symbols
  const mapper = (await ocad.readRaw(OCD, { quietWarnings: true })).symbols
  const tally = new Map()
  let critsyms = 0
  for (const m of mapper) {
    const o = ours.find(s => s.symNum === m.symNum)
    if (!o) continue
    const diffs = []
    for (const k of Object.keys(m)) { if (!IGNORE.has(k)) walk(k, o[k], m[k], diffs) }
    const crit = diffs.filter(d => RENDER_CRITICAL.has(d.path.split('.').pop()))
    if (crit.length) critsyms++
    for (const d of diffs) {
      const leaf = d.path.split('.').pop()
      tally.set(leaf, (tally.get(leaf) ?? 0) + 1)
    }
  }
  console.log(`\n${critsyms} symbols with critical diffs; top diffs:`)
  const rows = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 15)
  for (const [k, n] of rows) console.log(` ${RENDER_CRITICAL.has(k) ? '*' : ' '} ${n.toString().padStart(4)} ${k}`)
  fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}
main()
