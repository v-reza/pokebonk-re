// tools/apply-bundle-patches.test.mjs
//
// Covers the one-pass 0.8.29 patch set: anchors resolve, every patch is applied
// exactly once, re-running is a no-op, and a bad bundle fails loudly instead of
// writing a half-patched file. When PB_UPSTREAM_BUNDLE points at the real
// mvl14oup chunk, the same guarantees are checked against it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { applyCoopPatches, COOP_PATCHES } from './bundle-patches-0.8.29.mjs';
import { parsesAsModule } from './apply-bundle-patches.mjs';

// The three anchors exactly as they appear in mvl14oup, inside a module-shaped
// shell so the parse check is meaningful.
const FIXTURE = [
  'import{x}from"./chunk.js";',
  'var R=class{',
  'levelUp(){',
  'let t=this.meta.lab(`choice4`)?4:3,n=(e=!0)=>{this.ui.hideModal()},',
  'r=()=>{},',
  'i=e=>{},',
  'a=e=>{e.length?this.ui.showLevelUp(this,e,(e,r)=>{try{}catch(e){rc(`levelup`,e)}finally{n()}}):r()};',
  'a(bb(this,t))}',
  'tick(dt){let a=0,o=0;!this.sanctuary&&!a&&!o&&this.director.update(e),this.enemies.update(e),this.coop?.afterEnemies()}',
  'collect(e){let t=this.run,n=t.player;this.alive[e]=0,this.count--}',
  'openRun(){this.run=new nE(this.r,this.input,M,this.hud,this.meta,e),No(!0)}',
  'startBtn(){return X(`button`,{class:`btn big red`,disabled:!!te||a,onclick:async()=>{}})}',
  'onCtl(e,t){let n=this.peers.get(e);switch(t.t){case`mark`:Number.isFinite(+t.x+ +t.z)&&this.addMark(n.slot,+t.x,+t.z,n.name)}}',
  'takeHp(e,t){let n=this.run.enemies,r=this.run.coop;r&&n.flags[e]?r.hitProxy(e,t):n.hp[e]-=t}',
  '};',
].join('\n');

test('applies every patch exactly once and the result parses', () => {
  const { source, applied, skipped } = applyCoopPatches(FIXTURE);
  assert.deepEqual(applied, COOP_PATCHES.map((p) => p.id));
  assert.deepEqual(skipped, []);
  for (const patch of COOP_PATCHES) {
    assert.equal(source.split(patch.marker).length - 1, 1, `${patch.id} inserted once`);
  }
  // the anchors survive the insertion, so the bundle still reads the same code
  assert.ok(source.includes('a(bb(this,t))}'));
  assert.ok(source.includes('finally{'), 'card close path rewritten');
  assert.equal(parsesAsModule(source).ok, true);
});

test('only the host runs the wave director', () => {
  const { source } = applyCoopPatches(FIXTURE);
  const line = source.split('\n').find((l) => l.includes('director.update'));
  assert.match(line,
    /!\(globalThis\.__pbCoop&&__pbCoop\.skipSpawns&&__pbCoop\.skipSpawns\(\)\)&&this\.director\.update\(e\)/);
  assert.ok(line.includes('this.enemies.update(e)'), 'enemy AI still runs on guests (mirrors must move)');
});

test('pickups: per-frame tick + guest collect guard', () => {
  const { source } = applyCoopPatches(FIXTURE);
  const tickLine = source.split('\n').find((l) => l.includes('__pbCoop.tick'));
  assert.match(tickLine, /__pbCoop\.tick\(this,e\)/);
  assert.ok(tickLine.includes('this.enemies.update(e)'));
  const collectLine = source.split('\n').find((l) => l.includes('__pbCoop.pickupCollected'));
  assert.match(collectLine, /collect\(e\)\{if\(globalThis\.__pbCoop&&__pbCoop\.pickupCollected&&__pbCoop\.pickupCollected\(this\.run,this,e\)===false\)return;/);
  assert.ok(collectLine.includes('let t=this.run,n=t.player;'), 'original body preserved');
});

test('ctl receive: unknown types forwarded to bridge', () => {
  const { source } = applyCoopPatches(FIXTURE);
  const ctlLine = source.split('\n').find((l) => l.includes('__pbCoop.receive'));
  assert.match(ctlLine, /default:globalThis\.__pbCoop&&__pbCoop\.receive&&__pbCoop\.receive\(t,e\)/);
  assert.ok(ctlLine.includes('this.addMark(n.slot,+t.x,+t.z,n.name);break;'), 'break before default');
});

test('shot tick: samples projectiles at per-frame tick site', () => {
  const { source } = applyCoopPatches(FIXTURE);
  const shotLine = source.split('\n').find((l) => l.includes('__pbCoop.tickShots'));
  assert.match(shotLine, /__pbCoop\.tickShots\(this,e\),this\.enemies\.update\(e\)/);
});

test('hurt number: broadcasts damage number on authoritative takeHp', () => {
  const { source } = applyCoopPatches(FIXTURE);
  const hurtLine = source.split('\n').find((l) => l.includes('__pbCoop.damageNumber'));
  assert.match(hurtLine, /n\.hp\[e\]-=t,globalThis\.__pbCoop&&__pbCoop\.damageNumber&&__pbCoop\.damageNumber\(this\.run,n\.x\[e\],n\.y\[e\],n\.z\[e\],t\)\}/);
});

test('the host start gate accepts the relay transport', () => {
  const { source } = applyCoopPatches(FIXTURE);
  assert.match(source, /disabled:\(!!te&&!\(globalThis\.__pbCoop&&__pbCoop\.relayReady&&__pbCoop\.relayReady\(\)\)\)\|\|a/);
});

test('optional patches are skipped on builds without the anchor', () => {
  const withoutGate = FIXTURE.replace('disabled:!!te||a,', 'disabled:onlyAfterMesh,');
  const res = applyCoopPatches(withoutGate);
  assert.ok(res.skipped.includes('L10-start-gate'), 'gate patch skipped when its anchor is absent');
  assert.ok(res.applied.length >= 1);
});

test('re-applying is a no-op', () => {
  const first = applyCoopPatches(FIXTURE);
  const second = applyCoopPatches(first.source);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, COOP_PATCHES.map((p) => p.id));
  assert.equal(second.source, first.source);
});

test('level-up opener is handed to the bridge, with a stock fallback', () => {
  const { source } = applyCoopPatches(FIXTURE);
  const line = source.split('\n').find((l) => l.includes('__pbCoop.openLevel'));
  assert.match(
    line,
    /globalThis\.__pbCoop&&__pbCoop\.openLevel\?__pbCoop\.openLevel\(this,\(\)=>a\(bb\(this,t\)\)\):a\(bb\(this,t\)\)\}$/,
  );
});

test('a missing anchor fails with the patch id', () => {
  assert.throws(
    () => applyCoopPatches(FIXTURE.replace('a(bb(this,t))}', 'a(bb(this,t))')),
    /L1-open-level\] anchor not found/,
  );
});

test('a duplicated anchor fails instead of patching the wrong site', () => {
  const duplicated = `${FIXTURE}\nvar dup=c=>{a(bb(this,t))}};`;
  assert.throws(
    () => applyCoopPatches(duplicated),
    /L1-open-level\] anchor not unique \(2 matches\)/,
  );
});

test('co-op-off runs are untouched: every insertion is behind __pbCoop', () => {
  const { source } = applyCoopPatches(FIXTURE);
  const inserted = COOP_PATCHES.map((p) => source.split(p.marker).length - 1);
  assert.deepEqual(inserted, COOP_PATCHES.map(() => 1), 'each patch present once');
  for (const line of source.split('\n').filter((l) => l.includes('__pbCoop'))) {
    assert.ok(/globalThis\.__pbCoop&&/.test(line), line);
  }
});

const realBundle = process.env.PB_UPSTREAM_BUNDLE;
test('real mvl14oup bundle: anchors unique and output parses', { skip: !realBundle || !existsSync(realBundle) }, () => {
  const source = readFileSync(realBundle, 'utf8');
  const { applied, source: patched } = applyCoopPatches(source);
  assert.equal(applied.length, COOP_PATCHES.length);
  assert.equal(parsesAsModule(patched).ok, true);
});
