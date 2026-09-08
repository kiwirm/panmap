import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * PROJ.4 string for an EPSG code, or undefined if unknown.
 *
 * The OCAD reader only knows a map's projected CRS by its EPSG code, and proj4
 * cannot resolve `+init=epsg:NNNN` offline — so we read the resolved `+proj=…`
 * string from the `epsg-index` package (authoritative EPSG data, one small JSON
 * per code loaded lazily). Returns undefined for codes not in the index, in
 * which case the reader skips geographic derivation rather than fabricate one.
 */
export function proj4ForEpsg(epsg: string | number | undefined): string | undefined {
  if (epsg === undefined) return undefined
  try {
    const entry = require(`epsg-index/s/${String(epsg)}.json`) as { proj4?: string }
    // Drop the `+type=crs` suffix — redundant for a bare projection transform.
    return entry?.proj4 ? entry.proj4.replace(' +type=crs', '').trim() : undefined
  } catch {
    return undefined
  }
}
