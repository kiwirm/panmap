/**
 * NDJSON (newline-delimited JSON) parsing.
 */

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
          `Malformed NDJSON in ${label} line ${i + 1}: ${(err as Error).message}`,
        )
      }
    })
}
