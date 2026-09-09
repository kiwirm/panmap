import fs from 'node:fs/promises'
import path from 'node:path'
import PanMap from '../../map/model.js'
import { boundsForCoords } from '../../map/coord.js'
import {
  parseJson, parseNdjson,
} from '../../util/ndjson.js'
import {
  capStyleFromGitmap, joinStyleFromGitmap,
  hAlignFromGitmap, vAlignFromGitmap, rotationFromGitmap,
} from './enums.js'

// A gitmap is a small set of named files (manifest.json + colors/symbols/
// objects ndjson + optional private/view.json). A `GitmapSource` abstracts
// WHERE those bytes come from — the on-disk directory reader, or an
// in-memory bundle fetched straight from git (`git cat-file`) with no tar
// extraction / temp files. `read(name)` returns the file's UTF-8 text, or
// null when the file is absent.
export interface GitmapSource {
  read(name: string): Promise<string | null>
}

function directorySource(directory: string): GitmapSource {
  return {
    async read(name) {
      try {
        return await fs.readFile(path.join(directory, name), 'utf-8')
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return null
        throw err
      }
    },
  }
}

/** Wrap an in-memory `{ filename → bytes }` map as a GitmapSource. */
export function bundleSource(
  files: Record<string, string | Buffer | Uint8Array>,
): GitmapSource {
  return {
    async read(name) {
      const v = files[name]
      if (v == null) return null
      return typeof v === 'string' ? v : Buffer.from(v).toString('utf-8')
    },
  }
}

/** Read a gitmap from a directory on disk (the original entry point). */
async function readGitmap(directory: string): Promise<PanMap> {
  return readGitmapFrom(directorySource(directory), directory)
}

/**
 * Read a gitmap from an in-memory bundle — the files as `{ name → bytes }`,
 * e.g. produced by `git cat-file --batch`. Lets callers diff/render a gitmap
 * straight out of git's object store without materialising a temp directory.
 */
export async function readGitmapBundle(
  files: Record<string, string | Buffer | Uint8Array>,
): Promise<PanMap> {
  return readGitmapFrom(bundleSource(files), 'bundle')
}

/** Core reader, agnostic to where the bytes come from. */
async function readGitmapFrom(source: GitmapSource, label: string): Promise<PanMap> {
  const manifestText = await source.read('manifest.json')
  if (manifestText == null) {
    throw new Error(`Not a GitMap package: ${label} (missing manifest.json)`)
  }
  const manifest = parseJson(manifestText, 'manifest.json')
  if (manifest?.format !== 'gitmap') {
    throw new Error(`Not a GitMap package: ${label}`)
  }

  // Filenames are fixed by convention (no manifest `files` map).
  const readEntry = async (name: string): Promise<string> =>
    (await source.read(name)) ?? ''
  const colors = parseNdjson(await readEntry('colors.ndjson'), 'colors.ndjson') as any[]
  const symbols = parseNdjson(await readEntry('symbols.ndjson'), 'symbols.ndjson') as any[]
  const objects = parseNdjson(await readEntry('objects.ndjson'), 'objects.ndjson') as any[]

  // `view` / `print` live under `private/` for gitignoring editor state.
  const privText = await source.read('private/view.json')
  const privateData = privText
    ? (parseJson(privText, 'private/view.json') as Record<string, unknown>)
    : undefined
  const view = pickObject(privateData?.view)
  const print = pickObject(privateData?.print)

  const symbolIds = new Map<string | number, string | number>(
    symbols.map(symbol => [symbol.id, symbol.id]),
  )

  return new PanMap({
    sourceFormat: 'gitmap',
    sourceFile: { directory: label, manifest },
    metadata: { gitmap: manifest },
    colors: colors.map(colorFromGitmap),
    symbols: symbols.map((symbol, i) => symbolFromGitmap(symbol, i)),
    // Preserve source rendering order: gitmap files are sorted by
    // (partId, symbolId, id) for deterministic git diffs, which loses
    // the original OMap/OCAD document order. `order` is the object's
    // canonical z-rank, so sorting on it restores render order.
    objects: sortBySourceId(
      objects.map((object, i) => objectFromGitmap(object, symbolIds, i)),
    ) as any, // order-preserving reorder; MapObject typing is nominal here
    warnings: [],
    extensions: manifest.extensions && typeof manifest.extensions === 'object'
      ? manifest.extensions
      : {},
    notes: typeof manifest.notes === 'string' ? manifest.notes : '',
    view: view as PanMap['view'] | undefined,
    print: print as PanMap['print'] | undefined,
    templates: manifest.templates && typeof manifest.templates === 'object'
      ? manifest.templates as PanMap['templates']
      : undefined,
    georeferencing: manifest.georeferencing && typeof manifest.georeferencing === 'object'
      ? manifest.georeferencing as PanMap['georeferencing']
      : undefined,
  })
}

function pickObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

function sortBySourceId<T extends { sourceId?: unknown }>(objects: T[]): T[] {
  return objects.slice().sort((a, b) => {
    const sa = numericIfPossible(a.sourceId)
    const sb = numericIfPossible(b.sourceId)
    if (typeof sa === 'number' && typeof sb === 'number') return sa - sb
    return String(a.sourceId ?? '').localeCompare(String(b.sourceId ?? ''))
  })
}

function numericIfPossible(v: unknown): number | string {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v)
  return String(v ?? '')
}

function colorFromGitmap(color) {
  return {
    id: color.id,
    sourceId: color.order,
    name: color.name || '',
    // A valid gitmap colour always has an [r,g,b] array → a string here.
    rgb: rgbToString(color.rgb) as string,
    cmyk: color.cmyk,
    opacity: color.opacity,
    renderOrder: color.renderOrder ?? 0,
  }
}

// gitmap stores rgb as an [r, g, b] integer array; the model uses a CSS rgb()
// string (the SVG exporter renders it directly).
function rgbToString(rgb: unknown): string | undefined {
  if (Array.isArray(rgb) && rgb.length >= 3) {
    return `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`
  }
  return undefined
}

function symbolFromGitmap(symbol, index = 0) {
  const layers = symbol.layers ?? []
  return {
    id: symbol.id,
    // symbols.ndjson has no stored `order` — it was just the code-sorted line
    // position (derivable, and it diverged cross-format when the two exports'
    // symbol sets differed). Re-derive the same value from the read index; the
    // OCD/OMap writers use it only as a numbering fallback.
    sourceId: index,
    code: symbol.code,
    name: symbol.name,
    type: symbol.type,
    hidden: !!symbol.hidden,
    rotatable: !!symbol.rotatable,
    // Typography is authoritative in the text layer; surface fontSize on the
    // model for the OCAD/OMap writers.
    fontSize: fontSizeFromLayers(layers),
    textSymbol: symbol.textSymbol,
    renderLayers: layers.map(renderLayerFromGitmap),
  }
}

function fontSizeFromLayers(layers: unknown[]): number | undefined {
  for (const l of layers || []) {
    const layer = l as { type?: string; text?: { fontSize?: number }; fontSize?: number }
    if (layer.type === 'text') return layer.text?.fontSize ?? layer.fontSize
  }
  return undefined
}

function objectFromGitmap(object, symbolIds: Map<string | number, string | number>, index = 0) {
  const coordinates = ringsFromGitmap(object.coordinates || [], object.holes)
  return {
    // Gitmap stores no object id (objects.ndjson is geometry-sorted, not
    // id-keyed); use the canonical z-rank as the stable in-memory handle.
    id: object.order ?? index,
    sourceId: object.order,
    symbolId: symbolIds.get(object.symbolId) || object.symbolId,
    type: object.type,
    coordinates,
    text: object.text,
    rotation: rotationFromGitmap(object.rotation),
    hidden: !!object.hidden,
    hAlign: hAlignFromGitmap(object.hAlign),
    vAlign: vAlignFromGitmap(object.vAlign),
    textBox: object.textBox,
    pattern: patternFromGitmap(object.pattern),
    objectString: object.tag,
    objectStringType: object.tagType,
    bounds: boundsForCoords(coordinates),
  }
}

function renderLayerFromGitmap(layer) {
  const output = { ...layer }
  // Reverse the canonical enum strings back to the model's OCAD/Mapper ints.
  if (output.capStyle !== undefined) output.capStyle = capStyleFromGitmap(output.capStyle)
  if (output.joinStyle !== undefined) output.joinStyle = joinStyleFromGitmap(output.joinStyle)
  if (Array.isArray(output.borders)) output.borders = output.borders.map(borderFromGitmap)
  if (Array.isArray(output.elements)) {
    output.elements = output.elements.map(elementFromGitmap)
  }
  ;[
    'primSymElements',
    'cornerSymElements',
    'startSymElements',
    'endSymElements',
  ].forEach(key => {
    if (Array.isArray(output[key])) {
      output[key] = output[key].map(elementFromGitmap)
    }
  })
  return output
}

// A stroke casing line: restore the model's `color` field from `colorId`.
function borderFromGitmap(border) {
  if (!border || typeof border !== 'object' || border.colorId === undefined) return border
  const { colorId, ...rest } = border
  return { color: colorId, ...rest }
}

function elementFromGitmap(element) {
  const output = { ...element }
  // Restore the model field names the OCD/OMap writers expect: gitmap renamed
  // color→colorId and coords→coordinates and dropped the derived numberCoords
  // (= coordinates.length).
  if (output.colorId !== undefined) { output.color = output.colorId; delete output.colorId }
  if (output.radius !== undefined) { output.diameter = output.radius * 2; delete output.radius }
  const coordSrc = Array.isArray(output.coordinates) ? output.coordinates
    : Array.isArray(output.coords) ? output.coords : undefined
  if (coordSrc) {
    output.coords = coordsFromGitmap(coordSrc)
    delete output.coordinates
    output.numberCoords = output.coords.length
  }
  return output
}

// Object/pattern rotation is stored in degrees in gitmap; the model uses
// radians. Convert the pattern override's rotation back on read.
function patternFromGitmap(pattern) {
  if (!pattern || typeof pattern !== 'object' || pattern.rotation === undefined) return pattern
  return { ...pattern, rotation: rotationFromGitmap(pattern.rotation) }
}

type CoordArray = Array<number> & { xFlags?: number; yFlags?: number }

// Rebuild the model's flat coordinate list from explicit rings: the outer
// `coordinates` plus each `holes` ring, concatenated. Ring boundaries are
// restored by setting the hole bit (yFlags 0x02) on the LAST coord of every ring
// except the last — the inverse of the writer's `ringsToJson` split. Bézier
// control-runs never cross a ring, so each ring is parsed independently.
function ringsFromGitmap(outer: unknown[], holes: unknown): CoordArray[] {
  const rings = [outer, ...(Array.isArray(holes) ? (holes as unknown[][]) : [])]
  const flat: CoordArray[] = []
  rings.forEach((ring, ri) => {
    const coords = coordsFromGitmap(ring)
    if (ri < rings.length - 1 && coords.length > 0) {
      const last = coords[coords.length - 1]
      last.yFlags = (last.yFlags ?? 0) | 0x02
    }
    flat.push(...coords)
  })
  return flat
}

// Parse a coord list of tuples: `[x, y]` or `[x, y, {control?, corner?, hole?,
// dash?}]`. Both object coordinates and element (icon) coords use this shape.
// Semantic flags translate back to OCAD's xFlags/yFlags; `control` points come in
// pairs, so the first in a run is cp1 (0x01), the second cp2 (0x02). Object coords
// never carry `hole` (their rings are structural); element coords may.
function coordsFromGitmap(coords: unknown[]): CoordArray[] {
  let controlRun = 0
  return (coords || []).map((c): CoordArray => {
    if (!Array.isArray(c)) return c as CoordArray
    const flags = c.length > 2 && c[2] && typeof c[2] === 'object'
      ? (c[2] as Record<string, unknown>)
      : undefined
    let xFlags = 0
    let yFlags = 0
    if (flags?.control) { controlRun += 1; xFlags |= controlRun % 2 === 1 ? 0x01 : 0x02 }
    else controlRun = 0
    if (flags?.corner) yFlags |= 0x01
    if (flags?.hole) yFlags |= 0x02
    if (flags?.dash) yFlags |= 0x08
    const tuple = [Number(c[0]), Number(c[1])] as CoordArray
    if (xFlags) tuple.xFlags = xFlags
    if (yFlags) tuple.yFlags = yFlags
    return tuple
  })
}

export { readGitmap }
export default readGitmap
