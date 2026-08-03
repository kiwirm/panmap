/**
 * Gitmap format namespace.
 *
 * `read` / `write` operate at the PanMap level (preferred entry).
 * `readRaw` and `toMap` are provided for API parity with `ocad` / `omap`;
 * gitmap materializes directly into the PanMap, so `readRaw` is
 * an alias of `read` and `toMap` is the identity.
 */

import type PanMap from '../../map/model.js'
import read from './read.js'

export { default as read } from './read.js'
export { default as write } from './write.js'

export const readRaw = read
export const toMap = (map: PanMap): PanMap => map
