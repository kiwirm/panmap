/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import test from 'ava'
import xmldom from '@xmldom/xmldom'
import {
  Map,
  diff as diffMaps,
  diffChanges,
  diffMapsToSvg,
  mapToSvg,
} from '../src/index.ts'

const serializer = new xmldom.XMLSerializer()

function makeMap(objects) {
  return new Map({
    sourceFormat: 'test',
    colors: [],
    symbols: [
      {
        id: 'road',
        sourceId: 'road',
        code: '501.000',
        name: 'Road',
        type: 'line',
        hidden: false,
        layers: [{ type: 'stroke', colorId: 'black', width: 10 }],
      },
      {
        id: 'point',
        sourceId: 'point',
        code: '101.000',
        name: 'Point',
        type: 'point',
        hidden: false,
        layers: [{ type: 'point-fill', colorId: 'black', radius: 10 }],
      },
      {
        id: 'text',
        sourceId: 'text',
        code: '801.000',
        name: 'Text',
        type: 'text',
        hidden: false,
        layers: [{ type: 'text', colorId: 'black', fontSize: 12 }],
      },
      {
        id: 'area',
        sourceId: 'area',
        code: '401.000',
        name: 'Area',
        type: 'area',
        hidden: false,
        layers: [{ type: 'fill', colorId: 'black' }],
      },
    ],
    objects,
  })
}

function makeOcadMap(objects) {
  const map = makeMap(objects)
  map.sourceFormat = 'ocad'
  return map
}

test('diffMaps emits line segment-level additions and removals', (/** @type {ExecutionContext} */ t) => {
  const before = makeMap([
    {
      id: 'before-line',
      symbolId: 'road',
      type: 'line',
      coordinates: [
        [0, 0],
        [10, 0],
        [20, 0],
      ],
      hidden: false,
      bounds: { min: [0, 0], max: [20, 0] },
    },
  ])
  const after = makeMap([
    {
      id: 'after-line',
      symbolId: 'road',
      type: 'line',
      coordinates: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      hidden: false,
      bounds: { min: [0, 0], max: [10, 10] },
    },
  ])

  const diff = diffMaps(before, after)

  t.is(diff.objects.length, 2)
  t.deepEqual(diff.objects.map(object => object.diffKind).sort(), [
    'added',
    'removed',
  ])
  t.deepEqual(
    diff.objects.find(object => object.diffKind === 'removed').coordinates,
    [
      [10, 0],
      [20, 0],
    ]
  )
  t.deepEqual(
    diff.objects.find(object => object.diffKind === 'added').coordinates,
    [
      [10, 0],
      [10, 10],
    ]
  )
})

test('diffMaps compares points and areas as whole objects', (/** @type {ExecutionContext} */ t) => {
  const before = makeMap([
    {
      id: 'before-point',
      symbolId: 'point',
      type: 'point',
      coordinates: [[0, 0]],
      hidden: false,
      bounds: { min: [0, 0], max: [0, 0] },
    },
    {
      id: 'same-area',
      symbolId: 'area',
      type: 'area',
      coordinates: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      hidden: false,
      bounds: { min: [0, 0], max: [10, 10] },
    },
  ])
  const after = makeMap([
    {
      id: 'after-point',
      symbolId: 'point',
      type: 'point',
      coordinates: [[5, 0]],
      hidden: false,
      bounds: { min: [5, 0], max: [5, 0] },
    },
    {
      id: 'same-area',
      symbolId: 'area',
      type: 'area',
      coordinates: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      hidden: false,
      bounds: { min: [0, 0], max: [10, 10] },
    },
  ])

  const diff = diffMaps(before, after)

  t.is(diff.objects.length, 2)
  t.true(diff.objects.every(object => object.type === 'point'))
  t.deepEqual(diff.objects.map(object => object.diffKind).sort(), [
    'added',
    'removed',
  ])
})

test('diffMapsToSvg renders added and removed geometry in green and red', (/** @type {ExecutionContext} */ t) => {
  const before = makeMap([
    {
      id: 'before-line',
      symbolId: 'road',
      type: 'line',
      coordinates: [
        [0, 0],
        [10, 0],
      ],
      hidden: false,
      bounds: { min: [0, 0], max: [10, 0] },
    },
  ])
  const after = makeMap([
    {
      id: 'after-line',
      symbolId: 'road',
      type: 'line',
      coordinates: [
        [0, 0],
        [0, 10],
      ],
      hidden: false,
      bounds: { min: [0, 0], max: [0, 10] },
    },
  ])

  const svg = diffMapsToSvg(before, after)
  const xml = serializer.serializeToString(svg)

  t.true(xml.includes('rgb(220, 38, 38)'))
  t.true(xml.includes('rgb(22, 163, 74)'))
  t.is((xml.match(/<path\b/g) || []).length, 2)
})

test('diff map can include low opacity unchanged geometry', (/** @type {ExecutionContext} */ t) => {
  const before = makeMap([
    {
      id: 'same-line',
      symbolId: 'road',
      type: 'line',
      coordinates: [
        [0, 0],
        [10, 0],
      ],
      hidden: false,
      bounds: { min: [0, 0], max: [10, 0] },
    },
  ])
  const after = makeMap([
    {
      id: 'same-line',
      symbolId: 'road',
      type: 'line',
      coordinates: [
        [0, 0],
        [10, 0],
      ],
      hidden: false,
      bounds: { min: [0, 0], max: [10, 0] },
    },
  ])

  const diff = diffMaps(before, after, { includeUnchanged: true })
  const svg = mapToSvg(diff)
  const xml = serializer.serializeToString(svg)

  t.is(diff.objects.length, 1)
  t.is(diff.objects[0].diffKind, 'unchanged')
  t.true(xml.includes('opacity="0.18"'))
})

test('diffMaps can normalize coordinates before comparison', (/** @type {ExecutionContext} */ t) => {
  const before = makeMap([
    {
      id: 'before-line',
      symbolId: 'road',
      type: 'line',
      coordinates: [
        [0, -10],
        [10, -10],
      ],
      hidden: false,
      bounds: { min: [0, -10], max: [10, -10] },
    },
  ])
  const after = makeMap([
    {
      id: 'after-line',
      symbolId: 'road',
      type: 'line',
      coordinates: [
        [0, 10],
        [10, 10],
      ],
      hidden: false,
      bounds: { min: [0, 10], max: [10, 10] },
    },
  ])

  t.is(diffMaps(before, after).objects.length, 2)

  const normalized = diffMaps(before, after, {
    beforeCoordinateTransform: coord => [coord[0], -coord[1]],
  })

  t.is(normalized.objects.length, 0)
})

test('diffMaps can compare with a coordinate tolerance', (/** @type {ExecutionContext} */ t) => {
  const before = makeMap([
    {
      id: 'before-line',
      symbolId: 'road',
      type: 'line',
      coordinates: [
        [0, 0],
        [10, 0],
      ],
      hidden: false,
      bounds: { min: [0, 0], max: [10, 0] },
    },
  ])
  const after = makeMap([
    {
      id: 'after-line',
      symbolId: 'road',
      type: 'line',
      coordinates: [
        [1, 0],
        [11, 0],
      ],
      hidden: false,
      bounds: { min: [1, 0], max: [11, 0] },
    },
  ])

  t.is(diffMaps(before, after).objects.length, 2)
  t.is(diffMaps(before, after, { coordinateTolerance: 10 }).objects.length, 0)
})

test('diffMaps compares text by anchor and content, not text box extent', (/** @type {ExecutionContext} */ t) => {
  const before = makeMap([
    {
      id: 'before-text',
      symbolId: 'text',
      type: 'text',
      text: 'Road name',
      coordinates: [
        [0, 0],
        [0, -20],
        [100, -20],
        [100, 80],
      ],
      hidden: false,
      bounds: { min: [0, -20], max: [100, 80] },
    },
  ])
  const after = makeMap([
    {
      id: 'after-text',
      symbolId: 'text',
      type: 'text',
      text: 'Road name',
      coordinates: [
        [0, 0],
        [0, -20],
        [100, -20],
        [100, 100],
      ],
      hidden: false,
      bounds: { min: [0, -20], max: [100, 100] },
    },
  ])

  t.is(diffMaps(before, after).objects.length, 0)
})

test('diffMaps matches symbols across OMap/OCAD code formats (101 vs 101.0)', (/** @type {ExecutionContext} */ t) => {
  // Same physical symbol, formatted differently by source: OMap drops
  // the trailing sub ("101"), OCAD keeps it ("101.0"). Identical
  // geometry should diff to nothing rather than a full add/remove.
  const coords = [
    [0, 0],
    [10, 0],
    [20, 0],
  ]
  const mapWithCode = code =>
    new Map({
      sourceFormat: 'test',
      colors: [],
      symbols: [
        {
          id: `sym_${code}`,
          sourceId: `sym_${code}`,
          code,
          name: 'Contour',
          type: 'line',
          hidden: false,
          layers: [{ type: 'stroke', colorId: 'brown', width: 10 }],
        },
      ],
      objects: [
        {
          id: `line-${code}`,
          symbolId: `sym_${code}`,
          type: 'line',
          coordinates: coords,
          hidden: false,
          bounds: { min: [0, 0], max: [20, 0] },
        },
      ],
    })

  const before = mapWithCode('101') // OMap-sourced
  const after = mapWithCode('101.0') // OCAD-sourced

  t.is(diffMaps(before, after).objects.length, 0)
})

test('diffChanges reports per-feature changes and pairs modified across code formats', (/** @type {ExecutionContext} */ t) => {
  const lineSym = (code) => ({
    id: `sym_${code}`,
    sourceId: `sym_${code}`,
    code,
    name: 'Contour',
    type: 'line',
    hidden: false,
    layers: [{ type: 'stroke', colorId: 'brown', width: 10 }],
  })
  const ptSym = (code, name) => ({
    id: `sym_${code}`,
    sourceId: `sym_${code}`,
    code,
    name,
    type: 'point',
    hidden: false,
    layers: [{ type: 'point-fill', colorId: 'black', radius: 10 }],
  })
  const line = (code, coords) => ({
    id: `line-${code}`,
    symbolId: `sym_${code}`,
    type: 'line',
    coordinates: coords,
    hidden: false,
    bounds: {
      min: [Math.min(...coords.map(c => c[0])), Math.min(...coords.map(c => c[1]))],
      max: [Math.max(...coords.map(c => c[0])), Math.max(...coords.map(c => c[1]))],
    },
  })
  const point = (code, xy) => ({
    id: `pt-${code}`,
    symbolId: `sym_${code}`,
    type: 'point',
    coordinates: [xy],
    hidden: false,
    bounds: { min: xy, max: xy },
  })

  // Moved contour (same symbol, OMap "101" vs OCAD "101.0", overlapping)
  // + a removed-only point + an added-only point.
  const before = new Map({
    sourceFormat: 'test',
    colors: [],
    symbols: [lineSym('101'), ptSym('301', 'Boulder')],
    objects: [
      line('101', [[0, 0], [10, 0], [20, 0]]),
      point('301', [100, 100]),
    ],
  })
  const after = new Map({
    sourceFormat: 'test',
    colors: [],
    symbols: [lineSym('101.0'), ptSym('201', 'Pit')],
    objects: [
      line('101.0', [[0, 0], [10, 0], [20, 5]]),
      point('201', [-100, -100]),
    ],
  })

  const { changes } = diffChanges(before, after)
  const byKind = changes.reduce((m, c) => ({ ...m, [c.kind]: (m[c.kind] || 0) + 1 }), {})

  t.is(changes.length, 3)
  t.is(byKind.modified, 1)
  t.is(byKind.added, 1)
  t.is(byKind.removed, 1)
  const modified = changes.find(c => c.kind === 'modified')
  t.true(modified.addedCount > 0 && modified.removedCount > 0)
  t.is(modified.features[0].symbolName, 'Contour')
})

test('diffChanges distinguishes symbol changes from geometry changes', (/** @type {ExecutionContext} */ t) => {
  const lineSym = code => ({
    id: `sym_${code}`, sourceId: `sym_${code}`, code, name: `Sym ${code}`,
    type: 'line', hidden: false,
    layers: [{ type: 'stroke', colorId: 'black', width: 10 }],
  })
  const line = (code, id, coords) => ({
    id, symbolId: `sym_${code}`, type: 'line', coordinates: coords, hidden: false,
    bounds: {
      min: [Math.min(...coords.map(c => c[0])), Math.min(...coords.map(c => c[1]))],
      max: [Math.max(...coords.map(c => c[0])), Math.max(...coords.map(c => c[1]))],
    },
  })
  const coords = [[0, 0], [10, 0], [20, 0]]
  // Same geometry, different symbol → a symbol change.
  const before = new Map({
    sourceFormat: 'test', colors: [],
    symbols: [lineSym('505'), lineSym('507')],
    objects: [line('505', 'a', coords), line('507', 'b', [[100, 0], [110, 0], [120, 0], [130, 0]])],
  })
  const after = new Map({
    sourceFormat: 'test', colors: [],
    symbols: [lineSym('506'), lineSym('507')],
    // 'a' re-symbolised 505→506 (same coords); 'b' edited but keeps a
    // majority of its vertices (same symbol 507) → a geometry change.
    objects: [line('506', 'a2', coords), line('507', 'b2', [[100, 0], [110, 0], [120, 0], [130, 40]])],
  })

  const { changes } = diffChanges(before, after)
  const symbolChange = changes.find(c => c.modification === 'symbol')
  const geomChange = changes.find(c => c.modification === 'geometry')

  t.truthy(symbolChange)
  t.is(symbolChange.fromSymbol.symbolCode, '505')
  t.is(symbolChange.toSymbol.symbolCode, '506')
  t.truthy(geomChange)
})

test('diffChanges reports a reclassified + reshaped line as a "both" change', (/** @type {ExecutionContext} */ t) => {
  const lineSym = code => ({
    id: `sym_${code}`, sourceId: `sym_${code}`, code, name: `Sym ${code}`,
    type: 'line', hidden: false,
    layers: [{ type: 'stroke', colorId: 'black', width: 10 }],
  })
  const line = (code, id, coords) => ({
    id, symbolId: `sym_${code}`, type: 'line', coordinates: coords, hidden: false,
    bounds: {
      min: [Math.min(...coords.map(c => c[0])), Math.min(...coords.map(c => c[1]))],
      max: [Math.max(...coords.map(c => c[0])), Math.max(...coords.map(c => c[1]))],
    },
  })
  // Same feature: symbol 505→507 AND the last vertex moved (majority of
  // vertices shared → coverage matches; symbol differs).
  const before = new Map({ sourceFormat: 'test', colors: [], symbols: [lineSym('505')], objects: [line('505', 'a', [[0, 0], [10, 0], [20, 0], [30, 0]])] })
  const after = new Map({ sourceFormat: 'test', colors: [], symbols: [lineSym('507')], objects: [line('507', 'b', [[0, 0], [10, 0], [20, 0], [30, 30]])] })

  const { changes } = diffChanges(before, after)
  t.is(changes.length, 1)
  t.is(changes[0].modification, 'both')
  t.is(changes[0].fromSymbol.symbolCode, '505')
  t.is(changes[0].toSymbol.symbolCode, '507')
})

test('diffChanges renders an edited area with a hole without crossing rings', (/** @type {ExecutionContext} */ t) => {
  const areaSym = code => ({
    id: `sym_${code}`, sourceId: `sym_${code}`, code, name: 'Forest',
    type: 'area', hidden: false,
    layers: [{ type: 'fill', colorId: 'green' }],
  })
  // Outer ring (last coord flags the hole) + hole ring. Edit one outer
  // vertex between before/after; the hole is unchanged. Array coords with
  // flag props, matching real gitmap-read geometry.
  const holePt = () => { const c = [0, 100]; c.yFlags = 2; return c }
  const outer = extra => [[0, 0], [100, 0], extra, holePt()]
  const hole = [[30, 30], [60, 30], [45, 60]]
  const area = extra => ({
    id: `a-${extra[0]}`, symbolId: 'sym_406', type: 'area',
    coordinates: [...outer(extra), ...hole], hidden: false,
    bounds: { min: [0, 0], max: [120, 120] },
  })
  const before = new Map({ sourceFormat: 'test', colors: [], symbols: [areaSym('406')], objects: [area([100, 100])] })
  const after = new Map({ sourceFormat: 'test', colors: [], symbols: [areaSym('406')], objects: [area([120, 120])] })

  const { changes } = diffChanges(before, after, {}, { renderSvg: true })
  t.is(changes.length, 1)
  t.is(changes[0].kind, 'modified')
  t.is(changes[0].modification, 'geometry')
  // The hole (30,30)-(60,30)-(45,60) is unchanged, so its vertices must
  // survive in the rendered SVG (not dropped by a cross-ring merge).
  t.true(changes[0].svg.includes('45') && changes[0].svg.includes('60'))
})

test('diffMaps keeps canonical coordinates and SVG export orients OCAD diffs', (/** @type {ExecutionContext} */ t) => {
  const before = makeOcadMap([
    {
      id: 'before-line',
      symbolId: 'road',
      type: 'line',
      coordinates: [
        [0, -10],
        [10, -10],
      ],
      hidden: false,
      bounds: { min: [0, -10], max: [10, -10] },
    },
  ])
  const after = makeOcadMap([])

  const diff = diffMaps(before, after)
  const svg = mapToSvg(diff)
  const xml = serializer.serializeToString(svg)

  t.deepEqual(diff.objects[0].coordinates, [
    [0, -10],
    [10, -10],
  ])
  t.true(xml.includes('M 0 10 L 10 10'))
})
