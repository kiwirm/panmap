import { XMLSerializer, DOMImplementation } from '@xmldom/xmldom'
import PanMap, { type MapColor, type MapObject, type MapSymbol } from './model.js'
import diffMaps, { type DiffMapsOptions } from './diff.js'
import mapToSvg from '../export/svg.js'
import { DIFF_OUTLINE_WIDTH, recolorSymbol } from './diff.js'
import { isFirstBezier, isSecondBezier, isFirstHolePoint } from './coord.js'
import { parseSymbolCode } from '../util/symbol-code.js'

// A single navigable change: one changed source feature (or a
// removed+added pair recognised as the same feature moved/edited).
export interface DiffChangeFeature {
  symbolCode: string
  symbolName: string
  type: string
  count: number // diff primitives contributed (line segments, or 1 for point/area/text)
}

export interface DiffChange {
  id: number
  kind: 'added' | 'removed' | 'modified'
  // For `modified` changes: whether the geometry moved, the symbol was
  // re-classified, or both. Absent for pure added/removed.
  modification?: 'geometry' | 'symbol' | 'both'
  // For a symbol change: the old and new symbols, for an "A → B" label.
  fromSymbol?: DiffChangeFeature
  toSymbol?: DiffChangeFeature
  // [minX, minY, maxX, maxY] in the same coordinate space as the diff
  // SVG's viewBox, so callers can map straight to render pixels.
  bounds: [number, number, number, number]
  addedCount: number
  removedCount: number
  features: DiffChangeFeature[]
  // Full-symbology SVG of just this change, in the same viewBox as the
  // whole-diff SVG — for rendering the change in isolation. Present only
  // when diffChanges is called with { renderSvg: true }.
  svg?: string
}

export interface DiffChangesOptions {
  // Also render each change to a standalone SVG (see DiffChange.svg).
  renderSvg?: boolean
}

export interface DiffChangesResult {
  viewBox: [number, number, number, number] // [minX, minY, width, height]
  changes: DiffChange[]
  // Overall diff SVG: every change's changed (red/green) parts, no yellow.
  // Present only when called with { renderSvg: true }.
  overallSvg?: string
}

type Rect = [number, number, number, number] // minX, minY, maxX, maxY

// A point/text feature that moved less than this (on the ground) is
// treated as the same feature edited; further is a separate add + remove.
const POINT_MOVE_METERS = 50

// Lines/areas pair as "edited" when at least this fraction of each
// feature's points lie within POINT_MOVE_METERS of the other feature's
// geometry (symmetric coverage). Robust to a few moved vertices.
const COVERAGE_THRESHOLD = 0.8

interface Feature {
  kind: 'added' | 'removed'
  symbol?: MapSymbol
  type: string
  count: number
  bounds: Rect
  src: MapObject // the original source feature
  // The diff primitives this feature contributed (for isolated render).
  objects: Array<MapObject & { diffKind?: string }>
}

/**
 * Build a navigable, per-feature list of changes between two maps, plus
 * the viewBox that matches `diff()`'s SVG. Each entry is one changed
 * source feature; a removed feature that lines up with an added feature
 * of the same symbol and overlapping extent is reported as one
 * `modified` entry.
 *
 * Bounds are in the map's canonical coordinate space — identical to the
 * SVG `diff()` renders with `after.getBounds()` — so a consumer can map
 * a change's bounds directly onto the rendered image.
 */
export function diffChanges(
  before: PanMap,
  after: PanMap,
  options: DiffMapsOptions = {},
  changeOptions: DiffChangesOptions = {},
): DiffChangesResult {
  const diffMap = diffMaps(before, after, options)
  const beforeSymbols = symbolsById(before)
  const afterSymbols = symbolsById(after)

  // Group diff primitives back onto the source feature that produced
  // them (all segments of one line share the same sourceObject ref).
  const bySource = new Map<MapObject, Feature>()
  for (const raw of diffMap.objects as Array<
    MapObject & { diffKind?: string; sourceObject?: MapObject }
  >) {
    const src = raw.sourceObject
    const kind = raw.diffKind
    if (!src || (kind !== 'added' && kind !== 'removed')) continue
    let feat = bySource.get(src)
    if (!feat) {
      const symbols = kind === 'added' ? afterSymbols : beforeSymbols
      feat = {
        kind,
        symbol: symbols[src.symbolId as string | number],
        type: src.type,
        count: 0,
        bounds: [Infinity, Infinity, -Infinity, -Infinity],
        src,
        objects: [],
      }
      bySource.set(src, feat)
    }
    feat.count += 1
    feat.objects.push(raw)
    extendRect(feat.bounds, rectOf(raw))
  }

  const features = [...bySource.values()].filter(f => isFinite(f.bounds[0]))
  const removed = features.filter(f => f.kind === 'removed')
  const added = features.filter(f => f.kind === 'added')

  const usedAdded = new Set<Feature>()
  const usedRemoved = new Set<Feature>()
  const changes: DiffChange[] = []

  // Phase 1 — symbol changes: a removed and added feature with IDENTICAL
  // geometry but a different symbol. The feature didn't move; it was
  // re-classified. (Same geometry AND same symbol wouldn't reach the diff
  // at all.) Strongest signal, so pair these first.
  const addedGeom = new Map<string, Feature[]>()
  for (const a of added) {
    const k = geomKey(a.src)
    ;(addedGeom.get(k) ?? addedGeom.set(k, []).get(k)!).push(a)
  }
  for (const r of removed) {
    const candidates = addedGeom.get(geomKey(r.src)) ?? []
    const match = candidates.find(
      a => !usedAdded.has(a) && canonCode(a.symbol) !== canonCode(r.symbol),
    )
    if (!match) continue
    usedAdded.add(match); usedRemoved.add(r)
    const nc = changedNodeCounts(r, match)
    changes.push(makeChange('modified', unionRect(r.bounds, match.bounds),
      nc.added, nc.removed, [r, match], 'symbol'))
  }

  // Phase 2 — geometry changes: a removed and added feature of the SAME
  // symbol that are the same feature edited/moved. Rather than a loose
  // bbox overlap, require real geometry similarity:
  //   - lines/areas: share > 50% of their vertices
  //   - points: within ~10 m on the ground
  // Otherwise they're treated as separate add + remove. Match on the
  // canonical code so OMap "406" pairs with OCAD "406.0".
  const scale = after.georeferencing?.scale ?? before.georeferencing?.scale ?? 15000
  // 1 coord unit = 0.01 mm on paper → scale * 1e-5 m on the ground.
  const pointMoveUnits = POINT_MOVE_METERS / (scale * 1e-5)
  const bestMatch = (r: Feature, sameSymbol: boolean): Feature | null => {
    let best: Feature | null = null
    let bestScore = 0 // must beat 0 to count as a match
    for (const a of added) {
      if (usedAdded.has(a)) continue
      const same = canonCode(a.symbol) === canonCode(r.symbol)
      if (sameSymbol ? !same : same) continue
      const score = matchScore(r, a, pointMoveUnits)
      if (score > bestScore) { best = a; bestScore = score }
    }
    return best
  }

  // Phase 2 — geometry change: same symbol, geometry coverage-matches.
  for (const r of removed) {
    if (usedRemoved.has(r)) continue
    const best = bestMatch(r, true)
    if (best) {
      usedAdded.add(best); usedRemoved.add(r)
      const nc = changedNodeCounts(r, best)
      changes.push(makeChange('modified', unionRect(r.bounds, best.bounds),
        nc.added, nc.removed, [r, best], 'geometry'))
    }
  }

  // Phase 3 — both: leftover LINE/AREA features whose geometry coverage-
  // matches but whose symbol also differs (reclassified AND reshaped) —
  // one feature. Points/text are excluded: two distinct points within the
  // move threshold but of different symbols are almost never the same
  // feature, and an in-place point re-symbolisation is already a symbol
  // change (phase 1).
  for (const r of removed) {
    if (usedRemoved.has(r) || r.type === 'point' || r.type === 'text') continue
    const best = bestMatch(r, false)
    if (best) {
      usedAdded.add(best); usedRemoved.add(r)
      const nc = changedNodeCounts(r, best)
      changes.push(makeChange('modified', unionRect(r.bounds, best.bounds),
        nc.added, nc.removed, [r, best], 'both'))
    }
  }

  // Whatever is still unpaired is a genuine add or remove.
  for (const r of removed) {
    if (!usedRemoved.has(r)) changes.push(makeChange('removed', r.bounds, 0, r.count, [r]))
  }
  for (const a of added) {
    if (!usedAdded.has(a)) changes.push(makeChange('added', a.bounds, a.count, 0, [a]))
  }

  // Reading order: top-to-bottom, then left-to-right.
  changes.sort((x, y) => x.bounds[1] - y.bounds[1] || x.bounds[0] - y.bounds[0])
  changes.forEach((c, i) => (c.id = i + 1))

  const b = after.getBounds()
  const viewBox: [number, number, number, number] = [b[0], b[1], b[2] - b[0], b[3] - b[1]]
  let overallSvg: string | undefined

  // Optionally render each change on its own — same symbols/colours and
  // the whole-diff viewBox, so it drops straight onto the base map.
  if (changeOptions.renderSvg) {
    const serializer = new XMLSerializer()
    const georeferencing = after.georeferencing ?? before.georeferencing
    // Modified render needs both the real recoloured symbols (for points,
    // which keep their icon) and the outline/hatch symbols (for line/area
    // runs). Merge once.
    const modColors = [...diffMap.colors, ...OUTLINE_COLORS]
    const modSymbols = [...diffMap.symbols, ...OUTLINE_SYMBOLS]
    for (const change of changes) {
      const feats = changeFeatures.get(change) ?? []
      // Added/removed → full symbology recoloured green/red. Modified →
      // the unchanged part of the feature in yellow with the changed part
      // in red (removed) / green (added), so you can see WHAT changed.
      let mini: PanMap
      if (change.kind === 'modified') {
        const { objects, symbols } = modifiedRenderObjects(feats, true)
        mini = new PanMap({
          sourceFormat: 'diff', georeferencing,
          colors: modColors, symbols: [...modSymbols, ...symbols],
          objects, warnings: [],
        })
      } else {
        mini = new PanMap({
          sourceFormat: 'diff', georeferencing,
          colors: diffMap.colors, symbols: diffMap.symbols,
          objects: feats.flatMap(f => f.objects), warnings: [],
        })
      }
      const svg = mapToSvg(mini, {
        document: new DOMImplementation().createDocument(null, 'xml', null),
        bounds: b,
      })
      change.svg = serializer.serializeToString(svg)
    }

    // Overall diff = every change's CHANGED parts only (red/green, no
    // yellow); yellow context lives only in the per-change views above.
    const overallObjects: MapObject[] = []
    const overallExtraSymbols: MapSymbol[] = []
    for (const change of changes) {
      const feats = changeFeatures.get(change) ?? []
      if (change.kind === 'modified') {
        const { objects, symbols } = modifiedRenderObjects(feats, false)
        overallObjects.push(...objects)
        overallExtraSymbols.push(...symbols)
      } else {
        overallObjects.push(...feats.flatMap(f => f.objects))
      }
    }
    const overallMap = new PanMap({
      sourceFormat: 'diff', georeferencing,
      colors: modColors, symbols: [...modSymbols, ...overallExtraSymbols],
      objects: overallObjects, warnings: [],
    })
    overallSvg = serializer.serializeToString(mapToSvg(overallMap, {
      document: new DOMImplementation().createDocument(null, 'xml', null),
      bounds: b,
    }))
  }

  return { viewBox, changes, overallSvg }
}

// Features backing each change, kept out of the serialised result but
// available for per-change SVG rendering above.
const changeFeatures = new WeakMap<DiffChange, Feature[]>()

// Colours + symbols for the isolated modified render: the unchanged part
// of the feature in yellow, changed parts in green (added) / red (removed).
const OUTLINE_KIND_RGB: Record<string, string> = {
  added: 'rgb(22, 163, 74)',
  removed: 'rgb(220, 38, 38)',
  modified: 'rgb(234, 179, 8)',
}
// The exporter draws HIGHER renderOrder first (i.e. at the bottom), so to
// stack green over red over yellow, give green the lowest order and yellow
// the highest.
const OUTLINE_COLORS: MapColor[] = [
  { id: 'added', sourceId: 'added', name: 'added', rgb: OUTLINE_KIND_RGB.added, renderOrder: 1 },
  { id: 'removed', sourceId: 'removed', name: 'removed', rgb: OUTLINE_KIND_RGB.removed, renderOrder: 2 },
  { id: 'modified', sourceId: 'modified', name: 'modified', rgb: OUTLINE_KIND_RGB.modified, renderOrder: 3 },
]
const OUTLINE_SYMBOLS = [
  ...['added', 'removed', 'modified'].flatMap(k => [
    {
      id: `outline-line-${k}`, sourceId: `outline-line-${k}`, code: `outline-line-${k}`,
      name: k, type: 'line', hidden: false,
      renderLayers: [{ type: 'stroke', colorId: k, width: DIFF_OUTLINE_WIDTH }],
    },
    {
      id: `outline-point-${k}`, sourceId: `outline-point-${k}`, code: `outline-point-${k}`,
      name: k, type: 'point', hidden: false,
      renderLayers: [{ type: 'point-fill', colorId: k, radius: 40 }],
    },
  ]),
  // Hatched area fills: yellow when the area shares geometry (edited in
  // place), green when it shares none (effectively a new area).
  {
    id: 'diff-hatch-modified', sourceId: 'diff-hatch-modified', code: 'diff-hatch-modified',
    name: 'Modified', type: 'area', hidden: false,
    renderLayers: [{ type: 'hatch-fill', colorId: 'modified', spacing: 120, lineWidth: 14, angle: 45 }],
  },
  {
    id: 'diff-hatch-added', sourceId: 'diff-hatch-added', code: 'diff-hatch-added',
    name: 'Added', type: 'area', hidden: false,
    renderLayers: [{ type: 'hatch-fill', colorId: 'added', spacing: 120, lineWidth: 14, angle: 45 }],
  },
] as unknown as MapSymbol[]

// Build the render objects for a modified change: unchanged runs (yellow),
// removed runs (red), added runs (green). Returns any extra symbols the
// objects reference (recoloured real line symbols, so an edited line keeps
// its own thickness/style rather than a fat generic outline).
//
// Points/text show old (red) + new (green) real symbols; areas keep the
// fat outline + hatched fill; lines use the recoloured real symbol.
// `context=false` (overall diff) drops the yellow unchanged parts + fill.
function modifiedRenderObjects(
  feats: Feature[], context = true,
): { objects: MapObject[]; symbols: MapSymbol[] } {
  const addedFeat = feats.find(f => f.kind === 'added')
  const removedFeat = feats.find(f => f.kind === 'removed')
  const type = (addedFeat ?? removedFeat)?.type
  const objs: unknown[] = []
  const symbols: MapSymbol[] = []
  let nid = 1
  const mk = (coords: unknown[], symbolId: string, otype: string) =>
    objs.push({ id: `m${nid++}`, symbolId, type: otype, coordinates: coords, hidden: false, bounds: boundsOfCoords(coords) })

  if (type === 'point' || type === 'text') {
    return { objects: feats.flatMap(f => f.objects) as MapObject[], symbols: [] }
  }

  const main = addedFeat ?? removedFeat
  const before = removedFeat ? coordArr(removedFeat.src) : []
  const after = addedFeat ? coordArr(addedFeat.src) : []
  const { unchanged, removed, added } = classifyRuns(before, after)
  const hasShared = unchanged.length > 0

  if (type === 'area') {
    // Areas: hatched fill + fat coloured boundary outline.
    if (context && main) {
      objs.push({
        ...main.src, id: `m${nid++}`, type: 'area',
        symbolId: hasShared ? 'diff-hatch-modified' : 'diff-hatch-added',
      })
    }
    if (context) for (const run of unchanged) mk(run, 'outline-line-modified', 'line')
    for (const run of removed) mk(run, 'outline-line-removed', 'line')
    for (const run of added) mk(run, 'outline-line-added', 'line')
    return { objects: objs as MapObject[], symbols }
  }

  // Lines: render runs with the feature's REAL symbol recoloured, so an
  // edited contour keeps contour thickness (not the fat area outline).
  const baseSym = addedFeat?.symbol ?? removedFeat?.symbol
  const symFor = (feat: Feature | undefined, colorId: string): string | null => {
    if (!feat?.symbol) return null
    const clone = recolorSymbol(feat.symbol, colorId)
    symbols.push(clone)
    return String(clone.id)
  }
  const yellowId = baseSym ? symFor(main, 'modified') : null
  const removedId = symFor(removedFeat, 'removed')
  const addedId = symFor(addedFeat, 'added')
  if (context && yellowId) for (const run of unchanged) mk(run, yellowId, 'line')
  if (removedId) for (const run of removed) mk(run, removedId, 'line')
  if (addedId) for (const run of added) mk(run, addedId, 'line')
  return { objects: objs as MapObject[], symbols }
}

function coordArr(object: { coordinates?: unknown }): unknown[] {
  return Array.isArray(object.coordinates) ? object.coordinates : []
}

function boundsOfCoords(coords: unknown[]): { min: number[]; max: number[] } {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity
  for (const p of coords) {
    const x = Array.isArray(p) ? p[0] : (p as { x?: number }).x
    const y = Array.isArray(p) ? p[1] : (p as { y?: number }).y
    if (typeof x !== 'number' || typeof y !== 'number') continue
    if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y
  }
  return isFinite(a) ? { min: [a, b], max: [c, d] } : { min: [0, 0], max: [0, 0] }
}

// Classify a feature's before→after geometry into contiguous runs:
// unchanged (identical in both), removed (before only), added (after only).
// Matching is done on whole anchor-to-anchor SPANS (a bezier curve is one
// atomic span) so a run boundary never lands mid-curve — which would
// orphan control points and drop a segment when rendered.
function classifyRuns(before: unknown[], after: unknown[]): {
  unchanged: unknown[][]; removed: unknown[][]; added: unknown[][]
} {
  const unchanged: unknown[][] = []
  const removed: unknown[][] = []
  const added: unknown[][] = []
  const beforeSpans = toSpans(before)
  const afterSpans = toSpans(after)
  const beforeLeft = spanMultiset(beforeSpans)
  const afterLeft = spanMultiset(afterSpans)
  emitSpanRuns(afterSpans, s => (consumeKey(beforeLeft, spanKey(s)) ? 'u' : 'a'), { u: unchanged, a: added, r: removed })
  emitSpanRuns(beforeSpans, s => (consumeKey(afterLeft, spanKey(s)) ? 'skip' : 'r'), { u: unchanged, a: added, r: removed })
  return { unchanged, removed, added }
}

// Split coords into rings at hole points. Per panmap's convention the
// hole flag sits on the LAST coord of the previous ring, so that coord
// ends its ring and the next coord starts a fresh (hole) ring — there is
// no real edge between them.
function toRings(coords: unknown[]): unknown[][] {
  const rings: unknown[][] = []
  let cur: unknown[] = []
  for (let i = 0; i < coords.length; i++) {
    cur.push(coords[i])
    if (isFirstHolePoint(coords[i] as never) && i < coords.length - 1) {
      rings.push(cur); cur = []
    }
  }
  if (cur.length) rings.push(cur)
  return rings
}

// Split coords into anchor-to-anchor spans, per ring so a span never
// crosses a hole boundary. Bezier control points are grouped into the
// span that ends at the next anchor.
function toSpans(coords: unknown[]): unknown[][] {
  const spans: unknown[][] = []
  for (const ring of toRings(coords)) {
    if (ring.length < 2) continue
    let start = 0
    for (let i = 1; i < ring.length; i++) {
      const c = ring[i]
      const isControl = isFirstBezier(c as never) || isSecondBezier(c as never)
      if (!isControl) { spans.push(ring.slice(start, i + 1)); start = i }
    }
  }
  return spans
}

function emitSpanRuns(
  spans: unknown[][],
  classify: (span: unknown[]) => 'u' | 'a' | 'r' | 'skip',
  buckets: { u: unknown[][]; a: unknown[][]; r: unknown[][] },
): void {
  let cls: 'u' | 'a' | 'r' | null = null
  let run: unknown[] = []
  const flush = () => {
    if (cls && run.length >= 2) buckets[cls].push(run)
    cls = null; run = []
  }
  for (const span of spans) {
    const c = classify(span)
    if (c === 'skip') { flush(); continue }
    // A span continues the current run only if same class AND its start
    // anchor is the run's current end (contiguous). Ring boundaries break
    // contiguity, so hole rings become their own runs.
    const contiguous = run.length > 0 && ptKey(run[run.length - 1]) === ptKey(span[0])
    if (c !== cls || !contiguous) { flush(); cls = c; run = [...span] }
    else run.push(...span.slice(1))
  }
  flush()
}

// The vertices a geometry edit actually added / removed. Classify the
// before→after coords into runs and count anchor points (bezier control
// points aren't user-visible nodes) in the added vs removed runs. A pure
// re-symbolisation (identical geometry) yields 0/0.
function changedNodeCounts(
  before: Feature, after: Feature,
): { added: number; removed: number } {
  const runs = classifyRuns(coordArr(before.src), coordArr(after.src))
  return { added: countAnchors(runs.added), removed: countAnchors(runs.removed) }
}
function countAnchors(runs: unknown[][]): number {
  let n = 0
  for (const run of runs)
    for (const c of run)
      if (!isFirstBezier(c as never) && !isSecondBezier(c as never)) n++
  return n
}

function ptKey(p: unknown): string {
  const x = Array.isArray(p) ? p[0] : (p as { x?: number }).x ?? 0
  const y = Array.isArray(p) ? p[1] : (p as { y?: number }).y ?? 0
  return `${Math.round(x as number)},${Math.round(y as number)}`
}
// Span key is direction-independent so a reversed span still matches.
function spanKey(span: unknown[]): string {
  const fwd = span.map(ptKey).join('|')
  const rev = span.slice().reverse().map(ptKey).join('|')
  return fwd < rev ? fwd : rev
}
function spanMultiset(spans: unknown[][]): Map<string, number> {
  const m = new Map<string, number>()
  for (const s of spans) {
    const k = spanKey(s)
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}
function consumeKey(m: Map<string, number>, k: string): boolean {
  const n = m.get(k) ?? 0
  if (n <= 0) return false
  m.set(k, n - 1)
  return true
}

function featureOf(f: Feature): DiffChangeFeature {
  return {
    symbolCode: codeOf(f.symbol),
    symbolName: f.symbol?.name || '',
    type: f.type,
    count: f.count,
  }
}

function makeChange(
  kind: DiffChange['kind'],
  bounds: Rect,
  addedCount: number,
  removedCount: number,
  feats: Feature[],
  modification?: DiffChange['modification'],
): DiffChange {
  // Merge contributing features by canonical symbol code so a modified
  // pair with the same symbol reads as one line with a combined count.
  const merged = new Map<string, DiffChangeFeature>()
  for (const f of feats) {
    const key = canonCode(f.symbol)
    const existing = merged.get(key)
    if (existing) existing.count += f.count
    else
      merged.set(key, {
        symbolCode: codeOf(f.symbol),
        symbolName: f.symbol?.name || '',
        type: f.type,
        count: f.count,
      })
  }
  const change: DiffChange = {
    id: 0,
    kind,
    bounds: [...bounds] as Rect,
    addedCount,
    removedCount,
    features: [...merged.values()],
  }
  if (modification) change.modification = modification
  // For symbol / both changes, feats are [removed, added] — expose old → new.
  if ((modification === 'symbol' || modification === 'both') && feats.length === 2) {
    change.fromSymbol = featureOf(feats[0])
    change.toSymbol = featureOf(feats[1])
  }
  changeFeatures.set(change, feats)
  return change
}

// Rounded [x, y] vertices of a feature, tolerant of tuple / {x,y} shapes.
function srcCoords(object: { coordinates?: unknown }): Array<[number, number]> {
  const raw = object.coordinates
  if (!Array.isArray(raw)) return []
  const out: Array<[number, number]> = []
  for (const c of raw) {
    if (Array.isArray(c) && typeof c[0] === 'number') out.push([Math.round(c[0]), Math.round(c[1])])
    else if (c && typeof c === 'object') {
      const o = c as { x?: number; y?: number }
      if (typeof o.x === 'number') out.push([Math.round(o.x), Math.round(o.y ?? 0)])
    }
  }
  return out
}

// A precision-rounded key of a feature's coordinate sequence, for
// matching a removed feature to an added one with identical geometry.
function geomKey(object: { coordinates?: unknown }): string {
  return srcCoords(object).map(c => `${c[0]},${c[1]}`).join('|')
}

// Similarity score between a removed and added feature of the same
// symbol; > 0 means "the same feature, edited". Lines/areas score by the
// fraction of shared vertices (must exceed 50%); points/text by
// closeness (must be within `pointMoveUnits`). Higher = better match.
function matchScore(r: Feature, a: Feature, pointMoveUnits: number): number {
  if (r.type !== a.type) return 0
  const rc = srcCoords(r.src)
  const ac = srcCoords(a.src)
  if (!rc.length || !ac.length) return 0

  if (r.type === 'point' || r.type === 'text' || (rc.length === 1 && ac.length === 1)) {
    const d = Math.hypot(rc[0][0] - ac[0][0], rc[0][1] - ac[0][1])
    return d <= pointMoveUnits ? 1 - d / (pointMoveUnits + 1) : 0
  }

  // Symmetric coverage: the fraction of each feature's points lying within
  // `pointMoveUnits` of the OTHER feature's polyline (nearest segment, so
  // vertex density doesn't matter). Both directions must clear the
  // threshold; the score is the weaker direction so best-match still works.
  const cov = Math.min(
    coverage(rc, ac, pointMoveUnits),
    coverage(ac, rc, pointMoveUnits),
  )
  return cov >= COVERAGE_THRESHOLD ? cov : 0
}

// Fraction of `from` points within `d` of the `to` polyline.
function coverage(
  from: Array<[number, number]>, to: Array<[number, number]>, d: number,
): number {
  if (!from.length || !to.length) return 0
  let within = 0
  for (const p of from) {
    let best = Infinity
    if (to.length === 1) {
      best = Math.hypot(p[0] - to[0][0], p[1] - to[0][1])
    } else {
      for (let i = 1; i < to.length; i++) {
        const dist = pointToSegmentDist(p, to[i - 1], to[i])
        if (dist < best) { best = dist; if (best <= d) break }
      }
    }
    if (best <= d) within++
  }
  return within / from.length
}

function pointToSegmentDist(
  p: [number, number], a: [number, number], b: [number, number],
): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

function symbolsById(map: PanMap): Record<string | number, MapSymbol> {
  const out: Record<string | number, MapSymbol> = {}
  for (const s of map.symbols) out[s.id] = s
  return out
}

function codeOf(symbol?: MapSymbol): string {
  return symbol ? symbol.code || symbol.name || String(symbol.id) : ''
}

// Canonical key for symbol matching: numeric OCAD-style codes ("406",
// "406.0") collapse to the same integer; non-numeric codes fall back to
// the raw string. Mirrors the diff's symbolKey so pairing is consistent.
function canonCode(symbol?: MapSymbol): string {
  const code = codeOf(symbol)
  return /^\d+(\.\d+)*$/.test(code.trim()) ? `#${parseSymbolCode(code)}` : code
}

function rectOf(object: { bounds?: unknown }): Rect | null {
  const b = object.bounds as { min?: number[]; max?: number[] } | null | undefined
  if (!b || !Array.isArray(b.min) || !Array.isArray(b.max)) return null
  return [b.min[0], b.min[1], b.max[0], b.max[1]]
}

function extendRect(acc: Rect, r: Rect | null): void {
  if (!r) return
  acc[0] = Math.min(acc[0], r[0])
  acc[1] = Math.min(acc[1], r[1])
  acc[2] = Math.max(acc[2], r[2])
  acc[3] = Math.max(acc[3], r[3])
}

function unionRect(a: Rect, b: Rect): Rect {
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3]),
  ]
}


export default diffChanges
