// Unit tests for the shared render-layer classifiers in
// src/panmap/render-layers.ts. Snapshot tests indirectly cover them, but
// direct fixtures lock in the bucketing contract so a future refactor
// that reshuffles the classifiers has explicit checks to break.

import test from 'ava'
import {
  classifyAreaLayers,
  classifyLineLayers,
  classifyPointLayers,
  classifyTextLayers,
  isPatternLayer,
} from '../src/panmap/render-layers.ts'

/** Build a minimal MapSymbol with just the fields the classifiers touch. */
function symbol(layers) {
  return { id: 1, sourceId: 1, type: 'area', hidden: false, layers }
}

test('classifyAreaLayers buckets by type', t => {
  const s = symbol([
    { type: 'fill', colorId: 1 },
    { type: 'stroke', colorId: 2, width: 100 },
    { type: 'stroke', colorId: 3, width: 50 },
    { type: 'hatch-fill', colorId: 4, angle: 45 },
    { type: 'hatch-fill', colorId: 4, angle: 135 },
    { type: 'structure-fill', colorId: 5, pattern: { lineSpacing: 100 } },
    { type: 'point-pattern-fill', colorId: 6, pattern: { pointDistance: 200 } },
    { type: 'border-symbol', symbolId: 42 },
    // unrelated types should be ignored
    { type: 'text', colorId: 7 },
    { type: 'double-line' },
  ])
  const buckets = classifyAreaLayers(s)
  t.is(buckets.fill?.colorId, 1)
  t.is(buckets.fills.length, 1)
  t.is(buckets.strokes.length, 2)
  t.deepEqual(buckets.strokes.map(l => l.colorId), [2, 3])
  t.is(buckets.hatches.length, 2)
  t.is(buckets.structures.length, 1)
  t.is(buckets.pointPatterns.length, 1)
  t.is(buckets.border?.symbolId, 42)
})

test('classifyAreaLayers preserves source order within each bucket', t => {
  const s = symbol([
    { type: 'stroke', colorId: 'a' },
    { type: 'stroke', colorId: 'b' },
    { type: 'stroke', colorId: 'c' },
  ])
  t.deepEqual(classifyAreaLayers(s).strokes.map(l => l.colorId), ['a', 'b', 'c'])
})

test('classifyAreaLayers only keeps the FIRST border-symbol', t => {
  const s = symbol([
    { type: 'border-symbol', symbolId: 10 },
    { type: 'border-symbol', symbolId: 20 },
  ])
  t.is(classifyAreaLayers(s).border?.symbolId, 10)
})

test('classifyAreaLayers on an empty symbol', t => {
  const buckets = classifyAreaLayers(symbol([]))
  t.is(buckets.fill, undefined)
  t.is(buckets.border, undefined)
  t.deepEqual(buckets.fills, [])
  t.deepEqual(buckets.strokes, [])
  t.deepEqual(buckets.hatches, [])
  t.deepEqual(buckets.structures, [])
  t.deepEqual(buckets.pointPatterns, [])
})

test('classifyAreaLayers tolerates missing layers', t => {
  const buckets = classifyAreaLayers({ id: 1, sourceId: 1, type: 'area', hidden: false })
  t.deepEqual(buckets.strokes, [])
  t.is(buckets.fill, undefined)
})

test('classifyLineLayers buckets by type', t => {
  const s = symbol([
    { type: 'stroke', colorId: 1 },
    { type: 'stroke', colorId: 2 },
    { type: 'double-line', fillColorId: 3 },
    { type: 'line-elements' },
    { type: 'line-symbols', lineSymbol: { dashSymbol: {} } },
    { type: 'fill' }, // ignored
  ])
  const buckets = classifyLineLayers(s)
  t.is(buckets.strokes.length, 2)
  t.is(buckets.doubleLine?.fillColorId, 3)
  t.truthy(buckets.lineElements)
  t.truthy(buckets.lineSymbols)
})

test('classifyLineLayers keeps only the first double-line / line-elements / line-symbols', t => {
  const s = symbol([
    { type: 'double-line', fillColorId: 1 },
    { type: 'double-line', fillColorId: 2 },
    { type: 'line-elements', mainLength: 100 },
    { type: 'line-elements', mainLength: 200 },
  ])
  const buckets = classifyLineLayers(s)
  t.is(buckets.doubleLine?.fillColorId, 1)
  t.is(buckets.lineElements?.mainLength, 100)
})

test('classifyPointLayers keeps the first of each', t => {
  const s = symbol([
    { type: 'point-fill', colorId: 1, radius: 100 },
    { type: 'point-fill', colorId: 2, radius: 200 },
    { type: 'point-stroke', colorId: 3, radius: 100, width: 20 },
    { type: 'point-elements', elements: [{}] },
  ])
  const buckets = classifyPointLayers(s)
  t.is(buckets.fill?.colorId, 1)
  t.is(buckets.stroke?.colorId, 3)
  t.is(buckets.elements?.elements.length, 1)
})

test('classifyPointLayers on a symbol with no point layers', t => {
  const buckets = classifyPointLayers(symbol([{ type: 'fill' }]))
  t.is(buckets.fill, undefined)
  t.is(buckets.stroke, undefined)
  t.is(buckets.elements, undefined)
})

test('classifyTextLayers returns the first text layer', t => {
  const s = symbol([
    { type: 'fill' },
    { type: 'text', colorId: 5, text: { fontFamily: 'Arial', fontSize: 30 } },
    { type: 'text', colorId: 6 }, // dropped
  ])
  const buckets = classifyTextLayers(s)
  t.is(buckets.text?.colorId, 5)
})

test('classifyTextLayers on a symbol with no text', t => {
  t.is(classifyTextLayers(symbol([{ type: 'fill' }])).text, undefined)
})

test('isPatternLayer narrows only pattern-holding types', t => {
  t.true(isPatternLayer({ type: 'structure-fill' }))
  t.true(isPatternLayer({ type: 'point-pattern-fill' }))
  t.false(isPatternLayer({ type: 'fill' }))
  t.false(isPatternLayer({ type: 'hatch-fill' }))
  t.false(isPatternLayer({ type: 'text' }))
})
