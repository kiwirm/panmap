import path from 'node:path'
import type Panmap from './map/model.js'
import writeGitmap from './formats/gitmap/write.js'
import writeOcad from './formats/ocad/writer/index.js'
import writeOmap from './formats/omap/writer/index.js'


export type NativeFormat = 'gitmap' | 'xmap' | 'omap' | 'ocd' | 'ocad'

export interface WriteOptions {
  format?: NativeFormat | string
  overwrite?: boolean
}

/**
 * Writes a Map to one of the three native formats (gitmap, omap/xmap, ocd/ocad).
 *
 * This is the lossless side of the API. For lossy outputs (svg, geojson, mvt),
 * see `exportMap`.
 */
export async function write(
  map: Panmap,
  filename: string,
  options: WriteOptions = {}
): Promise<void> {
  const format = (
    options.format || path.extname(filename).slice(1)
  ).toLowerCase()

  switch (format) {
    case 'gitmap':
      await writeGitmap(map, filename, { overwrite: options.overwrite })
      return
    case 'xmap':
    case 'omap':
      await writeOmap(map, filename)
      return
    case 'ocd':
    case 'ocad':
      await writeOcad(map, filename)
      return
    default:
      throw new Error(
        `Unsupported native format: ${format}. ` +
          `Use exportMap() for lossy outputs (svg, geojson, mvt).`
      )
  }
}

export default write
