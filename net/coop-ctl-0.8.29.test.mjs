// Unit tests for net/coop-ctl-0.8.29.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ctlTransport, roomSignalTransport } from './coop-ctl-0.8.29.mjs';

function fakeCoop() {
  const broadcasts = [];
  const sendCtlCalls = [];
  const mesh = {
    broadcast: (msg) => broadcasts.push(msg),
    sendCtl: (to, msg) => sendCtlCalls.push({ to, msg }),
  };
  return { coop: { mesh }, broadcasts, sendCtlCalls };
}

test('coop without mesh throws a descriptive Error', () => {
  assert.throws(() => ctlTransport(null), /coop\.mesh is unavailable/);
  assert.throws(() => ctlTransport({}), /coop\.mesh is unavailable/);
  assert.throws(() => ctlTransport({ mesh: null }), /coop\.mesh is unavailable/);
});

test('send(ev) broadcasts with shape { t: "pb", l: ev }', () => {
  const { coop, broadcasts, sendCtlCalls } = fakeCoop();
  const transport = ctlTransport(coop);

  const ev = ['lu', 5, 2];
  transport.send(ev);

  assert.equal(broadcasts.length, 1);
  assert.equal(sendCtlCalls.length, 0);
  assert.deepEqual(broadcasts[0], { t: 'pb', l: ['lu', 5, 2] });
});

test('send(ev, "uid") addresses via mesh.sendCtl with shape { t: "pb", l: ev }', () => {
  const { coop, broadcasts, sendCtlCalls } = fakeCoop();
  const transport = ctlTransport(coop);

  const ev = ['lp'];
  transport.send(ev, 'player42');

  assert.equal(broadcasts.length, 0);
  assert.equal(sendCtlCalls.length, 1);
  assert.equal(sendCtlCalls[0].to, 'player42');
  assert.deepEqual(sendCtlCalls[0].msg, { t: 'pb', l: ['lp'] });
});

test('guest transport where host id exists ONLY at coop.room.room.host addresses that uid', () => {
  const sendCtlCalls = [];
  const coop = {
    mesh: {
      broadcast: () => {},
      sendCtl: (to, msg) => sendCtlCalls.push({ to, msg }),
    },
    room: {
      room: {
        host: 'host-uid-from-inner-room',
      },
    },
  };

  const transport = ctlTransport(coop);
  transport.send(['lp'], 'host');

  assert.equal(sendCtlCalls.length, 1);
  assert.equal(sendCtlCalls[0].to, 'host-uid-from-inner-room');
  assert.deepEqual(sendCtlCalls[0].msg, { t: 'pb', l: ['lp'] });
});

test('unresolvable host throws Error naming missing id', () => {
  const coop = {
    mesh: {
      broadcast: () => {},
      sendCtl: () => {},
    },
    // No hostId, no room.host, no room.room.host
  };

  const transport = ctlTransport(coop);
  assert.throws(
    () => transport.send(['lp'], 'host'),
    /ctlTransport: host id unresolved for addressed message/,
  );
});

test('opts.hostId takes precedence in host resolution', () => {
  const sendCtlCalls = [];
  const coop = {
    mesh: {
      broadcast: () => {},
      sendCtl: (to, msg) => sendCtlCalls.push({ to, msg }),
    },
    room: { room: { host: 'inner-host' } },
  };

  const transport = ctlTransport(coop, null, { hostId: 'explicit-override-host' });
  transport.send(['lp'], 'host');

  assert.equal(sendCtlCalls.length, 1);
  assert.equal(sendCtlCalls[0].to, 'explicit-override-host');
});

test('receive unpacks { t: "pb", l: ev } and delivers to listener', () => {
  const { coop } = fakeCoop();
  const delivered = [];
  const transport = ctlTransport(coop, (ev, from) => {
    delivered.push({ ev, from });
  });

  const msg = { t: 'pb', l: ['pkp', [1, 2], 50] };
  const res = transport.receive(msg, 'peer1');

  assert.deepEqual(res, ['pkp', [1, 2], 50]);
  assert.deepEqual(delivered, [{ ev: ['pkp', [1, 2], 50], from: 'peer1' }]);

  // Raw array pass-through
  const raw = ['lr'];
  const resRaw = transport.receive(raw, 'peer2');
  assert.deepEqual(resRaw, ['lr']);
  assert.deepEqual(delivered[1], { ev: ['lr'], from: 'peer2' });
});
test('roomSignalTransport send posts {to, kind:"pb", data:{l:ev}}', () => {
  const posted = [];
  const transport = roomSignalTransport({}, {
    signal: (to, kind, data) => posted.push({ to, kind, data }),
    hostId: 'H',
  });

  // Broadcast sends to '*'
  transport.send(['lu', 3, 1]);
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0], { to: '*', kind: 'pb', data: { l: ['lu', 3, 1] } });

  // Addressed to specific peer
  transport.send(['lp'], 'peer99');
  assert.equal(posted.length, 2);
  assert.deepEqual(posted[1], { to: 'peer99', kind: 'pb', data: { l: ['lp'] } });

  // Addressed to host
  transport.send(['pki', 42], 'host');
  assert.equal(posted.length, 3);
  assert.deepEqual(posted[2], { to: 'H', kind: 'pb', data: { l: ['pki', 42] } });
});

test('roomSignalTransport poll delivers signals exactly once and advances cursor', async () => {
  const signals = [
    { id: 1, from: 'me', to: '*', kind: 'pb', data: { l: ['echo'] } },
    { id: 2, from: 'peerA', to: '*', kind: 'pb', data: { l: ['lu', 2, 1] } },
    { id: 3, from: 'peerA', to: '*', kind: 'other', data: {} },
    { id: 4, from: 'peerB', to: 'me', kind: 'pb', data: { l: ['lp'] } },
  ];

  const delivered = [];
  const transport = roomSignalTransport({}, {
    signal: () => {},
    poll: async (after) => signals.filter((s) => s.id > after),
    me: 'me',
    onMessage: (ev, from) => delivered.push({ ev, from }),
  });

  await transport.pollOnce();
  assert.equal(transport.cursor, 4);
  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered[0], { ev: ['lu', 2, 1], from: 'peerA' });
  assert.deepEqual(delivered[1], { ev: ['lp'], from: 'peerB' });

  // Second poll with no new signals delivers nothing further
  await transport.pollOnce();
  assert.equal(delivered.length, 2);
  assert.equal(transport.cursor, 4);
});
