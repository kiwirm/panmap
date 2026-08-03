/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import test from 'ava'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ocad, write as writeMap } from '../src/index.ts'
const readOcad = ocad.readRaw

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Byte- and structural round-trip tests for OCD → PanMap → OCD were
// removed together with the `sourceObject` / `sourceSymbol` sidecar.
// PanMap is now the only representation; OCAD-specific detail
// (icon rasters, tree groups, structure fills, framing, tab stops, …)
// does not survive a trip through PanMap and back. What remains is a
// PanMap-level mutation test: modify the PanMap, write, re-read,
// verify the mutation stuck.

const FIXTURES = [
  '202012_Tahunanui.ocd',
  'bottle-lake-bc98714_UpdatedCoady.ocd',
  'basic-1.ocd',
]

for (const fixture of FIXTURES) {
  const fixturePath = path.join(__dirname, 'data', fixture)
  const exists = fsSync.existsSync(fixturePath)
  const t = exists ? test : test.skip

  t(`OCAD writer drops removed objects in ${fixture}`, async (/** @type {ExecutionContext} */ tt) => {
    const original = await readOcad(fixturePath, { quietWarnings: true })
    if (original.objects.length === 0) {
      tt.pass('no objects to remove')
      return
    }
    const map = ocad.toMap(original)
    const half = Math.floor(map.objects.length / 2)
    map.objects = map.objects.slice(0, half)
    original.objects = original.objects.slice(0, half)

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocad-mut-'))
    const output = path.join(tmp, fixture)
    await writeMap(map, output)
    const reread = await readOcad(output, { quietWarnings: true })
    tt.is(reread.objects.length, half)
  })
}
