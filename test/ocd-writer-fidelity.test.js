/**
 * OCD WRITER fidelity: ocd → gitmap → ocd must preserve the symbol fields
 * that decide whether decoration is DRAWN.
 *
 * The convergence suite can't catch this class of bug. It compares an
 * OCD-sourced gitmap against an XMap-sourced one — it measures whether two
 * READERS agree, not whether the writer emits correct bytes. A symbol can sit
 * at 100% convergence while the writer silently drops its tags, because both
 * readers agree about a value the writer then fails to reconstruct.
 *
 * Concrete case this was written for: the canonical model omits
 * `midSymbolsPerSpot` when it equals 1 (Mapper's default). The OCD writer
 * fell back to `?? 0`, so 104 Earth bank and 108 Small erosion gully exported
 * with their tick geometry intact and `nPrimSym=0` — present but invisible.
 * Convergence stayed green throughout.
 */
import test from 'ava'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import read from '../src/read.ts'
import write from '../src/write.ts'
import readOcadFile from '../src/formats/ocad/reader/decode/index.ts'

const FIX = 'test/fixtures'
const MAPS = ['bottle-lake', 'hillmorton', 'laidmore']

// Count fields that gate whether OCAD renders line decoration, paired with
// the geometry array each one governs. A count of zero only matters when the
// geometry is actually present — that is the "present but invisible" failure.
// A count zeroed on a symbol with no elements draws nothing either way.
const GATES = [
  ['nPrimSym', 'primSymElements'],
  ['nSecSym', 'secSymElements'],
  ['nCornerSym', 'cornerSymElements'],
  ['nStartSym', 'startSymElements'],
  ['nEndSym', 'endSymElements'],
]

function symbolsByNum(parsed) {
  const m = new Map()
  for (const s of parsed.symbols || []) {
    const num = s.symNum ?? s.number
    if (num !== undefined) m.set(num, s)
  }
  return m
}

for (const mapName of MAPS) {
  test(`ocd writer preserves decoration gates: ${mapName}`, async t => {
    const dir = `${FIX}/${mapName}/`
    const file = fs.readdirSync(dir).find(f => f.endsWith('.ocd'))
    if (!file) return t.pass('no ocd fixture')
    const src = dir + file

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocdfid-'))
    try {
      const map = await read(src)
      const gm = path.join(tmp, 'g.gitmap')
      await write(map, gm, { format: 'gitmap', overwrite: true })
      const back = await read(gm)
      const out = path.join(tmp, 'out.ocd')
      await write(back, out, { format: 'ocad', overwrite: true })

      const before = symbolsByNum(await readOcadFile(await fs.promises.readFile(src)))
      const after = symbolsByNum(await readOcadFile(await fs.promises.readFile(out)))

      const lost = []
      for (const [num, a] of before) {
        const b = after.get(num)
        if (!b) continue
        for (const [field, geomField] of GATES) {
          const va = a[field]
          const vb = b[field]
          if (va === undefined || vb === undefined) continue
          const geomBefore = (a[geomField] || []).length
          const geomAfter = (b[geomField] || []).length
          // Present-but-invisible: the geometry survived the round trip but
          // the count that decides how many times to draw it went to zero.
          if (va > 0 && vb === 0 && geomBefore > 0 && geomAfter > 0) {
            lost.push(`sym ${num}: ${field} ${va} → ${vb} (${geomField} kept: ${geomAfter})`)
          }
        }
      }
      if (lost.length) {
        t.log(`decoration gates zeroed on export (${lost.length}):`)
        for (const l of lost.slice(0, 15)) t.log(`  ${l}`)
      }
      t.deepEqual(lost, [], 'no decoration gate may drop to zero on ocd round-trip')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
}
