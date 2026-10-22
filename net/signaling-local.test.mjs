// ============ signaling-local.test.mjs — room store over the in-memory transport ============
// Exercises the RTDB-shaped facade net/signaling-local.mjs gives net.mjs and the
// co-op panel, without a browser or a server:
//   - a room created in one client is visible to a second client (gossip snapshot)
//   - `m/{uid}` presence appears as child_added on the other side
//   - `.once('value')` answers for an existing room and times out for a missing one
//   - the q/ queue still delivers a raw message to its recipient only
// Run:  node --test net/signaling-local.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDb, memoryIo } from './signaling-local.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `fn()` is truthy (polling; the store is push-driven). */
async function until(fn, ms = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  return false;
}

test('room created by the host is visible to a joining guest', async () => {
  const io = memoryIo();
  const host = localDb('host-1', { io });
  const guest = localDb('guest-1', { io });

  const room = host.rtdb.ref('rooms/AB12CD');
  await room.child('host').set('host-1');
  await room.update({ open: true, at: 1234, ['m/host-1']: { name: 'Host', dex: 7 } });

  const snap = await guest.rtdb.ref('rooms/AB12CD').once('value');
  const v = snap.val();
  assert.equal(v.host, 'host-1');
  assert.equal(v.open, true);
  assert.equal(v.at, 1234);
  assert.deepEqual(v.m['host-1'], { name: 'Host', dex: 7 });
});

test('guest presence reaches the host as child_added, and changes as child_changed', async () => {
  const io = memoryIo();
  const host = localDb('host-2', { io });
  const guest = localDb('guest-2', { io });
  await host.rtdb.ref('rooms/ROOM02/host').set('host-2');

  const seen = [];
  host.rtdb.ref('rooms/ROOM02/m').on('child_added', (s) => seen.push(['add', s.key, s.val()]));
  await sleep(120);

  await guest.rtdb.ref('rooms/ROOM02/m/guest-2').set({ name: 'Guest', dex: 4 });
  assert.ok(await until(() => seen.length === 1), 'child_added not delivered');
  assert.deepEqual(seen[0], ['add', 'guest-2', { name: 'Guest', dex: 4 }]);

  const changed = [];
  host.rtdb.ref('rooms/ROOM02/m').on('child_changed', (s) => changed.push([s.key, s.val()]));
  await guest.rtdb.ref('rooms/ROOM02/m/guest-2').set({ name: 'Guest', dex: 7 });
  assert.ok(await until(() => changed.length === 1), 'child_changed not delivered');
  assert.deepEqual(changed[0], ['guest-2', { name: 'Guest', dex: 7 }]);
});

test('child_removed fires when a member leaves', async () => {
  const io = memoryIo();
  const host = localDb('host-3', { io });
  const guest = localDb('guest-3', { io });
  await host.rtdb.ref('rooms/ROOM03/host').set('host-3');
  await guest.rtdb.ref('rooms/ROOM03/m/guest-3').set({ name: 'G', dex: 1 });

  const gone = [];
  host.rtdb.ref('rooms/ROOM03/m').on('child_removed', (s) => gone.push(s.key));
  await sleep(120);
  await guest.rtdb.ref('rooms/ROOM03/m/guest-3').remove();
  assert.ok(await until(() => gone.includes('guest-3')), 'child_removed not delivered');
});

test('once() on a missing room answers with an empty snapshot instead of hanging', async () => {
  const io = memoryIo();
  const guest = localDb('guest-4', { io });
  const t0 = Date.now();
  const snap = await guest.rtdb.ref('rooms/NOPE00').once('value');
  assert.equal(snap.val(), null);
  assert.ok(Date.now() - t0 < 4000);
});

test('the q/ queue delivers to the recipient only, as a raw string', async () => {
  const io = memoryIo();
  const a = localDb('a', { io });
  const b = localDb('b', { io });
  const c = localDb('c', { io });

  const gotB = [], gotC = [];
  b.rtdb.ref('rooms/QROOM/q/b').on('child_added', (s) => gotB.push(s.val()));
  c.rtdb.ref('rooms/QROOM/q/c').on('child_added', (s) => gotC.push(s.val()));
  await sleep(80);

  const payload = JSON.stringify({ f: 'a', d: { k: 'f' } });
  await a.rtdb.ref('rooms/QROOM/q/b').push(payload);

  assert.ok(await until(() => gotB.length === 1), 'queue message not delivered');
  assert.equal(gotB[0], payload);
  assert.equal(gotC.length, 0);
});

test('two guests writing presence concurrently do not clobber each other', async () => {
  const io = memoryIo();
  const host = localDb('h5', { io });
  const g1 = localDb('g5a', { io });
  const g2 = localDb('g5b', { io });
  await host.rtdb.ref('rooms/ROOM05/host').set('h5');
  await sleep(60);

  const members = new Map();
  host.rtdb.ref('rooms/ROOM05/m').on('child_added', (s) => members.set(s.key, s.val()));
  await sleep(80);
  await Promise.all([
    g1.rtdb.ref('rooms/ROOM05/m/g5a').set({ name: 'A', dex: 1 }),
    g2.rtdb.ref('rooms/ROOM05/m/g5b').set({ name: 'B', dex: 4 }),
  ]);
  assert.ok(await until(() => members.size === 2), 'one presence entry was lost');
  assert.deepEqual([...members.keys()].sort(), ['g5a', 'g5b']);
});
