/**
 * OMap format namespace (also handles OCAD's legacy .xmap XML exports).
 *
 * `read` (input → Panmap) and `write` (Panmap → path), symmetric with ocad and
 * gitmap. The reader and writer live in ./reader and ./writer.
 */

export { default as read } from './reader/index.js'
export { default as write } from './writer/index.js'
