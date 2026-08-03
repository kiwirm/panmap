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
  const symbolIds = new Map(
    map.symbols.map(symbol => [symbol.id, stableSymbolId(symbol)])
  )
  const symbolCodes = new Map<string | number, string>(
    map.symbols
      .filter(s => s.code !== undefined && s.code !== null)
      .map(s => [s.id, String(s.code)])
  )

  const symbols = map.symbols
    .map(symbol => toGitmapSymbol(symbol, colorIds))
    .sort(
      (a, b) =>
        String(a.code || '').localeCompare(String(b.code || '')) ||
        a.id.localeCompare(b.id)
    )

  const objects = makeObjectIdsUnique(map.objects
    .map(object => toGitmapObject(object, symbolIds, symbolCodes))
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
  const hasPrivate = !!(map.view || map.print)
  if (hasPrivate) files.private = 'private/view.json'

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
  if (map.templates) manifest.templates = map.templates
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

  // Editor viewport state — view center/zoom/rotation and print settings —
  // gets written under `private/` because it changes every time someone
  // opens the map in an editor and adjusts the viewport. Callers should
  // gitignore `private/` so those tweaks don't pollute commit history.
  // Content (georeferencing, templates, notes, extensions) stays tracked.
  if (hasPrivate) {
    await fs.mkdir(path.join(directory, 'private'), { recursive: true })
    const priv: Record<string, unknown> = {}
    if (map.view) priv.view = map.view
    if (map.print) priv.print = map.print
    await writeJson(directory, 'private/view.json', priv)
  }
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
