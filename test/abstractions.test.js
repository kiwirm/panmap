/**
 * Tests for the three canonical Map abstractions that cover fields both
 * OCAD and XMap carry natively:
 *
 *   1. MapColor.cmyk + opacity
 *   2. MapObject.objectString + objectStringType
 *   3. TextTypography on the 'text' RenderLayer
 */

/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import test from 'ava'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ocad, omap, read as readMap, write as writeMap } from '../src/index.ts'
const readOcad = ocad.readRaw
const writeOmap = omap.write

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// --------------------------------------------------------------------------
// helpers

async function xmapRoundTrip(map) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'abs-'))
  const out = path.join(tmp, 'map.xmap')
  await writeOmap(map, out)
  return readMap(out)
}

// --------------------------------------------------------------------------
// 1. CMYK + opacity

test('OCAD colors carry canonical cmyk and opacity', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(path.join(__dirname, 'data', 'basic-1.ocd'))
  const nonNull = map.colors.filter(Boolean)
  t.true(nonNull.length > 0, 'has colors')
  for (const color of nonNull) {
    t.truthy(color.cmyk, `color ${color.name} has cmyk`)
    t.is(color.cmyk.length, 4, 'cmyk is 4-tuple')
    t.true(
      color.cmyk.every(v => v >= 0 && v <= 1),
      `cmyk values in [0,1] for ${color.name}`
    )
    if (color.opacity !== undefined) {
      t.true(color.opacity >= 0 && color.opacity <= 1, 'opacity in [0,1]')
    }
  }
})

const XMAP_COLORS = `<?xml version="1.0" encoding="UTF-8"?>
<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">
  <colors count="3">
    <color priority="0" name="Black" c="0" m="0" y="0" k="1" opacity="1">
      <cmyk method="custom"/><rgb method="custom" r="0" g="0" b="0" />
    </color>
    <color priority="1" name="Red" c="0" m="1" y="1" k="0" opacity="0.8">
      <cmyk method="custom"/><rgb method="custom" r="1" g="0" b="0" />
    </color>
    <color priority="2" name="Green" c="1" m="0" y="1" k="0" opacity="1">
      <cmyk method="custom"/><rgb method="custom" r="0" g="0.5" b="0" />
    </color>
  </colors>
  <barrier version="6" required="0.6.0">
    <symbols count="0" id="x"></symbols>
    <parts count="1" current="0"><part name="default part"><objects count="0"/></part></parts>
  </barrier>
</map>`

test('XMap colors carry canonical cmyk and opacity', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(XMAP_COLORS)
  const black = map.colors.find(c => c?.name === 'Black')
  const red = map.colors.find(c => c?.name === 'Red')
  t.truthy(black?.cmyk, 'Black has cmyk')
  t.deepEqual(black.cmyk, [0, 0, 0, 1])
  t.is(black.opacity, 1)
  t.deepEqual(red.cmyk, [0, 1, 1, 0])
  t.is(red.opacity, 0.8)
})

test('CMYK survives omap round-trip', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(XMAP_COLORS)
  const rt = await xmapRoundTrip(map)
  const rtBlack = rt.colors.find(c => c?.name === 'Black')
  const rtRed = rt.colors.find(c => c?.name === 'Red')
  t.truthy(rtBlack?.cmyk)
  t.deepEqual(rtBlack.cmyk, [0, 0, 0, 1])
  t.truthy(rtRed?.cmyk)
  t.deepEqual(rtRed.cmyk, [0, 1, 1, 0])
  t.is(rtRed.opacity, 0.8)
})

test('XMap writer uses canonical cmyk instead of recomputing from RGB', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(XMAP_COLORS)
  // Mutate the canonical cmyk — this should persist to disk, not be
  // overwritten by RGB→CMYK recomputation.
  const red = map.colors.find(c => c?.name === 'Red')
  red.cmyk = [0, 0.9, 0.9, 0.1] // slightly different from exact RGB recompute
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cmyk-'))
  const out = path.join(tmp, 'map.xmap')
  await writeOmap(map, out)
  const xml = await fs.readFile(out, 'utf-8')
  t.true(xml.includes('c="0"'), 'c component present')
  t.true(xml.includes('m="0.9"'), 'm component written from canonical cmyk')
})

// --------------------------------------------------------------------------
// 2. objectString + objectStringType

const OCAD_FIXTURES = [
  path.join(__dirname, 'data', '202012_Tahunanui.ocd'),
  path.join(__dirname, 'data', 'bottle-lake-bc98714_UpdatedCoady.ocd'),
]

for (const fixture of OCAD_FIXTURES) {
  const exists = fsSync.existsSync(fixture)
  const t = exists ? test : test.skip

  t(`objectString populated for objects that have one (${path.basename(fixture)})`, async (/** @type {ExecutionContext} */ tt) => {
    const map = await readMap(fixture)
    const withStr = map.objects.filter(o => o.objectString)
    const withStrType = map.objects.filter(o => o.objectStringType !== undefined)
    // Not all maps have objectStrings; if none exist the test still verifies
    // the field is properly absent (undefined, not empty string).
    tt.true(
      map.objects.every(o => o.objectString === undefined || typeof o.objectString === 'string'),
      'objectString is string or undefined'
    )
    tt.true(
      map.objects.every(o => o.objectStringType === undefined || typeof o.objectStringType === 'number'),
      'objectStringType is number or undefined'
    )
    if (withStr.length > 0) {
      tt.log(`found ${withStr.length} objects with objectString`)
      tt.truthy(withStrType.length > 0, 'objectStringType set when objectString present')
    }
  })
}

test('objectString not leaked on objects that have none (basic-1.ocd)', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(path.join(__dirname, 'data', 'basic-1.ocd'))
  for (const obj of map.objects) {
    t.is(obj.objectString, undefined, 'no objectString on basic objects')
    t.is(obj.objectStringType, undefined)
  }
})

// --------------------------------------------------------------------------
// 3. TextTypography on RenderLayer

const XMAP_TEXT_SYM = `<?xml version="1.0" encoding="UTF-8"?>
<map xmlns="http://openorienteering.org/apps/mapper/xml/v2" version="9">
  <colors count="1">
    <color priority="0" name="Black" c="0" m="0" y="0" k="1" opacity="1">
      <cmyk method="custom"/><rgb method="custom" r="0" g="0" b="0" />
    </color>
  </colors>
  <barrier version="6" required="0.6.0">
    <symbols count="1" id="x">
      <symbol id="10" code="601.0" name="Label" type="8">
        <text_symbol rotatable="false">
          <font family="Noto Sans" size="3600" bold="true" italic="false" />
          <text color="0" line_spacing="1.5" paragraph_spacing="200" character_spacing="50" />
          <framing mode="0" line_half_width="0" shadow_x_offset="0" shadow_y_offset="0" color="0" />
          <line_below on="false" color="0" width="0" distance="0" />
        </text_symbol>
      </symbol>
    </symbols>
    <parts count="1" current="0"><part name="default part"><objects count="0"/></part></parts>
  </barrier>
</map>`

test('XMap text symbol populates full TextTypography', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(XMAP_TEXT_SYM)
  const sym = map.symbols[0]
  t.is(sym.type, 'text')
  const layer = sym.renderLayers[0]
  t.is(layer.type, 'text')
  t.truthy(layer.text, 'text sub-object present')
  const typo = layer.text
  t.is(typo.fontFamily, 'Noto Sans')
  t.is(typo.fontWeight, 700, 'bold → fontWeight 700')
  t.is(typo.italic, false)
  t.is(typo.lineSpace, 1.5)
  // paraSpace and charSpace are in map units; values from parseDim
  t.truthy(typo.paraSpace !== undefined)
  t.truthy(typo.charSpace !== undefined)
  // Legacy back-compat fields still present
  t.is(layer.fontFamily, 'Noto Sans')
})

test('OCAD text symbol populates full TextTypography', async (/** @type {ExecutionContext} */ t) => {
  const ocadFile = await readOcad(path.join(__dirname, 'data', 'basic-1.ocd'))
  // legacy re-import moved to top of file
  const map = ocad.toMap(ocadFile)
  const textSymbols = map.symbols.filter(s => s.type === 'text')
  t.true(textSymbols.length > 0, 'has text symbols')
  for (const sym of textSymbols) {
    const layer = sym.renderLayers.find(l => l.type === 'text')
    t.truthy(layer, `${sym.name} has text layer`)
    t.truthy(layer.text, `${sym.name} has text.typography sub-object`)
    const typo = layer.text
    t.truthy(typo.fontFamily, 'fontFamily present')
    t.true(typo.fontSize > 0, 'fontSize > 0')
    t.true(typo.fontWeight === 400 || typo.fontWeight === 700, 'fontWeight is 400 or 700')
    t.is(typeof typo.italic, 'boolean')
  }
})

test('TextTypography survives omap round-trip', async (/** @type {ExecutionContext} */ t) => {
  const map = await readMap(XMAP_TEXT_SYM)
  const rt = await xmapRoundTrip(map)
  const rtSym = rt.symbols[0]
  const rtLayer = rtSym.renderLayers[0]
  const typo = rtLayer.text
  t.is(typo.fontFamily, 'Noto Sans')
  t.is(typo.fontWeight, 700)
  t.is(typo.lineSpace, 1.5)
})

test('OCAD text symbol fontSize is millimetres at symbol and layer level', async (/** @type {ExecutionContext} */ t) => {
  const ocadFile = await readOcad(path.join(__dirname, 'data', 'basic-1.ocd'))
  // legacy re-import moved to top of file
  const map = ocad.toMap(ocadFile)
  const sym = map.symbols.find(s => s.type === 'text')
  const layer = sym.renderLayers.find(l => l.type === 'text')
  // The model contract is millimetres. The top-level `sym.fontSize` used to leak
  // OCAD's raw 1/10pt value while the text render layer was mm — so an OCD- and
  // an OMap-sourced copy differed. Both are now mm and agree.
  t.true(sym.fontSize > 0)
  t.is(layer.text.fontSize, sym.fontSize)
})
