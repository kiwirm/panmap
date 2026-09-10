/**
 * OCAD format namespace: `read` (bytes → PanMap) and `write` (PanMap → bytes),
 * symmetric with omap and gitmap.
 *
 * The low-level OcadFile stages (parse, toMap) are internal — import them from
 * ./read and ./to-map directly if you need to work below the PanMap model.
 */

import readRaw from './read/index.js'
import toMap from './to-map.js'
import type PanMap from '../../map/model.js'
import type { ReadOcadOptions } from './read/index.js'

export { default as write } from './from-map.js'

export type OcadFile = Awaited<ReturnType<typeof readRaw>>

export async function read(
  input: string | Buffer,
  options?: ReadOcadOptions
): Promise<PanMap> {
  return toMap(await readRaw(input, options))
}

export type { ReadOcadOptions } from './read/index.js'
