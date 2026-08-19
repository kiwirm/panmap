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
  // OCAD text alignment is a symbol-level property, but OMAP-sourced
  // gitmaps carry alignment per-OBJECT (see omap/read `hAlign`/`vAlign`).
  // Before synthesising symbols, hoist any per-object alignment into
  // the referenced text symbol's layer so `symbol-bodies/text.ts` can
  // read it. Assumes each text symbol is used with one consistent
  // alignment — mapper conventions match this.
  const symbolsForSynth = hoistTextAlignmentIntoSymbols(
    map.symbols ?? [], map.objects ?? [],
  )
  const symbols = synthesizeSymbols(
    symbolsForSynth, map.colors ?? [], map.sourceFormat, symNums,
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

function hoistTextAlignmentIntoSymbols(
  symbols: PanMap['symbols'],
  objects: PanMap['objects'],
) {
  const byId = new Map<string | number, {h?: number; v?: number}>()
  for (const o of objects) {
    if (o.type !== 'text') continue
    const anyO = o as any
    if (anyO.hAlign === undefined && anyO.vAlign === undefined) continue
    if (!byId.has(o.symbolId)) byId.set(o.symbolId, {
      h: anyO.hAlign, v: anyO.vAlign,
    })
  }
  if (!byId.size) return symbols
  // Mapper's <object v_align="…"> uses 0=baseline, 1=top, 2=middle,
  // 3=bottom. OCAD-panmap's text.verticalAlignment (from ocad/to-map)
  // is `(alignment >> 2) & 0x03` — 0=bottom, 1=middle, 2=top. Translate
  // so OCAD write's `verticalAlignment << 2` yields the right bits.
  const mapperVToOcad = (v: number | undefined): number | undefined => {
    if (v === undefined) return undefined
    switch (v) {
      case 1: return 2 // Mapper top → OCAD top
      case 2: return 1 // Mapper middle → OCAD middle
      case 3: return 0 // Mapper bottom → OCAD bottom
      default: return 0 // baseline ≈ bottom for OCAD's coarser enum
    }
  }
  return symbols.map(symbol => {
    const align = byId.get(symbol.id)
    if (!align) return symbol
    const layers = (symbol as any).renderLayers as any[] | undefined
    if (!Array.isArray(layers)) return symbol
    const newLayers = layers.map(layer => {
      if (!layer || layer.type !== 'text') return layer
      const text = { ...(layer.text ?? {}) }
      if (align.h !== undefined && text.alignment === undefined) text.alignment = align.h
      if (align.v !== undefined && text.verticalAlignment === undefined) {
        text.verticalAlignment = mapperVToOcad(align.v)
      }
      return { ...layer, text }
    })
    return { ...symbol, renderLayers: newLayers }
  })
}
