// ============ signaling.test.mjs — end-to-end test of the local relay + bundle ============
// Boots server.mjs on a spare port and exercises:
//   - index.html importmap/bootstrap bridge
//   - the patched bundle is served with the co-op hooks + intact string-patch literals
//   - /net/*.mjs modules are served
//   - the /signaling relay: subscribe (SSE) -> send (POST) -> deliver one message
// Run:  node --test net/signaling.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8199;
const BASE = `http://127.0.0.1:${PORT}`;

let server;

before(async () => {
  server = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // wait for the server to start listening
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${BASE}/status`); break; } catch { await sleep(150); }
  }
});

after(() => { if (server) server.kill(); });

async function readBody(pathname) {
  const r = await fetch(`${BASE}${pathname}`);
  assert.ok(r.ok, `${pathname} -> ${r.status}`);
  return r.text();
}

test('legacy index-0.8.13.html carries its co-op bridge', async () => {
  const legacyHtml = await readBody('/index-0.8.13.html');
  assert.match(legacyHtml, /__pbStartCoop/);
  assert.match(legacyHtml, /signaling-local\.mjs/);
  assert.match(legacyHtml, /__pbMakePuppets/);

  const defaultHtml = await readBody('/');
  const { BUILD, GAME } = await import('../tools/build-target.mjs');
  assert.ok(
    defaultHtml.includes(BUILD) || defaultHtml.includes(GAME),
    'default page should be the current build (' + BUILD + ')',
  );
});

test('patched bundle is served with hooks and applied string patches', async () => {
  const js = await readBody('/assets/main-D5OUVqGK-mvilprw2.js');
  // co-op hooks present
  assert.match(js, /__pbMakePuppets/);
  assert.match(js, /enemyAdded\(\{ slot/);
  assert.match(js, /enemyGone\(\{ slot/);
  assert.match(js, /coop\.tick/);
  assert.match(js, /coop\.hit\(/);
  assert.match(js, /coopRemoteUpdate/);
  // serve-time string patches applied: api base -> /api, turnstile -> stub
  assert.match(js, /turnstile-stub\.js/);
  assert.doesNotMatch(js, /challenges\.cloudflare\.com\/turnstile/);
  assert.doesNotMatch(js, /https:\/\/api\.pokebonk\.com/);
});

test('/net/*.mjs modules are served', async () => {
  for (const f of ['net.mjs', 'coop.mjs', 'codec.mjs', 'signaling-local.mjs']) {
    const body = await readBody(`/net/${f}`);
    assert.ok(body.length > 100, `${f} too short`);
  }
});

test('signaling relay: subscribe, send, deliver one message', async () => {
  const room = 'testroom1', to = 'uidB', from = 'uidA';

  const got = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('SSE timeout: message not delivered')), 3000);
    fetch(`${BASE}/signaling/stream?room=${room}&uid=${to}`)
      .then(async (r) => {
        assert.equal(r.status, 200);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        // read until a data: frame arrives
        while (buf.indexOf('data: ') < 0) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
        }
        clearTimeout(t);
        resolve(buf);
      })
      .catch(reject);
  });

  await sleep(200); // let the SSE subscribe register

  const env = JSON.stringify({ f: from, sig: { sdp: { type: 'offer', sdp: 'v=0 test' } } });
  const r = await fetch(`${BASE}/signaling/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room, to, from, data: env }),
  });
  assert.equal(r.status, 204);

  const buf = await got;
  assert.match(buf, /offer/);
});
