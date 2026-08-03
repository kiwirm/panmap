/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import path from 'node:path'
import { readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'ava'
import xmldom from '@xmldom/xmldom'
import kinks from '@turf/kinks'
import { ocad, mapToSvg } from '../src/index.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DOMImplementation = new xmldom.DOMImplementation()

async function readOcadMap(fixture) {
  return ocad.read(path.join(__dirname, 'data', fixture))
}

test.failing('renders house with offset outline without kinks', async (/** @type {ExecutionContext} */ t) => {
  const map = await readOcadMap('myggfritt_byggnad2.ocd')
  const svgDoc = mapToSvg(map, {
    document: DOMImplementation.createDocument(null, 'xml', null),
  })
  const mainGroup = /** @type {Element} */ (svgDoc.childNodes[1])
  t.is('g', mainGroup.tagName)

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
    t.is(0, pathKinks.features.length)
  }
})

test('can open all local test maps', async (/** @type {ExecutionContext} */ t) => {
  const localDir = path.join(__dirname, 'data', 'local')
  if (!existsSync(localDir)) {
    console.warn('No local test maps found in ', localDir)
    t.pass()
    return
  }
  const files = readdirSync(localDir).filter(f => f.endsWith('.ocd'))
  for (const file of files) {
    try {
      const map = await ocad.read(path.join(localDir, file))
      t.truthy(map)
      t.truthy(
        mapToSvg(map, {
          document: DOMImplementation.createDocument(null, 'xml', null),
        })
      )
    } catch (e) {
      console.error(`Failed to read ${file}: ${e}`)
      throw e
    }
  }
})
