/**
 * Vertical-axis orientation per native format — the single source of truth for
 * "who is Y-up vs Y-down", so every reader, writer and exporter agrees.
 *
 * OCAD's coordinate origin is bottom-left (Y increases upward). OMap/xmap,
 * gitmap and the SVG/GeoJSON exporters use screen space (top-left origin, Y
 * increases downward). The in-memory PanMap keeps whichever orientation its
 * SOURCE format used; any conversion to a target format negates Y iff the two
 * disagree.
 *
 * This fact used to be duplicated as `sourceFormat === 'ocad'` checks in the
 * OCAD writer, the OMap writer, the gitmap writer and the SVG exporter — change
 * the convention in one and the rest silently drift. They now all defer here.
 */
export type YAxis = 'up' | 'down'

const FORMAT_Y_AXIS: Readonly<Record<string, YAxis>> = {
  ocad: 'up',
  ocd: 'up',
  omap: 'down',
  xmap: 'down',
  gitmap: 'down',
  svg: 'down',
  geojson: 'down',
}

/** The vertical-axis direction a format stores coordinates in (defaults to the
 *  y-down screen convention for anything unlisted). */
export function yAxisOf(format: string | undefined): YAxis {
  return (format !== undefined && FORMAT_Y_AXIS[format]) || 'down'
}

/**
 * True when moving coordinates from a map in `sourceFormat` into
 * `targetFormat` requires negating Y (their axes point opposite ways).
 */
export function needsYFlip(
  sourceFormat: string | undefined,
  targetFormat: string
): boolean {
  return yAxisOf(sourceFormat) !== yAxisOf(targetFormat)
}
