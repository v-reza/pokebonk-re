#!/usr/bin/env node
// tools/apply-bundle-patches.mjs — apply the 0.8.29 co-op patch set in one pass.
//
//   node tools/apply-bundle-patches.mjs --in <app.js> [--out <app.patched.js>] [--check]
//
// Verifies every anchor is present exactly once, refuses to write on a mismatch,
// skips patches already applied, and re-parses the result as an ES module with
// `node --check` before the output path is committed.
//
// Exit codes: 0 applied (or already applied), 1 anchor/parse failure.

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { applyCoopPatches, COOP_PATCHES, UPSTREAM_BUILD } from './bundle-patches-0.8.29.mjs';

function parseArgs(argv) {
  const out = { in: null, out: null, check: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') out.in = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--check') out.check = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** Parse-checks an ES module source without executing it. */
export function parsesAsModule(source) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-parse-'));
  const file = join(dir, 'bundle.mjs');
  try {
    writeFileSync(file, source);
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    return { ok: r.status === 0, error: (r.stderr || '').trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Reports which upstream build a bundle looks like, from its own build stamp. */
export function detectBuild(source) {
  const m = source.match(/pokebonk-build"?\s*content="([a-z0-9]+)"/) || source.match(/-(mvl[a-z0-9]+)\.js/);
  return m ? m[1] : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.in) {
    console.log('usage: node tools/apply-bundle-patches.mjs --in <app.js> [--out <app.patched.js>] [--check]');
    process.exit(args.help ? 0 : 1);
  }

  const inPath = resolve(args.in);
  const source = readFileSync(inPath, 'utf8');

  const build = detectBuild(source);
  if (build && build !== UPSTREAM_BUILD) {
    console.error(`refusing: bundle build is ${build}, patch set targets ${UPSTREAM_BUILD}`);
    process.exit(1);
  }

  let result;
  try {
    result = applyCoopPatches(source);
  } catch (err) {
    console.error(`FAILED ${err.message}`);
    process.exit(1);
  }

  const parse = parsesAsModule(result.source);
  if (!parse.ok) {
    console.error('FAILED patched bundle does not parse:\n' + parse.error);
    process.exit(1);
  }

  const delta = result.source.length - source.length;
  const summary = {
    input: inPath,
    build: build ?? '(unversioned)',
    patches: COOP_PATCHES.length,
    applied: result.applied,
    skipped: result.skipped,
    bytesAdded: delta,
    parses: true,
  };

  if (args.check) {
    console.log(JSON.stringify({ ...summary, wrote: null }, null, 2));
    return;
  }

  const outPath = resolve(args.out ?? inPath.replace(/\.js$/, '.patched.js'));
  writeFileSync(outPath, result.source);
  console.log(JSON.stringify({ ...summary, wrote: outPath }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
