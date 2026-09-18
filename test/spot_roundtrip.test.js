import test from 'ava'
import fs from 'node:fs/promises'
import readOcad from '../src/formats/ocad/reader/decode/index.ts'
import ocadFileToMap from '../src/formats/ocad/reader/to-panmap.ts'
import omapFileToMap from '../src/formats/omap/reader/to-panmap.ts'
import { readOmap } from './helpers/omap.js'
import writeGitmap from '../src/formats/gitmap/writer/index.ts'
import readGitmap from '../src/formats/gitmap/reader/index.ts'

for (const [label, base] of [
  ['hillmorton', 'hillmorton/6275ebc'],
  ['butlers-bush', 'butlers-bush/bdc004d'],
  ['kura-tawhiti', 'kura-tawhiti/0b613b2'],
]) {
  test(`spotColors survive gitmap: ${label}`, async t => {
    const ocdMap = ocadFileToMap(
      await readOcad(await fs.readFile(`test/fixtures/${base}.ocd`)),
    )
    const xmapMap = omapFileToMap(
      await readOmap(await fs.readFile(`test/fixtures/${base}.xmap`, 'utf-8')),
    )
    const names = m => (m.spotColors ?? []).map(s => s.name)
    console.log(`\n### ${label}`)
    console.log('  from OCD :', names(ocdMap).join(', ') || '(none)')
    console.log('  from XMap:', names(xmapMap).join(', ') || '(none)')

    const dir = `/tmp/spotrt-${base.replace(/\//g, '-')}`
    await fs.rm(dir, { recursive: true, force: true })
    await writeGitmap(ocdMap, dir)
    const back = await readGitmap(dir)
    console.log('  after gitmap round-trip:', names(back).join(', ') || '(none)')
    t.deepEqual(
      names(back),
      names(ocdMap),
      'spotColors must survive a gitmap write/read cycle',
    )
  })
}
