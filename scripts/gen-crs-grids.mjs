// Regenerate src/formats/ocad/native/crs-grids.ts from the vendored CSV.
//
// The CSV (crs-grids.csv) is doppelmeter's original, kept verbatim as the
// source of truth; re-syncing is "drop in a newer CSV, run this script". We
// emit a .ts (not .json) because the library ships as tsc-compiled ESM — a
// generated .ts compiles into dist/ with no asset-copy step or import
// attributes, whereas a .json would need both.
//
// Usage: npm run gen:crs-grids

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '..', 'src', 'formats', 'ocad', 'native')
const csvPath = path.join(dir, 'crs-grids.csv')
const outPath = path.join(dir, 'crs-grids.ts')

const q = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

const rows = fs
  .readFileSync(csvPath, 'utf8')
  .split(/\r?\n/)
  .slice(1) // drop the header row
  .filter(line => line.trim() !== '')
  .map(line => {
    // OCAD-Grid-ID;CRS-Code;CRS-Catalog;Name;Comment — we keep the first four.
    // Names never contain ';' (they use '/'), so a plain split is safe.
    const [id, code, catalog = '', name = ''] = line.split(';')
    return `  [${Number(id)}, ${Number(code)}, ${q(catalog)}, ${q(name)}],`
  })

const out = `// GENERATED — do not edit by hand. Run: npm run gen:crs-grids
// Source: https://github.com/doppelmeter/OCAD-Grid-ID_to_EPSG (ocad_grid_id_2_epsg.csv)
//
// Maps OCAD's proprietary internal grid ID to an EPSG code + catalog + name.
// OCAD numbers coordinate systems with its own integers; this is the one bridge
// to the standards world (proj4 / epsg-index take over from the EPSG code).

export type GridDef = [number, number, string, string]

const crsGrids: GridDef[] = [
${rows.join('\n')}
]

export default crsGrids
`

fs.writeFileSync(outPath, out)
console.log(
  `wrote ${rows.length} rows to ${path.relative(process.cwd(), outPath)}`,
)
