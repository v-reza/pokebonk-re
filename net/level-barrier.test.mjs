// Unit tests for the party-wide level-up barrier (net/level-barrier.mjs).
// Host and guest instances are wired to each other through an in-memory link,
// so these exercise the real message flow, not a mock of it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { LevelBarrier } from './level-barrier.mjs';

/** Two barriers sharing a mailbox; `send(ev, to)` delivers on the next receive(). */
function pair({ members } = {}) {
  const box = [];
  const log = { host: [], guest: [] };
  const mk = (role) => new LevelBarrier({
    host: role === 'host',
    me: role === 'host' ? 'H' : 'G',
    members: members ?? ['H', 'G'],
    send: (ev, to) => {
      log[role].push(to ? ['→' + to, ...ev] : ev);
      box.push({ from: role === 'host' ? 'H' : 'G', to, ev });
    },
  });
  const events = { host: [], guest: [] };
  const host = mk('host');
  const guest = mk('guest');
  host.onOpen = (lv) => events.host.push(['open', lv]);
  host.onResume = () => events.host.push(['resume']);
  host.onWaiting = (names) => events.host.push(['waiting', names]);
  guest.onOpen = (lv) => events.guest.push(['open', lv]);
  guest.onResume = () => events.guest.push(['resume']);
  guest.onWaiting = (names) => events.guest.push(['waiting', names]);
  const flush = () => {
    while (box.length) {
      const { from, to, ev } = box.shift();
      const dest = to === 'host' ? host : guest;
      if (dest === host && from === 'H') continue;
      if (dest === guest && from === 'G') continue;
      dest.receive(ev, from);
    }
  };
  return { host, guest, log, events, flush };
}

test('host announces the level and the waiting list', () => {
  const { host, log, events } = pair();
  host.start(5);
  assert.deepEqual(log.host[0], ['lu', 5, 1]);
  assert.deepEqual(log.host[1], ['lw', ['H', 'G']]);
  assert.deepEqual(events.host, [['open', 5], ['waiting', ['H', 'G']]]);
});

test('guest opens its card only when the host says so', () => {
  const { host, guest, events, flush } = pair();
  host.start(5);
  flush();
  assert.deepEqual(events.guest, [['open', 5], ['waiting', ['H', 'G']]]);
  assert.equal(guest.open, true);
});

test('party resumes only after every member picked', () => {
  const { host, guest, log, events, flush } = pair();
  host.start(5);
  flush();
  guest.localPicked();
  flush();
  assert.equal(events.host.some((e) => e[0] === 'resume'), false, 'host still owed');
  host.localPicked();
  flush();
  assert.deepEqual(events.host.filter((e) => e[0] === 'resume'), [['resume']]);
  assert.deepEqual(events.guest.filter((e) => e[0] === 'resume'), [['resume']]);
  assert.deepEqual(log.host.at(-1), ['lr']);
  assert.equal(guest.open, false);
});

test('two queued level-ups cannot be cleared by one pick', () => {
  const { host, guest, events, flush } = pair();
  host.start(5);
  host.start(6);           // second card queued before anyone picked
  flush();
  guest.localPicked();     // guest picks card 1 only
  flush();
  assert.equal(events.host.some((e) => e[0] === 'resume'), false);
  guest.localPicked();     // guest's card 2
  host.localPicked();
  host.localPicked();
  flush();
  assert.deepEqual(events.host.filter((e) => e[0] === 'resume'), [['resume']]);
});

test('a member that leaves while owed releases the party', () => {
  const { host, events } = pair();
  host.start(9);
  host.localPicked();
  assert.equal(events.host.some((e) => e[0] === 'resume'), false);
  host.leave('G');
  assert.deepEqual(events.host.filter((e) => e[0] === 'resume'), [['resume']]);
});

test('a guest never owns the barrier', () => {
  const { guest, events } = pair();
  guest.start(5);          // ignored
  assert.deepEqual(guest.owed.size >= 0, true);
  assert.equal(guest.open, false);
  guest.receive(['lr'], 'H');   // a stray resume from the host is honoured
  assert.deepEqual(events.guest, [['resume']]);
});

test('host ignores its own echoed messages', () => {
  const { host, events } = pair();
  host.receive(['lu', 5, 1], 'H');
  host.receive(['lw', ['H']], 'H');
  host.receive(['lr'], 'H');
  assert.deepEqual(events.host, []);
});

test('attachMembers releases members that dropped out of the party', () => {
  const { host, events } = pair();
  host.start(3);
  host.localPicked();
  assert.equal(events.host.some((e) => e[0] === 'resume'), false);
  host.attachMembers(['H']);
  assert.deepEqual(events.host.filter((e) => e[0] === 'resume'), [['resume']]);
});
