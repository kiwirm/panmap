import fs from 'node:fs/promises'
import path from 'node:path'
import type Panmap from '../../../map/model.js'
import {
  toGitmapColor,
  toGitmapObject,
  stableColorId,
  stableSymbolId,
  toGitmapSymbol,
} from './from-panmap.js'
import { stableJson, stableJsonPretty } from '../stable-json.js'
import { needsYFlip } from '../../codecs/index.js'

interface WriteGitmapOptions {
  overwrite?: boolean
}

async function writeGitmap(
  map: Panmap,
  directory: string,
  options: WriteGitmapOptions = {}
): Promise<void> {
  if (options.overwrite) {
    await fs.rm(directory, { recursive: true, force: true })
  }

  await fs.mkdir(directory, { recursive: true })

  const colors = map.colors
    .filter(Boolean)
    .map(toGitmapColor)
    .sort((a, b) => a.renderOrder - b.renderOrder || a.id.localeCompare(b.id))

  const colorIds = new Map(
    map.colors.filter(Boolean).map(color => [color.id, stableColorId(color)])
  )
  // Build the `<input id> → <stable id>` map with collision handling.
  // Mapper allows two symbols to share the same numeric code (e.g. two
  // "522 Canopy" variants — a combined main + a "minimum size" point
  // variant). `stableSymbolId` derives its id from the code, so both
  // would collide as `sym_522` and one variant would silently overwrite
  // the other at read time (breaking any object using the loser). Give
  // every subsequent collider an `_N` suffix; base id keeps priority.
  const symbolIds = new Map<string | number, string>()
  {
    const used = new Map<string, number>()
    for (const symbol of map.symbols) {
      const base = stableSymbolId(symbol)
      const n = (used.get(base) ?? 0) + 1
      used.set(base, n)
      symbolIds.set(symbol.id, n === 1 ? base : `${base}_v${n}`)
    }
  }
  // `symbolsById` lets canonicalisers dereference cross-symbol references
  // (e.g. `border-symbol.symbolId` → the referenced line symbol's stroke).
  const symbolsById = new Map<string | number, typeof map.symbols[number]>()
  for (const s of map.symbols) {
    symbolsById.set(s.id, s)
    if (s.sourceId !== undefined && s.sourceId !== s.id) {
      symbolsById.set(s.sourceId, s)
    }
  }
  const symbols = map.symbols
    .map(symbol => ({
      ...toGitmapSymbol(symbol, colorIds, symbolIds, symbolsById),
      id: symbolIds.get(symbol.id) ?? stableSymbolId(symbol),
    }))
    .sort(
      (a, b) =>
        String(a.code || '').localeCompare(String(b.code || '')) ||
        a.id.localeCompare(b.id)
    )
  // No stored `order`: a symbol's rank was just its index in this code-sorted
  // list — derivable from line position, and it DIVERGED cross-format whenever
  // the two exports carried slightly different symbol sets (variants), shifting
  // the index of every later symbol. Dropping it converges those otherwise-
  // identical symbols; the reader re-derives the same value from the read index.

  // OCAD stores coordinates y-up; every other format (omap, gitmap) is
  // y-down "visual" space. Flip an ocad-sourced map's object coordinates on
  // the way into gitmap so the package is canonically y-down — otherwise an
  // ocd→gitmap conversion lands upside-down relative to omap-sourced gitmaps
  // and any diff between them reports the whole map as changed.
  const flipY = needsYFlip(map.sourceFormat, 'gitmap')
  // `map.objects` is in render (z-) order; the object's index is its canonical
  // z-rank, written as `order` so the same map serialises identically across
  // source formats (which assign different raw object ids but the same order).
  //
  // Sort by (partId, symbolId, geometry, text, rotation) — a canonical total
  // order derived from the object's own content, so the same map from OCD vs
  // OMAP serialises byte-identically WITHOUT storing a synthetic id. The sort
  // key is the coordinate sequence itself (not a hash of it): a small edit
  // keeps the object among its spatial neighbours in the file instead of
  // scattering it to a random hash position, so a local map edit is a local
  // diff. `order` (the z-rank) is deliberately NOT a sort key — it diverges
  // cross-format, which would reintroduce the identity gap this sort closes.
  const objects = map.objects
    .map((object, i) => toGitmapObject(object, symbolIds, 'part_main', flipY, i))
    .sort(compareObjects)

  const manifest: Record<string, unknown> = {
    format: 'gitmap',
    version: 1,
    units: 'map-units',
    precision: 3,
    // Parts are inline (single 'part_main' for now; a genuine multi-part map
    // would list them here). Filenames are fixed by convention — no `files` map.
    parts: [{ id: 'part_main', name: 'Main' }],
  }
  if (map.notes) manifest.notes = map.notes
  if (map.extensions && Object.keys(map.extensions).length > 0) {
    manifest.extensions = map.extensions
  }
  // Templates (background raster refs — LiDAR / aerial / basemaps) are
  // intentionally NOT persisted in the gitmap package. They churn per
  // mapper's local file paths, add noise to diffs, and downstream
  // consumers of the gitmap don't have the referenced files anyway.
  // If we ever add a first-class "template" concept (canonical URLs or
  // per-repo template store), revisit.
  if (map.georeferencing) manifest.georeferencing = map.georeferencing
  await writeJson(directory, 'manifest.json', manifest)
  await writeNdjson(directory, 'colors.ndjson', colors)
  await writeNdjson(directory, 'symbols.ndjson', symbols)
  await fs.writeFile(
    path.join(directory, 'objects.ndjson'),
    `${objects.map(stableJson).join('\n')}\n`
  )

  // Editor viewport / print state is deliberately NOT written. A gitmap
  // tracks map CONTENT only; view center/zoom churns every time someone
  // opens the map and would otherwise pollute the history with no-op
  // "changes" (see the diamond-harbour private/view.json commits).
}

// Total-order comparator for objects.ndjson: partId, then symbolId, then the
// full geometry (outer ring, then holes), then text, then rotation. A tie means
// two genuinely identical objects (byte-identical lines), so their relative
// order is irrelevant. This replaces the former content-hash `id` — the id was
// only ever a hash of these same fields, so sorting on them directly is the
// faithful, readable "un-hash".
interface SortableObject {
  partId: string
  symbolId?: string
  coordinates?: unknown[]
  holes?: unknown[]
  text?: string
  rotation?: number
}

function compareObjects(a: SortableObject, b: SortableObject): number {
  return (
    a.partId.localeCompare(b.partId)
    || String(a.symbolId ?? '').localeCompare(String(b.symbolId ?? ''))
    || compareRing(a.coordinates, b.coordinates)
    || compareRings(a.holes, b.holes)
    || (a.text ?? '').localeCompare(b.text ?? '')
    || (a.rotation ?? 0) - (b.rotation ?? 0)
  )
}

// Lexicographic compare of a coordinate sequence: vertex by vertex, x then y; a
// shorter sequence that is a prefix of the longer sorts first. Coordinate flags
// (the optional 3rd tuple element) don't participate — two objects sharing an
// x,y sequence but differing only in a vertex flag fall through to the
// text/rotation tiebreak, or are true duplicates.
function compareRing(a: unknown[] = [], b: unknown[] = []): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const va = a[i] as number[]
    const vb = b[i] as number[]
    const d = (va[0] - vb[0]) || (va[1] - vb[1])
    if (d) return d
  }
  return a.length - b.length
}

// Lexicographic compare of a list of rings (an area object's holes).
function compareRings(a: unknown[] = [], b: unknown[] = []): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = compareRing(a[i] as unknown[], b[i] as unknown[])
    if (d) return d
  }
  return a.length - b.length
}

async function writeJson(directory: string, filename: string, value: unknown) {
  await fs.writeFile(path.join(directory, filename), stableJsonPretty(value))
}

async function writeNdjson(directory: string, filename: string, records: unknown[]) {
  await fs.writeFile(
    path.join(directory, filename),
    `${records.map(stableJson).join('\n')}\n`
  )
}

export type { WriteGitmapOptions }
export { writeGitmap }
export default writeGitmap
