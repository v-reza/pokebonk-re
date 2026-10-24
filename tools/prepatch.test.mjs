// tools/prepatch.test.mjs — the deploy build must ship a patched, self-contained client.
//
// Regression guard for two deploy-only bugs:
//   * the modern-patch branch was keyed on the literal 'mvl14oup', so a newer
//     upstream build silently fell through to the legacy patch path and the
//     deployed client kept calling https://api.pokebonk.com ("No connection to
//     the server" in the browser);
//   * the client net modules were copied from a hardcoded list, so modules added
//     later (level-barrier, pickups-sync, coop-ctl/boot/bridge/shots) were absent
//     from dist/net and every import 404'd.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main as prepatch } from './prepatch.mjs';
import { GAME, ENTRY } from './build-target.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

test('prepatch ships a patched client with every net module', async () => {
  const out = mkdtempSync(path.join(tmpdir(), 'pb-dist-'));
  try {
    await prepatch([out, '--write']);

    const bundlePath = path.join(out, 'assets', GAME);
    assert.ok(existsSync(bundlePath), `game chunk missing: ${GAME}`);
    const bundle = readFileSync(bundlePath, 'utf8');

    assert.ok(bundle.includes('__pbCoop'), 'co-op hooks must be baked into the deployed chunk');
    assert.ok(!bundle.includes('https://api.pokebonk.com'), 'the deployed chunk must call /api, not upstream');
    assert.ok(bundle.includes('/turnstile-stub.js'), 'Turnstile must point at the local stub');

    // every net module the page can import must be present
    const srcModules = readdirSync(path.join(ROOT, 'net')).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
    const shipped = new Set(readdirSync(path.join(out, 'net')).filter((f) => f.endsWith('.mjs')));
    for (const m of srcModules) assert.ok(shipped.has(m), `dist/net is missing ${m}`);

    // the page must reference the current entry chunk and the co-op bootstrap
    const html = readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(html.includes(ENTRY), `index must load the ${ENTRY} entry`);
    assert.ok(html.includes('coop-page-0.8.29.mjs'), 'index must load the co-op bootstrap');
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
