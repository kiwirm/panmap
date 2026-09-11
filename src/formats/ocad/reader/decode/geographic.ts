import proj4 from 'proj4'
import { proj4ForEpsg } from './epsg-proj4.js'

// proj4 has "WGS84" registered as a lon/lat alias; passing the raw
// "+proj=latlong" string instead throws. (The georef `spec` we serialise still
// uses the canonical "+proj=latlong +datum=WGS84" text — that's display only.)
const WGS84 = 'WGS84'

export interface DerivedGeographic {
  refPointDeg: { lat: number; lon: number }
  /** Meridian convergence at the ref point, degrees (grid-north east of true). */
  convergenceDeg: number
}

/**
 * Derive a geographic reference point + meridian convergence from a projected
 * EPSG code + its projected ref point. OCAD stores only the projected side; OMap
 * carries the geographic ref point and a declination, but those are themselves
 * derived from the projection by OOMapper — so panmap can reproduce them
 * identically. Returns undefined when the EPSG isn't covered by the offline
 * proj4 table (derivation is skipped, never fabricated).
 */
export function deriveGeographic(
  epsg: string | number | undefined,
  refPoint: { x: number; y: number } | undefined,
): DerivedGeographic | undefined {
  const def = proj4ForEpsg(epsg)
  if (!def || !refPoint) return undefined
  try {
    const [lon, lat] = proj4(def, WGS84, [refPoint.x, refPoint.y]) as [
      number,
      number,
    ]
    // Numeric meridian convergence: the grid bearing of a small step due true
    // north at the ref point (projection-agnostic, needs no projection formula).
    const p0 = proj4(WGS84, def, [lon, lat]) as [number, number]
    const pN = proj4(WGS84, def, [lon, lat + 1e-4]) as [number, number]
    const convergenceDeg =
      (-Math.atan2(pN[0] - p0[0], pN[1] - p0[1]) * 180) / Math.PI
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(convergenceDeg)
    ) {
      return undefined
    }
    return { refPointDeg: { lat, lon }, convergenceDeg }
  } catch {
    return undefined
  }
}
