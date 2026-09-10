/**
 * GitMap extensions — arbitrary key/value metadata that survives round-trips
 * through OCAD/OMap files via the map notes text field.
 *
 * See the gitmap README ("Extensions & notes") for the format spec. Summary:
 *   --- gitmap-extensions v1 ---
 *   { ...pretty JSON, keys sorted... }
 *   --- end gitmap-extensions ---
 * User-authored free text lives outside the fences and is preserved verbatim.
 */

import { sortDeep } from '../../util/json.js'

const FENCE_VERSION = 1
const OPEN_FENCE = `--- gitmap-extensions v${FENCE_VERSION} ---`
const CLOSE_FENCE = '--- end gitmap-extensions ---'
const OPEN_FENCE_RE = /^--- gitmap-extensions v(\d+) ---$/
const CLOSE_FENCE_RE = /^--- end gitmap-extensions ---$/

export type Extensions = Record<string, unknown>

export interface ParsedNotes {
  userText: string
  extensions: Extensions
}

export class ExtensionsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtensionsError'
  }
}

/**
 * Parse the map notes text field into user free text plus a structured
 * extensions object. A malformed or nested fence aborts rather than dropping
 * data; an UNKNOWN block version is left verbatim (the block rides through as
 * user text) so a newer file doesn't break an older reader.
 */
export function parseNotes(text: string | null | undefined): ParsedNotes {
  if (text == null || text === '') return { userText: '', extensions: {} }

  const lines = text.split('\n')
  let openIndex = -1
  let openVersion = 0
  for (let i = 0; i < lines.length; i++) {
    const match = OPEN_FENCE_RE.exec(lines[i])
    if (match) {
      openIndex = i
      openVersion = Number(match[1])
      break
    }
  }
  if (openIndex === -1) return { userText: text, extensions: {} }
  // Unknown block version: this reader doesn't know the shape, so leave the
  // notes field untouched — the block rides through as plain user text instead
  // of being dropped or aborting the read. (A malformed or nested fence of a
  // KNOWN version is still a hard error below; that's corruption, not a newer
  // format.) Mirrors the preserve-don't-discard rule for unrecognised keys.
  if (openVersion !== FENCE_VERSION) {
    return { userText: text, extensions: {} }
  }

  let closeIndex = -1
  for (let i = openIndex + 1; i < lines.length; i++) {
    if (CLOSE_FENCE_RE.test(lines[i])) {
      closeIndex = i
      break
    }
    if (OPEN_FENCE_RE.test(lines[i])) {
      throw new ExtensionsError(
        'Nested gitmap-extensions block found; only one block per notes field is allowed'
      )
    }
  }
  if (closeIndex === -1) {
    throw new ExtensionsError('gitmap-extensions block is missing its closing fence')
  }

  const jsonText = lines.slice(openIndex + 1, closeIndex).join('\n').trim()
  let extensions: Extensions
  try {
    const parsed = jsonText === '' ? {} : JSON.parse(jsonText)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ExtensionsError('gitmap-extensions body must be a JSON object')
    }
    extensions = parsed as Extensions
  } catch (error) {
    if (error instanceof ExtensionsError) throw error
    throw new ExtensionsError(
      `gitmap-extensions body is not valid JSON: ${(error as Error).message}`
    )
  }

  const before = lines.slice(0, openIndex).join('\n').replace(/\n+$/, '')
  const after = lines.slice(closeIndex + 1).join('\n').replace(/^\n+/, '')
  const userText = joinUserText(before, after)
  return { userText, extensions }
}

/**
 * Produce the map notes text field from user free text plus extensions.
 * Emits the fenced block only when extensions has at least one key.
 */
export function formatNotes(
  userText: string | null | undefined,
  extensions: Extensions | null | undefined
): string {
  const raw = userText ?? ''
  const hasExtensions = extensions && Object.keys(extensions).length > 0

  // No extensions: preserve user text verbatim so byte-for-byte round-trips
  // hold. Only strip a stale block when we're about to write a fresh one.
  if (!hasExtensions) return raw

  const cleanUser = stripAnyBlock(raw).replace(/\s+$/, '')
  const body = JSON.stringify(sortDeep(extensions as Extensions), null, 2)
  const block = `${OPEN_FENCE}\n${body}\n${CLOSE_FENCE}`
  if (cleanUser === '') return block
  return `${cleanUser}\n\n${block}`
}

/**
 * Remove any existing extension block from a notes string without parsing
 * the JSON. Used by writers that only need to swap in a freshly-serialized
 * block without validating the old contents.
 */
export function stripExtensionsBlock(text: string | null | undefined): string {
  return stripAnyBlock(text ?? '')
}

function stripAnyBlock(text: string): string {
  const lines = text.split('\n')
  const openIndex = lines.findIndex((line) => OPEN_FENCE_RE.test(line))
  if (openIndex === -1) return text
  const closeIndex = lines
    .slice(openIndex + 1)
    .findIndex((line) => CLOSE_FENCE_RE.test(line))
  if (closeIndex === -1) return text
  const absoluteClose = openIndex + 1 + closeIndex
  const before = lines.slice(0, openIndex).join('\n').replace(/\n+$/, '')
  const after = lines.slice(absoluteClose + 1).join('\n').replace(/^\n+/, '')
  return joinUserText(before, after)
}

function joinUserText(before: string, after: string): string {
  if (before === '' && after === '') return ''
  if (before === '') return after
  if (after === '') return before
  return `${before}\n\n${after}`
}

export { OPEN_FENCE, CLOSE_FENCE, FENCE_VERSION }
