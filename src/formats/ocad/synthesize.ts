import type PanMap from '../../map/model.js'
import OcadFile from './internal/ocad-file.js'
import FileHeader, { type OcadVersion } from './internal/file-header.js'
import { synthesizeSymbols } from './synthesize-symbols.js'
import { synthesizeParameterStrings } from './synthesize-strings.js'
import { synthesizeObjects } from './synthesize-objects.js'
import { assignSymNums } from '../../util/assign-sym-nums.js'

export interface SynthesizeOptions {
  version?: OcadVersion
}

/**
 * Build a fresh `OcadFile` in memory from a `PanMap`.
 *
 * This is the from-scratch path used when writing OCAD from a source
 * that never had OCAD bytes to slice from (xmap, gitmap). Header +
 * symbols + objects + parameter strings are all synthesized here from
 * the PanMap fields; each record writer already falls back to its
 * field-level encoder when a record lacks `_byteRange`.
 */
export function synthesizeOcadFile(
  map: PanMap,
  options: SynthesizeOptions = {},
): OcadFile {
  // Preserve the source header when the map came from OCAD — Mapper
  // stamps `version = 12` on OCAD-2018 files (bumping `subVersion` to
  // signal the format flavour) and downstream consumers may care which
  // major version they see. Otherwise synth defaults to 2018.
  const sourceHeader = (map.metadata as { version?: number; subVersion?: number; subSubVersion?: number; currentFileVersion?: number } | undefined)
  const version = options.version ?? 2018
  const header = FileHeader.createFor(version)
  if (typeof sourceHeader?.version === 'number') header.version = sourceHeader.version
  if (typeof sourceHeader?.subVersion === 'number') header.subVersion = sourceHeader.subVersion
  if (typeof sourceHeader?.subSubVersion === 'number') header.subSubVersion = sourceHeader.subSubVersion
  if (typeof sourceHeader?.currentFileVersion === 'number') header.currentFileVersion = sourceHeader.currentFileVersion

  const symNums = assignSymNums(map.symbols ?? [])
  const symbols = synthesizeSymbols(
    map.symbols ?? [], map.colors ?? [], map.sourceFormat, symNums,
  )
  const objects = synthesizeObjects(
    map.objects ?? [],
    map.symbols ?? [],
    map.sourceFormat,
    symNums,
  )
  const { ordered: rawParamStrings, grouped } = synthesizeParameterStrings(map)

  const ocad = new OcadFile(
    header,
    grouped,
    objects as never[],
    symbols as never[],
    [],                          // warnings
  )
  ocad.rawParameterStrings = rawParamStrings
  return ocad
}
