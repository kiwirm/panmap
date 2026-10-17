/**
 * Text-symbol builder: a `MapSymbol` text layer → an XMap
 * `<text_symbol>` record (font family / size / weight / spacing).
 */
import type { MapSymbol, RenderLayer } from '../../../../panmap/model.js'
import type { OmapTextSymbol } from '../../native.js'
import { colorRef } from './colors.js'

function buildXmapTextSymbol(
  textLayer: RenderLayer | undefined,
  symbol: MapSymbol,
  colorIds: Map<string | number, number>,
  rotatable = false,
): OmapTextSymbol {
  const typo = textLayer?.text as
    | {
        fontFamily?: string
        fontSize?: number
        fontWeight?: number
        italic?: boolean
        lineSpace?: number
        paraSpace?: number
        charSpace?: number
        tabs?: number[]
        lineBelow?: {
          visible?: boolean
          color?: number
          width?: number
          distance?: number
        }
      }
    | undefined
  const family =
    typo?.fontFamily ?? (textLayer?.fontFamily as string | undefined) ?? 'Arial'
  const size =
    typo?.fontSize ??
    (textLayer?.fontSize as number | undefined) ??
    (symbol.fontSize as number | undefined) ??
    12
  const bold = typo?.fontWeight !== undefined ? typo.fontWeight >= 700 : false
  const italic = typo?.italic ?? false
  return {
    color: colorRef(textLayer?.colorId, colorIds),
    fontFamily: family,
    fontSize: size,
    bold,
    italic,
    rotatable,
    lineSpacing: typo?.lineSpace,
    paragraphSpacing: typo?.paraSpace,
    characterSpacing: typo?.charSpace,
    // Paragraph tab stops — reader stashes them on the text render
    // layer's `text.tabs`; pass through so the encoder emits
    // `<tabs count="N"><tab>V</tab>…</tabs>`.
    tabs: typo?.tabs,
    // Canonical lineBelow → xmap `<line_below>`; only emit when
    // `visible` (matches Mapper's write convention, and OCD-side
    // lbOn=false suppresses the element).
    lineBelow:
      typo?.lineBelow?.visible &&
      (typo.lineBelow.color !== undefined ||
        typo.lineBelow.width !== undefined ||
        typo.lineBelow.distance !== undefined)
        ? {
            color: typo.lineBelow.color,
            width: typo.lineBelow.width,
            distance: typo.lineBelow.distance,
          }
        : undefined,
  } as OmapTextSymbol
}

export { buildXmapTextSymbol }
