// Unit tests for net/coop-boot-0.8.29.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootCoop, bootInfo } from './coop-boot-0.8.29.mjs';

function fakeStore() {
  return {
    n: 0, count: 0, free: [],
    alive: new Uint8Array(2000), kind: new Uint8Array(2000),
    x: new Float32Array(2000), y: new Float32Array(2000), z: new Float32Array(2000),
    value: new Float32Array(2000),
    collected: [],
    spawn(kind, x, y, z, value) {
      let slot;
      if (this.free.length) slot = this.free.pop();
      else if (this.n < 2000) slot = this.n++;
      else return null;
      this.alive[slot] = 1;
      this.kind[slot] = kind === 'xp' ? 0 : 1;
      this.x[slot] = x; this.y[slot] = y; this.z[slot] = z; this.value[slot] = value;
      this.count++;
      return slot;
    },
    collect(slot) {
      this.alive[slot] = 0;
      this.free.push(slot);
      this.count--;
      this.collected.push(slot);
    },
  };
}

function fakeRun(level = 5, gold = 10) {
  const calls = { hideModal: 0, resume: 0 };
  return {
    player: { level },
    pendingLevels: 1,
    state: 'modal',
    gold,
    ui: { hideModal: () => calls.hideModal++ },
    resume: () => calls.resume++,
    calls,
  };
}

test('__pbCoop installed and bootInfo reports state', () => {
  if (globalThis.__pbCoop) globalThis.__pbCoop.reset();
  globalThis.__pbCoop = null;

  assert.throws(() => bootCoop({ store: fakeStore() }), /coop session is required/);
  assert.throws(() => bootCoop({ coop: { mesh: {} } }), /pickup store is required/);

  const coop = {
    mesh: { broadcast: () => {}, sendCtl: () => {} },
    isHost: true,
  };
  const store = fakeStore();
  const run = fakeRun();

  bootCoop({ coop, store, run, host: true, me: 'H', members: ['H', 'G'] });

  assert.ok(globalThis.__pbCoop, 'bridge installed on globalThis');
  const info = bootInfo();
  assert.equal(info.installed, true);
  assert.equal(info.guest, false);
  assert.equal(info.pickups, true);
});

test('host announces on openLevel and a guest defers then opens on an incoming lu', () => {
  if (globalThis.__pbCoop) globalThis.__pbCoop.reset();
  globalThis.__pbCoop = null;

  const hostBroadcasts = [];
  const hostCoop = {
    mesh: { broadcast: (msg) => hostBroadcasts.push(msg), sendCtl: () => {} },
    isHost: true,
  };
  const hostRun = fakeRun(7);
  const hostStore = fakeStore();

  const { bridge: hostBridge } = bootCoop({
    coop: hostCoop,
    store: hostStore,
    run: hostRun,
    host: true,
    me: 'H',
    members: ['H', 'G'],
  });

  const hostOpened = [];
  hostBridge.openLevel(hostRun, () => hostOpened.push(hostRun.player.level));

  assert.deepEqual(hostOpened, [7]);
  const luMsg = hostBroadcasts.find((m) => m.t === 'pb' && m.l[0] === 'lu');
  assert.ok(luMsg, 'host broadcast lu message');

  const guestCoop = {
    mesh: { broadcast: () => {}, sendCtl: () => {} },
    isHost: false,
    hostId: 'H',
  };
  const guestRun = fakeRun(7);
  const guestStore = fakeStore();

  const { bridge: guestBridge } = bootCoop({
    coop: guestCoop,
    store: guestStore,
    run: guestRun,
    host: false,
    me: 'G',
    members: ['H', 'G'],
  });

  const guestOpened = [];
  guestBridge.openLevel(guestRun, () => guestOpened.push(guestRun.player.level));

  assert.deepEqual(guestOpened, [], 'guest deferred openLevel');

  // Incoming lu arrives at guest bridge as ctl message { t: 'pb', l: ['lu', 7, 1] }
  guestBridge.receive(luMsg, 'H');

  assert.deepEqual(guestOpened, [7], 'guest card opened on lu');
});

test("a guest's pickupCollected returns false and sends ['pki',id] addressed to the host", () => {
  if (globalThis.__pbCoop) globalThis.__pbCoop.reset();
  globalThis.__pbCoop = null;

  const guestCtlSent = [];
  const guestCoop = {
    mesh: {
      broadcast: () => {},
      sendCtl: (to, msg) => guestCtlSent.push({ to, msg }),
    },
    isHost: false,
    hostId: 'H',
  };
  const guestStore = fakeStore();
  const guestRun = fakeRun();

  const { bridge } = bootCoop({
    coop: guestCoop,
    store: guestStore,
    run: guestRun,
    host: false,
    me: 'G',
    members: ['H', 'G'],
  });

  // Host sends snapshot with one pickup
  bridge.receive({ t: 'pb', l: ['pkp', [{ id: 80, kind: 0, x: 5, z: 10, value: 1 }], 0] }, 'H');

  let ghostSlot = -1;
  for (let i = 0; i < guestStore.n; i++) {
    if (guestStore.alive[i]) {
      ghostSlot = i;
      break;
    }
  }
  assert.ok(ghostSlot >= 0, 'ghost pickup spawned in guest store');

  const allowed = bridge.pickupCollected(guestRun, guestStore, ghostSlot);

  assert.equal(allowed, false);
  assert.equal(guestCtlSent.length, 1);
  assert.equal(guestCtlSent[0].to, 'H');
  assert.deepEqual(guestCtlSent[0].msg, { t: 'pb', l: ['pki', 80] });
});

test('tick(run,0.25) makes the host emit a pkp snapshot', () => {
  if (globalThis.__pbCoop) globalThis.__pbCoop.reset();
  globalThis.__pbCoop = null;

  const hostBroadcasts = [];
  const hostCoop = {
    mesh: { broadcast: (msg) => hostBroadcasts.push(msg), sendCtl: () => {} },
    isHost: true,
  };
  const hostStore = fakeStore();
  const hostRun = fakeRun(1, 42);

  const { bridge } = bootCoop({
    coop: hostCoop,
    store: hostStore,
    run: hostRun,
    host: true,
    me: 'H',
    members: ['H'],
  });

  hostStore.spawn('coin', 15, 0, 25, 5);

  bridge.tick(hostRun, 0.25);

  const pkpMsg = hostBroadcasts.find((m) => m.t === 'pb' && m.l[0] === 'pkp');
  assert.ok(pkpMsg, 'emitted pkp snapshot');
  assert.equal(pkpMsg.l[2], 42, 'included party gold');
  assert.equal(pkpMsg.l[1].length, 1, 'included 1 pickup row');
  assert.equal(pkpMsg.l[1][0].value, 5);
});

test('skipSpawns() true for guests / false for host', () => {
  if (globalThis.__pbCoop) globalThis.__pbCoop.reset();
  globalThis.__pbCoop = null;

  const hostCoop = { mesh: { broadcast: () => {}, sendCtl: () => {} }, isHost: true };
  const { bridge: hostBridge } = bootCoop({
    coop: hostCoop,
    store: fakeStore(),
    host: true,
    me: 'H',
  });
  assert.equal(hostBridge.skipSpawns(), false, 'host does not skip spawns');

  const guestCoop = { mesh: { broadcast: () => {}, sendCtl: () => {} }, isHost: false };
  const { bridge: guestBridge } = bootCoop({
    coop: guestCoop,
    store: fakeStore(),
    host: false,
    me: 'G',
    members: ['H', 'G'],
  });
  assert.equal(guestBridge.skipSpawns(), true, 'guest skips spawns');
});

test('two bootstraps (host+guest) exchanging messages through the ctl transport end up with the same visible pickup on both sides', () => {
  if (globalThis.__pbCoop) globalThis.__pbCoop.reset();
  globalThis.__pbCoop = null;

  let hostBridgeRef, guestBridgeRef;

  const hostCoop = {
    mesh: {
      broadcast: (msg) => {
        guestBridgeRef?.receive(msg, 'H');
      },
      sendCtl: (to, msg) => {
        if (to === 'G') guestBridgeRef?.receive(msg, 'H');
      },
    },
    isHost: true,
    me: 'H',
  };

  const guestCoop = {
    mesh: {
      broadcast: (msg) => {
        hostBridgeRef?.receive(msg, 'G');
      },
      sendCtl: (to, msg) => {
        if (to === 'H' || to === 'host') hostBridgeRef?.receive(msg, 'G');
      },
    },
    isHost: false,
    me: 'G',
    hostId: 'H',
  };

  const hostStore = fakeStore();
  const guestStore = fakeStore();
  const hostRun = fakeRun(1, 100);
  const guestRun = fakeRun(1, 0);
  const hostTarget = {};
  const guestTarget = {};

  const hostRes = bootCoop({
    target: hostTarget,
    coop: hostCoop,
    store: hostStore,
    run: hostRun,
    host: true,
    me: 'H',
    members: ['H', 'G'],
  });
  hostBridgeRef = hostRes.bridge;

  const guestRes = bootCoop({
    target: guestTarget,
    coop: guestCoop,
    store: guestStore,
    run: guestRun,
    host: false,
    me: 'G',
    members: ['H', 'G'],
  });
  guestBridgeRef = guestRes.bridge;

  // Host spawns a pickup
  hostStore.spawn('xp', 12.5, 0, 30.5, 25);
  assert.equal(hostStore.count, 1);
  assert.equal(guestStore.count, 0);

  // Host ticks: triggers snapshot broadcast via ctlTransport
  hostBridgeRef.tick(hostRun, 0.25);

  // Guest should have received the pkp snapshot and spawned ghost
  assert.equal(guestStore.count, 1, 'guest materialised the pickup ghost');

  let guestSlot = -1;
  for (let i = 0; i < guestStore.n; i++) {
    if (guestStore.alive[i]) {
      guestSlot = i;
      break;
    }
  }
  assert.ok(guestSlot >= 0);
  assert.equal(guestStore.x[guestSlot], 12.5);
  assert.equal(guestStore.z[guestSlot], 30.5);
  assert.equal(guestStore.value[guestSlot], 25);
});
test('boot with opts.host given as a uid string addresses that uid', () => {
  if (globalThis.__pbCoop) globalThis.__pbCoop.reset();
  globalThis.__pbCoop = null;

  const sent = [];
  const guestCoop = {
    mesh: {
      broadcast: () => {},
      sendCtl: (to, msg) => sent.push({ to, msg }),
    },
    isHost: false,
  };
  const guestRun = fakeRun();
  const guestStore = fakeStore();

  const { bridge } = bootCoop({
    coop: guestCoop,
    store: guestStore,
    run: guestRun,
    host: 'explicit-host-uid',
    me: 'G',
    members: ['first-member', 'G'],
  });

  bridge.localPicked(guestRun);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'explicit-host-uid');
  assert.deepEqual(sent[0].msg, { t: 'pb', l: ['lp'] });
  assert.equal(guestCoop.hostId, 'explicit-host-uid');
});

test('boot never uses members[0] as host and unresolvable host throws', () => {
  if (globalThis.__pbCoop) globalThis.__pbCoop.reset();
  globalThis.__pbCoop = null;

  const guestCoop = {
    mesh: {
      broadcast: () => {},
      sendCtl: () => {},
    },
    isHost: false,
  };
  const guestRun = fakeRun();
  const guestStore = fakeStore();

  const { bridge } = bootCoop({
    coop: guestCoop,
    store: guestStore,
    run: guestRun,
    host: false,
    me: 'G',
    members: ['first-member', 'G'],
  });

  assert.equal(guestCoop.hostId, undefined, 'members[0] was not assigned to coop.hostId');
  assert.throws(
    () => bridge.localPicked(guestRun),
    /ctlTransport: host id unresolved for addressed message/,
  );
});
test('boot with throwing mesh and no relay throws', () => {
  if (globalThis.__pbCoop) globalThis.__pbCoop.reset();
  globalThis.__pbCoop = null;

  const brokenCoop = {}; // no mesh
  assert.throws(
    () => bootCoop({ coop: brokenCoop, store: fakeStore(), host: true }),
    /coop\.mesh is unavailable/,
  );
});

test('boot with throwing mesh + relay uses the fallback and sets relay flag', () => {
  if (globalThis.__pbCoop) globalThis.__pbCoop.reset();
  globalThis.__pbCoop = null;

  const posted = [];
  const brokenCoop = { room: { host: 'H' } }; // no mesh
  const relay = {
    signal: (to, kind, data) => posted.push({ to, kind, data }),
    poll: async () => [],
  };

  const { bridge } = bootCoop({
    coop: brokenCoop,
    store: fakeStore(),
    host: 'H',
    me: 'G',
    relay,
  });

  const info = bootInfo();
  assert.equal(info.installed, true);
  assert.equal(info.relay, true, 'marked as relay in bootInfo');

  // Test that send routes through relay
  bridge.localPicked(fakeRun());
  assert.equal(posted.length, 1);
  assert.equal(posted[0].to, 'H');
  assert.equal(posted[0].kind, 'pb');
  assert.deepEqual(posted[0].data, { l: ['lp'] });
});
