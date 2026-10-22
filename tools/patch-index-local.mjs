// tools/patch-index-local.mjs — standalone script to patch public/index.html in place.
//
// Restricts the local SSE relay (?local=1) to localhost / 127.0.0.1 so production
// deployments on public domains never trigger the local relay.
//
// NOTE: Kept in sync with tools/prepatch.mjs's dist-time rewrite (patchAndAssertIndexHtml).
// See also docs/DEPLOY.md §6.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const TARGET = path.join(ROOT, 'public', 'index.html');

const UNCONSTRAINED_ANCHOR = "globalThis.__pbUseLocal = qs.has('local') || qs.get('coop') === 'local';";
const SECURED_SNIPPET =
  "const isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';\n" +
  "        globalThis.__pbUseLocal = isLocalHost && (qs.has('local') || qs.get('coop') === 'local');";

const src = await readFile(TARGET, 'utf8');

const isAlreadyPatched =
  src.includes(SECURED_SNIPPET) ||
  src.includes(SECURED_SNIPPET.replace(/\n/g, '\r\n')) ||
  src.includes("isLocalHost && (qs.has('local') || qs.get('coop') === 'local');");

if (isAlreadyPatched) {
  console.log(`[patch-index-local] ${TARGET} is already patched with the localhost-only co-op guard. Nothing to do.`);
  process.exit(0);
}

if (!src.includes(UNCONSTRAINED_ANCHOR)) {
  console.error(`[patch-index-local] FATAL: Anchor not found in ${TARGET}:`);
  console.error(`  Expected: ${JSON.stringify(UNCONSTRAINED_ANCHOR)}`);
  process.exit(1);
}

const patched = src.replace(UNCONSTRAINED_ANCHOR, SECURED_SNIPPET);

console.log('=== BEFORE ===');
console.log(`        ${UNCONSTRAINED_ANCHOR}`);
console.log('\n=== AFTER ===');
console.log(`        ${SECURED_SNIPPET}`);

await writeFile(TARGET, patched);
console.log(`\n[patch-index-local] Successfully updated ${TARGET}`);
