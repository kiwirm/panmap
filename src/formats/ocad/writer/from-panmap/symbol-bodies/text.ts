import type { MapSymbol } from '../../../../../panmap/model.js'
import { classifyTextLayers } from '../../../../../panmap/render-layers.js'
import { mmToOcadFontSize, packOcadTextAlign } from '../../../codecs/index.js'
import type { ColorNumber } from './shared.js'
import { normUnits } from './shared.js'

export function textBody(symbol: MapSymbol, colorNumber: ColorNumber) {
  const { text: textLayer } = classifyTextLayers(symbol)
  const text = (textLayer?.text as Record<string, unknown> | undefined) ?? {}
  // OCAD-only text extras — framing (`fr*`), line-below (`lb*`), tab
  // stops, paragraph indentation, embedded point symbols — are not
  // represented in Panmap and therefore not recoverable here. Emit
  // zero/empty defaults; visually the text still renders but framing
  // and tab-stop layout are lost.
  //
  // Default to OCAD's 3pt (raw 30) when no size is present.
  const panmapFontSize = (text.fontSize as number) ?? symbol.fontSize ?? 0
  const fontSize = mmToOcadFontSize(panmapFontSize) || 30
  return {
    fontName: (text.fontFamily as string) ?? 'Arial',
    _fontNameBytes: undefined as Uint8Array | undefined,
    fontColor: colorNumber(textLayer?.colorId),
    fontSize,
    weight: (text.fontWeight as number) ?? 400,
    italic: !!text.italic,
    res1: 0,
    charSpace: Math.round(((text.charSpace as number) ?? 0) * 100),
    wordSpace: 100,
    // OCAD's text-symbol `alignment` byte has no counterpart in an xmap
    // `<text_symbol>` (xmap stores per-object alignment, not per-symbol).
    // Mapper's own xmap→OCD conversion writes alignment=1 (centre) as the
    // Mapper-idiomatic default for any symbol without OCD-side alignment
    // info. Default to 1 so xmap-sourced text matches Mapper's OCD output
    // — OCD-sourced text still keeps the explicit alignment carried in
    // the render layer, since the OCD reader always stores a numeric value.
    alignment: packOcadTextAlign(
      Number(text.alignment ?? 1),
      Number(text.verticalAlignment ?? 0),
    ),
    // OCAD's lineSpace is stored as a percentage of font size (Mapper
    // writes 115 for Arial-family fonts, 120 for Segoe UI etc). OCD-
    // sourced text carries the exact ratio in `text.lineSpace` (1.15
    // → 115). Xmap's `line_spacing` is a font-metrics ratio that doesn't
    // map 1:1 to OCD; Mapper picks the OCD default from the font at
    // export time. Match by dispatching on the font family when the
    // ratio is in the xmap-default range, otherwise pass through.
    lineSpace: encodeLineSpace(
      text.lineSpace as number | undefined,
      (text.fontFamily as string) ?? '',
    ),
    paraSpace: normUnits((text.paraSpace as number) ?? 0),
    indentFirst: 0,
    indentOther: 0,
    ...encodeTabs(text.tabs),
    // Canonical `lineBelow` sub-object — both OCD and OMap readers
    // populate the same shape (see readers), so this round-trips
    // through gitmap and preserves the OCD `lb*` fields losslessly.
    lbOn: !!(text.lineBelow as { visible?: boolean })?.visible,
    lbColor: ((text.lineBelow as { color?: number })?.color as number) ?? 0,
    lbWidth: ((text.lineBelow as { width?: number })?.width as number) ?? 0,
    lbDist:
      ((text.lineBelow as { distance?: number })?.distance as number) ?? 0,
    res2: 0,
    // OCAD-only framing (fr*) — same story as lb*.
    frMode: (text.frMode as number) ?? 0,
    frStyle: (text.frStyle as number) ?? 0,
    pointSymOn: false,
    pointSymNumber: 0,
  }
}

function encodeLineSpace(v: number | undefined, _fontFamily: string): number {
  // OCAD's lineSpace = percent of font-size (100 = single-line). OCD-
  // sourced text carries the exact ratio in v (1.2 → 120); xmap-sourced
  // text carries Mapper's font-metric-derived ratio (e.g. 1.00008 for
  // Arial 3pt → OCD 115, 1.01891 for Segoe UI → OCD 120, 1.04357 for
  // Arial 36pt → OCD 120). Mapper's exact formula depends on font
  // metrics we can't reproduce without loading actual fonts. Empirical
  // buckets over the current corpus:
  //   • v ∈ [1.0, 1.01)  → 115 (Arial-family at small sizes)
  //   • v ∈ [1.01, 1.05) → 120 (Segoe UI, Arial at larger sizes)
  //   • v ≥ 1.05         → verbatim round(v*100) (OCD-sourced or explicit)
  // A handful of italic / larger-font cases still miss by a few percent
  // (bottle-lake 801 italic Tahoma, lincoln Border Titles) — documented
  // as a parity gap that needs real font metrics to close.
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 120
  if (v >= 1.0 && v < 1.01) return 115
  if (v >= 1.01 && v < 1.05) return 120
  return Math.round(v * 100)
}

// Serialise the text render layer's `tabs` array (per-paragraph tab
// stops in OCD ordinate units) into OCD's fixed-shape { nTabs, tabs[32] }
// record. Missing / empty → `{ nTabs: 0, tabs: [] }` (Mapper's default,
// what the writer used to hard-code).
function encodeTabs(rawTabs: unknown): { nTabs: number; tabs: number[] } {
  if (!Array.isArray(rawTabs) || rawTabs.length === 0) {
    return { nTabs: 0, tabs: [] }
  }
  const tabs = rawTabs
    .map(v => (typeof v === 'number' ? Math.round(v) : 0))
    .slice(0, 32)
  return { nTabs: tabs.length, tabs }
}
