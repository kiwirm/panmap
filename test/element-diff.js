import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { read as readMap, write as writeMap, ocad } from '../src/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = process.argv[2] ?? 'ara-c122f2d'
const NUM = Number(process.argv[3] ?? '101001')
const OCD = path.join(HERE, 'parity-fixtures', FIX, 'mapper.ocd')

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ed-'))
  const src = await readMap(OCD)
  const xmapOut = path.join(tmp, 't.xmap')
  await writeMap(src, xmapOut)
  const rt = await readMap(xmapOut)
  const ocdOut = path.join(tmp, 't.ocd')
  await writeMap(rt, ocdOut)
  const ours = (await ocad.readRaw(ocdOut, { quietWarnings: true })).symbols
  const mapper = (await ocad.readRaw(OCD, { quietWarnings: true })).symbols
  const o = ours.find(s => s.symNum === NUM)
  const m = mapper.find(s => s.symNum === NUM)
  console.log('OURS elements:', JSON.stringify(o.elements, null, 2))
  console.log('MAPPER elements:', JSON.stringify(m.elements, null, 2))
  fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}
main()
