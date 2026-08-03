import test from 'ava'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readGitmap } from '../src/formats/gitmap/read.ts'
import { writeGitmap } from '../src/formats/gitmap/write.ts'
import PanMap from '../src/map/model.ts'

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

test('extensions round-trip through the gitmap package', async t => {
  const dir = await tempDir('gitmap-ext-')
  try {
    const original = new PanMap({
      sourceFormat: 'test',
      colors: [],
      symbols: [],
      objects: [],
      notes: 'Human-authored map notes.',
      extensions: {
        'club/season': '2026-summer',
        'mapwall/publish_state': 'draft',
        'vendor/nested': { flag: true, list: [1, 2, 3] },
      },
    })

    await writeGitmap(original, dir, { overwrite: true })

    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, 'gitmap.json'), 'utf-8')
    )
    t.is(manifest.notes, 'Human-authored map notes.')
    t.deepEqual(manifest.extensions, original.extensions)

    const read = await readGitmap(dir)
    t.is(read.notes, original.notes)
    t.deepEqual(read.extensions, original.extensions)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('gitmap package omits extensions when empty', async t => {
  const dir = await tempDir('gitmap-noext-')
  try {
    const original = new PanMap({
      sourceFormat: 'test',
      colors: [],
      symbols: [],
      objects: [],
    })
    await writeGitmap(original, dir, { overwrite: true })
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, 'gitmap.json'), 'utf-8')
    )
    t.false('extensions' in manifest)
    t.false('notes' in manifest)

    const read = await readGitmap(dir)
    t.deepEqual(read.extensions, {})
    t.is(read.notes, '')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
