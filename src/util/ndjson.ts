import fs from 'node:fs/promises'

/** Read + parse a JSON file. Error message includes the source filename. */
export async function readJson(filename: string): Promise<any> {
  const text = await fs.readFile(filename, 'utf-8')
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`Malformed JSON in ${filename}: ${(err as Error).message}`)
  }
}

/** Read + parse an NDJSON file (one JSON value per line). Blank lines are skipped. */
export async function readNdjson(filename: string): Promise<unknown[]> {
  const text = await fs.readFile(filename, 'utf-8')
  return text
    .split('\n')
    .filter(line => line.trim())
    .map((line, i) => {
      try {
        return JSON.parse(line)
      } catch (err) {
        throw new Error(
          `Malformed NDJSON in ${filename} line ${i + 1}: ${(err as Error).message}`
        )
      }
    })
}

/** Dispatch on extension: `.ndjson` → readNdjson, everything else → readJson. */
export async function readJsonOrNdjson(filename: string): Promise<any> {
  if (filename.endsWith('.ndjson')) return readNdjson(filename)
  return readJson(filename)
}
