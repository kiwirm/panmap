/**
 * OCAD format namespace.
 *
 * `read` / `write` operate at the PanMap level (preferred entry).
 * `readRaw` returns the low-level OcadFile structure for callers that
 * need direct access to the file's internal tables.
 */

import readRaw from './read.js'
import toMap from './to-map.js'
import type PanMap from '../../map/model.js'
import type { ReadOcadOptions } from './read.js'

export { default as readRaw } from './read.js'
export { default as toMap } from './to-map.js'
export { default as write } from './from-map.js'

export type OcadFile = Awaited<ReturnType<typeof readRaw>>

export async function read(
  input: string | Buffer,
  options?: ReadOcadOptions
): Promise<PanMap> {
  return toMap(await readRaw(input, options))
}

export type { ReadOcadOptions } from './read.js'
