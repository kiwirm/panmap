import {
  XFLAG_FIRST_BEZIER,
  YFLAG_CORNER,
  YFLAG_DASH_POINT,
  YFLAG_FIRST_HOLE_POINT,
  coordX,
  coordY,
  type Coord,
  type FlaggedCoord,
} from '../../map/coord.js'

/**
 * OMap/xmap per-coord flag byte ↔ canonical `xFlags`/`yFlags` — inverse pair.
 *
 * OpenOrienteering's `MapCoord::Flag` packs everything into one `flags` byte;
 * panmap's canonical model splits bezier/corner/hole/dash semantics across
 * `xFlags`/`yFlags` (the OCAD-style split every downstream consumer reads).
 * `normaliseOmapFlags` decodes an xmap coord array on read; `coordinatesForOmap`
 * re-encodes the byte on write. Keep them together so the two mappings stay
 * consistent.
 *
 * XMap coord flag bits (OOM's MapCoord::Flag):
 *   0x01 CurveStart — start of a Bézier segment; next two coords are cp1/cp2.
 *   0x02 ClosePoint — last coord of a closed sub-path.
 *   0x04 GapPoint   — gap point (skipped section of a dashed line).
 *   0x10 HolePoint  — start of a new hole ring in an area.
 *   0x20 DashPoint  — dash / tick point on a line symbol.
 */

// -- decode: xmap flags byte → canonical xFlags/yFlags (in place) ------------

export function normaliseOmapFlags(coords: FlaggedCoord[]): void {
  for (let i = 0; i < coords.length; i++) {
    const c = coords[i]
    const own = omapFlagsOf(c)
    // If this coord already has explicit xFlags (e.g. an OCAD source), don't
    // overwrite — trust the reader that produced them.
    if (c.xFlags !== undefined && c.xFlags !== 0) continue

    let xFlags = c.xFlags ?? 0
    let yFlags = c.yFlags ?? 0

    if (i >= 1 && omapFlagsOf(coords[i - 1]) & 0x01) xFlags |= 0x01 // cp1
    if (i >= 2 && omapFlagsOf(coords[i - 2]) & 0x01) xFlags |= 0x02 // cp2
    if (own & 0x10) yFlags |= 0x02 // hole start
    if (own & 0x20) yFlags |= 0x08 // dash point
    // 0x04 GapPoint and 0x02 ClosePoint don't have OCAD-side twins; OOM stops
    // paths at end-of-array (no explicit close flag on the OCAD side), and gap
    // points affect line rendering only if a renderer looks at them separately.

    if (xFlags !== 0) c.xFlags = xFlags
    if (yFlags !== 0) c.yFlags = yFlags
  }
}

function omapFlagsOf(coord: FlaggedCoord | undefined): number {
  if (!coord) return 0
  const x = coord as FlaggedCoord & { omapFlags?: number }
  return x.omapFlags ?? coord.flags ?? 0
}

// -- encode: canonical xFlags/yFlags → xmap flags byte -----------------------

/**
 * Build the xmap `[x, y]` coord array with a `flags` byte re-derived from
 * canonical `xFlags`/`yFlags` (or passed straight through from `omapFlags`/
 * `flags` on a mixed-source map so nothing is silently dropped).
 */
export function coordinatesForOmap(coordinates: Coord[]): FlaggedCoord[] {
  const output: FlaggedCoord[] = coordinates.map(
    coord => [coordX(coord), coordY(coord)] as FlaggedCoord
  )

  coordinates.forEach((coord, index) => {
    const omapFlags = coord.omapFlags ?? coord.flags
    if (omapFlags !== undefined) {
      output[index].flags = (output[index].flags ?? 0) | omapFlags
      return
    }

    const xF = coord.xFlags
    const yF = coord.yFlags
    if (xF === undefined && yF === undefined) return

    if (((xF ?? 0) & XFLAG_FIRST_BEZIER) && index > 0) {
      output[index - 1].flags = (output[index - 1].flags || 0) | 0x01
    }
    if ((yF ?? 0) & YFLAG_DASH_POINT || (yF ?? 0) & YFLAG_CORNER) {
      output[index].flags = (output[index].flags || 0) | 0x20
    }
    if ((yF ?? 0) & YFLAG_FIRST_HOLE_POINT) {
      setPathHolePoint(output, index)
    }
  })

  return output
}

// Set the OMap HolePoint bit (0x10) on the coord AT `index`. Panmap's
// canonical `yFlags:2` and Mapper's OMap `0x10` bit both live on the LAST
// coord of the previous sub-path (documented at `hole-flags.ts:8-10` and
// `mapper/src/core/map_coord.h:55` — "isHolePoint: this point marks the end
// of a distinct path"). Bug-history: this function used to write to
// `index - 1`, which off-by-one'd the flag backward every write cycle and
// caused a slow drift where hole flags migrated toward coord 0 and got
// swallowed by the guards below.
//
// Skip if the coord itself or its bezier-partner neighbours carry the
// CurveStart bit (0x01) — the OMap format packs bezier and hole markers
// on separate bytes but writing both on the same coord confuses Mapper's
// coord reader.
function setPathHolePoint(coordinates: FlaggedCoord[], index: number): void {
  if (index < 0 || index >= coordinates.length) return
  if ((coordinates[index]?.flags ?? 0) & 0x01) return
  if (index >= 1 && ((coordinates[index - 1]?.flags ?? 0) & 0x01)) return
  if (index >= 2 && ((coordinates[index - 2]?.flags ?? 0) & 0x01)) return
  coordinates[index].flags = (coordinates[index].flags || 0) | 0x10
}
