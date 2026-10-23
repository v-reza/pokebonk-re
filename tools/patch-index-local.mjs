// tools/patch-index-local.mjs — standalone script to patch index HTML in place.
//
// Defaults to the legacy 0.8.13 index (public/index.html) pinned via LEGACY.INDEX,
// but accepts a custom target file (such as public/index-0.8.13.html) or --index flag.
//
// Restricts the local SSE relay (?local=1) to localhost / 127.0.0.1 so production
// deployments on public domains never trigger the local relay.
//
// NOTE: Kept in sync with tools/prepatch.mjs's dist-time rewrite (patchAndAssertIndexHtml).
// See also docs/DEPLOY.md §6.
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY, INDEX } from './build-target.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

export const UNCONSTRAINED_ANCHOR = "globalThis.__pbUseLocal = qs.has('local') || qs.get('coop') === 'local';";
export const SECURED_SNIPPET =
  "const isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';\n" +
  "        globalThis.__pbUseLocal = isLocalHost && (qs.has('local') || qs.get('coop') === 'local');";

export function showHelp() {
  console.log(`Usage: node tools/patch-index-local.mjs [targetFile] [options]

Patch local index HTML to restrict SSE relay (?local=1) to localhost.

Arguments:
  targetFile         HTML file to patch (default: public/${LEGACY.INDEX} [LEGACY])

Options:
  --write            Write changes to disk (defaults to dry-run)
  --dry-run          Explicitly run in dry-run mode (default)
  --legacy           Explicitly target legacy index (public/${LEGACY.INDEX})
  --index <file>     Target specific index file (e.g. public/${INDEX})
  -h, --help         Show this help message`);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    showHelp();
    return { help: true };
  }

  const shouldWrite = argv.includes('--write');
  const isLegacy = argv.includes('--legacy');

  let targetArg = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--index' && i + 1 < argv.length) {
      targetArg = argv[++i];
    } else if (!a.startsWith('-') && !targetArg) {
      targetArg = a;
    }
  }

  const targetRel = targetArg
    ? (targetArg.startsWith('public') ? targetArg : path.join('public', targetArg))
    : (isLegacy ? path.join('public', LEGACY.INDEX) : path.join('public', LEGACY.INDEX));

  const TARGET = path.isAbsolute(targetArg || '')
    ? targetArg
    : path.resolve(ROOT, targetRel);

  if (!existsSync(TARGET)) {
    const msg = `[patch-index-local] target not found: ${TARGET}`;
    if (!shouldWrite) {
      console.warn(`[patch-index-local] (dry-run) ${msg}`);
      return { dryRun: true, error: msg, wouldTouch: [] };
    }
    console.error(msg);
    process.exit(1);
  }

  const src = await readFile(TARGET, 'utf8');

  const isAlreadyPatched =
    src.includes(SECURED_SNIPPET) ||
    src.includes(SECURED_SNIPPET.replace(/\n/g, '\r\n')) ||
    src.includes("isLocalHost && (qs.has('local') || qs.get('coop') === 'local');");

  if (isAlreadyPatched) {
    console.log(`[patch-index-local] ${TARGET} is already patched with the localhost-only co-op guard. Nothing to do.`);
    if (!shouldWrite) {
      console.log(`[patch-index-local] (dry-run) Would touch 0 files.`);
    }
    return { dryRun: !shouldWrite, touched: [], alreadyPatched: true };
  }

  if (!src.includes(UNCONSTRAINED_ANCHOR)) {
    if (!shouldWrite) {
      console.log(`[patch-index-local] (dry-run) Anchor not found in ${TARGET}. Target does not contain unconstrained SSE relay bypass.`);
      console.log(`[patch-index-local] (dry-run) Would touch 0 files.`);
      return { dryRun: true, touched: [], anchorFound: false };
    }
    console.error(`[patch-index-local] FATAL: Anchor not found in ${TARGET}:`);
    console.error(`  Expected: ${JSON.stringify(UNCONSTRAINED_ANCHOR)}`);
    process.exit(1);
  }

  const patched = src.replace(UNCONSTRAINED_ANCHOR, SECURED_SNIPPET);

  console.log('=== BEFORE ===');
  console.log(`        ${UNCONSTRAINED_ANCHOR}`);
  console.log('\n=== AFTER ===');
  console.log(`        ${SECURED_SNIPPET}`);

  if (!shouldWrite) {
    console.log(`\n[patch-index-local] (dry-run) Would touch: ${TARGET}`);
    console.log(`[patch-index-local] (dry-run) Pass --write to apply changes.`);
    return { dryRun: true, wouldTouch: [TARGET] };
  }

  await writeFile(TARGET, patched);
  console.log(`\n[patch-index-local] Successfully updated ${TARGET}`);
  console.log(`[patch-index-local] Touched file: ${TARGET}`);
  return { dryRun: false, touched: [TARGET] };
}

const isDirectExecution = Boolean(process.argv[1] && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase());
if (isDirectExecution) {
  main().catch((err) => {
    console.error('[patch-index-local] FATAL:', err.message || err);
    process.exit(1);
  });
}
