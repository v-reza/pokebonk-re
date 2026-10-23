// Unit tests for the 0.8.29 co-op bridge: the patched call sites plus the barrier
// they drive, over an in-memory transport. Host and guest bridges talk to each
// other, so the message flow is exercised end to end.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installBridge, BRIDGE_KEY } from './coop-bridge-0.8.29.mjs';

function fakeRun(level = 7) {
  const calls = { hideModal: 0, resume: 0 };
  return {
    player: { level },
    pendingLevels: 2,
    state: 'modal',
    ui: { hideModal: () => calls.hideModal++ },
    resume: () => calls.resume++,
    calls,
  };
}

function solo() {
  const bridge = installBridge({ target: {} });
  const run = fakeRun();
  const opened = [];
  const open = () => opened.push(run.player.level);
  return { bridge, run, opened, open };
}

/** Host bridge + guest bridge wired through one mailbox. */
function paired() {
  const box = [];
  const host = solo();
  const guest = solo();
  host.bridge.attachSession({ host: true, me: 'H', members: ['H', 'G'], send: (ev) => box.push({ to: 'guest', ev }) });
  guest.bridge.attachSession({ host: false, me: 'G', members: ['H', 'G'], send: (ev, to) => box.push({ to: to || 'host', ev }) });
  const flush = () => {
    while (box.length) {
      const { to, ev } = box.shift();
      const target = to === 'host' ? host : guest;
      target.bridge.receive(ev, to === 'host' ? 'G' : 'H');
    }
  };
  return { host, guest, flush };
}

test('installs itself under the patched key', () => {
  const target = {};
  installBridge({ target });
  assert.equal(target[BRIDGE_KEY].active(), false);
  assert.equal(typeof target[BRIDGE_KEY].openLevel, 'function');
});

test('no session: the card opens exactly like stock', () => {
  const { bridge, run, opened, open } = solo();
  bridge.openLevel(run, open);
  assert.deepEqual(opened, [7]);
  assert.equal(run.pendingLevels, 2, 'nothing else touched');
  assert.equal(bridge.isGuest(), false);
});

test('host: announces, then opens its own card', () => {
  const { bridge, run, opened, open } = solo();
  const sent = [];
  bridge.attachSession({ host: true, me: 'H', members: ['H', 'G'], send: (ev) => sent.push(ev) });
  bridge.openLevel(run, open);
  assert.deepEqual(opened, [7]);
  assert.deepEqual(sent[0], ['lu', 7, 1]);
  assert.deepEqual(sent[1], ['lw', ['H', 'G']]);
});

test('guest: stashes the card until the host announces', () => {
  const { bridge, run, opened, open } = solo();
  bridge.attachSession({ host: false, me: 'G', members: ['H', 'G'], send: () => {} });
  bridge.openLevel(run, open);
  assert.deepEqual(opened, [], 'guest never opens on its own');
  bridge.receive(['lu', 7, 1], 'H');
  assert.deepEqual(opened, [7]);
  bridge.receive(['lu', 7, 1], 'H');
  assert.deepEqual(opened, [7], 'duplicate announce does not reopen');
});

test('guest: an early announce opens the card when the local level-up lands', () => {
  const { bridge, run, opened, open } = solo();
  bridge.attachSession({ host: false, me: 'G', members: ['H', 'G'], send: () => {} });
  bridge.receive(['lu', 7, 1], 'H');
  assert.deepEqual(opened, []);
  bridge.openLevel(run, open);
  assert.deepEqual(opened, [7]);
});

test('both roles report the pick to the barrier', () => {
  const host = solo();
  const sent = [];
  host.bridge.attachSession({ host: true, me: 'H', members: ['H'], send: (ev) => sent.push(ev) });
  host.bridge.openLevel(host.run, host.open);   // a level-up is in progress
  host.bridge.localPicked(host.run);
  assert.deepEqual(sent.at(-1), ['lr'], 'sole member picking releases the party');

  const guest = solo();
  const out = [];
  guest.bridge.attachSession({ host: false, me: 'G', members: ['H', 'G'], send: (ev, to) => out.push([to, ev]) });
  guest.bridge.localPicked(guest.run);
  assert.deepEqual(out, [['host', ['lp']]]);
});

test('resume clears the modal, the queue and hands control back', () => {
  const { bridge, run } = solo();
  bridge.bind(run).attachSession({ host: false, me: 'G', members: ['H', 'G'], send: () => {} });
  bridge.receive(['lr'], 'H');
  assert.equal(run.pendingLevels, 0);
  assert.equal(run.state, 'play');
  assert.equal(run.calls.hideModal, 1);
  assert.equal(run.calls.resume, 1);
});

test('resume drops a stashed card so a late announce cannot reopen it', () => {
  const { bridge, run, opened, open } = solo();
  bridge.bind(run).attachSession({ host: false, me: 'G', members: ['H'], send: () => {} });
  bridge.openLevel(run, open);
  bridge.receive(['lr'], 'H');
  bridge.receive(['lu', 7, 1], 'H');
  assert.deepEqual(opened, []);
});

test('detaching restores stock behaviour', () => {
  const { bridge, run, opened, open } = solo();
  bridge.attachSession({ host: false, me: 'G', members: ['H', 'G'], send: () => {} });
  bridge.openLevel(run, open);
  assert.deepEqual(opened, []);
  bridge.detach();
  bridge.openLevel(run, open);
  assert.deepEqual(opened, [7]);
});

test('waiting list reaches the HUD hook', () => {
  const seen = [];
  const bridge = installBridge({ target: {}, onWaiting: (names) => seen.push(names) });
  bridge.attachSession({ host: false, me: 'G', members: ['H', 'G'], send: () => {} });
  bridge.receive(['lw', ['H', 'G']], 'H');
  assert.deepEqual(seen, [['H', 'G']]);
  assert.deepEqual(bridge.waiting(), ['H', 'G']);
});

test('party flow: announce, guest card, one pick each resumes both', () => {
  const { host, guest, flush } = paired();
  host.bridge.openLevel(host.run, host.open);
  flush();
  assert.deepEqual(host.opened, [7], 'host card opened');
  assert.equal(guest.run.calls.resume, 0, 'nothing resumes before the guest picks');

  // The guest's own level-up routine runs from its local pendingLevels; the
  // announce it already received lets that card open immediately.
  guest.bridge.openLevel(guest.run, guest.open);
  assert.deepEqual(guest.opened, [7], 'guest card opened on its own level-up');
  assert.equal(guest.run.state, 'modal', 'guest frozen while choosing');

  guest.bridge.localPicked(guest.run);
  flush();
  assert.equal(guest.run.calls.resume, 0, 'one pick is not enough');

  host.bridge.localPicked(host.run);
  flush();
  assert.equal(host.run.calls.resume, 1);
  assert.equal(guest.run.calls.resume, 1, 'guest resumed by the release');
  assert.equal(guest.run.pendingLevels, 0);
  assert.equal(guest.run.state, 'play');
});

test('net transport: host broadcasts, guest sends picks to the host', () => {
  const sent = [];
  const net = { on() {}, send: (to, msg) => sent.push(['send', to, msg]), broadcast: (msg) => sent.push(['broadcast', msg]) };

  const host = solo();
  host.bridge.attachSession({ host: true, me: 'H', members: ['H', 'G'], net });
  host.bridge.openLevel(host.run, host.open);
  assert.deepEqual(sent[0], ['broadcast', ['lu', 7, 1]]);

  const guest = solo();
  const out = [];
  guest.bridge.attachSession({
    host: false, me: 'G', members: ['H', 'G'],
    net: { on() {}, toHost: (msg) => out.push(['toHost', msg]), send: (to, msg) => out.push(['send', to, msg]), broadcast: (msg) => out.push(['broadcast', msg]) },
  });
  guest.bridge.localPicked(guest.run);
  assert.deepEqual(out, [['toHost', ['lp']]]);
});

test('net transport: only barrier arrays are consumed, frames pass through', () => {
  const bridge = installBridge({ target: {} });
  let handler = null;
  bridge.attachSession({ host: false, me: 'G', members: ['H'], net: { on: (fn) => { handler = fn; }, send() {}, broadcast() {} } });
  bridge.bindNet({ on: (fn) => { handler = fn; } });
  handler('H', { k: 'f', t: 1 });            // a frame: ignored
  handler('H', ['lw', ['H', 'G']]);          // a barrier message: applied
  assert.deepEqual(bridge.waiting(), ['H', 'G']);
});

test('skipSpawns: guests never run the wave director, hosts and offline do', () => {
  const offline = solo();
  assert.equal(offline.bridge.skipSpawns(), false, 'no session: stock behaviour');

  const host = solo();
  host.bridge.attachSession({ host: true, me: 'H', members: ['H', 'G'], send: () => {} });
  assert.equal(host.bridge.skipSpawns(), false, 'the host spawns the world');

  const guest = solo();
  guest.bridge.attachSession({ host: false, me: 'G', members: ['H', 'G'], send: () => {} });
  assert.equal(guest.bridge.skipSpawns(), true, 'guests display the host\'s monsters only');

  guest.bridge.detach();
  assert.equal(guest.bridge.skipSpawns(), false, 'detaching restores stock behaviour');
});

function pickupStore() {
  return {
    n: 0, count: 0, free: [],
    alive: new Uint8Array(64), kind: new Uint8Array(64),
    x: new Float32Array(64), y: new Float32Array(64), z: new Float32Array(64),
    value: new Float32Array(64), collected: [],
    spawn(kind, x, y, z, value) {
      let slot;
      if (this.free.length) slot = this.free.pop();
      else slot = this.n++;
      this.alive[slot] = 1;
      this.kind[slot] = kind === 'xp' ? 0 : 1;
      this.x[slot] = x; this.y[slot] = y; this.z[slot] = z; this.value[slot] = value;
      this.count++;
    },
    collect(slot) { this.alive[slot] = 0; this.free.push(slot); this.count--; this.collected.push(slot); },
  };
}

test('shared pickups: guest touch, host credit, one ghost everywhere', () => {
  const { host, guest, flush } = paired();
  const hostStore = pickupStore();
  const guestStore = pickupStore();
  hostStore.spawn('coin', 3, 0.6, 5, 30);
  host.run.gold = 90;

  host.bridge.attachPickups({ store: hostStore, run: host.run });
  guest.bridge.attachPickups({ store: guestStore, run: guest.run });

  host.bridge.tick(host.run, 0.25);       // host snapshot
  flush();
  assert.equal(guestStore.count, 1, 'guest shows the host pickup');
  assert.equal(guest.run.gold, 90, 'party gold mirrored');

  const allowed = guest.bridge.pickupCollected(guest.run, guestStore, 0);
  assert.equal(allowed, false, 'guest must not credit locally');
  assert.equal(guestStore.collected.length, 0);

  flush();                                 // intent reaches the host
  assert.deepEqual(hostStore.collected, [0], 'host credited exactly once');
  flush();                                 // removal reaches the guest
  assert.equal(guestStore.count, 0, 'ghost removed on both sides');
});

test('pickups stay inert without a session or on the host', () => {
  const offline = solo();
  assert.equal(offline.bridge.pickupCollected(offline.run, pickupStore(), 0), true);
  assert.equal(offline.bridge.pickupsActive(), false);

  const host = solo();
  host.bridge.attachSession({ host: true, me: 'H', members: ['H'], send: () => {} });
  assert.equal(host.bridge.pickupCollected(host.run, pickupStore(), 0), true, 'host always credits');
});
test('teammate damage numbers: host emits, guest pops once, guest does not re-broadcast, no session is no-op', () => {
  // 1. No session -> no-op
  const offline = solo();
  const offlinePopups = [];
  offline.run.ui = { popup: (...args) => offlinePopups.push(args) };
  offline.bridge.damageNumber(offline.run, 10, 0, 20, 50, '#ff5555');
  assert.equal(offlinePopups.length, 0);

  // 2. Host emits and guest pops once
  const { host, guest, flush } = paired();
  const guestPopups = [];
  const hostPopups = [];
  guest.run.ui = { popup: (...args) => guestPopups.push(args) };
  guest.bridge.bind(guest.run);
  host.run.ui = { popup: (...args) => hostPopups.push(args) };
  host.bridge.bind(host.run);

  host.bridge.damageNumber(host.run, 12.5, 1, 34.5, 75, '#ff4444');
  assert.equal(guestPopups.length, 0, 'guest has not popped yet');

  flush();

  assert.equal(guestPopups.length, 1, 'guest popped once');
  assert.deepEqual(guestPopups[0], [12.5, 1, 34.5, '75', '#ff4444', 0.9]);

  // 3. Guest calling damageNumber is no-op (only host broadcasts)
  guest.bridge.damageNumber(guest.run, 5, 0, 5, 30);
  flush();
  assert.equal(hostPopups.length, 0, 'guest does not re-broadcast');
});
