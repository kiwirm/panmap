import fs from 'node:fs/promises'
import type PanMap from '../../map/model.js'
import { encodeOcadFile } from './writer/index.js'
import { syncNotesIntoOcadFile } from './notes.js'
import { synthesizeOcadFile } from './synthesize.js'

/**
 * Writes a Map back to an OCAD binary file.
 *
 * Supports OCAD versions 12 and 2018 (via `header.version` + `subVersion`
 * on the PanMap map metadata; synth preserves the source header when
 * present, otherwise defaults to Mapper's OCAD-2018 flavour).
 *
 * The writer runs the PanMap through `synthesizeOcadFile` —
 * there's no byte-slicing fast path. For OCAD-sourced maps the raw
 * `sourceSymbol` / `sourceObject` records still flow through as the
 * base of each record's field set (see `synthesizeSymbol`'s
 * `mergeOverBase` overlay), so unmodified records round-trip structurally
 * without needing the source buffer.
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
