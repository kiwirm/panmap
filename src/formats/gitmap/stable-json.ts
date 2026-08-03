const keyOrder = [
  'format',
  'version',
  'units',
  'precision',
  'files',
  'id',
  'sourceId',
  'code',
  'name',
  'type',
  'hidden',
  'visible',
  'locked',
  'partId',
  'symbolId',
  'symbolCode',
  'part',
  'coordinates',
  'text',
  'rotation',
  'bounds',
  'rgb',
  'renderOrder',
  'fontSize',
  'textSymbol',
  'renderLayers',
  'colorId',
  'color',
  'symbolId',
  'width',
  'height',
  'radius',
  'fontFamily',
  'angle',
  'spacing',
  'lineWidth',
  'opacity',
  'elements',
  'source',
  'metadata',
]

const keyRank = new Map(keyOrder.map((key, index) => [key, index]))

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function stableJsonPretty(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`
}

/**
 * Sort keys deeply using the gitmap-specific priority order (keyRank),
 * with alphabetical as the tiebreaker. Distinct from util/json.ts's
 * `sortDeep`, which does pure alphabetical.
 */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== 'object') return value

  const input = value as Record<string, unknown>
  const output: Record<string, unknown> = {}

  Object.keys(input)
    .filter(key => input[key] !== undefined)
    .sort(compareKeys)
    .forEach(key => {
      output[key] = sortValue(input[key])
    })

  return output
}

function compareKeys(a: string, b: string): number {
  const rankA = keyRank.get(a) ?? Number.MAX_SAFE_INTEGER
  const rankB = keyRank.get(b) ?? Number.MAX_SAFE_INTEGER
  return rankA - rankB || a.localeCompare(b)
}

export { stableJson, stableJsonPretty, sortValue }
