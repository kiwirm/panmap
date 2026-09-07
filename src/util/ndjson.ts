import fs from 'node:fs/promises'

/** Parse a JSON string. `label` names the source in error messages. */
export function parseJson(text: string, label = 'input'): any {
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`Malformed JSON in ${label}: ${(err as Error).message}`)
  }
}

/** Parse NDJSON text (one JSON value per line; blank lines skipped). */
export function parseNdjson(text: string, label = 'input'): unknown[] {
  return text
    .split('\n')
    .filter(line => line.trim())
    .map((line, i) => {
      try {
        return JSON.parse(line)
      } catch (err) {
        throw new Error(
          `Malformed NDJSON in ${label} line ${i + 1}: ${(err as Error).message}`
        )
      }
    })
}

/** Dispatch on filename: `.ndjson` → parseNdjson, everything else → parseJson. */
export function parseJsonOrNdjson(text: string, label = 'input'): any {
  return label.endsWith('.ndjson') ? parseNdjson(text, label) : parseJson(text, label)
}

/** Read + parse a JSON file. Error message includes the source filename. */
export async function readJson(filename: string): Promise<any> {
  return parseJson(await fs.readFile(filename, 'utf-8'), filename)
}

/** Read + parse an NDJSON file (one JSON value per line). Blank lines are skipped. */
export async function readNdjson(filename: string): Promise<unknown[]> {
  return parseNdjson(await fs.readFile(filename, 'utf-8'), filename)
}

/** Dispatch on extension: `.ndjson` → readNdjson, everything else → readJson. */
export async function readJsonOrNdjson(filename: string): Promise<any> {
  if (filename.endsWith('.ndjson')) return readNdjson(filename)
  return readJson(filename)
}
