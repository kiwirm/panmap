import { parseSymbolCode } from '../util/symbol-code.js'

/**
 * Parse a comma-separated list of OCAD symbol codes (e.g. "401.0,403.1")
 * into the raw symNum integer values (e.g. 401000, 403001) used by the
 * binary file format.
 */
export function parseSymNums(s: string): number[] {
  return s.split(',').map(parseSymbolCode)
}
