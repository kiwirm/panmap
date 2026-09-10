/**
 * OMap reader: file path / XML string / Buffer → Panmap.
 *
 * `decode.ts` parses the XML into the native `OmapFile`; `to-panmap.ts` maps
 * it into the canonical model.
 */
import { parseOmap, readOmapFile } from './decode.js'
import toPanmap from './to-panmap.js'
import type Panmap from '../../../map/model.js'
import type { OmapFile } from './decode.js'

/** Accepts an OMap/XMap file path, an OMap XML string, or a Buffer. */
export async function decode(input: string | Buffer): Promise<OmapFile> {
  if (Buffer.isBuffer(input)) return parseOmap(input)
  if (input.trimStart().startsWith('<')) return parseOmap(input)
  return readOmapFile(input)
}

export default async function read(input: string | Buffer): Promise<Panmap> {
  return toPanmap(await decode(input))
}
