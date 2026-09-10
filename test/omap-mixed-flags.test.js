// Guards against the C2 finding: coordinatesForXMap early-returns as soon
// as any coord carries omapFlags/flags, silently dropping the ocad→xmap
// flag translation for OCAD-flagged coords in a mixed-source Map.
//
// This test constructs a synthetic MapObject whose coord array carries a
// mixture of styles and asserts the emitted <coord> flags line up with
// the source flags of each coord individually.

import test from 'ava'
import Panmap from '../src/panmap/model.ts'
import { mapToOmapXml } from "./helpers/omap.js"

function makeCoord(x, y, extras) {
  const c = [x, y]
  Object.assign(c, extras)
  return c
}

function extractCoordFlags(xml) {
  // Returns the ordered list of numeric `flags` attribute values from each
  // <coord> element under the first <object>. Coords without a flags attr
  // become `null`.
  const objMatch = /<object[^>]*>[\s\S]*?<coords[^>]*>([\s\S]*?)<\/coords>/.exec(xml)
  if (!objMatch) return []
  const coordsSection = objMatch[1]
  const results = []
  const re = /<coord\b([^/]*)\/>/g
  let m
  while ((m = re.exec(coordsSection))) {
    const flagsMatch = /\bflags="(-?\d+)"/.exec(m[1])
    results.push(flagsMatch ? Number(flagsMatch[1]) : null)
  }
  return results
}

function synthMap(coordinates) {
  return new Panmap({
    sourceFormat: 'test',
    colors: [{ id: 0, sourceId: 0, name: 'black', rgb: 'rgb(0,0,0)', renderOrder: 0 }],
    symbols: [
      { id: 1, sourceId: 1, type: 'line', hidden: false, layers: [
        { type: 'stroke', colorId: 0, width: 10 },
      ] },
    ],
    objects: [
      { id: 'obj1', symbolId: 1, type: 'line', coordinates, hidden: false },
    ],
  })
}

test('coordinatesForXMap: xmap-only flag style', async t => {
  const map = synthMap([
    makeCoord(0, 0),
    makeCoord(10, 10, { flags: 0x20 }),
    makeCoord(20, 20),
  ])
  const xml = await mapToOmapXml(map)
  t.deepEqual(extractCoordFlags(xml), [null, 32, null])
})

test('coordinatesForXMap: ocad-only flag style is translated', async t => {
  // Bezier first-control-point marker (xFlags & 0x01) on the second coord
  // should shift onto index-1 as `flags |= 0x01` in xmap output.
  const map = synthMap([
    makeCoord(0, 0, { xFlags: 0, yFlags: 0 }),
    makeCoord(10, 10, { xFlags: 0x01, yFlags: 0 }),
    makeCoord(20, 20, { xFlags: 0, yFlags: 0 }),
  ])
  const xml = await mapToOmapXml(map)
  const flags = extractCoordFlags(xml)
  t.true((flags[0] ?? 0) === 0x01,
    `expected coord[0] flags to have bit 0x01 set (got ${flags[0]})`)
})

test('coordinatesForXMap: mixed sources — both styles honoured', async t => {
  // Coords 0,1 use xmap-style (flags directly); coords 2,3 use ocad-style
  // (xFlags/yFlags). Neither should suppress the other.
  const map = synthMap([
    makeCoord(0, 0),                                    // xmap: no flags
    makeCoord(10, 10, { flags: 0x20 }),                  // xmap: 0x20
    makeCoord(20, 20, { xFlags: 0, yFlags: 0 }),         // ocad: no flags
    makeCoord(30, 30, { xFlags: 0, yFlags: 0x08 }),      // ocad: dash bit → 0x20 in xmap
  ])
  const xml = await mapToOmapXml(map)
  const flags = extractCoordFlags(xml)
  t.is(flags[1], 0x20, 'xmap-style flags on coord[1] preserved')
  t.true((flags[3] ?? 0) === 0x20,
    `expected ocad-style coord[3] to have translated 0x20 (got ${flags[3]})`)
})
