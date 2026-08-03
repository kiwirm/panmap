import fs from 'node:fs/promises'
import { Buffer } from 'node:buffer'

import FileHeader from './file-header.js'
import SymbolIndex from './symbol-index.js'
import ObjectIndex from './object-index.js'
import StringIndex from './string-index.js'
import BufferReader from './buffer-reader.js'
import { InvalidObjectIndexBlockError } from './errors.js'
import OcadFile from './ocad-file.js'
import type { OcadObjectWithBounds } from './ocad-file.js'
import type BaseSymbol from './symbol.js'
import type ParameterString from './parameter-string.js'
import type { ParameterStringValues } from './parameter-string.js'

export interface ReadOcadOptions {
  bypassVersionCheck?: boolean
  quietWarnings?: boolean
  failOnWarning?: boolean
}

export default async function readOcad(
  input: string | Buffer,
  options: ReadOcadOptions = {}
): Promise<OcadFile> {
  const buffer = Buffer.isBuffer(input) ? input : await fs.readFile(input)
  return parseOcadBuffer(buffer, options)
}

function parseOcadBuffer(buffer: Buffer, options: ReadOcadOptions): OcadFile {
  const reader = new BufferReader(buffer)
  const header = new FileHeader(reader)
  if (!header.isValid()) {
    throw new Error(
      `Not an OCAD file (invalid header ${header.ocadMark} !== ${0x0cad})`
    )
  }
  if (header.version < 10 && !options.bypassVersionCheck) {
    throw new Error(
      `Unsupported OCAD file version (${header.version}), only >= 10 supported.`
    )
  }

  const warnings: string[] = []
  const symbols = readSymbols(reader, header, options, warnings) as BaseSymbol[]
  const objects = readObjects(reader, header, warnings) as OcadObjectWithBounds[]
  const { grouped, ordered } = readParameterStrings(reader, header)

  if (!options.quietWarnings) warnings.forEach(w => console.warn(w))

  const ocadFile = new OcadFile(header, grouped, objects, symbols, warnings)
  ocadFile.buffer = buffer
  ocadFile.rawParameterStrings = ordered
  return ocadFile
}

function readSymbols(
  reader: BufferReader,
  header: FileHeader,
  options: ReadOcadOptions,
  warnings: string[]
): unknown[] {
  const symbols: unknown[] = []
  let offset = header.symbolIndexBlock
  while (offset) {
    const symbolIndex = reader.withOffset(
      offset,
      () => new SymbolIndex(reader, header.version, options)
    )
    symbols.push(...symbolIndex.parseSymbols(reader))
    warnings.push(...symbolIndex.warnings)
    offset = symbolIndex.nextSymbolIndexBlock
  }
  return symbols
}

function readObjects(
  reader: BufferReader,
  header: FileHeader,
  warnings: string[]
): unknown[] {
  const objects: unknown[] = []
  let offset = header.objectIndexBlock
  let startIndex = 0
  while (offset) {
    reader.push(offset)
    try {
      const objectIndex = new ObjectIndex(reader, startIndex, header.version)
      startIndex += 256
      reader.pop()
      objects.push(...objectIndex.readObjects(reader))
      offset = objectIndex.nextObjectIndexBlock
    } catch (e) {
      if (e instanceof InvalidObjectIndexBlockError) {
        warnings.push(e.toString())
        return objects
      }
      throw e
    }
  }
  return objects
}

function readParameterStrings(
  reader: BufferReader,
  header: FileHeader
): {
  grouped: Record<number | string, ParameterStringValues[]>
  ordered: ParameterString[]
} {
  const grouped: Record<number | string, ParameterStringValues[]> = {}
  const ordered: ParameterString[] = []

  let offset = header.stringIndexBlock
  while (offset) {
    const stringIndex = reader.withOffset(offset, () => new StringIndex(reader))
    for (const ps of stringIndex.getStringsInOrder(reader)) {
      ;(grouped[ps.recType] ||= []).push(ps.values)
      ordered.push(ps)
    }
    offset = stringIndex.nextStringIndexBlock
  }

  return { grouped, ordered }
}
