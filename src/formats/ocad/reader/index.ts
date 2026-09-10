/**
 * OCAD reader: source bytes → Panmap.
 *
 * Two internal stages: `decode/` turns the bytes into the native `OcadFile`
 * record, then `to-panmap.ts` maps that into the canonical model.
 */
import decode from './decode/index.js'
import toPanmap from './to-panmap.js'
import type Panmap from '../../../map/model.js'
import type { ReadOcadOptions } from './decode/index.js'

export type OcadFile = Awaited<ReturnType<typeof decode>>

export default async function read(
  input: string | Buffer,
  options?: ReadOcadOptions,
): Promise<Panmap> {
  return toPanmap(await decode(input, options))
}

export type { ReadOcadOptions } from './decode/index.js'
