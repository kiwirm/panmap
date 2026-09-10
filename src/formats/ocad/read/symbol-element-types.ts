export const LineElementType = 1
export const AreaElementType = 2
export const CircleElementType = 3
export const DotElementType = 4

export type SymbolElementType =
  | typeof LineElementType
  | typeof AreaElementType
  | typeof CircleElementType
  | typeof DotElementType
