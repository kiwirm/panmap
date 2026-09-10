/**
 * Cross-format conversion codecs — representation details shared by more than
 * one format. Format-specific codec pairs live in that format's own codecs/
 * dir (see ocad/codecs, omap/codecs); a detail earns a place here only once a
 * second format needs it.
 *
 *   y-axis — vertical-axis orientation per format (single source of truth)
 */
export { needsYFlip } from './y-axis.js'
