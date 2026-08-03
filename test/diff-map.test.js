/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import test from 'ava'
import xmldom from '@xmldom/xmldom'
import {
  Map,
  diff as diffMaps,
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
        renderLayers: [{ type: 'stroke', colorId: 'black', width: 10 }],
      },
      {
        id: 'point',
        sourceId: 'point',
        code: '101.000',
        name: 'Point',
        type: 'point',
        hidden: false,
        renderLayers: [{ type: 'point-fill', colorId: 'black', radius: 10 }],
      },
      {
        id: 'text',
        sourceId: 'text',
        code: '801.000',
        name: 'Text',
        type: 'text',
        hidden: false,
        renderLayers: [{ type: 'text', colorId: 'black', fontSize: 12 }],
      },
      {
        id: 'area',
        sourceId: 'area',
        code: '401.000',
        name: 'Area',
        type: 'area',
        hidden: false,
        renderLayers: [{ type: 'fill', colorId: 'black' }],
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
