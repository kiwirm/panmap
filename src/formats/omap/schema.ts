/**
 * Constants shared by the XMap reader (`read.ts`) and writer (`from-map.ts`).
 * Keeping these in one place avoids silent drift when we add fields.
 */

/**
 * fast-xml-parser attribute prefix. Attributes are serialized as `@_name`
 * so they don't collide with child element names.
 */
export const ATTR_PREFIX = '@_'

/**
 * OpenOrienteering-Mapper stores coordinates as fixed-point centi-millimetres.
 * Multiply on-disk values by this to get map units (millimetres).
 */
export const MAP_UNIT_SCALE = 0.1
