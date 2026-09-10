/**
 * Gitmap format namespace: `read` (directory → Panmap) and `write`
 * (Panmap → directory), symmetric with ocad and omap.
 */

export { default as read } from './reader/index.js'
export { default as write } from './writer/index.js'
