import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import reproject from 'reproject'
import geojsonvt from 'geojson-vt'
import vtpbf from 'vt-pbf'
import { read, exportMap, mapToGeoJson } from '../index.js'
import { parseSymNums } from './sym-nums.js'

const { toWgs84 } = reproject

interface ExportCmdOptions {
  format?: string
  symbols?: string
  exportHidden?: boolean
  crs?: string
  whiteBackground?: boolean
}

interface ExportOpts {
  exportHidden: boolean
  includeSymbols: number[] | undefined
  applyCrs: boolean
  backgroundColor: string | undefined
}

export async function runExport(
  input: string,
  output: string,
  options: ExportCmdOptions
): Promise<void> {
  const format = (options.format ?? path.extname(output).slice(1)).toLowerCase()

  const exportOpts: ExportOpts = {
    exportHidden: !!options.exportHidden,
    includeSymbols:
      typeof options.symbols === 'string'
        ? parseSymNums(options.symbols)
        : undefined,
    applyCrs: options.crs !== 'source',
    backgroundColor: options.whiteBackground ? 'white' : undefined,
  }

  switch (format) {
    case 'svg':
      await exportMap(await read(input), output, { format: 'svg', ...exportOpts })
      return
    case 'json':
    case 'geojson':
      // CRS re-projection ("wgs84") and CRS metadata injection
      // ("projection") aren't part of the library-level exporter — they
      // depend on epsg.io lookups. Keep them CLI-only.
      await exportGeoJson(input, output, options.crs, exportOpts)
      return
    case 'mvt':
      await toMvt(input, output, exportOpts)
      return
    default:
      throw new Error(`Unknown export format: ${format}`)
  }
}

async function exportGeoJson(
  input: string,
  output: string,
  crsOption: string | undefined,
  exportOpts: ExportOpts
): Promise<void> {
  const map = await read(input)
  const crs = map.getCrs()
  const geojson = mapToGeoJson(map, exportOpts)
  const payload =
    crsOption === 'wgs84'
      ? toWgs84(geojson, await getProj4Def(crs?.code ?? 0))
      : geojson
  const crsDef =
    crsOption === 'projection' && crs?.catalog && crs.code
      ? {
          crs: {
            type: 'name',
            properties: {
              name: `urn:ogc:def:crs:${crs.catalog}::${crs.code}`,
            },
          },
        }
      : {}
  const stream = fs.createWriteStream(output)
  stream.write(JSON.stringify({ ...crsDef, ...payload }))
  stream.close()
}

async function toMvt(
  input: string,
  output: string,
  exportOpts: ExportOpts
): Promise<void> {
  const map = await read(input)
  const crs = map.getCrs()
  if (!crs || crs.catalog !== 'EPSG' || crs.code <= 0) {
    throw new Error(`Unsupported CRS ${crs?.catalog ?? null}:${crs?.code ?? 0} in map.`)
  }
  const geoJson = toWgs84(
    mapToGeoJson(map, exportOpts),
    await getProj4Def(crs.code)
  )
  const tileIndex = geojsonvt(geoJson, {
    maxZoom: 14,
    indexMaxZoom: 14,
    indexMaxPoints: 0,
  })
  tileIndex.tileCoords.forEach(tc => {
    fs.mkdirSync(`${output}/${tc.z}/${tc.x}`, { recursive: true })
    const tile = tileIndex.getTile(tc.z, tc.x, tc.y)
    const pbf = vtpbf.fromGeojsonVt({ ocad: tile })
    const tilePath = `${output}/${tc.z}/${tc.x}/${tc.y}.pbf`
    fs.writeFileSync(tilePath, pbf)
    console.log(tilePath)
  })
}

function getProj4Def(crs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: 'epsg.io', path: `/${crs}.proj4` },
      res => {
        let data = ''
        res.on('data', chunk => (data += chunk))
        res.on('end', () => resolve(data))
      }
    )
    req.on('error', reject)
    req.end()
  })
}
