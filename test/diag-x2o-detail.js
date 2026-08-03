import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { read as readMap, write as writeMap, ocad } from '../src/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = process.argv[2] ?? 'hillmorton-6275ebc'
const FIELD = process.argv[3] ?? 'lineStyle'
const dir = path.join(HERE, 'parity-fixtures', FIX)
const OCD = path.join(dir, 'mapper.ocd')
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'x2o-'))
  const files = await fs.readdir(dir)
  const xmapPath = path.join(dir, files.find(f => f === 'source.xmap' || f === 'source.omap'))
  const map = await readMap(xmapPath)
  const out = path.join(tmp, 't.ocd')
  await writeMap(map, out)
  const ours = (await ocad.readRaw(out, { quietWarnings: true })).symbols
  const mapper = (await ocad.readRaw(OCD, { quietWarnings: true })).symbols
  for (const m of mapper) {
    const o = ours.find(s => s.symNum === m.symNum)
    if (!o) continue
    if (JSON.stringify(o[FIELD]) !== JSON.stringify(m[FIELD])) {
      console.log(`sym ${m.symNum} (otp=${m.otp}) "${m.description?.slice(0, 40)}": ours=${JSON.stringify(o[FIELD])} mapper=${JSON.stringify(m[FIELD])}`)
    }
  }
  fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}
main()
