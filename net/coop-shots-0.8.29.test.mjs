// Unit tests for net/coop-shots-0.8.29.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ShotSync, shotsFor, SHOT_MAX, SHOT_RATE } from './coop-shots-0.8.29.mjs';

function fakeProjectiles(count = 10) {
  const cap = 200;
  return {
    n: count,
    alive: new Uint8Array(cap),
    x: new Float32Array(cap),
    y: new Float32Array(cap),
    z: new Float32Array(cap),
    vx: new Float32Array(cap),
    vy: new Float32Array(cap),
    vz: new Float32Array(cap),
    life: new Float32Array(cap),
    rad: new Float32Array(cap),
    dmg: new Float32Array(cap),
    shape: new Uint8Array(cap),
    slot: new Int8Array(cap),
    spawn({ x = 0, y = 0, z = 0, vx = 1, vy = 0, vz = 0, life = 2, rad = 0.5, dmg = 10, shape = 1, slot = -1 }) {
      const idx = this.n++;
      this.alive[idx] = 1;
      this.x[idx] = x; this.y[idx] = y; this.z[idx] = z;
      this.vx[idx] = vx; this.vy[idx] = vy; this.vz[idx] = vz;
      this.life[idx] = life; this.rad[idx] = rad; this.dmg[idx] = dmg;
      this.shape[idx] = shape; this.slot[idx] = slot;
      return idx;
    },
  };
}

test('shotsFor emits rows for alive projectiles only (skips alive === 0)', () => {
  const store = fakeProjectiles(0);
  store.spawn({ x: 10, z: 20, slot: -1 }); // idx 0: alive
  store.spawn({ x: 30, z: 40, slot: -1 }); // idx 1: dead
  store.alive[1] = 0;
  store.spawn({ x: 50, z: 60, slot: 0 });  // idx 2: player shot (slot 0)
  store.spawn({ x: 70, z: 80, slot: -1 }); // idx 3: alive

  const rows = shotsFor(store, -1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0], 10);
  assert.equal(rows[0][2], 20);
  assert.equal(rows[1][0], 70);
  assert.equal(rows[1][2], 80);
});

test('shotsFor respects capacity limit (cap)', () => {
  const store = fakeProjectiles(0);
  for (let i = 0; i < 100; i++) {
    store.spawn({ x: i, z: i, slot: -1 });
  }

  const rows = shotsFor(store, -1, 60);
  assert.equal(rows.length, 60);
});

test('host emits rows on tick at rate', () => {
  const store = fakeProjectiles(0);
  store.spawn({ x: 5, y: 1, z: 15, vx: 2, vy: 0, vz: 3, life: 1.5, rad: 0.8, dmg: 25, shape: 3, slot: -1 });

  const sent = [];
  const sync = new ShotSync({
    host: true,
    send: (ev) => sent.push(ev),
    projectiles: store,
  });

  // dt < SHOT_RATE -> no emit
  sync.tick(0.05);
  assert.equal(sent.length, 0);

  // dt >= SHOT_RATE -> emits ['esn', rows]
  sync.tick(0.06);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'esn');
  assert.equal(sent[0][1].length, 1);
  assert.deepEqual(sent[0][1][0], [5, 1, 15, 2, 0, 3, 1.5, 0.8, 25, 3]);
});

test('guest receives snapshot and clears on esc', () => {
  const sync = new ShotSync({
    host: false,
    send: () => {},
  });

  const snapshot = ['esn', [
    [10, 0, 20, 1, 0, 0, 2, 0.5, 10, 1],
    [30, 0, 40, 0, 0, 1, 3, 0.6, 15, 2],
  ]];

  sync.receive(snapshot);
  assert.equal(sync.ghosts.length, 2);
  assert.equal(sync.ghosts[0].x, 10);
  assert.equal(sync.ghosts[1].z, 40);

  // Clear message
  sync.receive(['esc']);
  assert.equal(sync.ghosts.length, 0);
});

test('no double-apply when the same snapshot arrives twice', () => {
  const sync = new ShotSync({
    host: false,
    send: () => {},
  });

  const snapshot = ['esn', [
    [10, 0, 20, 1, 0, 0, 2, 0.5, 10, 1],
  ]];

  sync.receive(snapshot);
  const firstGhosts = sync.ghosts;
  assert.equal(sync.ghosts.length, 1);

  // Receive the exact same snapshot again
  sync.receive(snapshot);
  assert.equal(sync.ghosts, firstGhosts, 'ghost list reference unchanged on duplicate snapshot');
  assert.equal(sync.ghosts.length, 1);
});
