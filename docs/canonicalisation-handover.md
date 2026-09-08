# Canonicalisation handover

A guide to the cross-format canonicalisation work done on panmap, the current
state, and how to use the paired `.ocd`/`.xmap` maps in `~/Downloads` to push it
to **0 diffs on every pair**.

## The goal

GitMap is meant to be **canonical**: the same map must serialise to the same
bytes regardless of source format. So an OCD-sourced and an OMap-sourced copy of
one map should produce byte-identical `objects.ndjson`, `symbols.ndjson`,
`colors.ndjson`, and `gitmap.json`. When they don't, a cross-format update reads
as a 100%-changed diff.

## How to measure (the harness)

Round-trip one source gitmap through **both** native formats and diff the two
results — this isolates pure format-representation differences on identical
geometry:

```js
import { read, write, gitmap } from '@kiwirm/panmap'
// src = a source gitmap (or any map). Write to ocd + xmap, read both back,
// re-serialise to gitmap, compare each package file.
await write(src, 'out.ocd'); await write(src, 'out.xmap')
const O = await read('out.ocd'), X = await read('out.xmap')
// gitmap.write each to a temp dir, then compare objects.ndjson / symbols.ndjson
// line-by-line (match objects by `id`, symbols by `code`, colors by `id`).
```

For a **paired** `.ocd`/`.xmap` (same map exported from OOMapper both ways — what
you have in `~/Downloads`), read each directly and compare — this is the truest
test because both files are real application output, not a round-trip:

```js
const O = await read('map.ocd'), X = await read('map.xmap')
// gitmap.write both, diff the package files.
```

The `test/ocad-cross-format.test.js` suite already points at pairs in
`~/Downloads/...` and checks counts survive `xmap → ocd → xmap → ocd`. Extend it
to assert **byte-identical** `objects.ndjson` / `symbols.ndjson` per pair — that
turns each pair into a regression gate and surfaces any new gap immediately.

## What this session fixed (all verified on bottle-lake, 15129 objects / 209 symbols)

**Objects — now 100% cross-format identical (15129/15129).**
- **Y-orientation** — single source of truth (`formats/codecs/y-axis.ts`); every
  reader/writer/exporter defers to `needsYFlip`.
- **Hole-ring flags** — the OCAD writer shifts the `0x02` flag last-of-prev →
  first-of-new; the reader now applies the exact inverse (`shiftHoleFlagsFromOcad`),
  excluding the closed-line ClosePoint on the last coord. (Was: every OCD
  round-trip walked area holes one coord forward; fixed a real "holes in areas"
  rendering bug — see the `svg.test.js` kinks test.)
- **Point rotation** — snapped to OCAD's 0.1° grid (`snapRotationToOcadGrid`), so
  OCD's quantised angle matches OMap's full-precision one.
- **Area pattern rotation** — OCAD stores it in the object *angle*
  (`setPatternRotation`); the reader/writer now route it to `object.pattern`
  (not `object.rotation`), so it isn't dropped.
- **Text objects** — reduced to the anchor (Mapper's `fillTextPathCoords`
  convention); the 4 synthesised box corners are dropped. Text alignment
  (`hAlign`) is read from the symbol onto the object (also fixed centre/right
  labels rendering left).
- **Canonical `sourceId`** — objects use a dense z-rank; symbols use a dense
  code-sorted rank; both drop the format-specific source id.
- **Canonical symbol code** — `canonicalSymbolCode` collapses OCAD's `101.0` and
  OMap's `101` (took hanmer objects from 12/2568 → 2568/2568, since every object
  references a symbol by its code-derived id).
- **Dropped `omapFlags`** — semantic flags live in `xFlags`/`yFlags`.

**Colors — bottle-lake 44/44, hanmer 32/33.** CMYK snapped to OCAD's whole-percent
grid, RGB to 6 dp (drops the OCD-vs-OMap precision drift). The 1 residual is a
genuine OMap tint-colour RGB loss, not canonicalisation.

**Georeferencing — identical except `auxiliaryScaleFactor`.**
- `geographic.refPointDeg` + `declination` are now **derived** in the OCAD reader
  (`internal/geographic.ts`): unproject the projected ref point via proj4 (EPSG
  resolved offline through the `epsg-index` dependency), and
  `declination = grivation + meridian convergence`. Verified exact to OMap
  (lat/lon 8 dp, declination 23.91).
- `auxiliaryScaleFactor` is the **one** field OCAD provably cannot store (it
  reflects a user "ground-true scale" choice). Left unset — never fabricated.
  Adopting a documented "orienteering maps are ground-true" convention
  (`aux = 1/gridScaleFactor`) would close it, behind an opt-in.

**Symbols — 62/209 identical (from 0).**
- Fixed: `sourceId` (rank), `fontSize` (OCD tenths-of-point → mm), phantom
  `990.x` border symbols (count 215 → 209), `type` label (area+border →
  `combined`), `rotatable` (OMap point-pattern rotatability), render-layer scalar
  precision (rounded to 3 dp), and **stroke default-field parity** (drop OCD's
  `lineStyle`; omit the zero defaults OMap emits).

**Architecture / cleanup.**
- Format↔canonical conversions are co-located as inverse pairs in
  `formats/codecs/` (y-axis, ocad-coord packing, ocad-angle, hole-flags,
  omap-flags, text-box), each with a round-trip test (`test/hole-flags.test.js`,
  `test/roundtrip.test.js`) so read/write can't drift.
- Removed dead code (`pathSegments`/`addPathSegment`, unused imports).

## Measured cross-format state

A byte-level *before-gitmap vs after-gitmap* for the same map isn't meaningful —
the gitmap **spec itself changed** (z-rank sourceIds, dropped omapFlags, snapped
rotation, canonical hole flags…), so every line moved for spec reasons, not
content. The meaningful, stable metric is **cross-format identity within one
version**: round-trip a map through OCD and OMap and compare. Before this work
that was ~0 identical on everything (a cross-format update read as ~100%
changed); after:

| Map | objects | symbols | colors | georef |
|---|---|---|---|---|
| bottle-lake (ISOM, 15129 obj) | **15129 / 15129** | 62 / 209 | **44 / 44** | all but `auxiliaryScaleFactor` |
| hanmer-forest (NZ MTBO, 2568 obj) | **2568 / 2568** | 31 / 127 | 32 / 33 | all but `auxiliaryScaleFactor` |

**Running the harness on a second map immediately found — and we fixed — two real
gaps bottle-lake never exercised:**

1. **Symbol code form (`101.0` vs `101`).** OCAD writes variant-zero codes with a
   trailing group (`101.0`); OMap drops it (`101`). The stored symbol id derived
   from the raw code, so `sym_101_0` vs `sym_101` — and *every object referencing
   them* then differed. hanmer objects were **12 / 2568**; after adding
   `canonicalSymbolCode` (reconstruct the canonical dotted string from the parsed
   value, so `101.0`→`101` collapses while `204.1.0` is preserved) they are
   **2568 / 2568**. (bottle-lake's codes already matched, so it was unaffected.)
2. **CMYK precision.** OCAD stores CMYK as whole percentages; OMap keeps
   half-percent (`0.14` vs `0.135`). Snapping CMYK to the 1 % grid (and RGB to
   6 dp) in the gitmap writer — the same principle as rotation/coordinate
   rounding — took colours from **25 / 33** to **32 / 33**.

The single remaining hanmer colour is a genuine OMap gap (a "Green 45 %" tint
whose RGB comes through as `rgb(0,0,0)` on the OMap side — lost, not imprecise).
Its symbols still differ on `renderLayers` (the dialect gap) plus 11 that don't
pair (edge-case codes).

**Lesson (validated):** bottle-lake alone got objects to 100 %, but each new map
surfaces gaps — hanmer's two were caught and fixed in minutes just by running the
harness. Run every `~/Downloads` pair; triage by the differing field.

## The remaining gap: symbol `renderLayers` dialect (147/209 symbols)

This is the **only** substantial gap left, and it's the least-impactful one: it
does **not** affect the geometry diff (object/colour based, 100% canonical) or
map rendering (both dialects render correctly) — only the bytes of
`symbols.ndjson` (the Symbols/Metadata tab and symbol round-trip).

The two readers emit **different render-layer vocabularies** for the same visual
symbol, and there is no normalisation between read and serialise. Breakdown on
bottle-lake (117 differ on layer *set*, 30 on fields within a matching set):

| Bucket | OCD dialect | OMap dialect | count |
|---|---|---|---|
| Point construction | `point-elements` (disc inside) | `point-fill` + `point-elements` | 64 |
| Line decorations | `line-elements` + `stroke` | `stroke` / `line-symbols` | 28 |
| Area patterns | `structure-fill` | `point-pattern-fill` | 16 |
| Line casings | `double-line` + `stroke` | `stroke.borders` | 9 |
| Dash vocabulary | `mainLength`/`mainGap`/`endLength` | `breakLength`/`dashesInGroup`/`segmentLength` | 30 |
| Border reference | synthetic symNum (`301004`) | real symbol id (`75`) | 7 |
| Text layer | flat OCAD text props | nested xmap text object | 5 |

### Why it's a project, not a tweak

The element *records* themselves are different representations. An OCD
`point-elements` element is a **flat** OCAD element (`{type, color, coords,
lineWidth, diameter, flags}`, y-up); the OMap one is a **nested** tree
(`{symbol:{lineSymbol:{~20 fields}}, object:{coords}}`, y-down). Making OCD
byte-match OMap means *reconstructing OOMapper's exact nested structure with all
its default fields* — effectively reimplementing its symbol serialisation. The
SVG renderer (`pointElementToSvg`) dispatches on shape (`element.coords` vs
`element.object`), so it renders both — but the two shapes go through different
code paths.

### Recommended approach (incremental, pair-verified)

Normalise in the **gitmap writer** (`formats/gitmap/from-map.ts`), not the
readers, so rendering and the OCD→OCD write path stay untouched. Reduce **both**
dialects to one canonical shape rather than making OCD match OMap's verbose one:

1. **Pick the simpler target per layer type.** Reducing OMap's nested elements to
   a flat `{type, color, coords, lineWidth, diameter}` is far more tractable than
   reconstructing the nested tree from OCD — and the renderer already has a flat
   path (`ocadPointElementToSvg`).
2. **Do one bucket at a time**, in this order (biggest first): border reference →
   point-fill split → structure-fill → double-line → line-elements → dash vocab →
   text layer. After each, run the measurement on **every** `~/Downloads` pair and
   the `svg-snapshot` test.
3. **Guard with the pairs.** Promote the byte-identical assertion in
   `test/ocad-cross-format.test.js` to run per pair; a bucket is "done" when it
   drops the diff on all pairs without moving the svg snapshot.
4. **Coordinate orientation**: OCD elements are y-up, OMap y-down — normalise the
   element coords through the same `needsYFlip` path when flattening.

### Using your `~/Downloads` pairs to find *new* gaps

bottle-lake got everything to 100% on objects/colours, but other maps will
exercise symbol/feature types it doesn't have (line text, framing, different
pattern modes, more CRS). For each pair:

1. Run the harness (read `.ocd` and `.xmap`, gitmap both, diff each package file).
2. Objects/colours should already be **0** — if a pair shows object diffs, that's
   a *new* gap worth fixing (likely a feature type bottle-lake lacks). Triage by
   the differing field (same method used all session: match by id, tally which
   keys differ).
3. Symbols will differ on `renderLayers` until the dialect work above lands;
   filter those out and watch for diffs on *other* symbol fields (a new gap).
4. `gitmap.json` georef: any pair whose EPSG isn't in `epsg-index` will lack the
   derived geographic block — check the missing list.

The aim: each pair reaches `objects.ndjson` and `colors.ndjson` byte-identical
immediately, `gitmap.json` identical bar `auxiliaryScaleFactor`, and
`symbols.ndjson` identical once the dialect buckets are closed.

## mapwall diff-rendering: what to change now that panmap is canonical

A sweep of `mapwall/apps/{api,web}/src` for code that compensated for panmap not
being canonical:

- **Nothing to unwind for Y-orientation.** mapwall never worked around it — it
  consumes panmap's SVG + `viewBox` verbatim (`maps.ts` `parseViewBox`,
  `MapViewer.tsx` `mapToPixel`, no flip anywhere). It correctly delegated
  orientation to panmap all along.
- **Do this now — bump the client cache-busters.** The browser HTTP cache keys on
  URL, which encodes commit shas but not the panmap version, so a returning user
  can serve *stale pre-fix* diff SVGs for up to an hour. Bump `?v=13`→`14` and
  `v:"7"`→`"8"` in `apps/web/src/lib/api.ts` (svgUrl / diffSvgUrl /
  rangeDiffSvgUrl). Better: fold the panmap version into those URLs so it's
  automatic. (The server side already auto-regenerates — see next.)
- **Keep (load-bearing for the upgrade):** the version-keyed SVG cache +
  `pruneStaleRenderCaches` (`maps.ts`, `warm.ts`, Dockerfile) — this is exactly
  what makes bumping panmap regenerate every SVG instead of serving stale bytes.
- **Keep, but the *rationale* is now stale:** the in-process `multisetDiffLines`
  changed-subset diff (`maps.ts`) was built to dodge panmap's O(n²) `diffChanges`
  hang; the hang is fixed, but the subset approach is still a real
  memory/latency win *and* its "unchanged lines cancel" correctness now *relies
  on* panmap's byte-identical canonical output — so it's a beneficiary of this
  work, not something to remove. Same for `MAX_ISOLATABLE_CHANGES` (the
  too-many-changes guard): its dominant historical trigger (a cross-format diff
  reading ~100 % changed) is gone, but it's still a valid ceiling for a genuine
  full re-survey. Keep both; relax the comments.
- **Optional later cleanup (not now):** the extract-and-subprocess fallbacks and
  the SSE cold-render progress "gate" were defensive scaffolding for the new
  in-process path / the old hang; lower-value now, safe to keep.

## Re-migrating the gitmap repo (required — the spec changed)

The gitmaps stored in `mapwall/data/repos/*.git` were written by pre-0.3.2 panmap,
so they're in the **old** spec. To get canonical form (and clean cross-format
diffs) they must be **re-created from the original `.ocd`/`.xmap` source**, not by
re-writing the existing gitmaps.

**Why source, not a re-write:** several canonicalisations live in the format
READERS, and reading a gitmap back doesn't trigger them —
- Y-orientation flip (OCD y-up → canonical y-down): old OCD-sourced gitmaps are
  stored upside-down; re-reading them as gitmap keeps them that way.
- Hole-ring flag shift (OCD first-of-new → last-of-prev).
- Georef `geographic`/`declination` derivation (OCAD reader only — an old gitmap
  never had these, and a re-write won't invent them).

The writer-side rules (z-rank sourceId, `canonicalSymbolCode`, CMYK/rotation snap,
default-field omission, dropped omapFlags) *would* apply on a plain re-write — so
an OMap-sourced map could be *mostly* canonicalised without its source — but the
reader-side items above still need the original file. Clean answer: re-import
every map from source.

**History caveat:** recreating from just the *latest* source drops the per-update
commit history (the "updates" timeline the app shows). Preserving it means
re-importing each historical version in order — only possible if every version's
source file was kept. Decide up front: a fresh single-commit rebuild (simplest) or
a version-by-version replay.

**Shape of the migration:** for each map, `read(source) → gitmap.write(pkg) →
commit into the repo`, replacing the old package. Do it once, alongside deploying
0.3.2 (the version-keyed SVG cache + prune already regenerates every render).

## What `auxiliaryScaleFactor` is, and whether we can close it

On a projected CRS, **grid** distances (the projected plane) differ from **ground**
distances (true horizontal on the ellipsoid) by the *point scale factor* — for a
transverse-Mercator grid like NZTM that's ~0.9996 on the central meridian rising
past 1.0004 at the zone edge. An orienteer covers real *ground* distance, so an
orienteering map wants to be **ground-true**: OOMapper lets the mapper set
`auxiliary_scale_factor = 1 / grid_scale_factor` so printed distances match the
ground. For bottle-lake that's `1 / 0.999608 = 1.000392` (what OMap stores).

**OCAD cannot store it.** OCAD's georef (parameter string 1039) carries only the
nominal `scale` and grid parameters; its paper→grid transform uses the scale
alone, and the grid spacing `g = d·1000/m` exactly — so the file records *nothing*
about whether the author wanted ground-true scaling. The information is genuinely
absent, which is why the OCAD reader leaves the field unset (it never fabricates).

Options to close it:
- **A — leave unset (current).** OCD and OMap georef then differ by this one
  field. Honest; no fabrication. Recommended default.
- **B — adopt a documented convention (recommended, behind a flag).** Since this
  is an orienteering tool, assume "maps are ground-true" and set
  `auxiliaryScaleFactor = 1 / gridScaleFactor`, where the point scale factor is
  computable from the projection at the ref point (the same proj4 path used to
  derive `geographic`). For bottle-lake this reproduces `1.000392` exactly and
  makes georef **fully** cross-format identical. Ship it opt-in and documented as
  a domain assumption, *not* recovered data.
- **C — store `gridScaleFactor` instead.** Don't: OMap stores
  `auxiliaryScaleFactor` (not `gridScaleFactor`) here, so this would *add* a field
  OMap lacks and increase the diff.

## Publishing panmap + a formal spec

Right now the "spec" is spread across `docs/`, the reader/writer code, and the
tests. To make the canonical rules authoritative and machine-checkable:

**Stop vendoring — publish to npm first.** panmap is already publish-ready
(`name: @kiwirm/panmap`, `prepublishOnly: build`). `npm publish`, then have
mapwall depend on the published version instead of a vendored copy. This removes
the whole class of "the vendored copy drifted" problems and makes the runtime
`epsg-index` dependency resolve normally.

**Tooling (three complementary layers):**
1. **JSON Schema for the data format** (in-repo, `schema/*.json`): one schema each
   for `gitmap.json`, and an `objects.ndjson` / `symbols.ndjson` / `colors.ndjson`
   record. This is the machine-readable spec. Wire it two ways: validate the
   round-trip test outputs with **ajv** (an executable spec gate), and generate TS
   types with **json-schema-to-typescript** to replace/verify the hand-written
   model. Strongly recommended — it's the highest-leverage piece.
2. **Prose spec site — MkDocs + Material** (recommended over Read the Docs/Sphinx
   for a TS project: markdown not reStructuredText, low friction, great search).
   Sections: package layout, canonical rules (orientation, sourceId ranks, flag
   conventions, rounding, field omission), the codec inverse-pairs, versioning.
   Publish via a GitHub Actions workflow to GitHub Pages. (Docusaurus is the
   heavier alternative if you want a richer React site; Read the Docs is fine too
   but Sphinx/rST is more overhead than this needs.)
3. **TypeDoc** for the public API reference (`read`/`write`/`convert`/`exportMap`
   + the `ocad`/`omap`/`gitmap` namespaces), generated from the TS source.

**Implementation plan:**
1. `npm publish` @kiwirm/panmap; switch mapwall to the published dep.
2. Author `schema/gitmap.schema.json` + record schemas; add an ava test that
   validates the cross-format round-trip outputs with ajv. Generate model types
   from the schemas.
3. Consolidate `docs/gitmap-canonical-form.md` + the codec comments into a MkDocs
   site; add the GitHub Pages workflow.
4. Add TypeDoc; link it from the site.
5. Version the spec: `gitmap.json` already has `version: 1` — bump + changelog on
   any canonical-rule change. The round-trip + cross-format tests are the
   executable spec that keeps the prose honest.
