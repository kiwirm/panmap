import path from 'node:path'
import readOcad from './formats/ocad/read.js'
import { parseOmap, readOmapFile } from './formats/omap/read.js'
import ocadFileToMap from './formats/ocad/to-map.js'
import omapFileToMap from './formats/omap/to-map.js'
import readGitmap from './formats/gitmap/read.js'
import type PanMap from './map/model.js'
import type { ReadOcadOptions } from './formats/ocad/read.js'

export type ReadInput = string | Buffer

/**
 * Reads any supported map file into the PanMap model.
 *
 * Format is detected by buffer/string sniff (XML prelude → omap), then file
 * extension (.gitmap → gitmap, .xmap/.omap → omap, else → OCAD).
 */
export async function read(
  input: ReadInput,
  options?: ReadOcadOptions
): Promise<PanMap> {
  if (looksLikeXml(input)) return omapFileToMap(parseOmap(input))

  if (typeof input === 'string') {
    const ext = path.extname(input).toLowerCase()
    if (ext === '.gitmap') return readGitmap(input)
    if (ext === '.xmap' || ext === '.omap') {
      return omapFileToMap(await readOmapFile(input))
    }
  }

  return ocadFileToMap(await readOcad(input, options))
}

function looksLikeXml(input: ReadInput): boolean {
  const head = Buffer.isBuffer(input)
    ? input.toString('utf-8', 0, 256)
    : input.slice(0, 256)
  // Strip a UTF-8 BOM if present before checking, so BOM-prefixed XML files
  // aren't misidentified as OCAD binary.
  const stripped = head.charCodeAt(0) === 0xFEFF ? head.slice(1) : head
  return stripped.trimStart().startsWith('<')
}

export default read
