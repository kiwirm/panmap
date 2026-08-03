import pathLib from 'node:path'
import { ocad, read } from '../index.js'
import type { OcadFile } from '../formats/ocad/index.js'
import { parseSymNums } from './sym-nums.js'

interface InfoOptions {
  symbols?: string | boolean
  iconsBits?: boolean
  parameterStrings?: string | boolean
  objectStrings?: string | boolean
}

const OCAD_EXTENSIONS = new Set(['.ocd', '.ocad', ''])

export async function runInfo(path: string, options: InfoOptions): Promise<void> {
  const ext = pathLib.extname(path).toLowerCase()
  if (OCAD_EXTENSIONS.has(ext)) return ocadInfo(path, options)

  const map = await read(path)
  println(
    `File: ${path}`,
    `Format: ${map.sourceFormat}`,
    `Colors: ${map.colors.length}`,
    `Symbols: ${map.symbols.length}`,
    `Objects: ${map.objects.length}`,
    `Warnings: ${map.warnings.length}`
  )
}

async function ocadInfo(path: string, options: InfoOptions): Promise<void> {
  const ocadFile = await ocad.readRaw(path)
  const { header } = ocadFile
  const crs = ocadFile.getCrs()
  const bounds = ocadFile.getBounds()
  const projectedBounds = ocadFile.getBounds(crs.toProjectedCoord.bind(crs))

  println(
    `File: ${path}`,
    `OCAD version: ${header.version}.${header.subVersion}.${header.subSubVersion}`,
    `File version: ${header.currentFileVersion}`,
    `Number symbols: ${ocadFile.symbols.length}`,
    `Number objects: ${ocadFile.objects.length}`,
    `Scale: 1:${crs.scale}`,
    `Grid ID: ${crs.gridId}`,
    `CRS Name: ${crs.name}`,
    `CRS identifier: ${crs.catalog}:${crs.code}`,
    `Grivation: ${((crs.grivation / Math.PI) * 180).toFixed(2)}°`,
    `Northing: ${crs.northing}`,
    `Easting: ${crs.easting}`,
    `Bounds (mm): ${bounds.map(x => x / 100)}`,
    `Bounds (CRS): ${projectedBounds}`
  )

  if (options.symbols) dumpSymbols(ocadFile, options)
  if (options.parameterStrings) dumpParameterStrings(ocadFile, options.parameterStrings)
  if (options.objectStrings) dumpObjectStrings(ocadFile, options.objectStrings)
}

function parseFilterSet(flag: string | boolean): Set<string> | null {
  return typeof flag === 'string' ? new Set(flag.split(',')) : null
}

function dumpSymbols(ocadFile: OcadFile, options: InfoOptions): void {
  const symNums =
    typeof options.symbols === 'string'
      ? new Set(parseSymNums(options.symbols))
      : null
  const symbols = symNums
    ? ocadFile.symbols.filter(s => symNums.has(s.symNum))
    : ocadFile.symbols

  if (symbols.length === 0) {
    throw new Error(`No such symbol (${options.symbols})`)
  }

  const blacklist = new Set(
    options.iconsBits
      ? ['buffer', 'offset', '_startOffset', 'filePos']
      : ['iconBits', 'buffer', 'offset', '_startOffset', 'filePos']
  )

  process.stdout.write(
    symbols
      .map(s =>
        [`${s.number} ${s.description}`, formatObject(s as unknown as Record<string, unknown>, blacklist)].join('\n')
      )
      .join('\n\n') + '\n'
  )
}

function dumpParameterStrings(ocadFile: OcadFile, flag: string | boolean): void {
  const filter = parseFilterSet(flag)
  for (const [k, v] of Object.entries(ocadFile.parameterStrings)) {
    if (filter && !filter.has(k)) continue
    process.stdout.write(`${k}\t${JSON.stringify(v)}\n`)
  }
}

function dumpObjectStrings(ocadFile: OcadFile, flag: string | boolean): void {
  const filter = parseFilterSet(flag)
  for (const o of ocadFile.objects) {
    if (filter) {
      const sym = Number(o.sym)
      const code = `${Math.trunc(sym / 1000)}.${String(sym % 1000).padStart(3, '0')}`
      if (!filter.has(code)) continue
    }
    process.stdout.write(`${o.sym}\t${o.objectString}\n`)
  }
}

function println(...lines: string[]): void {
  process.stdout.write(lines.join('\n') + '\n')
}

function formatObject(o: Record<string, unknown>, blacklist: Set<string>): string {
  const replacer = (k: string, v: unknown) => (blacklist.has(k) ? undefined : v)
  return Object.keys(o)
    .filter(k => !blacklist.has(k))
    .map(k => `\t${k}: ${JSON.stringify(o[k], replacer)}`)
    .join('\n')
}
