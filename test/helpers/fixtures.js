// Fixture path resolver. Old test/data/<slug>.<ext> → new
// test/fixtures/<map>/<file>.<ext>. Exposes the same names tests
// used pre-reorg so we don't have to touch dozens of fixture-name
// literals across the suite.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FIXTURES_DIR = path.resolve(HERE, '..', 'fixtures')

const OVERRIDES = {
  '202012_Tahunanui.ocd':                'tahunanui/202012.ocd',
  'basic-1.ocd':                         'basic-1/basic-1.ocd',
  'double-line.ocd':                     'double-line/double-line.ocd',
  'jarnvag.ocd':                         'jarnvag/jarnvag.ocd',
  'myggfritt_byggnad2.ocd':              'myggfritt/byggnad2.ocd',
  'bottle-lake-bc98714_UpdatedCoady.ocd': 'bottle-lake/bc98714-updated-coady.ocd',
}

// Resolve `<slug>.<ext>` (old test/data/ name) to an absolute path under
// test/fixtures/<map>/<rev>.<ext>. `<map>-<rev>.<ext>` splits on the LAST
// hyphen — matches how the fixture corpus was laid out at reorg time.
export function fixtureFile(oldName) {
  const rel = OVERRIDES[oldName] ?? splitByLastDash(oldName)
  return path.join(FIXTURES_DIR, rel)
}

function splitByLastDash(name) {
  const dot = name.lastIndexOf('.')
  const stem = name.slice(0, dot)
  const ext = name.slice(dot)
  const dash = stem.lastIndexOf('-')
  if (dash < 0) return `${stem}/${stem}${ext}`
  return `${stem.slice(0, dash)}/${stem.slice(dash + 1)}${ext}`
}
