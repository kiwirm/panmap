import { read, type ReadInput } from './read.js'
import { write, type WriteOptions } from './write.js'

/**
 * Lossless conversion between native formats (ocad, xmap/omap, gitmap).
 *
 * Reads the input into the Panmap model and writes it back out in
 * the requested native format. Canonical fields (`view`, `print`,
 * `templates`, `georeferencing`, `extensions`, `notes`) round-trip
 * across every format.
 *
 * For lossy outputs (svg, geojson, mvt) use `exportMap` instead.
 */
export async function convert(
  input: ReadInput,
  outputPath: string,
  options: WriteOptions = {},
): Promise<void> {
  const map = await read(input)
  await write(map, outputPath, options)
}

export default convert
