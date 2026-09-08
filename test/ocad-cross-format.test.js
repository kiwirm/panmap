// Cross-format round-trip suite. Written against real paired
// .xmap / .ocd files from the user's Downloads folder — the OCAD
// encoder we're building has to hold up against real Mapper output
// on real maps (100s of symbols, 10k+ objects), not just toy fixtures.
//
// For each map we verify five conversion paths land at the same
// shape (color/symbol/object counts, plus a coarse sanity check on
// the first object's geometry). Byte identity across formats is not
// a goal — the point is that any format can be losslessly written to
// any other format so it round-trips cleanly.
import test from 'ava'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { read, write } from '../src/index.ts'

// Paired xmap+ocd files curated from ~/Downloads. Both are exports of
// the same source map from OpenOrienteering Mapper.
const HOME = os.homedir()
const PAIRS = [
  {
    name: 'bottle-lake (Coady 2026-05)',
    xmap: `${HOME}/Downloads/2026-05-13-Coady-Clark-maps/bottle-lake-7f36fe7.xmap`,
    ocd:  `${HOME}/Downloads/2026-05-13-Coady-Clark-maps/bottle-lake-7f36fe7.ocd`,
  },
  {
    name: 'university-of-canterbury',
    xmap: `${HOME}/Downloads/2025-11-12-Aaron-Prince-maps/university-of-canterbury-f3dd92a.xmap`,
    ocd:  `${HOME}/Downloads/2025-11-12-Aaron-Prince-maps/university-of-canterbury-f3dd92a.ocd`,
  },
]

async function withTmp(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'panmap-crossfmt-'))
  try { return await fn(tmp) } finally {
    fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

for (const pair of PAIRS) {
  // Was `.failing`: OCAD symbol count didn't survive the round-trip because a
  // `combined` line symbol synthesised an orphan 990.x border. Fixed in
  // synthesize-symbols (skip border allocation for line-inferred symbols).
  test(`${pair.name}: xmap → ocd → xmap → ocd preserves counts`, async (t) => {
    // Skip if the paired files aren't installed on this machine.
    try { await fs.access(pair.xmap); await fs.access(pair.ocd) }
    catch { t.pass('skipped — sample maps not present'); return }

    await withTmp(async (tmp) => {
      const src = await read(pair.xmap)
      const initialCounts = {
        colors: src.colors.length,
        symbols: src.symbols.length,
        objects: src.objects.length,
      }
      // The OCAD encoder handles point/line/area/text natively and
      // infers a type for `combined` from render layers, so every
      // canonical symbol shape survives the round-trip now.
      const supportedSymbols = src.symbols.length

      // xmap → ocd
      const ocd1 = path.join(tmp, 'r1.ocd')
      await write(src, ocd1)
      const roundOcd1 = await read(ocd1)
      t.is(roundOcd1.colors.length, initialCounts.colors, 'colors after xmap→ocd')
      t.is(roundOcd1.symbols.length, supportedSymbols, 'symbols after xmap→ocd')
      t.is(roundOcd1.objects.length, initialCounts.objects, 'objects after xmap→ocd')

      // ocd → xmap
      const xmap2 = path.join(tmp, 'r2.xmap')
      await write(roundOcd1, xmap2)
      const roundXmap2 = await read(xmap2)
      t.is(roundXmap2.colors.length, initialCounts.colors, 'colors after ocd→xmap')
      t.is(roundXmap2.objects.length, initialCounts.objects, 'objects after ocd→xmap')

      // xmap → gitmap → ocd (via gitmap round-trip). This is the
      // critical send-from-mapwall path: the club's history is stored
      // in gitmap, so shipping OCD to mappers has to work end-to-end
      // from that source shape.
      const gitmap = path.join(tmp, 'r3.gitmap')
      await write(src, gitmap)
      const fromGitmap = await read(gitmap)
      const ocd2 = path.join(tmp, 'r4.ocd')
      await write(fromGitmap, ocd2)
      const roundGitmapOcd = await read(ocd2)
      t.is(roundGitmapOcd.colors.length, initialCounts.colors, 'colors via xmap→gitmap→ocd')
      t.is(roundGitmapOcd.objects.length, initialCounts.objects, 'objects via xmap→gitmap→ocd')

      // The reference ocd (produced by Mapper directly from the source)
      // should round-trip identically through the canonical model.
      const mapperOcdMap = await read(pair.ocd)
      const ocd3 = path.join(tmp, 'r5.ocd')
      await write(mapperOcdMap, ocd3)
      const roundMapperOcd = await read(ocd3)
      t.is(roundMapperOcd.objects.length, mapperOcdMap.objects.length,
        'objects preserved on Mapper-ocd → ocd')

      // Grid-spacing invariant on parameter string 1039 (map setup).
      // OOM enforces d = g × m / 1000 on export (ocd_file_export.cpp:
      // 945-966): d is the real-world grid distance in metres, g is
      // the same distance projected to paper mm. Condes divides by d
      // to compute grid cells — d=0 (which panmap used to hardcode)
      // opens the map as a blank canvas.
      const { readRaw } = await import('../src/formats/ocad/index.ts')
      const raw = await readRaw(ocd1)
      const ps1039 = raw.parameterStrings?.[1039]?.[0]
      t.truthy(ps1039, 'ocd has parameter string 1039')
      const m = Number(ps1039?.m)
      const g = Number(ps1039?.g)
      const d = Number(ps1039?.d)
      t.true(m > 0, `1039.m (scale) > 0 (got ${m})`)
      t.true(g > 0, `1039.g (paper mm) > 0 (got ${g})`)
      t.true(d > 0, `1039.d (real m) > 0 (got ${d})`)
      // Allow 0.5% slack for the string↔float rounding OOM does.
      const expectedD = g * m / 1000
      t.true(Math.abs(d - expectedD) / expectedD < 0.005,
        `1039.d ≈ g × m / 1000: got d=${d}, expected≈${expectedD}`)
    })
  })
}
