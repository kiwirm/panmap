/**
 * XMAP WRITER fidelity: xmap → gitmap → xmap must preserve the decoration
 * a symbol actually DRAWS.
 *
 * Counterpart to ocd-writer-fidelity.test.js, and it exists for the same
 * reason. Neither the convergence suite nor omap-roundtrip covers this:
 *
 *  - convergence compares an OCD-sourced gitmap against an XMap-sourced one,
 *    so it measures whether two READERS agree, not what a writer emits.
 *  - omap-roundtrip asserts counts + idempotence and does NOT route through
 *    gitmap, so a value dropped at the gitmap boundary round-trips happily.
 *  - omap-source-parity does cover this path, but it is red with documented
 *    by-design losses, so a new regression hides in the noise.
 *
 * The failure mode guarded here is "present but invisible": the decoration
 * block survives the round trip while the count that decides how often to
 * draw it goes to zero, or the block is dropped outright. That is how 104
 * Earth bank lost its tick marks on the OCD side while every metric stayed
 * green.
 */
import test from 'ava'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { XMLParser } from 'fast-xml-parser'
import read from '../src/read.ts'
import write from '../src/write.ts'
import { mapToOmapXml } from './helpers/omap.js'

const FIX = 'test/fixtures'
const MAPS = ['bottle-lake', 'hillmorton', 'laidmore']

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  trimValues: false,
})

// Decoration blocks a line symbol can carry. Each renders something; losing
// one means geometry silently stops being drawn.
const DECOR = ['mid_symbol', 'dash_symbol', 'start_symbol', 'end_symbol']

// Does this subtree draw any ink? True when some node references a real
// colour — xmap uses -1 for "no colour", so anything >= 0 paints. Walks the
// whole subtree because the ink usually lives on a nested <element>, not on
// the block's own wrapper.
function paintsInk(node) {
  if (!node || typeof node !== 'object') return false
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') && /color$/i.test(key.slice(2))) {
      if (Number(value) >= 0) return true
      continue
    }
    for (const child of Array.isArray(value) ? value : [value]) {
      if (paintsInk(child)) return true
    }
  }
  return false
}

// Tally decoration blocks across the WHOLE file, keyed by type only.
//
// Deliberately not keyed by symbol code: Mapper formats a three-component
// number as `{major}.{minor}{third:02d}` ("512.307") while our writer emits
// `{major}.{minor}.{third}` ("512.3.7"), so code-matching invents losses
// that aren't real. A whole-file tally is immune to that and still catches
// decoration disappearing, which is what this guards.
function decorTally(xml) {
  const root = parser.parse(xml)
  const totals = new Map()
  const visit = node => {
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      const list = Array.isArray(value) ? value : [value]
      for (const child of list) {
        if (!child || typeof child !== 'object') continue
        if (key === 'line_symbol') {
          for (const d of DECOR) {
            if (!child[d]) continue
            const blocks = Array.isArray(child[d]) ? child[d] : [child[d]]
            for (const blk of blocks) {
              // Count a block only if it actually PAINTS. A declared
              // element count is not enough: Mapper authors blocks whose
              // children are all `inner_color="-1" outer_width="0"`, so
              // they render nothing. OCAD cannot express a present-but-
              // blank block (`cornerDSize`/`startDSize`/`endDSize` = 0,
              // no `useSymbolFlags` bit), which makes it single-format
              // data the canonical model deliberately drops. Requiring
              // ink keeps this guard aimed at visible loss rather than
              // at a round-trip of invisible structure.
              if (!paintsInk(blk)) continue
              totals.set(d, (totals.get(d) ?? 0) + 1)
            }
          }
        }
        visit(child)
      }
    }
  }
  visit(root)
  return totals
}

for (const mapName of MAPS) {
  test(`xmap writer preserves line decoration: ${mapName}`, async t => {
    const dir = `${FIX}/${mapName}/`
    const file = fs.readdirSync(dir).find(f => f.endsWith('.xmap'))
    if (!file) return t.pass('no xmap fixture')
    const srcPath = dir + file
    const srcXml = fs.readFileSync(srcPath, 'utf-8')

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omapfid-'))
    try {
      const map = await read(srcPath)
      const gm = path.join(tmp, 'g.gitmap')
      await write(map, gm, { format: 'gitmap', overwrite: true })
      const back = await read(gm)
      const outXml = await mapToOmapXml(back)

      const before = decorTally(srcXml)
      const after = decorTally(outXml)

      const lost = []
      for (const d of DECOR) {
        const b = before.get(d) ?? 0
        const a = after.get(d) ?? 0
        t.log(`  ${d.padEnd(13)} source=${String(b).padStart(3)}  output=${String(a).padStart(3)}`)
        if (a < b) lost.push(`<${d}>: ${b} → ${a}`)
      }
      t.deepEqual(lost, [], 'xmap round-trip must not reduce line-decoration count')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
}
