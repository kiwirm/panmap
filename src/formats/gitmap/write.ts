import fs from 'node:fs/promises'
import path from 'node:path'
import type PanMap from '../../map/model.js'
import {
  toGitmapColor,
  toGitmapObject,
  stableColorId,
  stableSymbolId,
  toGitmapSymbol,
} from './from-map.js'
import { stableJson, stableJsonPretty } from './stable-json.js'
import { needsYFlip } from '../codecs/index.js'
import { canonicalSymbolCode } from '../../util/symbol-code.js'

interface WriteGitmapOptions {
  overwrite?: boolean
}

async function writeGitmap(
  map: PanMap,
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
  const symbolCodes = new Map<string | number, string>(
    map.symbols
      .filter(s => s.code !== undefined && s.code !== null)
      .map(s => [s.id, canonicalSymbolCode(s.code)])
  )

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
    // `sourceId` as a canonical dense rank (index in this code-sorted order),
    // not the format-specific source symbol number, so the same map from OCD vs
    // OMAP serialises identical symbol ids. The id is code-derived (independent
    // of sourceId), so this changes bytes, not identity; gitmap read still sorts
    // by sourceId to restore this order.
    .map((symbol, i) => ({ ...symbol, sourceId: i }))

  // OCAD stores coordinates y-up; every other format (omap, gitmap) is
  // y-down "visual" space. Flip an ocad-sourced map's object coordinates on
  // the way into gitmap so the package is canonically y-down — otherwise an
  // ocd→gitmap conversion lands upside-down relative to omap-sourced gitmaps
  // and any diff between them reports the whole map as changed.
  const flipY = needsYFlip(map.sourceFormat, 'gitmap')
  // `map.objects` is in render (z-) order; the object's index is its canonical
  // z-rank, written as `sourceId` so the same map serialises identically across
  // source formats (which assign different raw object ids but the same order).
  const objects = makeObjectIdsUnique(map.objects
    .map((object, i) => toGitmapObject(object, symbolIds, symbolCodes, 'part_main', flipY, i))
    .sort((a, b) =>
      a.partId.localeCompare(b.partId)
      || String(a.symbolCode ?? '').localeCompare(String(b.symbolCode ?? ''))
      || a.id.localeCompare(b.id)
    )
  )

  const files: Record<string, string> = {
    colors: 'colors.ndjson',
    symbols: 'symbols.ndjson',
    parts: 'parts.json',
    objects: 'objects.ndjson',
  }

  const manifest: Record<string, unknown> = {
    format: 'gitmap',
    version: 1,
    units: 'map-units',
    precision: 3,
    files,
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
  await writeJson(directory, 'gitmap.json', manifest)
  await writeNdjson(directory, 'colors.ndjson', colors)
  await writeNdjson(directory, 'symbols.ndjson', symbols)
  // Parts: omit `visible`/`locked` when they equal the defaults (true/false)
  // so toggling a part's visibility appears as a real field addition in diffs.
  await writeJson(directory, 'parts.json', [
    { id: 'part_main', name: 'Main' },
  ])
  await fs.writeFile(
    path.join(directory, 'objects.ndjson'),
    `${objects.map(stableJson).join('\n')}\n`
  )

  // Editor viewport / print state is deliberately NOT written. A gitmap
  // tracks map CONTENT only; view center/zoom churns every time someone
  // opens the map and would otherwise pollute the history with no-op
  // "changes" (see the diamond-harbour private/view.json commits).
}

function makeObjectIdsUnique<T extends { id: string }>(objects: T[]): T[] {
  const counts = new Map<string, number>()
  return objects.map(object => {
    const count = counts.get(object.id) || 0
    counts.set(object.id, count + 1)
    if (count === 0) return object

    return {
      ...object,
      id: `${object.id}_${count + 1}`,
    }
  })
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
