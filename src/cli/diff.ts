import fs from 'node:fs/promises'
import { XMLSerializer, DOMImplementation } from '@xmldom/xmldom'
import { read, diff, mapToSvg } from '../index.js'

interface DiffCmdOptions {
  whiteBackground?: boolean
}

/**
 * Render a visual SVG diff between two map files.
 *
 * Uses panmap's `diff()` to produce a PanMap diff (removed
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
  const diffMap = diff(before, after)
  // `getBounds` uses the same identity transform mapToSvg falls back
  // to when no `coordinateTransform` option is passed. For xmap-sourced
  // maps that's the identity — matches what the "after" render will use.
  const bounds = after.getBounds()
  const svg = mapToSvg(diffMap, {
    document: new DOMImplementation().createDocument(null, 'xml', null),
    backgroundColor: options.whiteBackground ? 'white' : undefined,
    bounds,
  })
  await fs.writeFile(output, new XMLSerializer().serializeToString(svg))
}
