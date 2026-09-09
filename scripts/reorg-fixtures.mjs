#!/usr/bin/env node
// One-shot mover: test/data/<map>-<rev>.{ocd,xmap} → test/fixtures/<map>/<rev>.{ocd,xmap}.
// Uses `git mv` for tracked paths so xmap history follows the rename; falls
// back to fs rename for untracked (gitignored) .ocd. Idempotent — skips
// paths already at destination.
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'test', 'data')
const DST = path.join(ROOT, 'test', 'fixtures')

// filename → [map-slug, rev-slug]. Single-file maps use the map name as rev.
const SPECIAL = {
  '202012_Tahunanui.ocd':                'tahunanui/202012.ocd',
  'basic-1.ocd':                          'basic-1/basic-1.ocd',
  'double-line.ocd':                      'double-line/double-line.ocd',
  'jarnvag.ocd':                          'jarnvag/jarnvag.ocd',
  'myggfritt_byggnad2.ocd':               'myggfritt/byggnad2.ocd',
  'bottle-lake-bc98714_UpdatedCoady.ocd': 'bottle-lake/bc98714-updated-coady.ocd',
}

// Which multi-word map slugs get folded — anything not listed uses `slug-rev`
// splitting on the LAST hyphen (rev = 7-hex or similar), which matches all
// remaining files in test/data/.
function target(name) {
  if (SPECIAL[name]) return SPECIAL[name]
  const dot = name.lastIndexOf('.')
  const stem = name.slice(0, dot)
  const ext = name.slice(dot)
  const dash = stem.lastIndexOf('-')
  if (dash < 0) return `${stem}/${stem}${ext}`
  const rev = stem.slice(dash + 1)
  const slug = stem.slice(0, dash)
  return `${slug}/${rev}${ext}`
}

function isTracked(p) {
  try {
    execSync(`git ls-files --error-unmatch "${p}"`, { cwd: ROOT, stdio: 'pipe' })
    return true
  } catch { return false }
}

if (!existsSync(SRC)) { console.log('nothing to do — test/data/ already gone'); process.exit(0) }
mkdirSync(DST, { recursive: true })

const files = readdirSync(SRC).filter(f => f.endsWith('.ocd') || f.endsWith('.xmap'))
let moved = 0, skipped = 0
for (const f of files) {
  const rel = target(f)
  const srcAbs = path.join(SRC, f)
  const dstAbs = path.join(DST, rel)
  const dstDir = path.dirname(dstAbs)
  mkdirSync(dstDir, { recursive: true })
  if (existsSync(dstAbs)) { console.log(`skip (dst exists): ${f}`); skipped++; continue }
  const relFromRoot = path.relative(ROOT, srcAbs)
  const relToDst = path.relative(ROOT, dstAbs)
  if (isTracked(relFromRoot)) {
    execSync(`git mv "${relFromRoot}" "${relToDst}"`, { cwd: ROOT, stdio: 'inherit' })
  } else {
    renameSync(srcAbs, dstAbs)
    console.log(`mv (untracked): ${f} → ${rel}`)
  }
  moved++
}

console.log(`\ndone: ${moved} moved, ${skipped} skipped`)

// Empty test/data/? Drop it.
const remaining = readdirSync(SRC).filter(f => !f.startsWith('.'))
if (remaining.length === 0) {
  try { execSync(`git rm -rf --ignore-unmatch test/data`, { cwd: ROOT, stdio: 'inherit' }) } catch {}
  try { require('node:fs').rmdirSync(SRC) } catch {}
  console.log('removed empty test/data/')
} else {
  console.log(`test/data/ still has: ${remaining.join(', ')}`)
}
