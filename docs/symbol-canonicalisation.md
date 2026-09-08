# Symbol canonicalisation — plan

## Problem

Each format reader emits its own native **render-layer dialect**, and
`gitmap/from-map.ts` serialises whatever the reader produced verbatim (it only
remaps colour ids and strips `undefined` — there is no normalisation pass). So
the same visual symbol serialises differently depending on the source format,
and symbols don't round-trip even within one format (`test/roundtrip.test.js`
todos: OCD ~19 lines drift, XMap ~105).

This does **not** affect the visual geometry diff (object-geometry based, symbol
codes canonicalised for matching) — only the Symbols/Metadata tab and symbol
round-trip fidelity.

## Where the readers disagree (bottle-lake, OCD vs OMap)

| Bucket | OCD reader | OMap reader | ~count |
|---|---|---|---|
| Area patterns | `structure-fill` (flat OCAD elements, `structDraw/mode`) | `point-pattern-fill` (nested `pattern.symbol.pointSymbol`, `lineSpacing/pointDistance`) | 16 |
| Line casings | `double-line` layer | `stroke.borders` | 9 |
| Line decorations | `line-elements` (raw arrays) | `line-symbols` (nested `lineSymbol`) | 28 |
| Point construction | `point-elements` only | split `point-fill` + `point-elements` | 66 |
| Point element records | flat OCAD `{type,lineWidth,coords(y-up),flags}` | nested `{object,symbol}` (y-down) | (largest) |
| Stroke default fields | emits `lineStyle`, drops zero fields | omits `lineStyle`, always emits `startOffset/endOffset/minimumMidSymbolCount/showAtLeastOneSymbol` | ~170 |
| `fontSize` (top level) | raw tenths-of-point (`30`) — **violates the mm model contract** | mm (`1.058`) | 5 |
| render-layer float precision | exact (`90`, `1.058333…`) | converted (`90.0002…`, `1.058`) | ~15 |
| `rotatable` | from area `flags & 1` | from `patterns.some(p=>p.rotatable)` only | 9 |
| `type` (area+border idiom) | `area` (+`borderSym`) | `combined` | 7 |
| Symbol **count** | 215 — 6 phantom `990.x` borders | 209 | 6 |

**Key leverage:** the OCAD *writer* already treats the xmap vocabulary as
primary — `areaBody` consumes only `point-pattern-fill` (never `structure-fill`);
`lineBody` derives casings/decorations from `stroke.borders`/`line-symbols`. So
the OCD reader's dialect is largely a dead-end even within panmap, and aligning
the reader to xmap mostly *removes* a dialect nothing needs.

## Recommendation (staged)

### Stage C — cheap, safe, high-count wins (do first, ~1–a-few lines each)
1. **`fontSize` → mm** in OCD `toMapSymbol` (`to-map.ts:110`): apply `* 25.4 / 720`
   (the reader already does this for the text render layer). Fixes 5 diffs and a
   contract violation.
2. **Round render-layer scalars** to fixed precision in `renderLayerToGitmap` /
   `toJsonSafe` (`from-map.ts`), mirroring the coordinate `cleanNumber` (3 dp).
   Kills the `text.fontSize` and `hatch-fill.angle` precision buckets centrally.
3. **Stroke default-field parity:** make both readers emit the same key set (drop
   OCD's `|| undefined` zero-gating and its `lineStyle`; derive `capStyle`/
   `joinStyle` as OMap does). Removes ~170 diffs.
4. **`rotatable`:** honour the nested `pointSymbol`/pattern rotatability
   consistently in both readers (or normalise centrally). Fixes 9.
5. **`type` label:** canonicalise the area+border idiom to one label. Fixes 7.
6. **Phantom `990.x` borders:** in `synthesize-symbols.ts:93-111`, skip the
   border-registry allocation when `inferOcadTypeFromLayers(symbol) === 'line'`
   (a `combined` symbol that infers to a line folds its casing into `doubleLine`
   itself, leaving the synthetic border orphaned). Closes the count gap.

Stage C alone removes the large majority of the per-symbol diffs and the count
gap, with minimal risk.

### Stage A — structural convergence (the real fix for the remaining buckets)
Rework the OCD reader (`src/formats/ocad/to-map.ts` + shared element converter)
to emit the **xmap render-layer vocabulary**: `point-pattern-fill` (not
`structure-fill`), split `point-fill`/`point-stroke`+`point-elements`,
`stroke.borders` (not `double-line`), `line-symbols` (not `line-elements`),
y-down element coords with the `{object,symbol}` record shape. This retires the
orphan `structure-fill` dialect (also a latent OCD→OCD area-pattern round-trip
bug) and makes the *stored gitmap* format-independent for symbols.

Risk: `lineBody` currently prefers the OCD-shaped `line-elements`/`double-line`
when present (for byte-exact OCD→OCD output); removing them from the reader
shifts OCD→OCD onto the derive path, which must be verified to still round-trip.
Medium effort, medium risk, highest payoff. Gate with `test/roundtrip.test.js`
(promote the symbol `test.todo`s to byte assertions).

### Stage B — fallback
If touching `to-map.ts` proves too coupled to OCD→OCD byte-fidelity, add a
single shared canonical-normalisation pass over `renderLayers` (post-read or in
`from-map.ts`) doing the same dialect rewrites. Same hard part (reconstructing
nested xmap element trees), relocated; slightly lower blast radius, but a third
representation to maintain.

**Pick:** Stage C now, then Stage A.
