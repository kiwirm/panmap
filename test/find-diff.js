// Find symbols where a nested field diff (e.g. doubleLine.dblMode) occurs.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { read as readMap, write as writeMap, ocad } from '../src/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = process.argv[2] ?? 'ara-c122f2d'
const KEY = process.argv[3] ?? 'dblMode'
const OCD = path.join(HERE, 'parity-fixtures', FIX, 'mapper.ocd')

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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fd-'))
  const src = await readMap(OCD)
  const xmapOut = path.join(tmp, 't.xmap')
  await writeMap(src, xmapOut)
  const rt = await readMap(xmapOut)
  const ocdOut = path.join(tmp, 't.ocd')
  await writeMap(rt, ocdOut)
  const ours = (await ocad.readRaw(ocdOut, { quietWarnings: true })).symbols
  const mapper = (await ocad.readRaw(OCD, { quietWarnings: true })).symbols
  for (const m of mapper) {
    const o = ours.find(s => s.symNum === m.symNum)
    if (!o) continue
    const diffs = []
    walk('', o, m, diffs)
    const key = diffs.filter(d => d.path.endsWith('.' + KEY) || d.path === '.' + KEY)
    if (key.length) {
      console.log(`sym ${m.symNum} (otp=${m.otp}) "${m.description?.slice(0, 40)}"`)
      for (const d of key) console.log(`  ${d.path}: ours=${JSON.stringify(d.ours)} mapper=${JSON.stringify(d.mapper)}`)
    }
  }
  fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}
main()
