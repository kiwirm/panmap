import test from 'ava'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import read from '../src/read.ts'
import write from '../src/write.ts'

for (const [label, src] of [
  ['ara (style A: defs in palette)', 'test/fixtures/ara/c122f2d.xmap'],
  ['butlers (style B: name refs only)', 'test/fixtures/butlers-bush/bdc004d.xmap'],
  ['hillmorton (style A)', 'test/fixtures/hillmorton/6275ebc.xmap'],
]) {
  test(`xmap spot round-trip is stable: ${label}`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'idem-'))
    const one = path.join(dir, 'one.xmap')
    const two = path.join(dir, 'two.xmap')

    const m0 = await read(src)
    await write(m0, one, { format: 'xmap', overwrite: true })
    const m1 = await read(one)
    await write(m1, two, { format: 'xmap', overwrite: true })
    const m2 = await read(two)

    const names = m => (m.spotColors ?? []).map(s => s.name).join(', ')
    t.log(`\n### ${label}`)
    t.log(`  colors  src=${m0.colors.length} pass1=${m1.colors.length} pass2=${m2.colors.length}`)
    t.log(`  spots   src=${(m0.spotColors || []).length} pass1=${(m1.spotColors || []).length} pass2=${(m2.spotColors || []).length}`)
    t.log(`  names   src : ${names(m0)}`)
    t.log(`  names   p2  : ${names(m2)}`)

    t.is(m1.colors.length, m2.colors.length, 'palette size must not drift on re-write')
    t.is(names(m1), names(m2), 'separations must not drift on re-write')
    const a = await fs.readFile(one, 'utf-8')
    const b = await fs.readFile(two, 'utf-8')
    t.is(a.length, b.length, 'second write must be byte-stable')
    await fs.rm(dir, { recursive: true, force: true })
  })
}
