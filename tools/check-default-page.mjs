#!/usr/bin/env node
// tools/check-default-page.mjs — Integration check verifying 0.8.29 is the default page
// and that 0.8.13 legacy page remains intact.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STORE_PATH = path.join(ROOT, 'data', 'store.json');

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch {
      // not ready yet
    }
    await wait(100);
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms`);
}

async function main() {
  console.log('[check-default-page] Starting check...');

  // 1. Back up store.json if it exists
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pb-store-backup-'));
  const backupStorePath = path.join(tempDir, 'store.json');
  let hadStore = false;
  if (existsSync(STORE_PATH)) {
    copyFileSync(STORE_PATH, backupStorePath);
    hadStore = true;
  }

  const port = 18000 + (process.pid % 1000) + Math.floor(Math.random() * 500);
  const baseUrl = `http://127.0.0.1:${port}`;
  let child = null;

  try {
    // 2. Spawn server.mjs
    child = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.on('error', (err) => {
      console.error('[check-default-page] Server spawn error:', err);
    });

    await waitForServer(`${baseUrl}/status`);
    console.log(`[check-default-page] Server listening at ${baseUrl}`);

    // 3. Fetch '/' and assert it is the 0.8.29 page
    const rootRes = await fetch(`${baseUrl}/`);
    if (!rootRes.ok) {
      throw new Error(`GET / returned status ${rootRes.status}`);
    }
    const rootHtml = await rootRes.text();

    const buildMatch = rootHtml.match(/meta\s+name=["']pokebonk-build["']\s+content=["']([^"']+)["']/i);
    const build = buildMatch ? buildMatch[1] : null;
    if (build !== 'mvl14oup') {
      throw new Error(`GET / meta[name=pokebonk-build] is '${build}', expected 'mvl14oup'`);
    }

    if (!rootHtml.includes('coop-page-0.8.29.mjs')) {
      throw new Error("GET / does not contain 'coop-page-0.8.29.mjs'");
    }
    console.log('[check-default-page] OK: GET / is 0.8.29 (build mvl14oup, contains coop-page-0.8.29.mjs)');

    // 4. Fetch every ./assets/... reference in the page and assert HTTP 200
    const assetMatches = [...rootHtml.matchAll(/(?:src|href)=["'](\.?\/?assets\/[^"']+)["']/g)];
    const assetUrls = [...new Set(assetMatches.map((m) => m[1]))];
    console.log(`[check-default-page] Checking ${assetUrls.length} assets referenced in default page...`);

    for (const relAsset of assetUrls) {
      const cleanPath = relAsset.startsWith('./') ? relAsset.slice(2) : (relAsset.startsWith('/') ? relAsset.slice(1) : relAsset);
      const assetRes = await fetch(`${baseUrl}/${cleanPath}`);
      if (!assetRes.ok) {
        throw new Error(`Asset ${cleanPath} failed with HTTP ${assetRes.status}`);
      }
    }
    console.log(`[check-default-page] OK: All ${assetUrls.length} assets returned HTTP 200`);

    // 5. Fetch /index-0.8.13.html and assert it references main-BcyzVqXo-mvilprw2.js
    const legacyRes = await fetch(`${baseUrl}/index-0.8.13.html`);
    if (!legacyRes.ok) {
      throw new Error(`GET /index-0.8.13.html returned status ${legacyRes.status}`);
    }
    const legacyHtml = await legacyRes.text();
    if (!legacyHtml.includes('main-BcyzVqXo-mvilprw2.js')) {
      throw new Error("GET /index-0.8.13.html does not reference 'main-BcyzVqXo-mvilprw2.js'");
    }
    console.log('[check-default-page] OK: GET /index-0.8.13.html references legacy entry main-BcyzVqXo-mvilprw2.js');

    // 6. Fetch /assets/main-DEBvJLhQ-mvl14oup.js and assert serve-time patches
    const bundleRes = await fetch(`${baseUrl}/assets/main-DEBvJLhQ-mvl14oup.js`);
    if (!bundleRes.ok) {
      throw new Error(`GET /assets/main-DEBvJLhQ-mvl14oup.js returned status ${bundleRes.status}`);
    }
    const bundleJs = await bundleRes.text();
    if (!bundleJs.includes('__pbCoop')) {
      throw new Error("GET /assets/main-DEBvJLhQ-mvl14oup.js does not contain '__pbCoop'");
    }
    if (bundleJs.includes('assertMirrorHooks') || bundleJs.includes('patch failure')) {
      throw new Error('GET /assets/main-DEBvJLhQ-mvl14oup.js contains patch failure output');
    }
    console.log('[check-default-page] OK: /assets/main-DEBvJLhQ-mvl14oup.js has serve-time co-op patches applied');

    console.log('\n========================================');
    console.log('check-default-page: ALL CHECKS PASSED');
    console.log('========================================\n');
  } finally {
    // Kill child server
    if (child && !child.killed) {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']);
        } else {
          child.kill('SIGTERM');
        }
      } catch {
        // process may have already exited
      }
    }

    // Restore store.json
    if (hadStore) {
      try {
        copyFileSync(backupStorePath, STORE_PATH);
      } catch (e) {
        console.error('[check-default-page] Failed to restore store.json:', e);
      }
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup
    }
  }
}

main().catch((err) => {
  console.error('[check-default-page] FAILED:', err);
  process.exit(1);
});
