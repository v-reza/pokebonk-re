// tools/prepatch.mjs — produce a deploy-ready copy of the client for Firebase Hosting.
//
// Firebase Hosting serves files statically and CANNOT perform server.mjs's
// serve-time rewrite of the client bundle, so the bundle must be patched ahead of
// time. This build step performs the same two string substitutions server.mjs
// applies at serve time, and writes a full, self-contained deployable tree:
//
//   1. https://api.pokebonk.com                                           -> /api
//   2. https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit -> /turnstile-stub.js
//
// Usage:
//   node tools/prepatch.mjs [outDir]     # default outDir: ./deploy
//
// It copies public/ -> outDir/ verbatim (index.html and every other asset byte-for-
// byte untouched), then patches only the served bundle
// public/assets/main-D5OUVqGK-mvilprw2.js inside the copy. The original public/
// tree is never modified. This is the only piece that needs to exist for the client
// to work without server.mjs — server.mjs's Cloudflare RUM beacon strip on
// index.html is a cosmetic analytics removal and is intentionally out of scope here.
import { cp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'public');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'deploy'));

const BUNDLE_REL = 'assets/main-D5OUVqGK-mvilprw2.js';

// Same two substitutions server.mjs applies at serve time (keep in sync).
const PATCHES = [
  ['https://api.pokebonk.com', '/api'],
  ['https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', '/turnstile-stub.js'],
];

const srcBundle = path.join(SRC, BUNDLE_REL);
if (!existsSync(srcBundle)) {
  console.error(`Bundle not found: ${srcBundle}`);
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await cp(SRC, OUT, { recursive: true });

const outBundle = path.join(OUT, BUNDLE_REL);
let src = await readFile(outBundle, 'utf8');
const before = src;
let changed = 0;
for (const [from, to] of PATCHES) {
  const n = src.split(from).length - 1;
  if (n > 0) changed += n;
  src = src.split(from).join(to);
}

if (changed === 0) {
  console.warn('WARNING: no substitution targets found in the bundle (already patched, or the bundle changed).');
} else {
  console.log(`Patched ${changed} occurrence(s) in ${BUNDLE_REL}`);
}
console.log(`  ${before.length} -> ${src.length} bytes`);
await writeFile(outBundle, src);
console.log(`Deploy tree ready at ${OUT}`);
console.log('  Point firebase.json "hosting.public" at this dir, then: npx firebase deploy --only hosting');
