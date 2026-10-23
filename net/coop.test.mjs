// Unit tests for the co-op controller (net/coop.mjs) against a stub net layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Coop, serializePlayerState, readPlayerState, serializeEnemyFrame } from './coop.mjs';

function stubNet(uid) {
  const sent = [];
  return {
    sent,
    getUid: () => uid,
    send: (to, msg) => sent.push({ to, msg }),
    toHost: (msg) => sent.push({ to: 'host', msg }),
    on() {}, off() {}, onPeer() {},
    slow: () => false,
  };
}

const members = [
  { uid: 'H', name: 'Host', dex: 4 },
  { uid: 'G', name: 'Guest', dex: 7, shiny: true },
];

function session(me, game = {}) {
  const net = stubNet(me);
  const coop = new Coop(net, game);
  coop.begin({ seed: 1, host: 'H', members }, { pos: { x: 0, z: 0 }, speciesId: me === 'H' ? 4 : 7 }, {
    team: () => ({ time: 0, level: 1, xp: 0, xpNext: 1, kills: 0, bosses: 0, coins: 0 }),
    ...game,
  });
  return { coop, net };
}

test('mates keep their own species from the member list', () => {
  const { coop } = session('H');
  const g = coop.mate('G');
  assert.equal(g.dex, 7);
  assert.equal(g.shiny, true);
});

test('player state carries species, shiny and sub-metre positions', () => {
  const a = serializePlayerState({ x: 7.678, y: -15.314, angle: 0, hp: 10, maxHp: 20, dex: 7, shiny: 1 });
  const s = readPlayerState(a);
  assert.equal(s.x, 7.68);
  assert.equal(s.y, -15.31);
  assert.equal(s.dex, 7);
  assert.equal(s.shiny, 1);
});

test('enemy rows are not rounded to whole metres', () => {
  const [row] = serializeEnemyFrame([{ slot: 3, x: 7.678, y: 15.314, hp: 9.2, anim: 0, dir: 0, status: 0 }]);
  assert.deepEqual(row.slice(0, 4), [3, 7.68, 15.31, 10]);
});

test('two queued level-ups: a guest pick counts for one card only', () => {
  let resumed = 0;
  const { coop } = session('H', { resume: () => resumed++ });
  coop.levelStart(2);
  coop.levelStart(3);
  coop.picked('G');                 // guest's first card
  coop.localPicked();               // host's first card
  coop.localPicked();               // host's second card
  assert.equal(resumed, 0, 'guest still owes its second card');
  assert.deepEqual([...coop.waiting], ['G']);
  coop.picked('G');
  assert.equal(resumed, 1);
  assert.equal(coop.waiting.size, 0);
});

test('a teammate leaving while owed cards releases the wait', () => {
  let resumed = 0;
  const { coop } = session('H', { resume: () => resumed++, mateLeft() {} });
  coop.levelStart(2);
  coop.levelStart(3);
  coop.localPicked();
  coop.localPicked();
  coop.mateGone('G');
  assert.equal(resumed, 1);
});

test('a guest never runs the shared level-up or sends host frames', () => {
  const { coop, net } = session('G');
  coop.levelStart(2);
  coop.flushAll();
  assert.equal(net.sent.length, 0);
  assert.equal(coop.waiting.size, 0);
});

test('a guest whose run ends says bye instead of vanishing', () => {
  const { coop, net } = session('G');
  coop.over({ why: 'lose' });
  const last = net.sent.at(-1);
  assert.equal(last.to, 'host');
  assert.deepEqual(last.msg.ev.at(-1), ['bye']);
  assert.equal(coop.active, false);
});

test('host sends a full enemy snapshot on a guest\'s first frame', () => {
  const snap = [['ne', 0, 16, 1, 2, 0, 0, 50, 3, 0], ['ne', 4, 19, 5, 6, 0, 0, 40, 2, 0]];
  const { coop } = session('H', { enemySnapshot: () => snap });
  coop.onClientFrame('G', { k: 'f', p: serializePlayerState({ x: 1, y: 2, dex: 7 }), ev: [] });
  assert.deepEqual(coop.mate('G').q, snap);
  coop.mate('G').q = [];
  coop.onClientFrame('G', { k: 'f', p: serializePlayerState({ x: 1, y: 2, dex: 7 }), ev: [] });
  assert.deepEqual(coop.mate('G').q, [], 'only once');
});

test('guest hits keep their direction and real damage', () => {
  const { coop } = session('G');
  coop.hit(5, 25.456, 16777215, 0.6, -0.8, 1.5);
  assert.deepEqual(coop.outEv.at(-1), ['h', 5, 25.46, 16777215, 0.6, -0.8, 1.5]);
});

test('a teammate that reloads (new session id) is taken back with a fresh snapshot', () => {
  let back = 0, snaps = 0;
  const { coop } = session('H', { mateBack: () => back++, enemySnapshot: () => { snaps++; return []; } });
  const frame = (sid) => ({ k: 'f', p: serializePlayerState({ x: 1, y: 2, dex: 7 }), ev: [], sid });
  coop.onClientFrame('G', frame('a'));
  coop.onClientFrame('G', frame('a'));
  assert.equal(back, 0);
  assert.equal(snaps, 1);
  coop.onClientFrame('G', frame('b'));        // reloaded
  assert.equal(back, 1);
  assert.equal(snaps, 2);
});

test('a silent teammate is dropped, and taken back when it speaks again', () => {
  let left = 0, back = 0;
  const { coop } = session('H', { mateLeft: () => left++, mateBack: () => back++ });
  coop.onClientFrame('G', { k: 'f', p: serializePlayerState({ x: 0, y: 0 }), ev: [], sid: 's1' });
  coop.mate('G').lastAt -= 11000;
  coop.tick(0.01);
  assert.equal(left, 1);
  assert.equal(coop.mate('G').connected, false);
  coop.onClientFrame('G', { k: 'f', p: serializePlayerState({ x: 0, y: 0 }), ev: [], sid: 's1' });
  assert.equal(back, 1);
  assert.equal(coop.mate('G').connected, true);
});

test('guest gold changes and ghost shots reach the host', () => {
  let gold = 0, ghosts = 0;
  const { coop } = session('H', { goldDelta: (d) => { gold += d; }, ghostFire: () => ghosts++ });
  coop.onClientFrame('G', { k: 'f', p: serializePlayerState({ x: 0, y: 0 }), ev: [['gd', 7], ['pf', [1, 2, 3]]], sid: 's' });
  assert.equal(gold, 7);
  assert.equal(ghosts, 1);
});
