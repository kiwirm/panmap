import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { read as readMap, write as writeMap } from '../src/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = process.argv[2] ?? 'ara-c122f2d'
const CODE = process.argv[3] ?? '108'
const dir = path.join(HERE, 'parity-fixtures', FIX)
const OCD = path.join(dir, 'mapper.ocd')

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'diag-'))
  const src = await readMap(OCD)
  const xmapOut = path.join(tmp, 't.xmap')
  await writeMap(src, xmapOut)
  const xml = await fs.readFile(xmapOut, 'utf-8')
  // find the symbol block
  const rx = new RegExp(`<symbol[^>]*code="${CODE}[^"]*"[\\s\\S]*?</symbol>`, 'g')
  const matches = xml.match(rx)
  if (matches) {
    for (const m of matches) console.log(m + '\n')
  } else {
    console.log('no match for code=' + CODE)
  }
  fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}
main()
