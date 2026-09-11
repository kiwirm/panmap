import fs from 'node:fs/promises'
import { XMLSerializer } from '@xmldom/xmldom'
import { read, diff, diffChanges, mapToSvg } from '../index.js'

interface DiffCmdOptions {
  whiteBackground?: boolean
  changes?: string
}

/**
 * Render a visual SVG diff between two map files.
 *
 * Uses panmap's `diff()` to produce a Panmap diff (removed
 * geometry in red, added in green) then feeds that through the same
 * SVG exporter as normal maps.
 *
 * The diff SVG is forced to use the *after* map's bounds — otherwise
 * the diff's viewBox shrinks to just the changed region and the SVG
 * no longer aligns with a side-by-side "after" render. Callers who
 * want to overlay the diff on the full map render (mapwall does this
 * to give visual context around the changes) rely on that alignment.
 */
export async function runDiff(
  beforePath: string,
  afterPath: string,
  output: string,
  options: DiffCmdOptions,
): Promise<void> {
  const [before, after] = await Promise.all([read(beforePath), read(afterPath)])
  // `getBounds` uses the same identity transform mapToSvg falls back
  // to when no `coordinateTransform` option is passed. For xmap-sourced
  // maps that's the identity — matches what the "after" render will use.
  const bounds = after.getBounds()

  // With --changes we also compute per-feature changes, and the overall
  // diff is composed from them (changed red/green parts only, no yellow)
  // so it stays consistent with the per-change views. Without --changes,
  // fall back to the plain whole-object diff render.
  const result = options.changes
    ? diffChanges(before, after, {}, { renderSvg: true })
    : null
  if (result?.overallSvg) {
    await fs.writeFile(output, result.overallSvg)
  } else {
    const svg = mapToSvg(diff(before, after), {
      backgroundColor: options.whiteBackground ? 'white' : undefined,
      bounds,
    })
    await fs.writeFile(output, new XMLSerializer().serializeToString(svg))
  }
  if (options.changes && result) {
    await fs.writeFile(options.changes, JSON.stringify(result))
  }
}
