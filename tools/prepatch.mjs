// tools/prepatch.mjs — produce a deploy-ready static client build.
//
// Static hosts (such as Vercel) serve files statically and cannot perform
// server.mjs's serve-time bundle patching. This build step applies the shared
// co-op patches and backend redirects ahead of time.
//
// It also gathers all client-side runtime modules into the deploy tree:
//   - public/ (upstream static bundle, assets, HTML, coop-ui)
//   - net/ (WebRTC, codec, co-op engine, and Firebase signaling adapter)
//   - firebase/firebase-config.js (browser-safe client Firebase config)
//
// And asserts/secures index.html to guarantee production environments NEVER
// fall back to the local SSE relay.
//
// Usage:
//   node tools/prepatch.mjs [outDir] [--write] [options]     # default outDir: ./dist
//
// Shared patch tables and assertions are imported from ./bundle-patches.mjs
// and ./bundle-patches-0.8.29.mjs.
import { cp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD, VERSION, ENTRY, GAME, INDEX, LEGACY } from './build-target.mjs';
import { BUNDLE_PATCHES, REDIRECT_PATCHES, applyPatches, assertMirrorHooks } from './bundle-patches.mjs';
import { applyCoopPatches } from './bundle-patches-0.8.29.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'public');

/**
 * Rewrites and asserts that index.html only permits the local SSE relay
 * on localhost origins. Fails loudly with an Error if unconstrained bypass remains.
 *
 * NOTE: Kept in sync with tools/patch-index-local.mjs (which patches public/index.html
 * in place once concurrent edits land). See also docs/DEPLOY.md §6.
 */
export function patchAndAssertIndexHtml(htmlSrc) {
  const unconstrainedNeedle = "globalThis.__pbUseLocal = qs.has('local') || qs.get('coop') === 'local';";
  const securedNeedle = "isLocalHost && (qs.has('local') || qs.get('coop') === 'local');";

  if (htmlSrc.includes(unconstrainedNeedle)) {
    const replacement =
      "const isLocalHost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';\n" +
      "        globalThis.__pbUseLocal = isLocalHost && (qs.has('local') || qs.get('coop') === 'local');";
    htmlSrc = htmlSrc.replace(unconstrainedNeedle, replacement);
  }

  if (htmlSrc.includes(unconstrainedNeedle)) {
    throw new Error(
      '[prepatch] Security guard failure: index.html permits unconditional local-relay fallback (?local=1) on non-localhost origins. Production builds must enforce isLocalHost.'
    );
  }

  return htmlSrc;
}

export function showHelp() {
  console.log(`Usage: node tools/prepatch.mjs [outDir] [options]

Produce a deploy-ready static client build.

Arguments:
  outDir             Target output directory (default: ./dist)

Options:
  --write            Write changes to disk (defaults to dry-run)
  --dry-run          Explicitly run in dry-run mode (default)
  --legacy           Target legacy 0.8.13 build (${LEGACY.BUILD})
  --index <file>     Target HTML index page (default: ${INDEX})
  --entry <file>     Target entry chunk (default: ${ENTRY})
  --game <file>      Target game chunk (default: ${GAME})
  -h, --help         Show this help message`);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    showHelp();
    return { help: true };
  }

  const shouldWrite = argv.includes('--write');
  const isLegacy = argv.includes('--legacy');

  let outDirArg = null;
  let customIndex = null;
  let customEntry = null;
  let customGame = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--index' && i + 1 < argv.length) {
      customIndex = argv[++i];
    } else if (a === '--entry' && i + 1 < argv.length) {
      customEntry = argv[++i];
    } else if (a === '--game' && i + 1 < argv.length) {
      customGame = argv[++i];
    } else if (!a.startsWith('-') && !outDirArg) {
      outDirArg = a;
    }
  }

  const OUT = outDirArg ? path.resolve(outDirArg) : path.join(ROOT, 'dist');
  const build = isLegacy ? LEGACY.BUILD : BUILD;
  const version = isLegacy ? LEGACY.VERSION : VERSION;
  const indexFile = customIndex || (isLegacy ? LEGACY.INDEX : INDEX);
  const entryFile = customEntry || (isLegacy ? LEGACY.ENTRY : ENTRY);
  const gameFile = customGame || (isLegacy ? LEGACY.GAME : GAME);

  const BUNDLE_REL = path.join('assets', gameFile);
  const srcBundle = path.join(SRC, BUNDLE_REL);
  const srcIndex = path.join(SRC, indexFile);

  if (!existsSync(srcBundle)) {
    const msg = `[prepatch] bundle not found: ${srcBundle}`;
    if (!shouldWrite) {
      console.warn(`[prepatch] (dry-run) ${msg}`);
      return { dryRun: true, error: msg, wouldTouch: [] };
    }
    console.error(msg);
    process.exit(1);
  }

  if (!existsSync(srcIndex)) {
    const msg = `[prepatch] index not found: ${srcIndex}`;
    if (!shouldWrite) {
      console.warn(`[prepatch] (dry-run) ${msg}`);
      return { dryRun: true, error: msg, wouldTouch: [] };
    }
    console.error(msg);
    process.exit(1);
  }

  if (!shouldWrite) {
    const wouldTouch = [
      path.join(OUT, 'index.html'),
      path.join(OUT, BUNDLE_REL),
      path.join(OUT, 'net', 'net.mjs'),
      path.join(OUT, 'net', 'coop.mjs'),
      path.join(OUT, 'net', 'codec.mjs'),
      path.join(OUT, 'net', 'signaling-firebase.mjs'),
      path.join(OUT, 'net', 'signaling-local.mjs'),
      path.join(OUT, 'firebase', 'firebase-config.js'),
    ];

    console.log(`[prepatch] (dry-run) Target build: ${build} (v${version})`);
    console.log(`[prepatch] (dry-run) Source index: ${indexFile} -> ${path.join(OUT, 'index.html')}`);
    console.log(`[prepatch] (dry-run) Entry chunk: assets/${entryFile}`);
    console.log(`[prepatch] (dry-run) Game bundle: ${BUNDLE_REL}`);
    console.log(`[prepatch] (dry-run) Output directory: ${OUT}`);
    console.log(`[prepatch] (dry-run) Would touch / write ${wouldTouch.length} files:`);
    for (const f of wouldTouch) console.log(`  - ${f}`);
    console.log(`[prepatch] (dry-run) No files written. Pass --write to apply changes.`);
    return { dryRun: true, wouldTouch };
  }

  const touched = [];
  const isSelf = OUT === SRC;
  if (!isSelf) {
    await rm(OUT, { recursive: true, force: true });
    await cp(SRC, OUT, { recursive: true });

    // Copy client-side networking modules into OUT/net/
    const netSrc = path.join(ROOT, 'net');
    const netOut = path.join(OUT, 'net');
    await mkdir(netOut, { recursive: true });
    // every module the page can import: the list is derived, not hand-maintained
    const clientNetFiles = (await readdir(netSrc)).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
    for (const f of clientNetFiles) {
      const srcFile = path.join(netSrc, f);
      if (existsSync(srcFile)) {
        const dest = path.join(netOut, f);
        await cp(srcFile, dest);
        touched.push(dest);
      }
    }

    // Copy public client Firebase config into OUT/firebase/
    const fbOut = path.join(OUT, 'firebase');
    await mkdir(fbOut, { recursive: true });
    const fbClientConfig = path.join(ROOT, 'firebase', 'firebase-config.js');
    if (existsSync(fbClientConfig)) {
      const dest = path.join(fbOut, 'firebase-config.js');
      await cp(fbClientConfig, dest);
      touched.push(dest);
    }
  }

  // Deploy target index to OUT/index.html
  const outIndex = path.join(OUT, 'index.html');
  if (indexFile !== 'index.html' && existsSync(srcIndex)) {
    await cp(srcIndex, outIndex);
  }
  if (existsSync(outIndex)) {
    const rawHtml = await readFile(outIndex, 'utf8');
    const securedHtml = patchAndAssertIndexHtml(rawHtml);
    if (securedHtml !== rawHtml) {
      await writeFile(outIndex, securedHtml);
      console.log(`[prepatch] secured index.html with localhost-only co-op guard`);
    } else {
      console.log(`[prepatch] index.html already enforces localhost-only co-op guard`);
    }
    touched.push(outIndex);
  }

  // Patch game bundle
  const outBundle = path.join(OUT, BUNDLE_REL);
  const src = await readFile(outBundle, 'utf8');
  let patched;
  if (!isLegacy) {
    const redirected = applyPatches(src, REDIRECT_PATCHES, BUNDLE_REL);
    const res = applyCoopPatches(redirected);
    patched = res.source;
    console.log(`[prepatch] applied redirects + ${res.applied.length} co-op hooks (${build})`);
  } else {
    assertMirrorHooks(src);
    patched = applyPatches(src, BUNDLE_PATCHES, BUNDLE_REL);
  }
  const beforeLen = Buffer.byteLength(src, 'utf8');
  const afterLen = Buffer.byteLength(patched, 'utf8');

  await writeFile(outBundle, patched);
  touched.push(outBundle);
  if (!patched.includes('__pbCoop')) {
    console.error('[prepatch] FATAL: patched bundle does not contain __pbCoop');
    process.exit(1);
  }
  if (patched.includes('https://api.pokebonk.com')) {
    console.error('[prepatch] FATAL: patched bundle still points at api.pokebonk.com');
    process.exit(1);
  }
  console.log(`[prepatch] successfully patched ${BUNDLE_REL}`);
  console.log(`  size: ${beforeLen} -> ${afterLen} bytes (delta: ${afterLen - beforeLen >= 0 ? '+' : ''}${afterLen - beforeLen})`);
  console.log(`[prepatch] Touched / wrote ${touched.length} files:`);
  for (const f of touched) console.log(`  - ${f}`);
  console.log(`[prepatch] output ready at: ${OUT}`);
  return { dryRun: false, touched };
}

const isDirectExecution = Boolean(process.argv[1] && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase());
if (isDirectExecution) {
  main().catch((err) => {
    console.error('[prepatch] FATAL:', err.message || err);
    process.exit(1);
  });
}
