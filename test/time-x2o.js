import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { read as readMap, write as writeMap } from '../src/index.ts'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = process.argv[2] ?? 'rangiora-7545c63'
const dir = path.join(HERE, 'parity-fixtures', FIX)
const xmapPath = path.join(dir, 'source.xmap')
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'time-'))
  const t0 = performance.now()
  const map = await readMap(xmapPath)
  const t1 = performance.now()
  console.log(`read: ${((t1-t0)/1000).toFixed(2)}s (${map.symbols.length} syms, ${map.objects.length} objs)`)
  const out = path.join(tmp, 't.ocd')
  await writeMap(map, out)
  const t2 = performance.now()
  console.log(`write: ${((t2-t1)/1000).toFixed(2)}s`)
  fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
}
main()
