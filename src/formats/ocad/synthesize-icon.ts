import type { MapColor, MapSymbol } from '../../map/model.js'

/**
 * OCAD symbol-element shape carried by icon rendering. Compatible
 * with the objects we hand to `writeSymbolElement` — kept local so
 * this file doesn't depend on the writer.
 */
interface IconElement {
  type: number         // 1=Line, 2=Area, 3=Circle, 4=Dot
  color: number        // OCAD color slot (not palette index)
  lineWidth: number    // 0.01 mm units
  diameter: number     // 0.01 mm units
  coords: Array<{ 0: number; 1: number }>
}

/**
 * Produce the 484-byte icon bitmap OCAD stores on every symbol record.
 *
 * OCAD v11 / v12 / v2018 icons are 22 × 22 palette-indexed pixels
 * (indices 0..124) using a fixed 5³ RGB cube palette from Mapper's
 * `ocd_types_v9.h` — see `paletteIndex()` below for the layout. The
 * icon is stored top-to-bottom, left-to-right in file order.
 *
 * Bytes on-disk layout:
 *   iconBits[y * 22 + x] = palette index for pixel (x, y)
 *
 * We render a stylised placeholder appropriate to the symbol's
 * effective type (matching what `synthesize-symbols.ts` decides), in
 * the symbol's dominant color, on a white background. It's not the
 * same icon Mapper would render from render-layers, but it's far more
 * useful than an all-zero (black) square in the symbol palette:
 *   - point  → filled disc
 *   - line   → horizontal stroke through the middle
 *   - area   → filled square with a small darker border
 *   - text   → colored "A" glyph on white
 */
export function synthesizeIconBits(
  symbol: MapSymbol,
  effectiveType: string,
  colors: MapColor[],
  pointElements?: IconElement[],
): number[] {
  const primary = pickPrimaryColor(symbol, colors)
  const iconColor = primary ? paletteIndex(...rgbFromColor(primary)) : 0
  const bg = paletteIndex(255, 255, 255) // white
  const dark = paletteIndex(96, 96, 96)  // border shade

  const bits = new Array<number>(484).fill(bg)
  switch (effectiveType) {
    case 'point':
      if (pointElements && pointElements.length > 0) {
        renderPointElements(bits, pointElements, colors)
      } else {
        drawDisc(bits, 11, 11, 5, iconColor)
      }
      break
    case 'line':   drawHLine(bits, 3, 18, 11, iconColor); break
    case 'area':   drawFilledRect(bits, 3, 3, 18, 18, iconColor, dark); break
    case 'text':   drawA(bits, iconColor); break
    default:
      if (pointElements && pointElements.length > 0) {
        renderPointElements(bits, pointElements, colors)
      } else {
        drawDisc(bits, 11, 11, 5, iconColor)
      }
      break
  }
  return bits
}

/**
 * Rasterize a symbol's actual OCAD point elements into the 22×22
 * icon. Auto-fits the element extent to the icon canvas so a small
 * "boulder" (radius 30 units) and a large "control point" (radius
 * 500 units) both fill the same visual area.
 *
 * OCAD elements at this point live in map units (~0.01 mm) with
 * arbitrary offsets, and each carries a color slot (not a palette
 * index). We look up the slot in `colors` to get an RGB and quantize.
 */
function renderPointElements(
  bits: number[],
  elements: IconElement[],
  colors: MapColor[],
): void {
  // Compute extent from all element coord bboxes plus radii.
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity
  for (const el of elements) {
    const halfExtent = Math.max(el.diameter / 2, el.lineWidth / 2)
    for (const c of el.coords) {
      if (c[0] - halfExtent < minX) minX = c[0] - halfExtent
      if (c[1] - halfExtent < minY) minY = c[1] - halfExtent
      if (c[0] + halfExtent > maxX) maxX = c[0] + halfExtent
      if (c[1] + halfExtent > maxY) maxY = c[1] + halfExtent
    }
  }
  if (!Number.isFinite(minX)) return
  const width = Math.max(maxX - minX, 1)
  const height = Math.max(maxY - minY, 1)
  const pad = 2
  const scale = Math.min((22 - 2 * pad) / width, (22 - 2 * pad) / height)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const toPx = (x: number, y: number) => ({
    // OCAD y increases upward; icon rows increase downward.
    px: Math.round(11 + (x - cx) * scale),
    py: Math.round(11 - (y - cy) * scale),
  })

  // Painter's algorithm: no z-order info in OCAD elements themselves,
  // so we render in the order given (matches OCAD's own convention).
  for (const el of elements) {
    const color = pickColorPalette(el.color, colors)
    switch (el.type) {
      case 4: { // Dot — filled disc at coords[0]
        const c = el.coords[0]; if (!c) break
        const { px, py } = toPx(c[0], c[1])
        const r = Math.max(1, Math.round((el.diameter / 2) * scale))
        drawDisc(bits, px, py, r, color)
        break
      }
      case 3: { // Circle — outlined ring
        const c = el.coords[0]; if (!c) break
        const { px, py } = toPx(c[0], c[1])
        const r = Math.max(1, Math.round((el.diameter / 2) * scale))
        const w = Math.max(1, Math.round(el.lineWidth * scale))
        drawRing(bits, px, py, r, w, color)
        break
      }
      case 1: { // Line — polyline
        const w = Math.max(1, Math.round(el.lineWidth * scale))
        for (let i = 1; i < el.coords.length; i++) {
          const a = toPx(el.coords[i - 1][0], el.coords[i - 1][1])
          const b = toPx(el.coords[i][0], el.coords[i][1])
          drawLine(bits, a.px, a.py, b.px, b.py, w, color)
        }
        break
      }
      case 2: { // Area — filled polygon
        const poly = el.coords.map((c) => toPx(c[0], c[1]))
        fillPolygon(bits, poly, color)
        break
      }
    }
  }
}

function pickColorPalette(slot: number, colors: MapColor[]): number {
  const color = colors.find(
    (c) => c && (c.sourceId === slot || c.id === slot),
  ) ?? colors[slot]
  if (!color) return 0 // black fallback
  return paletteIndex(...rgbFromColor(color))
}

/**
 * OCAD's icon palette is the RGB cube with each channel quantised to
 * {0, 64, 128, 192, 255}. Index = r_step * 25 + g_step * 5 + b_step,
 * where step ∈ {0..4}. Total 125 entries (0..124).
 */
function paletteIndex(r: number, g: number, b: number): number {
  const step = (v: number): number => {
    // Nearest of {0, 64, 128, 192, 255}. Boundaries at 32, 96, 160, 224.
    if (v < 32)  return 0
    if (v < 96)  return 1
    if (v < 160) return 2
    if (v < 224) return 3
    return 4
  }
  return step(r) * 25 + step(g) * 5 + step(b)
}

function pickPrimaryColor(
  symbol: MapSymbol,
  colors: MapColor[],
): MapColor | undefined {
  // Walk the render layers for the first color reference; fall back
  // to the first symbol color if none.
  for (const layer of symbol.renderLayers ?? []) {
    for (const key of ['color', 'colorId', 'fillColor', 'hatchColor', 'innerColor']) {
      const v = (layer as Record<string, unknown>)[key]
      if (v === undefined || v === null) continue
      // `colors` is sparse when sourced from OCAD (indexed by color number),
      // so filter holes before comparing — Array.find visits holes as undefined.
      const color = colors.find(
        (c) => !!c && (c.id === v || c.sourceId === v || c.renderOrder === v),
      )
      if (color) return color
    }
  }
  return colors.find(c => !!c)
}

function rgbFromColor(color: MapColor): [number, number, number] {
  // MapColor.rgb is stored as `rgb(r, g, b)` with 0..255 components.
  const m = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(color.rgb || '')
  if (!m) return [0, 0, 0]
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

// ── Simple raster primitives on the 22×22 grid ─────────────────────

function put(bits: number[], x: number, y: number, c: number): void {
  if (x < 0 || x >= 22 || y < 0 || y >= 22) return
  bits[y * 22 + x] = c
}

function drawDisc(
  bits: number[], cx: number, cy: number, radius: number, color: number,
): void {
  const r2 = radius * radius
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = x - cx; const dy = y - cy
      if (dx * dx + dy * dy <= r2) put(bits, x, y, color)
    }
  }
}

function drawHLine(
  bits: number[], x0: number, x1: number, y: number, color: number,
): void {
  const thickness = 3
  for (let yy = y - Math.floor(thickness / 2); yy <= y + Math.floor(thickness / 2); yy++) {
    for (let x = x0; x <= x1; x++) put(bits, x, yy, color)
  }
}

function drawFilledRect(
  bits: number[],
  x0: number, y0: number, x1: number, y1: number,
  fill: number, border: number,
): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) put(bits, x, y, fill)
  }
  // Thin border for definition against the white background.
  for (let x = x0; x <= x1; x++) { put(bits, x, y0, border); put(bits, x, y1, border) }
  for (let y = y0; y <= y1; y++) { put(bits, x0, y, border); put(bits, x1, y, border) }
}

// Minimal 12-pixel-tall "A" glyph. Not pretty; readable at 22×22.
const A_GLYPH: readonly string[] = [
  '   ##   ',
  '  ####  ',
  ' ##  ## ',
  ' ##  ## ',
  '########',
  '########',
  '##    ##',
  '##    ##',
  '##    ##',
]

function drawA(bits: number[], color: number): void {
  const yOff = 7; const xOff = 7
  for (let y = 0; y < A_GLYPH.length; y++) {
    const row = A_GLYPH[y]
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '#') put(bits, xOff + x, yOff + y, color)
    }
  }
}

/** Outlined ring — stroke width in pixels, centre at (cx, cy). */
function drawRing(
  bits: number[], cx: number, cy: number,
  radius: number, width: number, color: number,
): void {
  const outer = radius; const inner = Math.max(0, radius - width)
  const outer2 = outer * outer; const inner2 = inner * inner
  for (let y = cy - outer; y <= cy + outer; y++) {
    for (let x = cx - outer; x <= cx + outer; x++) {
      const dx = x - cx; const dy = y - cy
      const d2 = dx * dx + dy * dy
      if (d2 <= outer2 && d2 >= inner2) put(bits, x, y, color)
    }
  }
}

/** Thick line from (x0,y0) to (x1,y1). Bresenham with a radius stamp. */
function drawLine(
  bits: number[], x0: number, y0: number,
  x1: number, y1: number, width: number, color: number,
): void {
  const dx = Math.abs(x1 - x0); const sx = x0 < x1 ? 1 : -1
  const dy = -Math.abs(y1 - y0); const sy = y0 < y1 ? 1 : -1
  let err = dx + dy
  let x = x0; let y = y0
  const r = Math.max(0, Math.floor((width - 1) / 2))
  while (true) {
    // Square stamp — cheap and looks fine at this resolution.
    for (let sy2 = -r; sy2 <= r; sy2++) {
      for (let sx2 = -r; sx2 <= r; sx2++) {
        put(bits, x + sx2, y + sy2, color)
      }
    }
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 >= dy) { err += dy; x += sx }
    if (e2 <= dx) { err += dx; y += sy }
  }
}

/** Fill a polygon (scanline). Points in pixel coords. Handles concave shapes. */
function fillPolygon(
  bits: number[], points: Array<{ px: number; py: number }>, color: number,
): void {
  if (points.length < 3) return
  let minY = Infinity; let maxY = -Infinity
  for (const p of points) {
    if (p.py < minY) minY = p.py
    if (p.py > maxY) maxY = p.py
  }
  minY = Math.max(0, minY)
  maxY = Math.min(21, maxY)
  for (let y = minY; y <= maxY; y++) {
    // Collect x-intersections of the horizontal line y+0.5 with each
    // polygon edge — offset by half a pixel to avoid vertex ambiguity.
    const xs: number[] = []
    for (let i = 0; i < points.length; i++) {
      const a = points[i]; const b = points[(i + 1) % points.length]
      const yA = a.py; const yB = b.py
      if ((yA <= y && yB > y) || (yB <= y && yA > y)) {
        const t = (y + 0.5 - yA) / (yB - yA)
        xs.push(a.px + t * (b.px - a.px))
      }
    }
    xs.sort((p, q) => p - q)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.ceil(xs[i]))
      const x1 = Math.min(21, Math.floor(xs[i + 1]))
      for (let x = x0; x <= x1; x++) put(bits, x, y, color)
    }
  }
}
