// Test-only convenience wrappers over the omap format's public entry
// points. The src/ layer intentionally exposes only the two clean
// primitives — `parseOmap` (string | Buffer → OmapFile) and
// `readOmapFile` (path → OmapFile) — plus `writeOmap` (map + path).
// Tests frequently want a "figure out what I gave you" reader and a
// "give me the XML string" writer; those live here.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseOmap, readOmapFile } from '../../src/formats/omap/read.ts'
import { writeOmap } from '../../src/formats/omap/write.ts'

/** Accepts an XMap file path, an XMap XML string, or a Buffer. */
export async function readOmap(input) {
  if (Buffer.isBuffer(input)) return parseOmap(input)
  if (typeof input === 'string') {
    return input.trimStart().startsWith('<')
      ? parseOmap(input)
      : readOmapFile(input)
  }
  throw new Error('Unsupported xmap input type')
}

/** Serialise a canonical PanMap to an XMap XML string via a tmp file. */
export async function mapToOmapXml(map) {
  const tmp = path.join(
    os.tmpdir(),
    `panmap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.xmap`
  )
  await writeOmap(map, tmp)
  try {
    return await fs.readFile(tmp, 'utf-8')
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

export default readOmap
