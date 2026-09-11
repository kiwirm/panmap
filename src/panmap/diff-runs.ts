/**
 * Geometry-run classification for the change differ: split a coordinate list
 * into rings and anchor-to-anchor spans, and classify a feature's before→after
 * geometry into contiguous unchanged / removed / added runs. Pure geometry —
 * no diff pairing or SVG-render state.
 */
import { isFirstBezier, isSecondBezier, isFirstHolePoint } from './coord.js'

export function coordArr(object: { coordinates?: unknown }): unknown[] {
  return Array.isArray(object.coordinates) ? object.coordinates : []
}

export function boundsOfCoords(coords: unknown[]): {
  min: number[]
  max: number[]
} {
  let a = Infinity
  let b = Infinity
  let c = -Infinity
  let d = -Infinity
  for (const p of coords) {
    const x = Array.isArray(p) ? p[0] : (p as { x?: number }).x
    const y = Array.isArray(p) ? p[1] : (p as { y?: number }).y
    if (typeof x !== 'number' || typeof y !== 'number') continue
    if (x < a) a = x
    if (y < b) b = y
    if (x > c) c = x
    if (y > d) d = y
  }
  return isFinite(a)
    ? { min: [a, b], max: [c, d] }
    : { min: [0, 0], max: [0, 0] }
}

// Classify a feature's before→after geometry into contiguous runs:
// unchanged (identical in both), removed (before only), added (after only).
// Matching is done on whole anchor-to-anchor SPANS (a bezier curve is one
// atomic span) so a run boundary never lands mid-curve — which would
// orphan control points and drop a segment when rendered.
export function classifyRuns(
  before: unknown[],
  after: unknown[],
): {
  unchanged: unknown[][]
  removed: unknown[][]
  added: unknown[][]
} {
  const unchanged: unknown[][] = []
  const removed: unknown[][] = []
  const added: unknown[][] = []
  const beforeSpans = toSpans(before)
  const afterSpans = toSpans(after)
  const beforeLeft = spanMultiset(beforeSpans)
  const afterLeft = spanMultiset(afterSpans)
  emitSpanRuns(
    afterSpans,
    s => (consumeKey(beforeLeft, spanKey(s)) ? 'u' : 'a'),
    { u: unchanged, a: added, r: removed },
  )
  emitSpanRuns(
    beforeSpans,
    s => (consumeKey(afterLeft, spanKey(s)) ? 'skip' : 'r'),
    { u: unchanged, a: added, r: removed },
  )
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
      rings.push(cur)
      cur = []
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
      if (!isControl) {
        spans.push(ring.slice(start, i + 1))
        start = i
      }
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
    cls = null
    run = []
  }
  for (const span of spans) {
    const c = classify(span)
    if (c === 'skip') {
      flush()
      continue
    }
    // A span continues the current run only if same class AND its start
    // anchor is the run's current end (contiguous). Ring boundaries break
    // contiguity, so hole rings become their own runs.
    const contiguous =
      run.length > 0 && ptKey(run[run.length - 1]) === ptKey(span[0])
    if (c !== cls || !contiguous) {
      flush()
      cls = c
      run = [...span]
    } else run.push(...span.slice(1))
  }
  flush()
}

export function countAnchors(runs: unknown[][]): number {
  let n = 0
  for (const run of runs)
    for (const c of run)
      if (!isFirstBezier(c as never) && !isSecondBezier(c as never)) n++
  return n
}

function ptKey(p: unknown): string {
  const x = Array.isArray(p) ? p[0] : ((p as { x?: number }).x ?? 0)
  const y = Array.isArray(p) ? p[1] : ((p as { y?: number }).y ?? 0)
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
