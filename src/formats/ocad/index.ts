/**
 * OCAD format namespace: `read` (bytes → Panmap) and `write` (Panmap → bytes),
 * symmetric with omap and gitmap.
 *
 * The reader and writer live in ./reader and ./writer; their internal stages
 * (decode/to-panmap on the read side, from-panmap/encode on the write side)
 * are there if you need to work below the Panmap model.
 */

export { default as read } from './reader/index.js'
export { default as write } from './writer/index.js'
export type { OcadFile, ReadOcadOptions } from './reader/index.js'
