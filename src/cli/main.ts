#!/usr/bin/env node
import { program } from 'commander'
import { runInfo } from './info.js'
import { runConvert } from './convert.js'
import { runExport } from './export.js'
import { runDiff } from './diff.js'

// Wrap a subcommand handler so any thrown error prints a single-line
// message and exits non-zero — every subcommand gets the same treatment
// instead of each one inventing its own console.error / process.exit dance.
function run<A extends unknown[]>(
  fn: (...args: A) => Promise<void>
): (...args: A) => Promise<void> {
  return async (...args) => {
    try {
      await fn(...args)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`panmap: ${message}`)
      process.exit(1)
    }
  }
}

program
  .command('info <path>')
  .description('display map file info')
  .option(
    '--symbols [identifiers]',
    'dump symbol info (comma-separated codes); pass without value to dump all'
  )
  .option(
    '--icons-bits',
    "include symbols' iconBits property (OCAD only, hidden by default)"
  )
  .option(
    '--parameter-strings [types]',
    'dump OCAD parameter strings (comma-separated type ids); pass without value to dump all'
  )
  .option(
    '--object-strings [symbols]',
    'dump per-object strings (comma-separated symbol codes); pass without value to dump all'
  )
  .action(run(runInfo))

program
  .command('convert <input> <output>')
  .description(
    'losslessly convert between native formats (ocad/ocd, xmap/omap, gitmap)'
  )
  .option(
    '-f, --format <string>',
    'output format; otherwise guessed from output file extension'
  )
  .action(run(runConvert))

program
  .command('export <input> <output>')
  .description('export to a lossy target (svg, geojson, mvt)')
  .option(
    '-f, --format <string>',
    'output format; otherwise guessed from output file extension'
  )
  .option(
    '--symbols <identifiers>',
    'limit the output by a comma separated list of symbol identifiers'
  )
  .option('--export-hidden', 'include hidden objects in the export', false)
  .option(
    '--crs <string>',
    'exported CRS for geojson: "source" (unmodified), "projection" (default), or "wgs84"',
    'projection'
  )
  .option(
    '--white-background',
    'render SVG exports with a white background',
    false
  )
  .action(run(runExport))

program
  .command('diff <before> <after> <output>')
  .description('render a visual SVG diff between two maps')
  .option(
    '--white-background',
    'render with a white background',
    false,
  )
  .option(
    '--changes <path>',
    'also write a JSON list of per-feature changes (with bounds) to <path>',
  )
  .action(run(runDiff))

program.parse(process.argv)
