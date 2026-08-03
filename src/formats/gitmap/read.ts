import path from 'node:path'
import PanMap from '../../map/model.js'
import { boundsForCoords } from '../../map/coord.js'
import { readJson, readNdjson, readJsonOrNdjson } from '../../util/ndjson.js'

async function readGitmap(directory: string): Promise<PanMap> {
  const manifest = await readJson(path.join(directory, 'gitmap.json'))
  if (manifest?.format !== 'gitmap') {
    throw new Error(`Not a GitMap package: ${directory}`)
  }

  const files = manifest.files || {}
  const colors = await readJsonOrNdjson(path.join(directory, files.colors || 'colors.ndjson'))
  const symbols = await readJsonOrNdjson(path.join(directory, files.symbols || 'symbols.ndjson'))
  const objects = await readNdjson(path.join(directory, files.objects || 'objects.ndjson'))

  // `view` / `print` live under `private/` for gitignoring editor state.
  // Older gitmaps kept them in the manifest — read either shape.
  const privateData = await readPrivate(directory, files.private)
  const view = pickObject(privateData?.view) ?? pickObject(manifest.view)
  const print = pickObject(privateData?.print) ?? pickObject(manifest.print)

  const symbolIds = new Map<string | number, string | number>(
    symbols.map(symbol => [symbol.id, symbol.id]),
  )

  return new PanMap({
    sourceFormat: 'gitmap',
    sourceFile: { directory, manifest },
    metadata: { gitmap: manifest },
    colors: colors.map(colorFromGitmap),
    symbols: symbols.map(symbol => symbolFromGitmap(symbol)),
    // Preserve source rendering order: gitmap files are sorted by
    // (partId, symbolCode, id) for deterministic git diffs, which loses
    // the original OMap/OCAD document order. `sourceId` is the original
    // numeric object id, so sorting on that restores z-order.
    objects: sortBySourceId(
      objects.map(object => objectFromGitmap(object, symbolIds)),
    ) as any, // sourceId-preserving reorder; MapObject typing is nominal here
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

async function readPrivate(
  directory: string,
  relpath?: string,
): Promise<Record<string, unknown> | undefined> {
  const target = relpath || 'private/view.json'
  try {
    return (await readJson(path.join(directory, target))) as Record<string, unknown>
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return undefined
    throw err
  }
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
    sourceId: color.sourceId ?? color.id,
    name: color.name || '',
    rgb: color.rgb,
    cmyk: color.cmyk,
    opacity: color.opacity,
    renderOrder: color.renderOrder ?? 0,
  }
}

function symbolFromGitmap(symbol) {
  return {
    id: symbol.id,
    sourceId: symbol.sourceId ?? symbol.id,
    code: symbol.code,
    name: symbol.name,
    type: symbol.type,
    hidden: !!symbol.hidden,
    rotatable: !!symbol.rotatable,
    fontSize: symbol.fontSize,
    textSymbol: symbol.textSymbol,
    renderLayers: (symbol.renderLayers || []).map(renderLayerFromGitmap),
  }
}

function objectFromGitmap(object, symbolIds: Map<string | number, string | number>) {
  const coordinates = (object.coordinates || []).map(coordFromGitmap)
  return {
    id: object.id,
    sourceId: object.sourceId,
    symbolId: symbolIds.get(object.symbolId) || object.symbolId,
    type: object.type,
    coordinates,
    text: object.text,
    rotation: object.rotation,
    hidden: !!object.hidden,
    hAlign: object.hAlign,
    vAlign: object.vAlign,
    textBox: object.textBox,
    pattern: object.pattern,
    objectString: object.objectString,
    objectStringType: object.objectStringType,
    bounds: boundsForCoords(coordinates),
  }
}

function renderLayerFromGitmap(layer) {
  const output = { ...layer }
  // Legacy gitmap files (pre-consolidation) sometimes carry `color`
  // on a render layer instead of `colorId`. Normalize on read so
  // callers only need to read `colorId`.
  if (output.color !== undefined && output.colorId === undefined) {
    output.colorId = output.color
    delete output.color
  }
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

function elementFromGitmap(element) {
  const output = { ...element }
  if (Array.isArray(output.coords)) {
    output.coords = output.coords.map(coordFromGitmap)
  }
  return output
}

function coordFromGitmap(coord) {
  type CoordArray = Array<number> & {
    flags?: number
    xFlags?: number
    yFlags?: number
    omapFlags?: number
  }
  // Object form is the only shape the writer emits. Bare `[x, y]`
  // tuples are accepted for backwards compatibility with the short-
  // lived tuple-when-no-flags variant; in-memory arrays with attached
  // flag properties are the pre-serialisation shape and pass through.
  if (Array.isArray(coord) && coord.length === 2 && typeof coord[0] === 'number') {
    return [coord[0], coord[1]] as CoordArray
  }
  if (Array.isArray(coord)) return coord
  if (coord && typeof coord === 'object' && 'x' in coord && 'y' in coord) {
    const tuple = [coord.x, coord.y] as CoordArray
    if (coord.flags !== undefined) tuple.flags = coord.flags
    if (coord.xFlags !== undefined) tuple.xFlags = coord.xFlags
    if (coord.yFlags !== undefined) tuple.yFlags = coord.yFlags
    if (coord.omapFlags !== undefined) tuple.omapFlags = coord.omapFlags
    return tuple
  }
  return coord
}

export { readGitmap }
export default readGitmap
