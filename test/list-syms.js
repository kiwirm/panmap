import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ocad } from '../src/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = process.argv[2] ?? 'bottle-lake-merged'
const CODE = process.argv[3] ?? '509'
const OCD = path.join(HERE, 'parity-fixtures', FIX, 'mapper.ocd')

async function main() {
  const f = await ocad.readRaw(OCD, { quietWarnings: true })
  const syms = f.symbols.filter(s => String(s.number ?? '').startsWith(CODE))
  for (const s of syms) {
    console.log(`sym ${s.symNum} (${s.number}) otp=${s.otp} lineColor=${s.lineColor} colors=${s.colors?.slice(0, s.nColors)}`)
  }
}
main()
