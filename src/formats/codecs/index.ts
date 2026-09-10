/**
 * Cross-format representation codecs shared by more than one format.
 * (Format-specific codecs live in that format's own codecs/ dir.)
 *
 *   extensions — canonical `extensions` map ↔ the gitmap-extensions fence
 *                embedded in OCAD/OMap notes text.
 */
export * from './extensions.js'
