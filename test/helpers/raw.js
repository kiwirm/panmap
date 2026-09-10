// Low-level reader / toMap stages for tests that exercise them directly.
// The public per-format API is read/write only (see src/formats/*/index.ts);
// these internal stages live here so tests can reach them without src/ having
// to re-export them. `readXmap` is the input-sniffing OMap reader from ./omap.js.
export { default as readOcad } from '../../src/formats/ocad/read/index.ts'
export { default as ocadFileToMap } from '../../src/formats/ocad/to-map.ts'
export { default as omapFileToMap } from '../../src/formats/omap/to-map.ts'
export { readOmap as readXmap } from './omap.js'
