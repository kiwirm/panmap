/**
 * Low-level XMap XML string helpers shared by the writer orchestration
 * (index.ts) and the record serialisers (encode.ts).
 */
import { escapeXmlAttr as xmlAttr } from '../../../util/xml.js'
import { cleanNumber } from '../../../util/number.js'
import { MAP_UNIT_SCALE } from '../native.js'

export function block(name: string, children: string[]): string {
  const tag = name.split(/\s+/, 1)[0]
  if (!children.length) return `  <${name}/>`
  return [`  <${name}>`, children.join('\n'), `  </${tag}>`].join('\n')
}

export function indent(value: string, spaces: number): string {
  const padding = ' '.repeat(spaces)
  return value
    .split('\n')
    .map(line => `${padding}${line}`)
    .join('\n')
}

/** Convert an internal coordinate value (0.01 mm) to XMap map units. */
export function dim(value: number): number {
  return cleanNumber(value / MAP_UNIT_SCALE)
}

// The XMap serialiser escapes `"` inside text content as well as attributes,
// so both `attr` and `text` here map through the attribute escaper.

export function attr(value: unknown): string {
  return xmlAttr(value)
}

export function text(value: string): string {
  return xmlAttr(value)
}

export function attrs(values: Record<string, unknown>): string {
  return Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => ` ${key}="${attr(value)}"`)
    .join('')
}

export function boolAttr(value: unknown): string | undefined {
  return value === undefined ? undefined : value ? 'true' : 'false'
}
