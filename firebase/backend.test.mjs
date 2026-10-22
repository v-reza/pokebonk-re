// PokéBonk — Firebase backend tests (node:test).
//
// Exercises the route handlers against an in-memory DB fake, so no Firebase SDK
// or emulator is required. Run with:
//
//   node --test firebase/backend.test.mjs
//
// Covers the acceptance flow: guest create → /auth/me → /profile get →
// /profile save → /runs POST → /runs/:id/finish (persisting end to end),
// plus register/login, name availability, leaderboard and auth failures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend, MemoryDB } from './backend.mjs';

const backend = createBackend(new MemoryDB());

// Minimal fetch-like harness: builds a fake req/res and runs a route handler.
async function call(method, path, { token, body } = {}) {
  const url = new URL(path, 'http://localhost');
  const m = backend.match(method, url.pathname);
  assert.ok(m, `no route matched ${method} ${url.pathname}`);
  const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const req = {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; },
  };
  const res = {
    status: null,
    headers: null,
    buf: Buffer.alloc(0),
    ended: false,
    writeHead(code, headers) {
      if (this.ended) throw new Error('ERR_HTTP_HEADERS_SENT: headers already sent');
      this.status = code; this.headers = headers;
    },
    end(b) { this.buf = b ?? Buffer.alloc(0); this.ended = true; },
  };
  Object.defineProperty(res, 'writableEnded', { get: () => res.ended });

  const out = await m.handler(req, res, url, m.params);
  if (out !== undefined && !res.ended) {
    res.status = 200;
    res.buf = Buffer.from(JSON.stringify(out));
    res.ended = true;
  }
  const json = res.buf.length ? JSON.parse(res.buf.toString('utf8')) : null;
  return { status: res.status, json };
}

test('guest → me → profile → prefs → run → finish persists end to end', async () => {
  // 1. guest create
  const g = await call('POST', '/auth/guest');
  assert.equal(g.status, 200);
  assert.ok(g.json.id);
  assert.ok(g.json.token);
  assert.equal(g.json.guest, true);

  // 2. /auth/me
  const me = await call('GET', '/auth/me', { token: g.json.token });
  assert.equal(me.status, 200);
  assert.equal(me.json.id, g.json.id);
  assert.equal(me.json.name, g.json.name);
  assert.equal(me.json.guest, true);
  assert.ok(me.json.created > 0);

  // 3. /profile get
  const prof = await call('GET', '/profile', { token: g.json.token });
  assert.equal(prof.status, 200);
  assert.equal(prof.json.profile.name, g.json.name);
  assert.ok(prof.json.now > 0);

  // 4. /profile save (prefs)
  const prefs = await call('PUT', '/profile/prefs', {
    token: g.json.token,
    body: { settings: { music: 0.25 }, lastSpecies: 25 },
  });
  assert.equal(prefs.status, 204);
  const prof2 = await call('GET', '/profile', { token: g.json.token });
  assert.equal(prof2.json.profile.settings.music, 0.25);
  assert.equal(prof2.json.profile.lastSpecies, 25);

  // 5. /runs POST
  const run = await call('POST', '/runs', { token: g.json.token, body: { biome: 'forest' } });
  assert.equal(run.status, 200);
  assert.ok(run.json.id);
  assert.ok(Number.isInteger(run.json.seed));
  assert.equal(run.json.ranked, true);

  // 6. /runs/:id/finish
  const fin = await call('POST', `/runs/${run.json.id}/finish`, {
    token: g.json.token,
    body: {
      result: {
        kills: 300, biome: 'forest', tier: 1, species: 4,
        victory: true, time: 120,
        progress: { seen: [4], league: [7], shinies: [] },
      },
    },
  });
  assert.equal(fin.status, 200);
  assert.equal(fin.json.record.id, run.json.id);
  assert.equal(fin.json.profile.counters.runs, 1);
  assert.equal(fin.json.profile.counters.kills, 300);
  assert.ok(fin.json.profile.runs.length >= 1);
  assert.ok(fin.json.profile.stardust >= 1);
  assert.ok(fin.json.ends > 0);

  // 7. persistence: the finished run survives a fresh /profile read
  const prof3 = await call('GET', '/profile', { token: g.json.token });
  assert.equal(prof3.json.profile.runs[0].id, run.json.id);
  assert.equal(prof3.json.profile.runs[0].kills, 300);
  assert.deepEqual(prof3.json.profile.seen, [4]);
  assert.deepEqual(prof3.json.profile.league, [7]);
});

test('register, login, name availability and conflict', async () => {
  const name = 'AshKetchum';
  const ok = await call('GET', `/auth/name?name=${name}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);

  const reg = await call('POST', '/auth/register', { body: { name, password: 'secret123' } });
  assert.equal(reg.status, 200);
  assert.equal(reg.json.name, name);
  assert.equal(reg.json.guest, false);

  // duplicate name → 409
  const dup = await call('POST', '/auth/register', { body: { name, password: 'other' } });
  assert.equal(dup.status, 409);

  // now unavailable
  const taken = await call('GET', `/auth/name?name=${name}`);
  assert.equal(taken.json.ok, false);

  // login correct
  const login = await call('POST', '/auth/login', { body: { name, password: 'secret123' } });
  assert.equal(login.status, 200);
  assert.equal(login.json.id, reg.json.id);

  // login wrong password → 401
  const bad = await call('POST', '/auth/login', { body: { name, password: 'nope' } });
  assert.equal(bad.status, 401);
});

test('leaderboard ranks a finished run; auth failures return 401', async () => {
  // profile read without a token → 401
  const noAuth = await call('GET', '/profile');
  assert.equal(noAuth.status, 401);

  // invalid token → 401
  const badToken = await call('GET', '/profile', { token: 'bogus-token' });
  assert.equal(badToken.status, 401);

  const g = await call('POST', '/auth/guest');
  const run = await call('POST', '/runs', { token: g.json.token, body: { biome: 'forest' } });
  await call('POST', `/runs/${run.json.id}/finish`, {
    token: g.json.token,
    body: { result: { kills: 500, biome: 'forest', tier: 1, species: 4, victory: true, time: 90 } },
  });

  const lb = await call('GET', '/leaderboard?mode=kills&season=week');
  assert.equal(lb.status, 200);
  assert.ok(lb.json.entries.some((e) => e.id === g.json.id));
  const mine = lb.json.entries.find((e) => e.id === g.json.id);
  assert.equal(mine.kills, 500);
  assert.ok(mine.rank >= 1);
});
