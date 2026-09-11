/**
 * GitMap reader: source bytes → Panmap.
 *
 * `index.ts` reads the package files from a `GitmapSource` (a directory or an
 * in-memory bundle) and parses them; `to-panmap.ts` maps the parsed records
 * into the canonical model — symmetric with the ocad/omap readers.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import type Panmap from '../../../panmap/model.js'
import { parseJson } from '../../../util/json.js'
import { parseNdjson } from '../../../util/ndjson.js'
import gitmapToPanmap from './to-panmap.js'

// A gitmap is a small set of named files (manifest.json + colors/symbols/
// objects ndjson + optional private/view.json). A `GitmapSource` abstracts
// WHERE those bytes come from — the on-disk directory reader, or an
// in-memory bundle fetched straight from git (`git cat-file`) with no tar
// extraction / temp files. `read(name)` returns the file's UTF-8 text, or
// null when the file is absent.
export interface GitmapSource {
  read(name: string): Promise<string | null>
}

function directorySource(directory: string): GitmapSource {
  return {
    async read(name) {
      try {
        return await fs.readFile(path.join(directory, name), 'utf-8')
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') return null
        throw err
      }
    },
  }
}

/** Wrap an in-memory `{ filename → bytes }` map as a GitmapSource. */
export function bundleSource(
  files: Record<string, string | Buffer | Uint8Array>,
): GitmapSource {
  return {
    async read(name) {
      const v = files[name]
      if (v == null) return null
      return typeof v === 'string' ? v : Buffer.from(v).toString('utf-8')
    },
  }
}

/** Read a gitmap from a directory on disk (the original entry point). */
async function readGitmap(directory: string): Promise<Panmap> {
  return readGitmapFrom(directorySource(directory), directory)
}

/**
 * Read a gitmap from an in-memory bundle — the files as `{ name → bytes }`,
 * e.g. produced by `git cat-file --batch`. Lets callers diff/render a gitmap
 * straight out of git's object store without materialising a temp directory.
 */
export async function readGitmapBundle(
  files: Record<string, string | Buffer | Uint8Array>,
): Promise<Panmap> {
  return readGitmapFrom(bundleSource(files), 'bundle')
}

/** Core reader, agnostic to where the bytes come from: read + parse the
 *  package files, then hand the records to `gitmapToPanmap`. */
async function readGitmapFrom(
  source: GitmapSource,
  label: string,
): Promise<Panmap> {
  const manifestText = await source.read('manifest.json')
  if (manifestText == null) {
    throw new Error(`Not a GitMap package: ${label} (missing manifest.json)`)
  }
  const manifest = parseJson(manifestText, 'manifest.json')
  if (manifest?.format !== 'gitmap') {
    throw new Error(`Not a GitMap package: ${label}`)
  }

  // Filenames are fixed by convention (no manifest `files` map).
  const readEntry = async (name: string): Promise<string> =>
    (await source.read(name)) ?? ''
  const colors = parseNdjson(
    await readEntry('colors.ndjson'),
    'colors.ndjson',
  ) as any[]
  const symbols = parseNdjson(
    await readEntry('symbols.ndjson'),
    'symbols.ndjson',
  ) as any[]
  const objects = parseNdjson(
    await readEntry('objects.ndjson'),
    'objects.ndjson',
  ) as any[]

  // `view` / `print` live under `private/` for gitignoring editor state.
  const privText = await source.read('private/view.json')
  const privateData = privText
    ? (parseJson(privText, 'private/view.json') as Record<string, unknown>)
    : undefined

  return gitmapToPanmap({
    manifest,
    colors,
    symbols,
    objects,
    privateData,
    label,
  })
}

export { readGitmap }
export default readGitmap
