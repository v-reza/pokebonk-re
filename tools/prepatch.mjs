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
//   node tools/prepatch.mjs [outDir]     # default outDir: ./dist
//
// Shared patch tables and assertions are imported from ./bundle-patches.mjs.
import { cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BUNDLE_PATCHES, applyPatches, assertMirrorHooks } from './bundle-patches.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'public');
const targetArg = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'dist');
const OUT = targetArg;

const BUNDLE_REL = path.join('assets', 'main-D5OUVqGK-mvilprw2.js');
const srcBundle = path.join(SRC, BUNDLE_REL);

if (!existsSync(srcBundle)) {
  console.error(`[prepatch] bundle not found: ${srcBundle}`);
  process.exit(1);
}

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

  if (!htmlSrc.includes(securedNeedle) || htmlSrc.includes(unconstrainedNeedle)) {
    throw new Error(
      '[prepatch] Security guard failure: index.html permits unconditional local-relay fallback (?local=1) on non-localhost origins. Production builds must enforce isLocalHost.'
    );
  }

  return htmlSrc;
}

try {
  const isSelf = OUT === SRC;
  if (!isSelf) {
    await rm(OUT, { recursive: true, force: true });
    await cp(SRC, OUT, { recursive: true });

    // Copy client-side networking modules into OUT/net/
    const netSrc = path.join(ROOT, 'net');
    const netOut = path.join(OUT, 'net');
    await mkdir(netOut, { recursive: true });
    const clientNetFiles = ['net.mjs', 'coop.mjs', 'codec.mjs', 'signaling-firebase.mjs', 'signaling-local.mjs'];
    for (const f of clientNetFiles) {
      const srcFile = path.join(netSrc, f);
      if (existsSync(srcFile)) {
        await cp(srcFile, path.join(netOut, f));
      }
    }

    // Copy public client Firebase config into OUT/firebase/
    const fbOut = path.join(OUT, 'firebase');
    await mkdir(fbOut, { recursive: true });
    const fbClientConfig = path.join(ROOT, 'firebase', 'firebase-config.js');
    if (existsSync(fbClientConfig)) {
      await cp(fbClientConfig, path.join(fbOut, 'firebase-config.js'));
    }
  }

  // Secure index.html in the deploy tree
  const outIndex = path.join(OUT, 'index.html');
  if (existsSync(outIndex)) {
    const rawHtml = await readFile(outIndex, 'utf8');
    const securedHtml = patchAndAssertIndexHtml(rawHtml);
    if (securedHtml !== rawHtml) {
      await writeFile(outIndex, securedHtml);
      console.log(`[prepatch] secured index.html with localhost-only co-op guard`);
    } else {
      console.log(`[prepatch] index.html already enforces localhost-only co-op guard`);
    }
  }

  // Patch game bundle
  const outBundle = path.join(OUT, BUNDLE_REL);
  const src = await readFile(outBundle, 'utf8');
  assertMirrorHooks(src);

  const patched = applyPatches(src, BUNDLE_PATCHES, BUNDLE_REL);
  const beforeLen = Buffer.byteLength(src, 'utf8');
  const afterLen = Buffer.byteLength(patched, 'utf8');

  await writeFile(outBundle, patched);
  console.log(`[prepatch] successfully patched ${BUNDLE_REL}`);
  console.log(`  size: ${beforeLen} -> ${afterLen} bytes (delta: ${afterLen - beforeLen >= 0 ? '+' : ''}${afterLen - beforeLen})`);
  console.log(`[prepatch] output ready at: ${OUT}`);
} catch (err) {
  console.error('[prepatch] FATAL:', err.message || err);
  process.exit(1);
}
