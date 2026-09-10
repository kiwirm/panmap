import fs from 'node:fs/promises'
import type PanMap from '../../map/model.js'
import { encodeOcadFile } from './write/index.js'
import { syncNotesIntoOcadFile } from './notes.js'
import { synthesizeOcadFile } from './synthesize/index.js'

/**
 * Writes a Map back to an OCAD binary file.
 *
 * Supports OCAD versions 12 and 2018 (via `header.version` + `subVersion`
 * on the PanMap map metadata; synth preserves the source header when
 * present, otherwise defaults to Mapper's OCAD-2018 flavour).
 *
 * Every record is synthesized from PanMap fields via `synthesizeOcadFile`;
 * there's no byte preservation. OCAD-native detail that PanMap doesn't
 * model (icon rasters, tree groups, structure fills, framing, tab stops)
 * is lost on a round-trip through the model — PanMap is the sole source
 * of truth.
 *
 * Layout: records first, then their index blocks. The source file's
 * exact interleaving isn't reproduced.
 */
async function writeOcad(map: PanMap, filename: string): Promise<void> {
  const ocadFile = synthesizeOcadFile(map)
  syncNotesIntoOcadFile(ocadFile, map.notes, map.extensions)
  const buffer = encodeOcadFile(ocadFile)
  await fs.writeFile(filename, buffer)
}

export { writeOcad }
export default writeOcad
