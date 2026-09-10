/**
 * OMap format namespace (also handles OCAD's legacy .xmap XML exports).
 *
 * `read` (input → PanMap) and `write` (PanMap → path), symmetric with ocad and
 * gitmap. The low-level OmapFile stages live in ./read and ./to-map.
 */

import { parseOmap, readOmapFile } from './read.js'
import toMap from './to-map.js'
import type PanMap from '../../map/model.js'
import type { OmapFile } from './read.js'

export { default as write } from './write.js'

/** Accepts an OMap/XMap file path, an OMap XML string, or a Buffer. */
async function readRaw(input: string | Buffer): Promise<OmapFile> {
  if (Buffer.isBuffer(input)) return parseOmap(input)
  if (input.trimStart().startsWith('<')) return parseOmap(input)
  return readOmapFile(input)
}

export async function read(input: string | Buffer): Promise<PanMap> {
  return toMap(await readRaw(input))
}
