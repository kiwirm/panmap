import type { OmapSymbol } from '../../native.js'

/** XMap symbol shape accepted by `xmapSymbolToXml`. Wider than
 *  `OmapSymbol` because the Panmap → xmap adapter may produce
 *  records with a few optional fields the strict interface omits. */
export type RawOmapSymbol =
  | OmapSymbol
  | (Partial<OmapSymbol> & {
      id?: number
      code?: string
      name?: string
      [key: string]: unknown
    })
