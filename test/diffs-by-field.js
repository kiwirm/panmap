// Show specific diffs for a given field across all symbols.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { read as readMap, write as writeMap, ocad } from '../src/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = process.argv[2] ?? 'ara-c122f2d'
const FIELD = process.argv[3] ?? 'flags'
const dir = path.join(HERE, 'parity-fixtures', FIX)
const OCD = path.join(dir, 'mapper.ocd')

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'diff-'))
  const src = await readMap(OCD)
  const xmapOut = path.join(tmp, 't.xmap')
  await writeMap(src, xmapOut)
  const rt = await readMap(xmapOut)
  const ocdOut = path.join(tmp, 't.ocd')
  await writeMap(rt, ocdOut)

  const ours = (await ocad.readRaw(ocdOut, { quietWarnings: true })).symbols
  const mapper = (await ocad.readRaw(OCD, { quietWarnings: true })).symbols

  const diffs = []
  for (const m of mapper) {
    const o = ours.find(s => s.symNum === m.symNum)
    if (!o) continue
    if (JSON.stringify(o[FIELD]) !== JSON.stringify(m[FIELD])) {
      diffs.push({ symNum: m.symNum, otp: m.otp, desc: m.description?.slice(0, 30), o: o[FIELD], m: m[FIELD] })
    }
  }
  console.log(`${diffs.length} symbols differ on '${FIELD}':`)
  for (const d of diffs.slice(0, 20)) {
    console.log(` sym ${d.symNum} (otp=${d.otp}) "${d.desc}": ours=${JSON.stringify(d.o).slice(0,60)} mapper=${JSON.stringify(d.m).slice(0,60)}`)
  }
  fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}
main()
