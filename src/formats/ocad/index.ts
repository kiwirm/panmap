/**
 * OCAD format namespace: `read` (bytes → Panmap) and `write` (Panmap → bytes),
 * symmetric with omap and gitmap.
 *
 * The low-level OcadFile stages (parse, toMap) are internal — import them from
 * ./read and ./to-map directly if you need to work below the Panmap model.
 */

import readRaw from './read/index.js'
import toMap from './to-map.js'
import type Panmap from '../../map/model.js'
import type { ReadOcadOptions } from './read/index.js'

export { default as write } from './from-map.js'

export type OcadFile = Awaited<ReturnType<typeof readRaw>>

export async function read(
  input: string | Buffer,
  options?: ReadOcadOptions
): Promise<Panmap> {
  return toMap(await readRaw(input, options))
}

export type { ReadOcadOptions } from './read/index.js'
