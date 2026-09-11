import fs from 'node:fs/promises'
import path from 'node:path'
import { XMLSerializer } from '@xmldom/xmldom'
import type Panmap from '../panmap/model.js'
import mapToGeoJson from './geojson/index.js'
import mapToSvg from './svg/index.js'

export type ExportFormat = 'svg' | 'geojson' | 'json'

export interface ExportOptions {
  format?: ExportFormat | string
  backgroundColor?: string
  whiteBackground?: boolean
  applyCrs?: boolean
  exportHidden?: boolean
  includeSymbols?: number[] | false
}

/**
 * Exports a Map to a lossy target format (svg, geojson).
 *
 * Lossy: the rendering / GIS representation does not retain enough
 * information to reconstruct the original native map file. For lossless
 * format-to-format conversion, see `convert`.
 */
export async function exportMap(
  map: Panmap,
  filename: string,
  options: ExportOptions = {},
): Promise<void> {
  const format = (
    options.format ?? path.extname(filename).slice(1)
  ).toLowerCase()

  switch (format) {
    case 'svg': {
      const svg = mapToSvg(map, {
        backgroundColor:
          options.backgroundColor ??
          (options.whiteBackground ? 'white' : undefined),
      })
      await fs.writeFile(filename, new XMLSerializer().serializeToString(svg))
      return
    }
    case 'json':
    case 'geojson':
      await fs.writeFile(filename, JSON.stringify(mapToGeoJson(map, options)))
      return
    default:
      throw new Error(`Unsupported export format: ${format}`)
  }
}

/**
 * Render a map to an SVG STRING (the same output `exportMap(map, '*.svg')`
 * writes to disk). For callers that render in-process and want the markup
 * directly — e.g. straight from a `git cat-file` bundle, no temp file.
 */
export function mapToSvgString(
  map: Panmap,
  options: ExportOptions = {},
): string {
  const svg = mapToSvg(map, {
    backgroundColor:
      options.backgroundColor ??
      (options.whiteBackground ? 'white' : undefined),
  })
  return new XMLSerializer().serializeToString(svg)
}

export { default as mapToGeoJson } from './geojson/index.js'
export { default as mapToSvg, getMapSvgRenderSupport } from './svg/index.js'
export default exportMap
