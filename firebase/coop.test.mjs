// firebase/coop.test.mjs — the /coop/* room service the 0.8.29 client speaks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend, MemoryDB } from './backend.mjs';

const db = new MemoryDB();
const backend = createBackend(db);

async function call(method, path, { token, body } = {}) {
  const url = new URL(path, 'http://localhost');
  const m = backend.match(method, url.pathname);
  assert.ok(m, `no route matched ${method} ${url.pathname}`);
  const chunks = body !== undefined ? [Buffer.from(JSON.stringify(body))] : [];
  const req = {
    method,
    url: path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; },
  };
  const res = {
    status: null, buf: Buffer.alloc(0), ended: false,
    writeHead(code) { this.status = code; },
    end(b) { this.buf = b ?? Buffer.alloc(0); this.ended = true; },
  };
  Object.defineProperty(res, 'writableEnded', { get: () => res.ended });
  const out = await m.handler(req, res, url, m.params);
  if (out !== undefined && !res.ended) {
    res.status = 200; res.buf = Buffer.from(JSON.stringify(out)); res.ended = true;
  }
  return { status: res.status, json: res.buf.length ? JSON.parse(res.buf.toString('utf8')) : null };
}

const player = async () => (await call('POST', '/auth/guest')).json;

test('access advertises co-op', async () => {
  const a = await player();
  const r = await call('GET', '/coop/access', { token: a.token });
  assert.deepEqual(r.json, { show: true, play: true });
});

test('create → join → payload shape with slots', async () => {
  const host = await player();
  const mate = await player();

  const created = await call('POST', '/coop/rooms', { token: host.token, body: { species: 4, skin: null } });
  assert.equal(created.status, 200);
  const code = created.json.room.code;
  assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/, 'client-valid alphabet only (no I/L/O/0/1)');
  assert.equal(created.json.room.host, host.id);
  assert.equal(created.json.room.state, 'lobby');
  assert.equal(created.json.room.members.length, 1);
  assert.equal(created.json.room.members[0].slot, 0);
  assert.equal(created.json.me, host.id);

  const joined = await call('POST', `/coop/rooms/${code}/join`, { token: mate.token, body: { species: 7 } });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.room.members.length, 2);
  assert.deepEqual(joined.json.room.members.map((m) => m.slot).sort(), [0, 1]);
});

test('signals are delivered only to their addressee, by increasing id', async () => {
  const host = await player();
  const mate = await player();
  const code = (await call('POST', '/coop/rooms', { token: host.token, body: { species: 4 } })).json.room.code;
  await call('POST', `/coop/rooms/${code}/join`, { token: mate.token, body: { species: 7 } });

  await call('POST', `/coop/rooms/${code}/signal`, {
    token: host.token,
    body: { to: mate.id, kind: 'offer', data: { sdp: 'v=0' } },
  });
  await call('POST', `/coop/rooms/${code}/signal`, {
    token: host.token,
    body: { to: 'someone-else', kind: 'offer', data: {} },
  });

  const forMate = await call('GET', `/coop/rooms/${code}?after=0`, { token: mate.token });
  assert.equal(forMate.json.signals.length, 1, 'only the addressed signal');
  assert.equal(forMate.json.signals[0].kind, 'offer');
  assert.equal(forMate.json.signals[0].from, host.id);

  const forHost = await call('GET', `/coop/rooms/${code}?after=0`, { token: host.token });
  assert.equal(forHost.json.signals.length, 0, 'your own signals are not echoed');

  const after = forMate.json.signals[0].id;
  const later = await call('GET', `/coop/rooms/${code}?after=${after}`, { token: mate.token });
  assert.equal(later.json.signals.length, 0, 'cursor honoured');
});

test('pick, ready and settings (host only)', async () => {
  const host = await player();
  const mate = await player();
  const code = (await call('POST', '/coop/rooms', { token: host.token, body: { species: 4 } })).json.room.code;
  await call('POST', `/coop/rooms/${code}/join`, { token: mate.token, body: { species: 7 } });

  const pick = await call('POST', `/coop/rooms/${code}/me`, { token: mate.token, body: { species: 25, skin: 'shiny' } });
  const mine = pick.json.room.members.find((m) => m.id === mate.id);
  assert.equal(mine.species, 25);
  assert.equal(mine.skin, 'shiny');

  const ready = await call('POST', `/coop/rooms/${code}/me`, { token: mate.token, body: { ready: true } });
  assert.equal(ready.json.room.members.find((m) => m.id === mate.id).ready, true);

  const denied = await call('POST', `/coop/rooms/${code}/settings`, { token: mate.token, body: { biome: 'cave', tier: 3 } });
  assert.equal(denied.status, 403);
  const ok = await call('POST', `/coop/rooms/${code}/settings`, { token: host.token, body: { biome: 'cave', tier: 3 } });
  assert.equal(ok.json.room.biome, 'cave');
  assert.equal(ok.json.room.tier, 3);
});

test('chat is appended with increasing ids', async () => {
  const host = await player();
  const code = (await call('POST', '/coop/rooms', { token: host.token, body: { species: 4 } })).json.room.code;
  await call('POST', `/coop/rooms/${code}/chat`, { token: host.token, body: { text: '  hola   equipo ' } });
  await call('POST', `/coop/rooms/${code}/chat`, { token: host.token, body: { text: 'vamos' } });
  const poll = await call('GET', `/coop/rooms/${code}?after=0&chat=0`, { token: host.token });
  assert.deepEqual(poll.json.chat.map((c) => c.text), ['hola equipo', 'vamos']);
  assert.deepEqual(poll.json.chat.map((c) => c.id), [1, 2]);
});

test('invites: create, list, decline', async () => {
  const host = await player();
  const mate = await player();
  const code = (await call('POST', '/coop/rooms', { token: host.token, body: { species: 4 } })).json.room.code;

  const inv = await call('POST', `/coop/rooms/${code}/invite`, { token: host.token, body: { user: mate.id } });
  assert.equal(inv.status, 204);

  const list = await call('GET', '/coop/invites', { token: mate.token });
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].code, code);
  assert.equal(list.json[0].id, code, 'the client declines by code');
  assert.equal(list.json[0].from.name, host.name, 'the card needs a player summary');
  assert.equal(typeof list.json[0].created, 'number');

  const declined = await call('POST', `/coop/invites/${list.json[0].code}/decline`, { token: mate.token });
  assert.equal(declined.status, 204);
  const after = await call('GET', '/coop/invites', { token: mate.token });
  assert.deepEqual(after.json, []);
});

test('start is host-only and gives the party one seed for every member', async () => {
  const host = await player();
  const mate = await player();
  const code = (await call('POST', '/coop/rooms', { token: host.token, body: { species: 4 } })).json.room.code;
  await call('POST', `/coop/rooms/${code}/join`, { token: mate.token, body: { species: 7 } });

  const denied = await call('POST', `/coop/rooms/${code}/start`, { token: mate.token, body: {} });
  assert.equal(denied.status, 403);

  const started = await call('POST', `/coop/rooms/${code}/start`, { token: host.token, body: {} });
  assert.equal(started.json.room.state, 'started');
  const party = started.json.room.party;
  const seed = started.json.room.seed;
  assert.ok(party && typeof seed === 'number');

  // both members ask for a run ticket with that party → same seed (shared world)
  const t1 = await call('POST', '/runs', { token: host.token, body: { party, species: 4 } });
  const t2 = await call('POST', '/runs', { token: mate.token, body: { party, species: 7 } });
  assert.equal(t1.json.seed, t2.json.seed, 'one seed per party');
  assert.equal(t1.json.party, party);
  assert.equal(t1.json.seed, seed, 'the seed the room announced is the one used');
});

test('leave: members drop, host passes on, empty room closes', async () => {
  const host = await player();
  const mate = await player();
  const code = (await call('POST', '/coop/rooms', { token: host.token, body: { species: 4 } })).json.room.code;
  await call('POST', `/coop/rooms/${code}/join`, { token: mate.token, body: { species: 7 } });

  const leftMate = await call('POST', `/coop/rooms/${code}/leave`, { token: mate.token, body: {} });
  assert.equal(leftMate.json.room.members.length, 1);

  await call('POST', `/coop/rooms/${code}/join`, { token: mate.token, body: { species: 7 } });
  const leftHost = await call('POST', `/coop/rooms/${code}/leave`, { token: host.token, body: {} });
  assert.equal(leftHost.json.room.host, mate.id, 'host passed to the remaining member');
  assert.equal(leftHost.json.room.state, 'lobby');

  const gone = await call('POST', `/coop/rooms/${code}/leave`, { token: mate.token, body: {} });
  assert.equal(gone.json.room, null);
  const after = await call('GET', `/coop/rooms/${code}?after=0`, { token: mate.token });
  assert.equal(after.status, 404, 'closed room is gone');
});

test('kick is host-only and removes the member', async () => {
  const host = await player();
  const mate = await player();
  const code = (await call('POST', '/coop/rooms', { token: host.token, body: { species: 4 } })).json.room.code;
  await call('POST', `/coop/rooms/${code}/join`, { token: mate.token, body: { species: 7 } });

  const denied = await call('POST', `/coop/rooms/${code}/kick`, { token: mate.token, body: { user: host.id } });
  assert.equal(denied.status, 403);

  const kicked = await call('POST', `/coop/rooms/${code}/kick`, { token: host.token, body: { user: mate.id } });
  assert.equal(kicked.json.room.members.length, 1);
  const poll = await call('GET', `/coop/rooms/${code}?after=0`, { token: mate.token });
  assert.equal(poll.status, 403, 'a kicked member can no longer poll');
});

test('outsiders cannot read or join a started room', async () => {
  const host = await player();
  const mate = await player();
  const outsider = await player();
  const code = (await call('POST', '/coop/rooms', { token: host.token, body: { species: 4 } })).json.room.code;
  await call('POST', `/coop/rooms/${code}/join`, { token: mate.token, body: { species: 7 } });
  await call('POST', `/coop/rooms/${code}/start`, { token: host.token, body: {} });

  const late = await call('POST', `/coop/rooms/${code}/join`, { token: outsider.token, body: { species: 1 } });
  assert.equal(late.status, 400, 'run already started');

  const spy = await call('GET', `/coop/rooms/${code}?after=0`, { token: outsider.token });
  assert.equal(spy.status, 403);
});

test('room capacity is 4', async () => {
  const host = await player();
  const code = (await call('POST', '/coop/rooms', { token: host.token, body: { species: 4 } })).json.room.code;
  for (let i = 0; i < 3; i++) {
    const p = await player();
    const r = await call('POST', `/coop/rooms/${code}/join`, { token: p.token, body: { species: 1 + i } });
    assert.equal(r.status, 200);
  }
  const fifth = await player();
  const full = await call('POST', `/coop/rooms/${code}/join`, { token: fifth.token, body: { species: 9 } });
  assert.equal(full.status, 400);
});


test('ice config and room standing (0.8.34 endpoints)', async () => {
  const host = await player();
  const mate = await player();

  const ice = await call('GET', '/coop/ice', { token: host.token });
  assert.equal(ice.status, 200);
  assert.ok(Array.isArray(ice.json.servers) && ice.json.servers.length, 'ice servers expected');

  const code = (await call('POST', '/coop/rooms', { token: host.token, body: { species: 4 } })).json.room.code;
  await call('POST', `/coop/rooms/${code}/join`, { token: mate.token, body: { species: 7 } });

  const standing = await call('GET', `/coop/rooms/${code}/standing`, { token: host.token });
  assert.equal(standing.status, 200);
  assert.equal(typeof standing.json.biome, 'string');
  assert.equal(typeof standing.json.tier, 'number');
  assert.equal(standing.json.ranked, false, 'guest teams are unranked');
  assert.equal(standing.json.best, null);

  const outsider = await player();
  const denied = await call('GET', `/coop/rooms/${code}/standing`, { token: outsider.token });
  assert.equal(denied.status, 403, 'only members can read the room standing');
});
