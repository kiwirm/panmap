export const PointObjectType = 1
export const LineObjectType = 2
export const AreaObjectType = 3
export const UnformattedTextObjectType = 4
export const FormattedTextObjectType = 5
export const LineTextObjectType = 6
export const RectangleObjectType = 7

export type ObjectType =
  | typeof PointObjectType
  | typeof LineObjectType
  | typeof AreaObjectType
  | typeof UnformattedTextObjectType
  | typeof FormattedTextObjectType
  | typeof LineTextObjectType
  | typeof RectangleObjectType
