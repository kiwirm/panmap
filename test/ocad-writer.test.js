/**
 * @typedef {import('../node_modules/ava/types/test-fn').ExecutionContext} ExecutionContext
 */
import test from 'ava'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { write as writeMap } from '../src/index.ts'
import { fixtureFile } from './helpers/fixtures.js'
import { readOcad, ocadFileToMap } from './helpers/raw.js'

// Byte- and structural round-trip tests for OCD → Panmap → OCD were
// removed together with the `sourceObject` / `sourceSymbol` sidecar.
// Panmap is now the only representation; OCAD-specific detail
// (icon rasters, tree groups, structure fills, framing, tab stops, …)
// does not survive a trip through Panmap and back. What remains is a
// Panmap-level mutation test: modify the Panmap, write, re-read,
// verify the mutation stuck.

// One small always-present fixture and one large holed map (corpus-only,
// skipped in a bare clone). The invariant is format-agnostic, so a third map
// added nothing.
const FIXTURES = ['basic-1.ocd', 'bottle-lake-bc98714_UpdatedCoady.ocd']

for (const fixture of FIXTURES) {
  const fixturePath = fixtureFile(fixture)
  const exists = fsSync.existsSync(fixturePath)
  const t = exists ? test : test.skip

  t(
    `OCAD writer drops removed objects in ${fixture}`,
    async (/** @type {ExecutionContext} */ tt) => {
      const original = await readOcad(fixturePath, { quietWarnings: true })
      if (original.objects.length === 0) {
        tt.pass('no objects to remove')
        return
      }
      const map = ocadFileToMap(original)
      const half = Math.floor(map.objects.length / 2)
      map.objects = map.objects.slice(0, half)
      original.objects = original.objects.slice(0, half)

      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ocad-mut-'))
      const output = path.join(tmp, fixture)
      await writeMap(map, output)
      const reread = await readOcad(output, { quietWarnings: true })
      tt.is(reread.objects.length, half)
    },
  )
}
