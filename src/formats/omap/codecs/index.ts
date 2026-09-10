/**
 * OMap ↔ canonical conversion codecs.
 *
 * Co-locates BOTH directions of each OMap-representation detail so the pair
 * can't drift out of sync. Add a new detail as its own file.
 *
 *   omap-flags — OMap flag byte ↔ canonical xFlags/yFlags
 */
export { normaliseOmapFlags, coordinatesForOmap } from './omap-flags.js'
