import type OcadFile from './internal/ocad-file.js'
import type { ParameterStringValues } from './internal/parameter-string.js'
import { formatNotes } from '../extensions.js'

/**
 * OCAD parameter string record type used to store the map notes / file
 * information text. Verified for OCAD 11+; older versions may need a
 * different value. If your fixtures store notes elsewhere, override this
 * constant or extend syncNotesIntoOcadFile to search additional recTypes.
 */
export const OCAD_NOTES_RECTYPE = 1061

interface RawParameterString {
  recType: number
  values: ParameterStringValues
  _byteRange?: { start: number; end: number }
  _indexRecord?: { pos: number; len: number; recType: number; objIndex: number }
}

/**
 * Update (or create) the map-notes parameter string on an OcadFile so that
 * a subsequent encode picks up any changes to `map.notes` / `map.extensions`.
 */
export function syncNotesIntoOcadFile(
  ocadFile: OcadFile,
  userText: string,
  extensions: Record<string, unknown>
): void {
  const nextText = formatNotes(userText, extensions)
  const existing = findNotesEntry(ocadFile)

  if (existing) {
    const currentText = String(existing.values._first ?? '')
    if (currentText === nextText) return
    existing.values._first = nextText
    delete existing._byteRange   // force re-encode from values
    return
  }

  if (nextText === '') return

  const created: RawParameterString = {
    recType: OCAD_NOTES_RECTYPE,
    values: { _first: nextText, _pairs: [] },
  }
  ocadFile.rawParameterStrings.push(created)
  const grouped = ocadFile.parameterStrings[OCAD_NOTES_RECTYPE]
  if (grouped) grouped.push(created.values)
  else ocadFile.parameterStrings[OCAD_NOTES_RECTYPE] = [created.values]
}

function findNotesEntry(ocadFile: OcadFile): RawParameterString | null {
  for (const raw of ocadFile.rawParameterStrings as RawParameterString[]) {
    if (raw && raw.recType === OCAD_NOTES_RECTYPE) return raw
  }
  return null
}
