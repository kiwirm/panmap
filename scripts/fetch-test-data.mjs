#!/usr/bin/env node
// Bring test/fixtures/ into agreement with test/fixtures.manifest.json.
//
// The manifest declares every bundled file (paths relative to test/fixtures/)
// with its expected sha256. If every file present matches, exit 0. Otherwise
// download the release-asset tarball, verify its sha, extract into
// test/fixtures/, and re-verify. Files in git-tracked smoke folders aren't
// listed in the manifest and are left alone.
//
// Config:
//   PANMAP_FIXTURES_URL — override the download URL (default = manifest's
//   release + asset). Point at a mirror or local file:// URL for CI.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, mkdir, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FIX = path.join(ROOT, 'test', 'fixtures')
const MANIFEST_PATH = path.join(ROOT, 'test', 'fixtures.manifest.json')
const BUILD = path.join(ROOT, 'build')

async function sha256(p) {
  return await new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(p).on('data', c => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts })
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)))
    p.on('error', reject)
  })
}

// Manifest → flat entry list [{file, sha256, bytes}].
function entriesOf(manifest) {
  return Object.values(manifest.maps).flat()
}

async function verify(entries) {
  const missing = [], drifted = []
  for (const e of entries) {
    const p = path.join(FIX, e.file)
    try { await access(p) } catch { missing.push(e.file); continue }
    const got = await sha256(p)
    if (got !== e.sha256) drifted.push({ file: e.file, want: e.sha256, got })
  }
  return { missing, drifted }
}

async function fetchAndExtract(manifest) {
  await mkdir(BUILD, { recursive: true })
  const url = process.env.PANMAP_FIXTURES_URL || `${manifest.release}/${manifest.asset}`
  const tmp = path.join(BUILD, `${manifest.asset}.download`)
  console.log(`→ downloading ${url}`)
  await run('curl', ['-fL', '--retry', '3', '-o', tmp, url])
  const gotSha = await sha256(tmp)
  if (gotSha !== manifest.asset_sha256) {
    await rm(tmp, { force: true })
    throw new Error(`tarball sha mismatch: got ${gotSha}, want ${manifest.asset_sha256}`)
  }
  console.log(`✔ tarball sha ok (${(manifest.asset_bytes / 1024 / 1024).toFixed(1)} MiB)`)
  await mkdir(FIX, { recursive: true })
  console.log(`→ extracting to ${path.relative(ROOT, FIX)}/`)
  await run('tar', ['-xzf', tmp, '-C', FIX])
  await rm(tmp, { force: true })
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf-8'))
const entries = entriesOf(manifest)
const first = await verify(entries)

if (first.missing.length === 0 && first.drifted.length === 0) {
  console.log(`✔ ${entries.length} bundled fixtures OK`)
  process.exit(0)
}

console.log(`→ ${first.missing.length} missing, ${first.drifted.length} drifted — fetching`)
await fetchAndExtract(manifest)

const second = await verify(entries)
if (second.missing.length || second.drifted.length) {
  console.error(`! after fetch: ${second.missing.length} missing, ${second.drifted.length} drifted`)
  for (const f of second.missing) console.error(`  missing: ${f}`)
  for (const d of second.drifted) console.error(`  drifted: ${d.file} (want ${d.want}, got ${d.got})`)
  process.exit(1)
}

console.log(`✔ ${entries.length} bundled fixtures OK`)
