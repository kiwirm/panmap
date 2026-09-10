import type PanMap from '../../../map/model.js'
import type { MapColor, MapObject } from '../../../map/model.js'
import type { RawParameterStringRecord } from '../read/ocad-file.js'
import type { ParameterStringValues } from '../read/parameter-string.js'
import { coordX, coordY } from '../../../map/coord.js'
import crsGrids from '../read/crs-grids.js'

/**
 * Synthesize the OCAD parameter-string block for a PanMap.
 *
 * OCAD uses these strings to carry everything the binary record layout
 * can't: the color palette, map scale, projection / CRS, view settings,
 * template references, etc. The three we _must_ produce for a usable
 * file are 9 (colors), 1039 (map setup / CRS), and 1030 (view). Other
 * types (1061 = symbol tree, etc.) fall back to sensible empty
 * strings which OCAD tolerates.
 *
 * Returned records go to `OcadFile.rawParameterStrings` in order — the
 * writer emits them back-to-back, then builds a fresh string-index
 * chain from that array.
 */
/**
 * recTypes synth emits from PanMap fields. Everything else falls
 * through to a passthrough branch that re-uses whatever the source
 * file had on `map.metadata.parameterStrings`.
 *
 * Passthrough matters most for OCAD-sourced maps: they carry spot
 * colours (10), font/tab tables (12/15), symbol-tree groupings (1061),
 * and a handful of layout records (1024/1026/1028/1035) that neither
 * xmap nor gitmap describe. Emitting them keeps OCAD → PanMap → OCAD
 * structurally equivalent to what Mapper writes for the same map.
 */
const SYNTHESIZED_REC_TYPES: ReadonlySet<number> = new Set([9, 1030, 1039])

export function synthesizeParameterStrings(map: PanMap): {
  ordered: RawParameterStringRecord[]
  grouped: Record<number | string, ParameterStringValues[]>
} {
  const ordered: RawParameterStringRecord[] = []
  const grouped: Record<number | string, ParameterStringValues[]> = {}

  const pushRec = (recType: number, values: ParameterStringValues): void => {
    const rec: RawParameterStringRecord = {
      recType,
      values,
    }
    ordered.push(rec)
    ;(grouped[recType] ||= []).push(values)
  }

  const sourceStrings = map.metadata?.parameterStrings as
    | Record<string | number, ParameterStringValues[] | undefined>
    | undefined
  const hasSourceRec = (rt: number): boolean =>
    !!sourceStrings && Array.isArray(sourceStrings[rt]) && sourceStrings[rt]!.length > 0

  // For OCAD-sourced maps, prefer the source's rec 9 verbatim —
  // Mapper's per-colour spot-colour separations, halftones, and
  // overprint flags are authoritative and synth's `colorParamString`
  // doesn't reconstruct them from the MapColor shape.
  // `map.colors` is sparse when sourced from OCAD (indexed by number);
  // filter holes so `colorParamString` doesn't see `undefined`.
  if (hasSourceRec(9)) {
    for (const v of sourceStrings![9]!) pushRec(9, v)
  } else {
    for (const color of map.colors ?? []) {
      if (color) pushRec(9, colorParamString(color))
    }
  }

  pushRec(1039, setupParamString(map))
  pushRec(1030, viewParamString(map))

  // Preserve source-only records (spot colours 10, symbol tree 1061, etc.).
  if (sourceStrings) {
    for (const [key, values] of Object.entries(sourceStrings)) {
      const recType = Number(key)
      if (!Number.isFinite(recType)) continue
      if (SYNTHESIZED_REC_TYPES.has(recType)) continue
      for (const v of values ?? []) pushRec(recType, v)
    }
  }

  return { ordered, grouped }
}

/**
 * recType 9 = a single palette color. Empirical shape from real OCAD
 * files:
 *   _first = display name (e.g. "Black")
 *   pairs  = n=<slot>, c=<c>, m=<m>, y=<y>, k=<k>, o=<overprint>, t=<halftone>
 *
 * CMYK values in the file are integer percentages 0..100.
 */
function colorParamString(color: MapColor): ParameterStringValues {
  // MapColor.cmyk is documented in [0,1]; OCAD wants 0..100 integers.
  // Every real source format we care about (OCAD, xmap, gitmap) now
  // persists CMYK — so if it's missing we take the color as unpainted
  // rather than trying to reverse-engineer it from RGB.
  const cmykSource = color.cmyk ?? [0, 0, 0, 0]
  const [c, m, y, k] = cmykSource.map((v) =>
    Math.round(clamp01(v) * 100),
  )
  // Slot number: falls back to renderOrder if sourceId isn't a number
  // (gitmap sources use string slugs).
  const n = typeof color.sourceId === 'number'
    ? color.sourceId
    : typeof color.id === 'number' ? color.id : color.renderOrder
  const pairs: Array<{ code: string; value: string }> = [
    { code: 'n', value: String(n) },
    { code: 'c', value: String(c) },
    { code: 'm', value: String(m) },
    { code: 'y', value: String(y) },
    { code: 'k', value: String(k) },
    { code: 'o', value: '1' },   // overprint on
    { code: 't', value: String(Math.round(clamp01(color.opacity ?? 1) * 100)) },
  ]
  const values: ParameterStringValues = {
    _first: color.name || `Color ${n}`,
    _pairs: pairs,
  }
  for (const p of pairs) values[p.code] = p.value
  return values
}

/**
 * recType 1039 = map setup + georeferencing. Fields:
 *   m = scale denominator (e.g. 15000 for 1:15000)
 *   g = grid distance in mm
 *   r = real coordinates flag (1 = use projected coords)
 *   x, y = offset in projected units (micrometres for metre-based CRSes)
 *   a = grid rotation, decimal degrees
 *   d = paper distance in mm
 *   i = grid IJK / declination, integer
 *   b, c = declination / auxiliary calibration
 */
function setupParamString(map: PanMap): ParameterStringValues {
  // If the source file had a 1039 record, re-emit it verbatim. Synth
  // can't reconstruct grid rotation / CRS ID / offsets from PanMap
  // fields alone at Mapper's precision, and dropping them would break
  // the georeferencing.
  const sourceSetup = (map.metadata?.parameterStrings as
    | Record<string | number, ParameterStringValues[] | undefined>
    | undefined)?.['1039']?.[0]
  if (sourceSetup) return sourceSetup

  // Xmap/gitmap-sourced map with a `georeferencing` shape (PanMap):
  // build a 1039 from `MapCrs`. Grid ID (`i`) reverse-looks-up the
  // xmap projected_crs EPSG code via `crs-grids.ts`; without a match
  // we fall through to paper coords.
  const g = map.georeferencing
  const scale =
    (g?.scale as number | undefined)
    ?? (map.metadata?.scale as number | undefined)
    ?? (map.metadata?.mapScale as number | undefined)
    ?? 15000
  const gridId = gridIdForCrs(g)
  const grivation = g?.grivation ?? 0
  const projX = g?.projected?.refPoint?.x
  const projY = g?.projected?.refPoint?.y
  const useReal = gridId !== undefined && projX !== undefined && projY !== undefined
  // Grid spacing pair. `d` = real-world grid distance in metres; `g` =
  // the same distance projected to paper mm = d × 1000 / scale. OOM
  // enforces this invariant on export (ocd_file_export.cpp:945-966).
  // Emitting `d=0` (as this file used to) crashes downstream consumers
  // like Condes with a blank canvas because it divides by zero when
  // computing grid cells. Use the standard 500m orienteering grid.
  const gridReal = 500
  const gridMap = (gridReal * 1000) / scale
  const pairs: Array<{ code: string; value: string }> = [
    { code: 'm', value: String(scale) },
    { code: 'g', value: gridMap.toFixed(4) },
    { code: 'r', value: useReal ? '1' : '0' },
    { code: 'x', value: String(useReal ? projX : 0) },
    { code: 'y', value: String(useReal ? projY : 0) },
    { code: 'a', value: String(grivation) },
    { code: 'd', value: gridReal.toFixed(6) },
    { code: 'b', value: '0.00' },
    { code: 'c', value: '0.00' },
  ]
  if (gridId !== undefined) pairs.push({ code: 'i', value: String(gridId) })
  const values: ParameterStringValues = { _first: '', _pairs: pairs }
  for (const p of pairs) values[p.code] = p.value
  return values
}

/**
 * Reverse-lookup an OCAD grid ID from a `MapCrs.projected`
 * EPSG code. Returns `undefined` when the CRS isn't georeferenced or
 * the EPSG code isn't in the `crs-grids` table.
 */
function gridIdForCrs(crs: PanMap['georeferencing']): number | undefined {
  const epsgStr = crs?.projected?.parameter
  if (!epsgStr) return undefined
  const epsg = Number(epsgStr)
  if (!Number.isFinite(epsg)) return undefined
  const match = crsGrids.find(([, code, catalog]) => code === epsg && catalog === 'EPSG')
  return match?.[0]
}

/**
 * recType 1030 = current view. `x`/`y` are the viewport centre in mm
 * (paper units, OCAD's y-up frame); `z` is a zoom multiplier where
 * 1.0 is roughly "100%" in Mapper/OCAD.
 *
 * Prefer the PanMap `map.view` when set (round-tripping a saved
 * viewport from OCAD or xmap). Otherwise fall back to the object
 * bounding-box centre so a fresh file opens looking at content rather
 * than paper origin.
 */
function viewParamString(map: PanMap): ParameterStringValues {
  // OCAD-sourced maps keep their 1030 record verbatim so v/m/t/b/c/h/d
  // and the exact centre/zoom Mapper wrote survive the round-trip.
  const sourceView = (map.metadata?.parameterStrings as
    | Record<string | number, ParameterStringValues[] | undefined>
    | undefined)?.['1030']?.[0]
  if (sourceView) return sourceView

  const centre = map.view?.center ?? objectCentreMm(map)
  const zoom = map.view?.zoom ?? 1
  const pairs: Array<{ code: string; value: string }> = [
    { code: 'x', value: formatMm(centre.x) },
    { code: 'y', value: formatMm(centre.y) },
    { code: 'z', value: formatZoom(zoom) },
    { code: 'v', value: '0' },
    { code: 'm', value: '50' },
    { code: 't', value: '50' },
    { code: 'b', value: '50' },
    { code: 'c', value: '50' },
    { code: 'h', value: '0' },
    { code: 'd', value: '0' },
  ]
  const values: ParameterStringValues = { _first: '', _pairs: pairs }
  for (const p of pairs) values[p.code] = p.value
  return values
}

/**
 * Object bounding-box centre in OCAD's mm/y-up frame.
 *
 * Canonical coords are stored as OCAD's `x >> 8` shape (still in 0.01
 * mm units, high 24 bits of the raw int32). Xmap and gitmap sources
 * arrive Y-down (paper origin top-left); the writer flips them to
 * OCAD's Y-up frame in `synthesize-objects`, so we mirror that flip
 * here for the view to line up with what's written to disk.
 */
function objectCentreMm(map: PanMap): { x: number; y: number } {
  const objects: MapObject[] = map.objects ?? []
  const flipY = map.sourceFormat !== 'ocad'
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const o of objects) {
    if (o.hidden) continue
    for (const c of o.coordinates ?? []) {
      const x = coordX(c)
      const y = flipY ? -coordY(c) : coordY(c)
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0 }
  return { x: (minX + maxX) / 2 / 100, y: (minY + maxY) / 2 / 100 }
}

function formatMm(v: number): string {
  return (Math.round(v * 1000) / 1000).toString()
}

/** Zoom keeps more precision than paper mm to match Mapper's 5-6 digit output. */
function formatZoom(v: number): string {
  return (Math.round(v * 100000) / 100000).toString()
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}
