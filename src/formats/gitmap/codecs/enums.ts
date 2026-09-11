/**
 * Canonical string enums for the gitmap read/write boundary.
 *
 * The in-memory model and the OCD/OMap codecs speak OCAD/Mapper INTEGER enums
 * (capStyle 1, joinStyle 2, …). gitmap emits SEMANTIC STRINGS so a diff reads
 * `capStyle: "round"` rather than `capStyle: 1`, and the canonical form doesn't
 * carry a source format's raw byte values. These tables are the single source of
 * truth; the mapping happens ONLY here, so the codecs are unaffected.
 *
 * Domains are the OpenOrienteering Mapper enums (../mapper):
 *   CapStyle  0 flat, 1 round, 2 square, 3 pointed   (line_symbol.h)
 *   JoinStyle 0 bevel, 1 miter, 2 round              (line_symbol.h)
 *   h_align   0 left, 1 center, 2 right              (text_object.h)
 *   v_align   0 baseline, 1 top, 2 middle, 3 bottom  (text_object.h)
 */

const CAP_STYLE = ['flat', 'round', 'square', 'pointed'] as const
const JOIN_STYLE = ['bevel', 'miter', 'round'] as const
const H_ALIGN = ['left', 'center', 'right'] as const
const V_ALIGN = ['baseline', 'top', 'middle', 'bottom'] as const

// Unknown/out-of-domain values pass through unchanged so a stray value is
// preserved rather than silently corrupted (and shows up loudly in validation).
function toStr(table: readonly string[], v: unknown): unknown {
  return typeof v === 'number' && table[v] !== undefined ? table[v] : v
}
function fromStr(table: readonly string[], v: unknown): unknown {
  if (typeof v !== 'string') return v
  const i = table.indexOf(v)
  return i >= 0 ? i : v
}

export const capStyleToGitmap = (v: unknown): unknown => toStr(CAP_STYLE, v)
export const capStyleFromGitmap = (v: unknown): unknown => fromStr(CAP_STYLE, v)
export const joinStyleToGitmap = (v: unknown): unknown => toStr(JOIN_STYLE, v)
export const joinStyleFromGitmap = (v: unknown): unknown =>
  fromStr(JOIN_STYLE, v)
export const hAlignToGitmap = (v: unknown): unknown => toStr(H_ALIGN, v)
export const hAlignFromGitmap = (v: unknown): unknown => fromStr(H_ALIGN, v)
export const vAlignToGitmap = (v: unknown): unknown => toStr(V_ALIGN, v)
export const vAlignFromGitmap = (v: unknown): unknown => fromStr(V_ALIGN, v)

// Object/pattern rotation: the model stores radians (OCAD/Mapper convention);
// gitmap stores DEGREES — readable in a diff and consistent with layer `angle`
// (already degrees). The value is snapped to OCAD's 0.1° grid, so a round to 1
// dp is exact; the inverse is a plain degrees→radians conversion.
const RAD_TO_DEG = 180 / Math.PI
const DEG_TO_RAD = Math.PI / 180

export function rotationToGitmap(radians: unknown): number {
  const r = Number(radians)
  if (!r || !Number.isFinite(r)) return 0
  return Math.round(r * RAD_TO_DEG * 10) / 10
}
export function rotationFromGitmap(degrees: unknown): number {
  const d = Number(degrees)
  if (!d || !Number.isFinite(d)) return 0
  return d * DEG_TO_RAD
}
