/**
 * OCAD (.ocd) file reader — bytes → raw `OcadFile` record.
 *
 * Thin re-export of the reader in `internal/index.ts` so the format
 * directory has a `read.ts` entry matching xmap and gitmap.
 * Consumers that need the underlying record and index types should
 * still import from `./internal/`.
 */
export { default } from './internal/index.js'
export type { ReadOcadOptions } from './internal/index.js'
