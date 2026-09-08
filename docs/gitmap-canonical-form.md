# GitMap canonical form (proposal)

## Principle

**GitMap is a canonical representation of a map: the same map must serialise to
the same bytes regardless of which source format it was imported from.**

This is what makes gitmap useful as version control for maps — a `git diff`
between two commits should show only what *actually changed on the map*, never
artefacts of the import path. When gitmap leaks source-format details into the
stored bytes, an OCD-sourced and an OMap-sourced copy of the *same* map differ
on every line, so a cross-format update (e.g. a mapper re-exports from OCAD and
uploads it against an OMap-sourced base) reads as a 100%-changed diff.

This document records the canonical rules, what's enforced today, and the known
gaps.

## Why it matters (measured)

Round-tripping one gitmap through **both** OCD and OMap and diffing the two
results — i.e. isolating pure format-representation differences on identical
geometry:

| bottle-lake (15129 objects) | `objects.ndjson` byte-identical |
|---|---|
| Before canonicalisation | **0 / 15129** |
| After canonicalisation (initial) | 13102 / 15129 |
| After the hole-flag codec fix | 13174 / 15129 |
| After the rotation snap | 15088 / 15129 |
| **After area-pattern + text-anchor** | **15129 / 15129 (100%)** |

Objects are now fully cross-format canonical on bottle-lake. Colours: 44/44.
Georeferencing: identical bar `auxiliaryScaleFactor` (a field OCAD can't store —
see `canonicalisation-handover.md`). Symbols: 62/209 — the rest differ only on
`renderLayers`, a reader-dialect gap (below). See `canonicalisation-handover.md`
for the full state, the hanmer-forest curve/Bézier gap a second map surfaced, and
the remaining-work plan.

## Canonical rules

### 1. Coordinate orientation — ENFORCED
GitMap coordinates are **y-down (visual/screen space)**, regardless of source.
OCAD stores y-up; the gitmap writer negates Y for ocad-sourced maps (matching
the OMap convention and the SVG exporter's `getVisualCoordinateTransform`).
Without this, ocd→gitmap lands upside-down vs every omap-sourced gitmap.

### 2. Object serialisation — ENFORCED
The same object must serialise identically. The writer now:
- **`sourceId` = a dense z-rank** (the object's index in render order), not the
  raw source-file object id. The formats number objects differently but agree
  on order, so the rank is canonical.
- **Omits default/empty fields** — `text:""`, `rotation:0`, and all-default
  `pattern` (`rotation:0, origin:{0,0}`) are dropped, since one reader emits
  them and another omits them. The object id hash already normalises these to
  their defaults, so omitting them changes bytes, not identity.
- **Does not store `omapFlags`** — the raw OMap flag byte is source-specific and
  redundant: the canonical semantic flags (bezier control points, corner, hole,
  dash) live in `xFlags`/`yFlags`, which both readers populate, and the OMap
  writer re-derives its byte from those.

### 3. Symbol codes — canonical numeric form
Numeric OCAD-style codes are canonicalised (`parseSymbolCode`: OMap `101` and
OCAD `101.0` collapse to the same value). The *diff* already does this for
matching; the *stored* `symbolCode` should be canonical too so lines match.
(Currently the stored code can still differ — see gaps.)

## Enforcement — round-trip idempotence (`test/roundtrip.test.js`)

Canonical form makes a format's writer and reader an **inverse pair on the
canonical projection**: `read(write(M))` must gitmap-serialise byte-identically
to `M`. If a writer applies a transform its reader doesn't exactly undo (an OCAD
hole-flag shift, the Y-flip, a coordinate-precision change), the second gitmap
drifts. The round-trip test asserts this per format and is the mechanical guard
against read/write drift being introduced silently.

Measured today (see test): **`objects.ndjson` round-trips byte-identical for both
OCD and XMap** — geometry (coordinates + flags) is fully canonical and
invertible. `symbols.ndjson` does **not** yet round-trip (a `test.todo` tracks
it): the symbol dialect isn't even self-inverse (OCD ~19 lines, XMap ~105).

### The hole-flag codec — the bug this class of test exists to catch

OCAD stores a multi-ring area's hole-start flag (`yFlags & 0x02`) on the FIRST
coord of the new ring; canonical (and every consumer — SVG splitter, geojson,
diff) wants it on the LAST coord of the previous ring — one coord earlier. So the
OCAD writer shifts each flag forward on write, and the reader **must** shift it
back on read. The reader shift was missing: every OCAD-sourced area hole sat one
coord late, and each OCD round-trip walked it forward again (measured: all 235
interior hole flags on bottle-lake moved per round-trip; the 72 cross-format
"yFlags-only" object diffs were entirely this). Fixed by making the two shifts a
**co-located inverse pair** in `map/coord.ts` (`shiftHoleFlagsToOcad` /
`shiftHoleFlagsFromOcad`), asserted `fromOcad(toOcad(x)) === x` in
`test/hole-flags.test.js`. Result: cross-format yFlags diffs 72 → 0, byte-
identical objects 13102 → 13174, no regression.

Subtlety worth recording (it caused a wrong first fix): the last coord is
excluded from both shifts. A `0x02` on the final coord is a closed-line
*ClosePoint* marker, not a hole boundary (220 on bottle-lake, all on `line`
objects); the forward shift never lands a real hole flag there, and the
consumers already ignore it (`isFirstHolePoint(c) && i < length-1`). A naive
"shift everything back" moved those 220 and regressed 148 objects — which is why
the fix is guarded by both the unit inverse test and a real-data round-trip test
over bottle-lake's hundreds of holed areas.

## Known gaps (not yet canonical)

These are genuine differences between how the formats model things, so closing
them is reader-level work, not a writer tweak:

- **Symbols — the main remaining gap.** The two readers emit different
  render-layer *dialects* for the same visual symbol, and the writers don't
  reproduce them, so symbols don't round-trip even within one format. Concretely
  (bottle-lake): area patterns `structure-fill` (OCD) vs `point-pattern-fill`
  (OMap); line casings `double-line` vs `stroke.borders`; line decorations
  `line-elements` vs `line-symbols`; points `point-elements`-only vs split
  `point-fill`+`point-elements` with differently-shaped element records and
  inverted Y; `fontSize` in raw tenths-of-point (OCD, a model-contract violation
  — should be mm) vs mm (OMap); OCD emits `stroke.lineStyle` and drops zero
  fields, OMap does the opposite (~170 stroke-key diffs); `type` `area` vs
  `combined` for the area+border idiom; a writer bug synthesises 6 phantom
  `990.x` border line symbols so even the *count* differs (215 vs 209).
  **Direction:** the OCAD *writer* already consumes the xmap render-layer
  vocabulary (`areaBody` reads only `point-pattern-fill`; `lineBody` derives
  casings/decorations from `stroke.borders`/`line-symbols`), so the convergence
  point is to make the **OCD reader emit the xmap dialect** — see
  `docs/symbol-canonicalisation.md`. Note this does **not** affect the visual
  geometry diff (object-geometry-based, symbol codes canonicalised for matching)
  — only the Symbols/Metadata tab and symbol round-trip.
- **Georeferencing.** The canonical `MapCrs` model already has every field; the
  OCAD reader just populates a subset. OCD stores **grivation only** — but the
  two fields OMap adds are *derivable*, not lost data: `geographic.refPointDeg`
  by unprojecting `projected.refPoint`, and `declination = grivation +
  meridian-convergence` (convergence is a pure function of the projection at the
  ref point). Only `auxiliaryScaleFactor` is genuinely absent from OCD (it
  reflects a user "ground-true scale" choice OCAD never stores) — canonicalising
  it requires adopting an orienteering "ground-true" convention, not a read. The
  one infra dependency is offline PROJ.4 defs (promote `proj4` to a direct dep +
  bundle an EPSG→proj table keyed by the codes already in `crs-grids`). See
  `docs/georef-canonicalisation.md`.
- **`symbolCode` string form** (see rule 3).

## Round-trip fidelity vs canonical form

Dropping `omapFlags` trades a little OMap round-trip fidelity for canonical form.
This is the right call for a version-control format: gitmap is the canonical
representation, and exact source-byte round-trip — if ever needed — belongs in a
separate optional sidecar, not in the canonical geometry. (The `omap → gitmap →
omap` content-equality tests still pass: the semantic flags are enough to
reconstruct an equivalent OMap.)

## Migration

Canonicalising the writer changes the bytes of every gitmap (though **not** the
object ids — those are hashed from normalised content). Existing committed maps
keep their old bytes until re-imported, so to get clean cross-format diffs the
repo's maps should be re-canonicalised (re-import / rewrite) once — the same
one-time migration the y-fix needs.
