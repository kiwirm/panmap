/**
 * OMap format namespace (also handles OCAD's legacy .xmap XML exports).
 *
 * `read` / `write` operate at the PanMap level (preferred entry).
 * `readRaw` returns the parsed OMap structure for low-level access.
 */

import { parseOmap, readOmapFile } from './read.js'
import toMap from './to-map.js'
import type PanMap from '../../map/model.js'
import type { OmapFile } from './read.js'

export { default as toMap } from './to-map.js'
export { default as write } from './write.js'

/** Accepts an OMap/XMap file path, an OMap XML string, or a Buffer. */
export async function readRaw(input: string | Buffer): Promise<OmapFile> {
  if (Buffer.isBuffer(input)) return parseOmap(input)
  if (input.trimStart().startsWith('<')) return parseOmap(input)
  return readOmapFile(input)
}

export async function read(input: string | Buffer): Promise<PanMap> {
  return toMap(await readRaw(input))
}
