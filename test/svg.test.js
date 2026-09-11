/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import test from 'ava'
import kinks from '@turf/kinks'
import { ocad, mapToSvg } from '../src/index.ts'
import { fixtureFile } from './helpers/fixtures.js'

async function readOcadMap(fixture) {
  return ocad.read(fixtureFile(fixture))
}

// Was `.failing`: OCAD-sourced area holes were off by one coord (the hole-flag
// codec bug — the OCD reader lacked the inverse of the writer's forward shift),
// so the SVG ring splitter cut at the wrong boundary and holes crossed the
// outer ring, producing self-intersections. Fixed by shiftHoleFlagsFromOcad.
test('renders house with offset outline without kinks', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcadMap('myggfritt_byggnad2.ocd')
  const svgDoc = mapToSvg(map)
  const mainGroup = /** @type {Element} */ (svgDoc.childNodes[1])
  t.is(mainGroup.tagName, 'g')

  const paths = Array.from(mainGroup.childNodes)
    .filter(n => n.nodeType === 1)
    .map(n => /** @type {Element} */ (n))
    .filter(n => n.tagName === 'path')

  for (const p of paths) {
    const pathStr = p.getAttribute('d') || ''
    const coordMatches = pathStr.matchAll(/(\w) ([-\d.]+ [-\d.]+)/g)
    /** @type {number[][]} */
    let currentRing = []
    const rings = []
    for (const coordMatch of coordMatches) {
      const c = coordMatch[2].split(' ').map(Number)
      if (coordMatch[1] === 'M') {
        currentRing = [c]
        rings.push(currentRing)
      } else {
        currentRing.push(c)
      }
    }
    /** @type {import('geojson').Polygon} */
    const geometry = { type: 'Polygon', coordinates: rings }
    const pathKinks = kinks(geometry)
    t.is(pathKinks.features.length, 0)
  }
})
