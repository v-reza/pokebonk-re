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

// ------------------------------------------------------------- social flow ----
// The acceptance flow, exercised against the same route table the browser hits:
//   A adds B by name → B accepts → A creates a room → A invites B → B accepts
//   the invite → both see each other in the room → A starts → both get the seed.

test('friends: request by name, accept, list, presence, remove', async () => {
  const a = await call('POST', '/auth/guest');
  const b = await call('POST', '/auth/guest');
  const ta = a.json.token, tb = b.json.token;

  // Anonymous access is refused everywhere.
  assert.equal((await call('GET', '/friends')).status, 401);
  assert.equal((await call('POST', '/friends', { body: { name: b.json.name } })).status, 401);

  // Empty list shape.
  const empty = await call('GET', '/friends', { token: ta });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json.friends, []);
  assert.deepEqual(empty.json.incoming, []);
  assert.deepEqual(empty.json.outgoing, []);
  assert.equal(empty.json.max, 100);
  assert.equal(empty.json.room, null);

  // Unknown player / self / empty name.
  assert.equal((await call('POST', '/friends', { token: ta, body: { name: 'Nadie Existe' } })).status, 404);
  assert.equal((await call('POST', '/friends', { token: ta, body: { name: a.json.name } })).status, 400);
  assert.equal((await call('POST', '/friends', { token: ta, body: {} })).status, 400);

  // A → B by exact name (case-insensitive lookup, like accountByName).
  const sent = await call('POST', '/friends', { token: ta, body: { name: b.json.name.toUpperCase() } });
  assert.equal(sent.status, 200);
  assert.equal(sent.json.state, 'sent');
  assert.equal(sent.json.to.id, b.json.id);

  // Duplicate request is a conflict, from either side.
  assert.equal((await call('POST', '/friends', { token: ta, body: { name: b.json.name } })).status, 409);

  // B sees it as incoming; A sees it as outgoing.
  const forB = await call('GET', '/friends', { token: tb });
  assert.equal(forB.json.incoming.length, 1);
  assert.equal(forB.json.incoming[0].id, a.json.id);
  assert.equal(forB.json.incoming[0].name, a.json.name);
  assert.equal(forB.json.friends.length, 0);
  const forA = await call('GET', '/friends', { token: ta });
  assert.equal(forA.json.outgoing.length, 1);
  assert.equal(forA.json.outgoing[0].id, b.json.id);

  // A cannot accept their own request.
  assert.equal((await call('POST', `/friends/requests/${b.json.id}/accept`, { token: ta })).status, 409);
  // A cannot decline/cancel B's side either.
  assert.equal((await call('POST', `/friends/requests/${b.json.id}/decline`, { token: ta })).status, 409);

  // B accepts.
  const acc = await call('POST', `/friends/requests/${a.json.id}/accept`, { token: tb });
  assert.equal(acc.status, 200);
  assert.equal(acc.json.state, 'friends');
  assert.equal(acc.json.friend.id, a.json.id);
  // Accepting twice is a conflict.
  assert.equal((await call('POST', `/friends/requests/${a.json.id}/accept`, { token: tb })).status, 409);

  // Both lists show the accepted friend (offline: nobody has beaten yet).
  const la = await call('GET', '/friends', { token: ta });
  assert.equal(la.json.friends.length, 1);
  assert.equal(la.json.friends[0].id, b.json.id);
  assert.equal(la.json.friends[0].online, false);
  assert.equal(la.json.friends[0].room, '');
  assert.equal(la.json.friends[0].play, false);
  assert.equal(la.json.incoming.length, 0);
  assert.equal(la.json.outgoing.length, 0);

  // Presence heartbeat: B is online, A sees it.
  const beat = await call('POST', '/presence', { token: tb, body: { room: '', play: true } });
  assert.equal(beat.status, 200);
  assert.equal(beat.json.online[a.json.id].online, false);
  assert.equal(beat.json.ttl, 120000);
  const pres = await call('GET', '/presence', { token: ta });
  assert.equal(pres.json.online[b.json.id].online, true);
  assert.equal(pres.json.online[b.json.id].play, true);
  const la2 = await call('GET', '/friends', { token: ta });
  assert.equal(la2.json.friends[0].online, true);
  assert.equal(la2.json.friends[0].play, true);

  // Name search excludes yourself and matches substrings.
  const search = await call('GET', `/players/search?q=${encodeURIComponent(b.json.name.slice(2, 8))}`, { token: ta });
  assert.equal(search.status, 200);
  assert.ok(search.json.players.some((p) => p.id === b.json.id));
  assert.ok(!search.json.players.some((p) => p.id === a.json.id));
  assert.deepEqual((await call('GET', '/players/search?q=a', { token: ta })).json.players, []);

  // Remove: needs the id, then both lists are empty again.
  assert.equal((await call('POST', '/friends/remove', { token: ta, body: {} })).status, 400);
  const rm = await call('POST', '/friends/remove', { token: ta, body: { id: b.json.id } });
  assert.equal(rm.status, 200);
  assert.equal((await call('GET', '/friends', { token: ta })).json.friends.length, 0);
  assert.equal((await call('GET', '/friends', { token: tb })).json.friends.length, 0);
});

test('friends: decline and cancel drop the pending edge', async () => {
  const a = await call('POST', '/auth/guest');
  const b = await call('POST', '/auth/guest');
  const c = await call('POST', '/auth/guest');

  await call('POST', '/friends', { token: a.json.token, body: { name: b.json.name } });
  const dec = await call('POST', `/friends/requests/${a.json.id}/decline`, { token: b.json.token });
  assert.equal(dec.status, 200);
  assert.equal((await call('GET', '/friends', { token: a.json.token })).json.outgoing.length, 0);
  assert.equal((await call('GET', '/friends', { token: b.json.token })).json.incoming.length, 0);
  // Declining again: nothing left to decline.
  assert.equal((await call('POST', `/friends/requests/${a.json.id}/decline`, { token: b.json.token })).status, 404);

  await call('POST', '/friends', { token: a.json.token, body: { name: c.json.name } });
  // C cannot cancel a request it did not send.
  assert.equal((await call('POST', `/friends/requests/${a.json.id}/cancel`, { token: c.json.token })).status, 409);
  const can = await call('POST', `/friends/requests/${c.json.id}/cancel`, { token: a.json.token });
  assert.equal(can.status, 200);
  assert.equal((await call('GET', '/friends', { token: c.json.token })).json.incoming.length, 0);
});

test('rooms + invites: create, invite a friend, accept, both members, host starts', async () => {
  const a = await call('POST', '/auth/guest');
  const b = await call('POST', '/auth/guest');
  const ta = a.json.token, tb = b.json.token;
  await call('POST', '/friends', { token: ta, body: { name: b.json.name } });
  await call('POST', `/friends/requests/${a.json.id}/accept`, { token: tb });

  // Room codes are 6 uppercase alphanumerics and start open with the host in it.
  const made = await call('POST', '/rooms', { token: ta, body: { dex: 4 } });
  assert.equal(made.status, 200);
  const code = made.json.room.code;
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.equal(made.json.room.host, a.json.id);
  assert.equal(made.json.room.open, true);
  assert.equal(made.json.room.started, false);
  assert.equal(made.json.room.members.length, 1);
  assert.equal(made.json.room.members[0].dex, 4);
  assert.equal((await call('GET', `/rooms/${code}`, { token: tb })).json.room.code, code);

  // Host start needs a second player.
  const early = await call('POST', `/rooms/${code}/start`, { token: ta });
  assert.equal(early.status, 409);
  assert.equal(early.json.error, 'You need at least one friend in the room.');
  // Only friends can be invited, and only by the host.
  const c = await call('POST', '/auth/guest');
  const notFriend = await call('POST', '/invites', { token: ta, body: { to: c.json.id, room: code } });
  assert.equal(notFriend.status, 403);

  const inv = await call('POST', '/invites', { token: ta, body: { to: b.json.id, room: code } });
  assert.equal(inv.status, 200);
  assert.equal(inv.json.invite.room, code);
  assert.equal(inv.json.invite.name, a.json.name);
  // The invite is mirrored in GET /friends so a poll can raise the popup.
  const bList = await call('GET', '/friends', { token: tb });
  assert.equal(bList.json.invite.from, a.json.id);
  assert.equal(bList.json.invite.room, code);
  // And it shows up in the dedicated feed.
  const feed = await call('GET', '/invites', { token: tb });
  assert.equal(feed.json.invites.length, 1);
  assert.equal(feed.json.ttl, 180000);
  assert.equal((await call('GET', '/invites', { token: ta })).json.invites.length, 0);

  // B accepts → lands in the room with both members, host first.
  const yes = await call('POST', `/invites/${a.json.id}/accept`, { token: tb, body: { dex: 7 } });
  assert.equal(yes.status, 200);
  assert.equal(yes.json.room.code, code);
  assert.deepEqual(yes.json.room.members.map((m) => m.uid), [a.json.id, b.json.id]);
  assert.equal(yes.json.room.members[1].dex, 7);
  assert.equal(yes.json.room.members[1].name, b.json.name);
  // The invite is spent.
  assert.equal((await call('GET', '/invites', { token: tb })).json.invites.length, 0);
  assert.equal((await call('POST', `/invites/${a.json.id}/accept`, { token: tb })).status, 404);
  // A sees the room in /friends (the lobby renders from it).
  assert.equal((await call('GET', '/friends', { token: ta })).json.room.code, code);

  // Only the host can start; guests get 403.
  assert.equal((await call('POST', `/rooms/${code}/start`, { token: tb })).status, 403);

  // Everyone picks their own Pokémon before the host can start.
  assert.equal((await call('POST', `/rooms/${code}/start`, { token: ta, body: { seed: 1 } })).status, 409);
  const pickA = await call('POST', `/rooms/${code}/pick`, { token: ta, body: { dex: 4 } });
  assert.equal(pickA.status, 200);
  assert.equal((await call('POST', `/rooms/${code}/start`, { token: ta, body: { seed: 1 } })).status, 409);
  const pickB = await call('POST', `/rooms/${code}/pick`, { token: tb, body: { dex: 7, shiny: true } });
  assert.deepEqual(pickB.json.room.members.map((m) => [m.dex, m.ready]), [[4, true], [7, true]]);
  assert.equal((await call('POST', `/rooms/${code}/pick`, { token: tb, body: { dex: 0 } })).status, 400);

  const started = await call('POST', `/rooms/${code}/start`, { token: ta, body: { seed: 424242, cfg: { biome: 'forest', tier: 1, mode: 'standard' } } });
  assert.deepEqual(started.json.room.cfg, { biome: 'forest', tier: 1, mode: 'standard' });
  assert.equal(started.status, 200);
  assert.equal(started.json.seed, 424242);
  assert.equal(started.json.room.started, true);
  assert.equal(started.json.room.open, false);
  // Both players are marked as playing and can read the seed.
  const after = await call('GET', `/rooms/${code}`, { token: tb });
  assert.equal(after.json.room.seed, 424242);
  const pres = await call('GET', '/presence', { token: tb });
  assert.equal(pres.json.online[a.json.id].play, true);
  assert.equal(pres.json.online[a.json.id].room, code);

  // Joining a started room is refused.
  assert.equal((await call('POST', `/rooms/${code}/join`, { token: tb })).status, 200); // already a member
  const stranger = await call('POST', '/auth/guest');
  await call('POST', '/friends', { token: stranger.json.token, body: { name: a.json.name } });
  await call('POST', `/friends/requests/${stranger.json.id}/accept`, { token: ta });
  assert.equal((await call('POST', `/rooms/${code}/join`, { token: stranger.json.token })).status, 409);

  // Host leaving closes the room for everyone.
  assert.equal((await call('POST', `/rooms/${code}/leave`, { token: ta })).status, 200);
  assert.equal((await call('GET', `/rooms/${code}`, { token: tb })).status, 404);
});

test('rooms: invite without a room creates one; decline and join by code', async () => {
  const a = await call('POST', '/auth/guest');
  const b = await call('POST', '/auth/guest');
  const ta = a.json.token, tb = b.json.token;
  await call('POST', '/friends', { token: ta, body: { name: b.json.name } });
  await call('POST', `/friends/requests/${a.json.id}/accept`, { token: tb });

  // No room yet: inviting creates one and returns it.
  const inv = await call('POST', '/invites', { token: ta, body: { to: b.json.id } });
  assert.equal(inv.status, 200);
  const code = inv.json.room.code;
  assert.equal(inv.json.room.members[0].uid, a.json.id);

  // Decline drops it.
  const no = await call('POST', `/invites/${a.json.id}/decline`, { token: tb });
  assert.equal(no.status, 200);
  assert.equal((await call('GET', '/invites', { token: tb })).json.invites.length, 0);
  assert.equal((await call('POST', `/invites/${a.json.id}/accept`, { token: tb })).status, 404);

  // Joining by code still works (the code is what the lobby shows).
  const joined = await call('POST', `/rooms/${code}/join`, { token: tb, body: { dex: 1 } });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.room.members.length, 2);
  // Unknown code → 404.
  const missing = await call('POST', '/rooms/ZZZZZZ/join', { token: tb });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'That room no longer exists.');
});
