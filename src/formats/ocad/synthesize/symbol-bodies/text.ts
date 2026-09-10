import type { MapSymbol } from '../../../../map/model.js'
import { classifyTextLayers } from '../../../../map/render-layers.js'
import type { ColorNumber } from './shared.js'
import { normUnits } from './shared.js'

export function textBody(symbol: MapSymbol, colorNumber: ColorNumber) {
  const { text: textLayer } = classifyTextLayers(symbol)
  const text = (textLayer?.text as Record<string, unknown> | undefined) ?? {}
  // OCAD-only text extras — framing (`fr*`), line-below (`lb*`), tab
  // stops, paragraph indentation, embedded point symbols — are not
  // represented in PanMap and therefore not recoverable here. Emit
  // zero/empty defaults; visually the text still renders but framing
  // and tab-stop layout are lost.
  //
  // PanMap fontSize is stored in millimetres. OCAD stores font sizes as
  // tenths of a point. 1 pt = 25.4/72 mm, so
  //     ocadRaw = mm × 720 / 25.4
  //             ≈ mm × 28.346
  // Inverse of `to-map.ts`' `× 25.4 / 720`.
  const panmapFontSize = (text.fontSize as number) ?? symbol.fontSize ?? 0
  const fontSize = Math.round((panmapFontSize * 720) / 25.4) || 30
  return {
    fontName: (text.fontFamily as string) ?? 'Arial',
    _fontNameBytes: undefined as Uint8Array | undefined,
    fontColor: colorNumber(textLayer?.colorId),
    fontSize,
    weight: ((text.fontWeight as number) ?? 400),
    italic: !!text.italic,
    res1: 0,
    charSpace: Math.round(((text.charSpace as number) ?? 0) * 100),
    wordSpace: 100,
    // OCAD packs vertical alignment into the top bits of `alignment`
    // (low 2 bits = horizontal, next 2 bits = vertical).
    alignment: ((Number(text.alignment ?? 0) & 0x03)
       | ((Number(text.verticalAlignment ?? 0) & 0x03) << 2)),
    // OCAD's lineSpace is stored as a percentage of font size (Mapper
    // writes 120 for a 1.20 multiplier). Canonical stores the multiplier
    // verbatim, so scale by 100.
    lineSpace: Math.round(((text.lineSpace as number) ?? 1) * 100),
    paraSpace: normUnits((text.paraSpace as number) ?? 0),
    indentFirst: 0,
    indentOther: 0,
    nTabs: 0,
    tabs: [] as number[],
    lbOn: false,
    lbColor: 0,
    lbWidth: 0,
    lbDist: 0,
    res2: 0,
    frMode: 0,
    frStyle: 0,
    pointSymOn: false,
    pointSymNumber: 0,
  }
}
