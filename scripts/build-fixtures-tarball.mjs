#!/usr/bin/env node
// Build the bundled test-fixture tarball and write the checked-in manifest.
//
// Input:  test/fixtures/<map>/<file>  (skips the git-tracked smoke folders
//         listed in SMOKE below — those ship in the repo).
// Output: build/panmap-fixtures-<VERSION>.tar.gz
//         test/fixtures.manifest.json
//
// Bump VERSION whenever the fixture set changes so pinned checkouts pull
// the version they were tested with, not the newest.
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIX = path.join(ROOT, 'test', 'fixtures')
const BUILD = path.join(ROOT, 'build')
const MANIFEST = path.join(ROOT, 'test', 'fixtures.manifest.json')
const VERSION = 'v1'
const ASSET = `panmap-fixtures-${VERSION}.tar.gz`
const RELEASE_URL_BASE = `https://github.com/kiwirm/panmap/releases/download/fixtures-${VERSION}`

// Smoke folders — tracked in git, excluded from the tarball so we don't
// ship them twice. Keep in sync with .gitignore allow-list.
const SMOKE = new Set(['basic-1', 'double-line', 'ara'])

async function sha256File(p) {
  return await new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(p)
      .on('data', c => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

function listMaps() {
  return readdirSync(FIX)
    .filter(name => !SMOKE.has(name))
    .filter(name => {
      try {
        return statSync(path.join(FIX, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}

function listFiles(mapDir) {
  return readdirSync(path.join(FIX, mapDir))
    .filter(f => f.endsWith('.ocd') || f.endsWith('.xmap'))
    .sort()
}

mkdirSync(BUILD, { recursive: true })
const maps = listMaps()
console.log(
  `bundling ${maps.length} maps (excluding smoke: ${[...SMOKE].join(', ')})`,
)

// -- tar --
const tarPath = path.join(BUILD, ASSET)
const includes = maps.join(' ')
execSync(`tar -czf "${tarPath}" -C "${FIX}" ${includes}`, { stdio: 'inherit' })
const tarSha = await sha256File(tarPath)
const tarBytes = statSync(tarPath).size
console.log(
  `\ntarball ${(tarBytes / 1024 / 1024).toFixed(1)} MiB  sha256=${tarSha}`,
)

// -- per-file manifest --
const manifest = {
  release: RELEASE_URL_BASE,
  asset: ASSET,
  asset_sha256: tarSha,
  asset_bytes: tarBytes,
  maps: {},
}
let fileCount = 0
for (const map of maps) {
  const entries = []
  for (const f of listFiles(map)) {
    const abs = path.join(FIX, map, f)
    entries.push({
      file: `${map}/${f}`,
      sha256: await sha256File(abs),
      bytes: statSync(abs).size,
    })
    fileCount++
  }
  manifest.maps[map] = entries
}

writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
console.log(
  `wrote ${path.relative(ROOT, MANIFEST)} (${maps.length} maps, ${fileCount} files)`,
)
