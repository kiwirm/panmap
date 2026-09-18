/**
 * One-off: route latest bottle-lake through gitmap → produce fresh
 * .ocd and .xmap files for visual comparison in mapwall.
 *   ocd → panmap → gitmap → panmap → {ocd, xmap}
 *
 * Also verifies the marked-vertex flag rule survives the round trip:
 * OCAD's corner (0x01) / dash (0x08) bytes collapse to one canonical
 * flag and are re-derived from the symbol on write, per Mapper's own
 * ocd_file_export.cpp rule.
 */
import test from 'ava'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { mapToOmapXml } from './helpers/omap.js'
import readOcadFile from '../src/formats/ocad/reader/decode/index.ts'
import ocadFileToMap from '../src/formats/ocad/reader/to-panmap.ts'
import writeGitmap from '../src/formats/gitmap/writer/index.ts'
import readGitmap from '../src/formats/gitmap/reader/index.ts'
import writeOcad from '../src/formats/ocad/writer/index.ts'

const SRC = 'test/fixtures/bottle-lake/7f36fe7.ocd'

// Tally yFlags bytes across every object coord of a parsed OCD file.
async function flagTally(file) {
  const parsed = await readOcadFile(await fs.readFile(file))
  const counts = { corner: 0, dash: 0, hole: 0 }
  for (const obj of parsed.objects ?? []) {
    for (const c of obj.coordinates ?? []) {
      const y = c.yFlags ?? 0
      if (y & 0x01) counts.corner++
      if (y & 0x08) counts.dash++
      if (y & 0x02) counts.hole++
    }
  }
  return counts
}

test('bottle-lake ocd → gitmap → {ocd, xmap}', async t => {
  const outDir = path.join(os.homedir(), 'Downloads', 'bottle-lake-regen')
  await fs.rm(outDir, { recursive: true, force: true })
  await fs.mkdir(outDir, { recursive: true })

  const map0 = ocadFileToMap(await readOcadFile(await fs.readFile(SRC)))
  const gitmapDir = path.join(outDir, 'bottle-lake.gitmap')
  await writeGitmap(map0, gitmapDir)
  const map1 = await readGitmap(gitmapDir)

  const ocdOut = path.join(outDir, 'bottle-lake.ocd')
  await writeOcad(map1, ocdOut)
  const xmapOut = path.join(outDir, 'bottle-lake.xmap')
  await fs.writeFile(xmapOut, await mapToOmapXml(map1))

  const src = await flagTally(SRC)
  const out = await flagTally(ocdOut)
  t.log(`\n### marked-vertex flags (object coords)`)
  t.log(`  source : corner=${src.corner} dash=${src.dash} hole=${src.hole}`)
  t.log(`  output : corner=${out.corner} dash=${out.dash} hole=${out.hole}`)
  t.log(`  total marked  src=${src.corner + src.dash} out=${out.corner + out.dash}`)

  const ocdStat = await fs.stat(ocdOut)
  const xmapStat = await fs.stat(xmapOut)
  t.log(`\n  ocd  : ${ocdOut} (${(ocdStat.size / 1e6).toFixed(1)} MB)`)
  t.log(`  xmap : ${xmapOut} (${(xmapStat.size / 1e6).toFixed(1)} MB)`)
  t.log(`  gitmap: ${gitmapDir}`)

  t.is(
    out.corner + out.dash,
    src.corner + src.dash,
    'total marked vertices must be preserved through the round trip',
  )
  t.true(out.dash > 0, 'the dash byte must still be emitted for dashed lines')
})
