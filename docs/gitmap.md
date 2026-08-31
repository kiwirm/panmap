# GitMap Specification And Implementation Plan

GitMap is a deterministic, revision-control-friendly directory format for
orienteering maps. It is designed to be stored in Git and converted to and from
panmap's canonical `Map` representation.

## Goals

- Make map changes reviewable with normal Git tooling.
- Avoid noisy editor metadata such as undo stacks, current view, zoom, and local
  absolute template paths.
- Avoid source-format ordering noise from OCAD/OCD and XMap/OMap files.
- Preserve enough map data for export through panmap's internal `Map` model.
- Support semantic visual diffs and future semantic merges.

## Non-Goals

- Replacing Git as the version-control engine.
- Live collaborative editing.
- Optimizing for hand-authored map files over deterministic machine output.

## Package Layout

The gitmap directory contains a manifest plus three NDJSON streams:

```text
map.gitmap/
  gitmap.json
  crs.json
  colors.ndjson
  symbols.ndjson
  objects.ndjson
```

Each NDJSON file is one record per line, sorted by stable ID. This keeps the
diffs textual and reviewable while avoiding array-comma noise. Very large maps
may later split `objects.ndjson` into hash buckets (`objects/ab.ndjson` etc.).

Optional future files:

```text
map.gitmap/
  source.json
  private/view.json
  conflicts/merge-001.json
```

`private/` and generated `exports/` should be gitignored.

Templates (background raster references — LiDAR, aerial, basemaps) are
intentionally **not** part of the gitmap package. They churn per mapper's
local file paths, add noise to diffs, and downstream consumers of the
gitmap don't have the referenced files anyway. If a canonical URL-based
template concept is added later, this decision will be revisited.

## Determinism Rules

Writers must:

- use UTF-8 and LF line endings
- use stable JSON key ordering
- sort colors by `renderOrder`, then `id`
- sort symbols by `code`, then `id`
- sort objects by `id`
- sort tags by key
- omit empty optional fields
- use stable numeric precision
- avoid generated timestamps
- avoid derived counts and bounds
- avoid local absolute paths in tracked files

## Manifest

`gitmap.json`

```json
{
  "format": "gitmap",
  "version": 1,
  "units": "map-units",
  "precision": 3,
  "files": {
    "crs": "crs.json",
    "colors": "colors.ndjson",
    "symbols": "symbols.ndjson",
    "objects": "objects.ndjson"
  }
}
```

## Colors

`colors.ndjson` — one JSON object per line, sorted by `renderOrder` then `id`.

Colors use stable IDs and explicit render order. Symbols reference color IDs,
not source palette indexes. Both RGB (screen) and CMYK (print / OCAD) are
stored — OCAD-side rendering uses CMYK, and going gitmap → OCD without it
would produce a colorless map. Per-color opacity is optional but preserved
when the source carries it (Mapper XMap does).

Color IDs are `color_<slug(name)>_<sourceId>`. The sourceId disambiguator
keeps duplicate-named slots (a map with six different "Green" render layers,
for instance) from collapsing to a single id — that was previously silent and
caused an off-by-N shift on every symbol that referenced the tail of the palette
in a gitmap round-trip.

```json
{
  "id": "color_brown_100_line_symbols_16",
  "sourceId": 16,
  "name": "Brown 100% line symbols",
  "rgb": "rgb(224, 113, 30)",
  "cmyk": [0, 0.5, 1, 0.12],
  "opacity": 1,
  "renderOrder": 16000
}
```

`renderOrder` is scaled by 1000 on write to leave insertion gaps for future
palette edits without renumbering.

## Symbols

`symbols.ndjson` — one JSON object per line, sorted by `code` then `id`.

Symbols carry source-independent render layers plus enough metadata to round-
trip through every format panmap writes. The known render-layer types:

| type                 | purpose                                            |
| -------------------- | -------------------------------------------------- |
| `stroke`             | line symbol's main stroke (color/width/dash/cap/join, optional `borders`, `segmentLength`, `endLength`, mid/dash-symbol placement fields) |
| `line-elements`      | line-symbol OCD-style element arrays (primSym / cornerSym / startSym / endSym / dashSym) — mid/start/end/dash decorations |
| `line-symbols`       | xmap-shape wrapper carrying nested `dashSymbol` / `midSymbol` / `startSymbol` / `endSymbol` records |
| `double-line`        | OCAD-encoded fill-between-borders shape (fill color + left/right border colors and widths + dblMode) |
| `fill`               | area symbol's inner fill                           |
| `hatch-fill`         | area hatch (color, spacing, lineWidth, angle in degrees, `rotatable`) |
| `structure-fill`     | area structure pattern (elements, mode 1/2, width, height, angle, `noClipping`, `rotatable`) |
| `point-pattern-fill` | area point-pattern (xmap-native — carries the raw pattern record for `isShiftedRows` detection) |
| `border-symbol`      | area's border-line reference (`symbolId`) — mirrors OCAD's `borderSym` slot; a gitmap → ocd write reuses this instead of allocating a synthetic 99xxxx border |
| `point-fill`         | point-symbol inner disc                            |
| `point-stroke`       | point-symbol outer ring                            |
| `point-elements`     | array of OCAD-style icon primitives for a point symbol |
| `text`               | text symbol typography (family, size, weight, italic, spacing) |

All color references are stable string IDs (`color_...`). Numeric fields use
"map units" (0.01 mm), matching the coord scale. Angles on hatch/structure
layers are stored in degrees; conversion to xmap's radians happens at write time.

A symbol may also carry a top-level `rotatable: true` flag. Both format
readers surface it — OCAD sets it from `flags & 1` on the raw symbol,
XMap from any `rotatable="true"` on a nested `<point_symbol>` /
`<text_symbol>` / `<pattern>`. It replaces the earlier practice of
peeking into a per-format native bag.

```json
{
  "id": "sym_416_000",
  "sourceId": 416000,
  "code": "416.000",
  "name": "Distinct vegetation boundary",
  "type": "line",
  "hidden": false,
  "renderLayers": [
    {
      "type": "stroke",
      "colorId": "color_black_100_9",
      "width": 21,
      "lineStyle": 4,
      "capStyle": 0,
      "joinStyle": 1
    },
    {
      "type": "line-elements",
      "mainLength": 40,
      "primSymElements": [
        {
          "type": 4,
          "flags": 0,
          "color": "color_black_100_9",
          "lineWidth": 0,
          "diameter": 25,
          "coords": [[0, 0]]
        }
      ]
    }
  ]
}
```

## Objects

`objects.ndjson`

Each line is one object record:

```json
{"id":"obj_000001","symbolId":"sym_101_000","type":"line","coordinates":[[0,0],[100,0]],"hidden":false}
{"id":"obj_000002","symbolId":"sym_416_000","type":"line","coordinates":[[0,50],[100,50]],"hidden":false}
```

Coordinates are stored as `{x, y}` records with optional path flags:

- `flags` — the xmap coord byte (bit 0x01 = curve start, 0x02 = close point, etc.)
- `xFlags` / `yFlags` — OCAD's separate x/y bit fields (curve control markers, hole points, dash points)
- `xmapFlags` — the raw xmap flag byte kept alongside the derived xFlags/yFlags
  for lossless xmap-side round-trip

Writers should record whichever flag style the source produced; the OCAD and
XMap converters both accept a mix and translate.

Text and area objects may also carry a handful of xmap-native extras:

- `hAlign` / `vAlign` — text object alignment overrides (xmap `h_align` /
  `v_align`).
- `textBox` — `{ width, height }` in map units for the object's text
  bounding box (xmap `<size>`).
- `pattern` — per-object pattern override `{ rotation?, origin? }`
  (xmap `<pattern>`).

These were previously stashed under `native.xmap.raw` and only survived a
gitmap detour by accident. Promoting them to first-class canonical fields
is what lets the writer drop the raw passthrough entirely.

## Stable IDs

Writers should preserve existing stable IDs. When importing source formats:

- color IDs are derived from source color names/numbers
- symbol IDs are derived from code/source IDs
- object IDs are derived from source object IDs when stable
- otherwise object IDs fall back to deterministic content hashes

The current v1 implementation starts with deterministic IDs generated from the
existing `Map` ids and source ids.

## Commands

Planned CLI:

```sh
panmap gitmap import input.ocd map.gitmap
panmap gitmap export map.gitmap output.svg
panmap gitmap validate map.gitmap
panmap gitmap diff old.gitmap new.gitmap --svg diff.svg
```

## Implementation Phases

1. Harden `Map` for canonical package reads.
2. Add stable JSON/NDJSON utilities.
3. Add `writeGitmap(map, directory)` and `readGitmap(directory)`.
4. Add round-trip tests: OCAD/XMap -> GitMap -> Map -> SVG.
5. Add CLI import/export commands.
6. Add GitMap diff command using existing `diffMaps`.
7. Add semantic merge prototype.
8. Add XMap/OMap writer.
9. Add OCAD/OCD writer if required.

## Merge Strategy

Git handles storage and ordinary merges. GitMap should later provide a semantic
merge helper:

```sh
panmap gitmap merge base.gitmap ours.gitmap theirs.gitmap --out merged.gitmap
```

Object records merge by stable object ID:

- different objects changed: auto-merge
- same object tags changed on different keys: auto-merge
- same object geometry changed both sides: conflict
- object deleted on one side and edited on another: conflict
- symbols/colors changed both sides: conflict until symbol-aware merge exists

Conflict output can be represented as a conflict report JSON and/or rendered as
a visual diff SVG.
