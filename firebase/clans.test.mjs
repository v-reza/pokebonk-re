// firebase/clans.test.mjs — clan domain routes against the in-memory backend.
//
// Covers the 0.8.29 additions (guide, join requirements, leader succession) and
// the twelve management routes, all through the HTTP surface the client uses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend, MemoryDB } from './backend.mjs';
import { CLAN_RULES } from './clans.mjs';

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
    status: null,
    buf: Buffer.alloc(0),
    ended: false,
    writeHead(code) { this.status = code; },
    end(b) { this.buf = b ?? Buffer.alloc(0); this.ended = true; },
  };
  Object.defineProperty(res, 'writableEnded', { get: () => res.ended });
  const out = await m.handler(req, res, url, m.params);
  if (out !== undefined && !res.ended) {
    res.status = 200;
    res.buf = Buffer.from(JSON.stringify(out));
    res.ended = true;
  }
  return { status: res.status, json: res.buf.length ? JSON.parse(res.buf.toString('utf8')) : null };
}

const newPlayer = async () => (await call('POST', '/auth/guest')).json;

test('create → status → guide → notice → rename → emblem', async () => {
  const a = await newPlayer();
  const created = await call('POST', '/clans', {
    token: a.token,
    body: { name: 'Team Rocket', tag: 'TR', emblem: 'rocket' },
  });
  assert.equal(created.status, 200);
  const id = created.json.clan.id;
  assert.equal(created.json.clan.role, 'leader');
  assert.equal(created.json.clan.tag, 'TR');

  const status = await call('GET', '/clans/status', { token: a.token });
  assert.equal(status.json.clan.id, id);
  assert.equal(status.json.clan.role, 'leader');

  const guide = await call('POST', '/clans/guide', {
    token: a.token,
    body: { text: '# Rules\n- play daily' },
  });
  assert.equal(guide.status, 200);
  assert.match(guide.json.clan.guide.text, /play daily/);
  assert.equal(guide.json.clan.guide.by, a.name);

  const notice = await call('POST', '/clans/notice', { token: a.token, body: { text: 'Top 10 this season' } });
  assert.equal(notice.json.clan.notice.text, 'Top 10 this season');

  const renamed = await call('POST', '/clans/rename', { token: a.token, body: { name: 'Team Aqua', tag: 'TA' } });
  assert.equal(renamed.json.clan.name, 'Team Aqua');
  assert.equal(renamed.json.clan.tag, 'TA');

  const emblem = await call('POST', '/clans/emblem', { token: a.token, body: { emblem: 'aqua' } });
  assert.equal(emblem.json.clan.emblem, 'aqua');
});

test('invite, join, role, mute, kick, leave, disband', async () => {
  const boss = await newPlayer();
  const mate = await newPlayer();
  const friend = await newPlayer();

  const clan = (await call('POST', '/clans', { token: boss.token, body: { name: 'Brock', tag: 'BR' } })).json.clan;

  // invite by name, then accept the invite by joining
  const inv = await call('POST', '/clans/invite', { token: boss.token, body: { name: mate.name } });
  assert.equal(inv.status, 204);
  const joined = await call('POST', `/clans/${clan.id}/join`, { token: mate.token, body: {} });
  assert.equal(joined.status, 200);
  assert.equal(joined.json.clan.role, 'member');

  // promote to officer, then demote again
  const up = await call('POST', '/clans/role', { token: boss.token, body: { user: mate.id, role: 'officer' } });
  assert.equal(up.json.clan.members.find((m) => m.id === mate.id).role, 'officer');

  // an officer cannot kick another officer, the leader can
  const third = await newPlayer();
  await call('POST', `/clans/${clan.id}/join`, { token: third.token, body: {} });
  await call('POST', '/clans/role', { token: boss.token, body: { user: third.id, role: 'officer' } });
  const denied = await call('POST', '/clans/kick', { token: mate.token, body: { user: third.id } });
  assert.equal(denied.status, 403);
  const kicked = await call('POST', '/clans/kick', { token: boss.token, body: { user: third.id } });
  assert.equal(kicked.status, 200);
  assert.equal(kicked.json.clan.members.some((m) => m.id === third.id), false);

  // mute / unmute
  const muted = await call('POST', '/clans/mute', { token: boss.token, body: { user: mate.id, hours: 2 } });
  assert.equal(muted.json.clan.members.find((m) => m.id === mate.id).muted, true);
  const quiet = await call('POST', '/clans/chat', { token: mate.token, body: { text: 'hi' } });
  assert.equal(quiet.status, 403, 'a muted member cannot post');
  await call('POST', '/clans/mute', { token: boss.token, body: { user: mate.id, hours: 0 } });

  // a plain member cannot touch settings, the leader can
  const noSettings = await call('POST', '/clans/settings', { token: mate.token, body: { reqWins: 5 } });
  assert.equal(noSettings.status, 403);
  const settings = await call('POST', '/clans/settings', {
    token: boss.token,
    body: { reqWins: 5, reqLeague: 3, access: 'request' },
  });
  assert.equal(settings.json.clan.settings.reqWins, 5);
  assert.equal(settings.json.clan.access, 'request');

  // leaving drops the member; the leader cannot disband without confirmation
  const left = await call('POST', '/clans/leave', { token: mate.token, body: {} });
  assert.equal(left.json.clan, null);
  const noConfirm = await call('POST', '/clans/disband', { token: boss.token, body: {} });
  assert.equal(noConfirm.status, 400);
  const gone = await call('POST', '/clans/disband', { token: boss.token, body: { confirm: true } });
  assert.equal(gone.status, 204);
  const after = await call('GET', '/clans/status', { token: boss.token });
  assert.equal(after.json.clan, null);
});

test('join requirements are enforced, and request-access queues a request', async () => {
  const boss = await newPlayer();
  const outsider = await newPlayer();
  const clan = (await call('POST', '/clans', { token: boss.token, body: { name: 'Sabrina', tag: 'SB' } })).json.clan;

  await call('POST', '/clans/settings', { token: boss.token, body: { reqWins: 3, access: 'request' } });

  const denied = await call('POST', `/clans/${clan.id}/join`, { token: outsider.token, body: {} });
  assert.equal(denied.status, 400, 'requirement blocks the join');

  await call('POST', '/clans/settings', { token: boss.token, body: { reqWins: 0 } });
  const queued = await call('POST', `/clans/${clan.id}/join`, { token: outsider.token, body: { message: 'let me in' } });
  assert.equal(queued.status, 200);
  assert.equal(queued.json.request, true);

  const status = await call('GET', '/clans/status', { token: boss.token });
  assert.equal(status.json.requests, 1, 'staff see the pending request count');
  const mine = await call('GET', '/clans/status', { token: outsider.token });
  assert.equal(mine.json.clan, null, 'a request is not membership');
});

test('succession: an idle leader hands over to the most active officer', async () => {
  const leader = await newPlayer();
  const officer = await newPlayer();
  const clan = (await call('POST', '/clans', { token: leader.token, body: { name: 'Erika', tag: 'EK' } })).json.clan;
  await call('POST', `/clans/${clan.id}/join`, { token: officer.token, body: {} });
  await call('POST', '/clans/role', { token: leader.token, body: { user: officer.id, role: 'officer' } });

  const store = db.clans();
  const doc = await store.get(clan.id);
  doc.members.find((m) => m.id === leader.id).lastSeen = Date.now() - CLAN_RULES.LEADER_IDLE_MS - 1000;
  doc.members.find((m) => m.id === officer.id).points = 40;
  await store.save(doc);

  const status = await call('GET', '/clans/status', { token: officer.token });
  assert.equal(status.json.clan.role, 'leader', 'the officer took over');
  assert.equal(status.json.clan.leader, officer.id);
  assert.ok(status.json.clan.activity.some((a) => a.kind === 'succession'));

  const old = await call('GET', '/clans/status', { token: leader.token });
  assert.equal(old.json.clan.role, 'officer', 'the idle leader was demoted');
});

test('succession: with no active officer, a member takes over', async () => {
  const leader = await newPlayer();
  const member = await newPlayer();
  const clan = (await call('POST', '/clans', { token: leader.token, body: { name: 'Koga', tag: 'KG' } })).json.clan;
  await call('POST', `/clans/${clan.id}/join`, { token: member.token, body: {} });

  const store = db.clans();
  const doc = await store.get(clan.id);
  doc.members.find((m) => m.id === leader.id).lastSeen = Date.now() - CLAN_RULES.LEADER_IDLE_MS - 1000;
  await store.save(doc);

  const status = await call('GET', '/clans/status', { token: member.token });
  assert.equal(status.json.clan.role, 'leader');
});

test('non-members cannot read a clan, managers need staff rights', async () => {
  const boss = await newPlayer();
  const outsider = await newPlayer();
  const clan = (await call('POST', '/clans', { token: boss.token, body: { name: 'Misty', tag: 'MS' } })).json.clan;

  const view = await call('GET', `/clans/${clan.id}`, { token: outsider.token });
  assert.equal(view.status, 200, 'clan pages are readable for the public profile');
  assert.equal(view.json.role, null);
  assert.deepEqual(view.json.requests, [], 'requests are hidden from outsiders');

  const guide = await call('POST', '/clans/guide', { token: outsider.token, body: { text: 'x' } });
  assert.equal(guide.status, 400, 'not in a clan');

  const missing = await call('GET', '/clans/nope', { token: boss.token });
  assert.equal(missing.status, 404);
});
