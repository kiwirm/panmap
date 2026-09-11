/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import test from 'ava'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { omap, read as readMap, write as writeMap } from '../src/index.ts'
const writeOmap = omap.write

// ------------------------------------------------------------------ helpers

async function roundTrip(map) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xmap-mut-'))
  const out = path.join(tmp, 'map.xmap')
  await writeOmap(map, out)
  return readMap(out)
}

// ------------------------------------------------------------------ fixture

const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">
  <notes>original notes</notes>
  <georeferencing scale="10000" declination="1.0" grivation="0.5">
    <projected_crs id="EPSG"><spec language="PROJ.4">+init=epsg:3006</spec><parameter>3006</parameter></projected_crs>
    <geographic_crs id="Geographic coordinates"><spec language="PROJ.4">+proj=latlong</spec></geographic_crs>
  </georeferencing>
  <colors count="4">
    <color priority="0" name="Black" c="0" m="0" y="0" k="1" opacity="1">
      <cmyk method="custom"/><rgb method="custom" r="0" g="0" b="0" />
    </color>
    <color priority="1" name="Red" c="0" m="1" y="1" k="0" opacity="1">
      <cmyk method="custom"/><rgb method="custom" r="1" g="0" b="0" />
    </color>
    <color priority="2" name="Green" c="1" m="0" y="1" k="0" opacity="1">
      <cmyk method="custom"/><rgb method="custom" r="0" g="0.5" b="0" />
    </color>
    <color priority="3" name="Blue" c="1" m="1" y="0" k="0" opacity="1">
      <cmyk method="custom"/><rgb method="custom" r="0" g="0" b="1" />
    </color>
  </colors>
  <barrier version="6" required="0.6.0">
    <symbols count="6" id="panmap">
      <symbol id="10" code="101.0" name="Contour" type="2">
        <line_symbol color="0" line_width="150" minimum_length="0" join_style="1" cap_style="0"
          start_offset="0" end_offset="0" segment_length="4000" end_length="0"
          show_at_least_one_symbol="true" minimum_mid_symbol_count="0"
          minimum_mid_symbol_count_when_closed="0" dash_length="4000" break_length="1000"
          dashes_in_group="1" in_group_break_length="500" mid_symbols_per_spot="1"
          mid_symbol_distance="0" />
      </symbol>
      <symbol id="20" code="201.0" name="Open land" type="4">
        <area_symbol inner_color="2" min_area="0" patterns="0" />
      </symbol>
      <symbol id="30" code="301.0" name="Boulder" type="1">
        <point_symbol inner_radius="100" inner_color="0" outer_width="25" outer_color="0"
          elements="0" rotatable="false" />
      </symbol>
      <symbol id="40" code="401.0" name="Label" type="8">
        <text_symbol rotatable="false">
          <font family="Arial" size="1800" bold="false" italic="false" />
          <text color="0" line_spacing="1" paragraph_spacing="0" character_spacing="0"
            kerning="false" />
          <framing mode="0" line_half_width="200" shadow_x_offset="0"
            shadow_y_offset="0" color="0" />
          <line_below on="false" color="0" width="0" distance="0" />
        </text_symbol>
      </symbol>
      <symbol id="50" code="502.0" name="Combined road" type="2">
        <line_symbol color="0" line_width="200" minimum_length="0" join_style="1" cap_style="0"
          start_offset="0" end_offset="0" segment_length="4000" end_length="0"
          show_at_least_one_symbol="true" minimum_mid_symbol_count="0"
          minimum_mid_symbol_count_when_closed="0" dash_length="4000" break_length="1000"
          dashes_in_group="1" in_group_break_length="500" mid_symbols_per_spot="1"
          mid_symbol_distance="0">
          <borders>
            <border color="1" width="100" shift="0" />
          </borders>
        </line_symbol>
      </symbol>
      <symbol id="60" code="601.0" name="Dashed line" type="2">
        <line_symbol color="3" line_width="100" minimum_length="0" join_style="1" cap_style="0"
          start_offset="0" end_offset="0" segment_length="4000" end_length="0"
          show_at_least_one_symbol="true" minimum_mid_symbol_count="0"
          minimum_mid_symbol_count_when_closed="0" dashed="true" dash_length="600"
          break_length="250" dashes_in_group="1" in_group_break_length="500"
          mid_symbols_per_spot="1" mid_symbol_distance="0" />
      </symbol>
    </symbols>
    <parts count="1" current="0">
      <part name="default part">
        <objects count="7">
          <object type="1" symbol="10">
            <coords count="4">
              <coord x="-1000" y="0" flags="0"/>
              <coord x="0" y="1000" flags="0"/>
              <coord x="1000" y="0" flags="0"/>
              <coord x="0" y="-1000" flags="0"/>
            </coords>
          </object>
          <object type="1" symbol="20">
            <coords count="4">
              <coord x="-500" y="-500" flags="0"/>
              <coord x="500" y="-500" flags="0"/>
              <coord x="500" y="500" flags="0"/>
              <coord x="-500" y="500" flags="0"/>
            </coords>
          </object>
          <object type="0" symbol="30">
            <coords count="1">
              <coord x="0" y="0" flags="0"/>
            </coords>
          </object>
          <object type="4" symbol="40" rotation="0.523599" h_align="1" v_align="2">
            <coords count="1">
              <coord x="200" y="200" flags="0"/>
            </coords>
            <size width="500" height="200" />
            <text>Summit</text>
          </object>
          <object type="1" symbol="50">
            <coords count="2">
              <coord x="-200" y="0" flags="0"/>
              <coord x="200" y="0" flags="0"/>
            </coords>
          </object>
          <object type="1" symbol="60">
            <coords count="2">
              <coord x="-300" y="100" flags="0"/>
              <coord x="300" y="100" flags="0"/>
            </coords>
          </object>
          <object type="4" symbol="40">
            <coords count="1">
              <coord x="-100" y="-200" flags="0"/>
            </coords>
            <pattern rotation="1.5707963">
              <coord x="10" y="20" />
            </pattern>
            <text>Cliff base</text>
          </object>
        </objects>
      </part>
    </parts>
  </barrier>
</map>`

// ------------------------------------------------------------------ tests

test('canonical symbol fields survive omap round-trip', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(FIXTURE_XML)

  // Mutate canonical Map fields on every symbol
  map.symbols[0].name = 'Contour MODIFIED'
  map.symbols[0].code = '101.1'
  map.symbols[1].name = 'Open land MODIFIED'
  map.symbols[2].name = 'Boulder MODIFIED'

  const rt = await roundTrip(map)
  t.is(rt.symbols[0].name, 'Contour MODIFIED')
  t.is(rt.symbols[0].code, '101.1')
  t.is(rt.symbols[1].name, 'Open land MODIFIED')
  t.is(rt.symbols[2].name, 'Boulder MODIFIED')
})

test('line symbol body preserved after name mutation', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(FIXTURE_XML)
  map.symbols[0].name = 'Renamed'

  const rt = await roundTrip(map)
  const xml = await fs.readFile(
    await (async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xmap-body-'))
      const out = path.join(tmp, 'map.xmap')
      await writeOmap(map, out)
      return out
    })(),
    'utf-8',
  )
  // The raw line_symbol body must still be present — no fallback to the
  // stripped-down synthetic line_symbol encoder.
  t.true(xml.includes('line_width="150"'), 'line_width preserved')
  t.true(xml.includes('name="Renamed"'), 'name updated')
})

test('dashed line symbol body preserved', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(FIXTURE_XML)
  map.symbols[5].name = 'Dashed MODIFIED'

  const rt = await roundTrip(map)
  t.is(rt.symbols[5].name, 'Dashed MODIFIED')

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xmap-dash-'))
  const out = path.join(tmp, 'map.xmap')
  await writeOmap(map, out)
  const xml = await fs.readFile(out, 'utf-8')
  t.true(xml.includes('dashed="true"'), 'dashed attribute preserved')
})

test('line symbol with border body preserved', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(FIXTURE_XML)
  map.symbols[4].name = 'Road MODIFIED'

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'xmap-border-'))
  const out = path.join(tmp, 'map.xmap')
  await writeOmap(map, out)
  const xml = await fs.readFile(out, 'utf-8')
  t.true(xml.includes('<border'), 'border preserved')
  t.true(xml.includes('name="Road MODIFIED"'))
})

test('canonical object fields survive omap round-trip', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(FIXTURE_XML)

  const textObj = map.objects.find(o => o.text === 'Summit')
  t.truthy(textObj, 'found Summit text object')
  textObj.text = 'Summit MODIFIED'
  textObj.rotation = 1.0

  const lineObj = map.objects.find(
    o => o.type === 'line' && o.coordinates?.length === 4,
  )
  // Move the first coord
  lineObj.coordinates[0][0] = -2000

  const rt = await roundTrip(map)
  const rtText = rt.objects.find(o => o.text === 'Summit MODIFIED')
  t.truthy(rtText, 'text mutation survived')
  t.is(rtText.rotation, 1.0)

  const rtLine = rt.objects.find(
    o => o.type === 'line' && o.coordinates?.length === 4,
  )
  t.is(rtLine.coordinates[0][0], -2000, 'coord mutation survived')
})

test('object hAlign/vAlign preserved through round-trip', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(FIXTURE_XML)
  const textObj = map.objects.find(o => o.text === 'Summit')

  const rt = await roundTrip(map)
  const rtText = rt.objects.find(o => o.text === 'Summit')
  t.truthy(rtText)
  t.is(rtText.hAlign, 1)
  t.is(rtText.vAlign, 2)
})

test('object textBox (size) preserved through round-trip', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(FIXTURE_XML)
  const rt = await roundTrip(map)
  const rtText = rt.objects.find(o => o.text === 'Summit')
  t.truthy(rtText)
  t.truthy(rtText.textBox, 'textBox field preserved')
})

test('pattern object preserved through round-trip', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(FIXTURE_XML)
  const patternObj = map.objects.find(o => o.text === 'Cliff base')
  t.truthy(patternObj, 'found pattern text object')

  const rt = await roundTrip(map)
  const rtPatternObj = rt.objects.find(o => o.text === 'Cliff base')
  t.truthy(rtPatternObj)
  t.truthy(rtPatternObj.pattern, 'pattern preserved')
})

test('georeferencing and notes preserved when symbols mutated', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(FIXTURE_XML)
  map.symbols[0].name = 'Mutated'

  const rt = await roundTrip(map)
  t.truthy(rt.georeferencing, 'georeferencing still present')
  t.truthy(rt.notes, 'notes still present')
})

test('hidden objects omitted from omap output', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(FIXTURE_XML)
  const lineObjs = map.objects.filter(o => o.type === 'line')
  t.true(lineObjs.length > 0)
  lineObjs[0].hidden = true

  const rt = await roundTrip(map)
  t.is(rt.objects.filter(o => o.type === 'line').length, lineObjs.length - 1)
})

test('adding a new object to a xmap-sourced map survives round-trip', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(FIXTURE_XML)
  const originalCount = map.objects.length

  map.objects.push({
    id: 9999,
    symbolId: map.symbols[0].id,
    type: 'line',
    coordinates: [
      [-100, 0],
      [100, 0],
    ],
    hidden: false,
    text: '',
    rotation: 0,
  })

  const rt = await roundTrip(map)
  t.is(rt.objects.length, originalCount + 1)
})
