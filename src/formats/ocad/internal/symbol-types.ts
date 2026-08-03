export const PointSymbolType = 1
export const LineSymbolType = 2
export const AreaSymbolType = 3
export const TextSymbolType = 4
export const LineTextSymbolType = 6
export const RectangleSymbolType = 7

/** Line symbol dblFlag — line fill color on. */
export const DblFillColorOn = 1

export type SymbolType =
  | typeof PointSymbolType
  | typeof LineSymbolType
  | typeof AreaSymbolType
  | typeof TextSymbolType
  | typeof LineTextSymbolType
  | typeof RectangleSymbolType
