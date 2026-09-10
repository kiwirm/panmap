/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import test from 'ava'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  omap,
  read as readMap,
  write as writeMap,
  mapToGeoJson,
  Map,
} from '../src/index.ts'
import {
  readOcad,
  ocadFileToMap,
  omapFileToMap,
  readXmap,
} from './helpers/raw.js'
const writeOmap = omap.write

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const xmapXml = `<?xml version="1.0" encoding="UTF-8"?>
<map>
  <colors>
    <color priority="1" name="Black">
      <rgb method="custom" r="0" g="0" b="0" />
    </color>
    <color priority="2" name="Green">
      <rgb method="custom" r="0" g="0.5" b="0" />
    </color>
  </colors>
  <symbols>
    <symbol id="10" code="501.0" name="Path" type="2">
      <line_symbol color="1" line_width="100" />
    </symbol>
    <symbol id="20" code="401.0" name="Open land" type="3">
      <area_symbol inner_color="2" />
    </symbol>
    <symbol id="30" code="801.0" name="Label" type="4">
      <text_symbol>
        <font family="Arial" size="120" />
        <text color="1" />
      </text_symbol>
    </symbol>
  </symbols>
  <objects>
    <object type="1" symbol="10">
      <coords>
        <coord x="0" y="0" />
        <coord x="1000" y="0" />
      </coords>
    </object>
    <object type="1" symbol="20">
      <coords>
        <coord x="0" y="0" />
        <coord x="1000" y="0" />
        <coord x="1000" y="1000" />
      </coords>
    </object>
    <object type="4" symbol="30">
      <coords>
        <coord x="500" y="500" />
      </coords>
      <text>Control</text>
    </object>
  </objects>
</map>`

test('can normalize XMap file to canonical Map', async (/** @type {ExecutionContext} */ t) => {
  const xmapFile = await readXmap(xmapXml)
  const map = omapFileToMap(xmapFile)

  t.true(map instanceof Map)
  t.is(map.sourceFormat, 'xmap')
  t.is(map.sourceFile, xmapFile)
  t.is(map.colors.length, 2)
  t.is(map.symbols.length, 3)
  t.is(map.objects.length, 3)
  t.deepEqual(map.getBounds(), [0, 0, 100, 100])

  t.is(map.symbols[0].type, 'line')
  t.is(map.symbols[1].type, 'area')
  t.is(map.symbols[2].type, 'text')
  t.is(map.objects[0].type, 'line')
  t.is(map.objects[1].type, 'area')
  t.is(map.objects[2].type, 'text')
  t.is(map.objects[2].text, 'Control')
})

test('XMap symbols expose shared render layers', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(xmapXml)
  const lineSymbol = map.symbols.find(symbol => symbol.type === 'line')
  const areaSymbol = map.symbols.find(symbol => symbol.type === 'area')
  const textSymbol = map.symbols.find(symbol => symbol.type === 'text')

  // The stroke layer also carries join/cap/segment metadata needed for
  // round-trip; assert the essential fields, not the exact set.
  t.like(lineSymbol.renderLayers[0], {
    type: 'stroke',
    colorId: 1,
    width: 10,
  })
  t.deepEqual(areaSymbol.renderLayers[0], {
    type: 'fill',
    colorId: 2,
  })
  // OMap `size="120"` (1/1000 mm) reads as 0.12 mm; fontSize is in mm.
  t.like(textSymbol.renderLayers[0], {
    type: 'text',
    colorId: 1,
    fontFamily: 'Arial',
    fontSize: 0.12,
  })
  t.truthy(textSymbol.renderLayers[0].text, 'text typography sub-object present')
})

test('readMap supports XMap XML strings and buffers', async (/** @type {ExecutionContext} */ t) => {
  const fromString = await readMap(xmapXml)
  const fromBuffer = await readMap(Buffer.from(xmapXml))

  t.true(fromString instanceof Map)
  t.true(fromBuffer instanceof Map)
  t.is(fromString.sourceFormat, 'xmap')
  t.is(fromBuffer.sourceFormat, 'xmap')
  t.is(fromString.objects.length, 3)
  t.is(fromBuffer.objects.length, 3)
})

test('can convert simple XMap-backed Map to GeoJSON', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(xmapXml)
  const geoJson = mapToGeoJson(map, { applyCrs: false })

  t.is(geoJson.type, 'FeatureCollection')
  t.is(geoJson.features.length, 3)
  t.is(geoJson.features[0].geometry.type, 'LineString')
  t.is(geoJson.features[1].geometry.type, 'Polygon')
  t.is(geoJson.features[2].geometry.type, 'Point')
  t.is(geoJson.features[2].properties.text, 'Control')
})

test('can write XMap and read it back', async (/** @type {ExecutionContext} */ t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xmap-writer-'))
  const direct = path.join(tmp, 'direct.xmap')
  const dispatched = path.join(tmp, 'dispatched.xmap')
  const map = await readMap(xmapXml)

  await writeOmap(map, direct)
  await writeMap(map, dispatched)

  const xml = await fs.readFile(direct, 'utf-8')
  t.true(xml.includes('<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">'))
  t.true(xml.includes('<colors count="2">'))
  t.true(xml.includes('<barrier version="6" required="0.6.0">'))
  t.true(xml.includes('<symbols count="3" id="panmap">'))
  t.true(xml.includes('<parts count="1" current="0">'))
  t.true(xml.includes('<part name="default part">'))
  t.true(xml.includes('<objects count="3">'))
  t.true(xml.includes('<symbol type="4" id="20" code="401.0" name="Open land">'))
  t.true(xml.includes('<symbol type="8" id="30" code="801.0" name="Label">'))
  t.true(xml.includes('<area_symbol inner_color="2" min_area="0" patterns="0"/>'))

  const roundTrip = await readMap(direct)
  const dispatchedRoundTrip = await readMap(dispatched)

  t.is(roundTrip.objects.length, map.objects.length)
  t.is(roundTrip.symbols.length, map.symbols.length)
  t.is(roundTrip.colors.length, map.colors.length)
  t.deepEqual(dispatchedRoundTrip.getBounds(), map.getBounds())
})

test('XMap writer preserves dashed line symbols', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(`<?xml version="1.0" encoding="UTF-8"?>
<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">
  <colors count="1">
    <color priority="0" name="Black"><rgb method="custom" r="0" g="0" b="0" /></color>
  </colors>
  <barrier version="6" required="0.6.0">
    <symbols count="1" id="test">
      <symbol type="2" id="10" code="505.0" name="Footpath">
        <line_symbol color="0" line_width="250" dashed="true" dash_length="2000" break_length="250" />
      </symbol>
    </symbols>
  </barrier>
</map>`)

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xmap-dashed-'))
  const output = path.join(tmp, 'dashed.xmap')
  await writeOmap(map, output)
  const xml = await fs.readFile(output, 'utf-8')

  t.true(xml.includes('dashed="true"'))
  t.true(xml.includes('dash_length="2000"'))
  t.true(xml.includes('break_length="250"'))
})

test('XMap writer preserves composite line symbol borders', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(`<?xml version="1.0" encoding="UTF-8"?>
<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">
  <colors count="2">
    <color priority="18" name="Light brown"><rgb method="custom" r="0.7" g="0.45" b="0.2" /></color>
    <color priority="19" name="Black"><rgb method="custom" r="0" g="0" b="0" /></color>
  </colors>
  <barrier version="6" required="0.6.0">
    <symbols count="1" id="test">
      <symbol type="2" id="5020" code="502.0" name="Wide road">
        <combined_symbol parts="2">
          <part private="true">
            <symbol type="2">
              <line_symbol color="18" line_width="300" />
            </symbol>
          </part>
          <part private="true">
            <symbol type="2">
              <line_symbol color="-1" line_width="300">
                <borders>
                  <border color="19" width="140" shift="70"/>
                </borders>
              </line_symbol>
            </symbol>
          </part>
        </combined_symbol>
      </symbol>
    </symbols>
  </barrier>
</map>`)

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xmap-border-'))
  const output = path.join(tmp, 'border.xmap')
  await writeOmap(map, output)
  const xml = await fs.readFile(output, 'utf-8')

  t.true(xml.includes('<borders>'))
  // The writer appends default dash attrs; match the border's meaningful prefix.
  t.regex(xml, /<border color="19" width="140" shift="70"/)
})


test('XMap round-trips templates, georeferencing, notes, view, print', async (/** @type {ExecutionContext} */ t) => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">
  <colors count="1">
    <color priority="0" name="Black" c="0" m="0" y="0" k="1" opacity="1">
      <cmyk method="custom"/>
      <rgb method="custom" r="0" g="0" b="0" />
    </color>
  </colors>
  <notes>Hello, world.</notes>
  <georeferencing scale="15000" declination="3.4" grivation="-1.5">
    <projected_crs id="EPSG"><spec language="PROJ.4">+init=epsg:3006</spec><parameter>3006</parameter></projected_crs>
    <geographic_crs id="Geographic coordinates"><spec language="PROJ.4">+proj=latlong</spec></geographic_crs>
  </georeferencing>
  <templates count="1" first_front_template="0">
    <template open="true" name="overlay.gif" path="overlay.gif" relpath="overlay.gif" georef="false">
      <transformations>
        <active>0</active>
        <other_transform x="0" y="0" scale_x="1" scale_y="1" rotation="0" />
      </transformations>
    </template>
  </templates>
  <view zoom="1" rotation="0" position_x="0" position_y="0" grid="false" overprinting_simulation="false">
    <map_view zoom="1" rotation="0" position_x="0" position_y="0" />
  </view>
  <print params=""/>
  <barrier version="6" required="0.6.0">
    <symbols count="1" id="panmap">
      <symbol id="0" code="501.0" name="Path" type="2">
        <line_symbol color="0" line_width="100" />
      </symbol>
    </symbols>
    <parts count="1" current="0">
      <part name="default part">
        <objects count="0"/>
      </part>
    </parts>
  </barrier>
</map>`

  const map = await readMap(xml)

  // Round-trip via write-then-read.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xmap-rt-'))
  const output = path.join(tmp, 'rt.xmap')
  await writeOmap(map, output)
  const map2 = await readMap(output)

  t.is(map2.notes ?? '', map.notes ?? '')
  t.deepEqual(map2.extensions ?? {}, map.extensions ?? {})
  t.deepEqual(map2.georeferencing, map.georeferencing)
  t.deepEqual(map2.templates, map.templates)
  t.deepEqual(map2.view, map.view)
  t.deepEqual(map2.print, map.print)
  t.is(map2.colors.length, map.colors.length)
  t.is(map2.symbols.length, map.symbols.length)
})

