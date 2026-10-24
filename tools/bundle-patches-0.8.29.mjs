// tools/bundle-patches-0.8.29.mjs — one-pass patch set for upstream build mvl14oup.
//
// Scope: the fork-only behaviour upstream does not ship — the party-wide level-up
// barrier (docs/upstream-coop-protocol-diff.md §6.1). Everything else about co-op
// (hits, deaths, statuses, boss, xp, revive, fx, party HUD, minimap markers, lobby,
// chat, invites) is upstream code and must NOT be re-patched.
//
// Every patch is gated on `globalThis.__pbCoop`, so a bundle with the patches
// applied behaves exactly like stock until the co-op bridge installs that object.
// The bridge owns the semantics; these patches only call into it.
//
// Anchors were read from mvl14oup (main-DEBvJLhQ-mvl14oup.js) and are verified
// unique by tools/apply-bundle-patches.mjs before anything is written.

// Verified against both builds: mvl14oup (0.8.29) and mvlr7rzv (0.8.34).
// Anchors are listed per patch as candidates; the applier picks the one that
// occurs exactly once, so one table serves every build it has been checked on.
export const UPSTREAM_BUILDS = ['mvlr7rzv', 'mvl14oup'];
export const UPSTREAM_BUILD = UPSTREAM_BUILDS[0];
export const UPSTREAM_VERSION = '0.8.34';

const guard = (call) => `globalThis.__pbCoop&&${call}`;

export const COOP_PATCHES = [
  {
    id: 'L1-open-level',
    why:
      'Upstream opens a level-up card only for the player who levelled and tells nobody. '
      + 'The routine ends by calling its own card opener; handing that closure to the bridge '
      + 'lets the host announce first and lets a guest defer the card until the host says so. '
      + 'With no co-op session the bridge calls the opener immediately, so stock behaviour is '
      + 'preserved byte for byte.',
    anchors: ['a(bb(this,t))}', 'a(Ub(this,t))}'],
    marker: guard('__pbCoop.openLevel'),
    build: (anchor) => {
      const call = anchor.slice(0, -1); // strip the routine's closing brace
      return `globalThis.__pbCoop&&__pbCoop.openLevel?__pbCoop.openLevel(this,()=>${call}):${anchor}`;
    },
  },
  {
    id: 'L2-pick-confirm',
    why:
      'A guest must never run the shared level-up, but the host has to learn when it picked. '
      + 'The card callback ends in `finally{n()}`, the single place every confirm path '
      + '(pick, reroll, banish, skip) passes through.',
    anchors: [
      'catch(e){rc(`levelup`,e)}finally{n()}}):r()};',
      'catch(e){oc(`levelup`,e)}finally{n()}}):r()};',
    ],
    marker: guard('__pbCoop.localPicked&&__pbCoop.localPicked()'),
    build: (anchor) =>
      anchor.replace('finally{n()}', `finally{${guard('__pbCoop.localPicked&&__pbCoop.localPicked()')},n()}`),
  },
  {
    id: 'L3-host-spawns',
    why:
      'Upstream co-op lets every client run its own wave director, so each screen spawns its own '
      + 'monsters and then mirrors everyone else\'s. The fork wants ONE world: only the host spawns, '
      + 'and guests display the host\'s monsters through the existing proxy machinery. With no '
      + 'co-op session, or on the host, the director runs exactly as stock.',
    anchors: [
      '!this.sanctuary&&!a&&!o&&this.director.update(e)',
      '!this.sanctuary&&!s&&!l&&this.director.update(e)',
    ],
    marker: guard('__pbCoop.skipSpawns&&__pbCoop.skipSpawns()'),
    build: (anchor) =>
      anchor.replace(
        'this.director.update(e)',
        '!(globalThis.__pbCoop&&__pbCoop.skipSpawns&&__pbCoop.skipSpawns())&&this.director.update(e)',
      ),
  },
  {
    id: 'L4-pickup-tick',
    why:
      'Shared pickups need a per-frame hook to drive the host snapshot cadence (5 Hz). '
      + 'Inserted right before the enemy update, which runs in every play state.',
    anchors: [',this.enemies.update(e),this.coop?.afterEnemies()'],
    marker: guard('__pbCoop.tick&&__pbCoop.tick(this,e)'),
    build: (anchor) =>
      `,globalThis.__pbCoop&&__pbCoop.tick&&__pbCoop.tick(this,e)${anchor}`,
  },
  {
    id: 'L5-pickup-collect',
    why:
      'Every pickup type funnels through collect(slot). A guest must not credit gold/XP '
      + 'itself for a shared pickup: the bridge asks the host, which credits once and '
      + 'broadcasts the removal. Native guest pickups (not shared) still credit locally.',
    anchors: ['collect(e){let t=this.run,n=t.player;'],
    marker: guard('__pbCoop.pickupCollected'),
    build: (anchor) =>
      `collect(e){if(globalThis.__pbCoop&&__pbCoop.pickupCollected&&__pbCoop.pickupCollected(this.run,this,e)===false)return;`
      + anchor.slice('collect(e){'.length),
  },
  {
    id: 'L6-ctl-receive',
    why:
      'Upstream drops ctl message types it does not recognise. Forward unknown '
      + 'messages to the bridge so party-wide level barrier and pickup sync can travel '
      + 'on the reliable ctl channel.',
    anchors: ['case`mark`:Number.isFinite(+t.x+ +t.z)&&this.addMark(n.slot,+t.x,+t.z,n.name)}}'],
    marker: guard('__pbCoop.receive'),
    build: (anchor) =>
      anchor.replace(
        'this.addMark(n.slot,+t.x,+t.z,n.name)}}',
        `this.addMark(n.slot,+t.x,+t.z,n.name);break;default:${guard('__pbCoop.receive&&__pbCoop.receive(t,e)')}}}`,
      ),
  },
  {
    id: 'L7-shot-tick',
    why:
      'Enemy projectiles must be replicated from host to guests. Samples enemy '
      + 'projectiles on the host cadence at the same per-frame site as pickup tick.',
    anchor: ',this.enemies.update(e),this.coop?.afterEnemies()',
    marker: guard('__pbCoop.tickShots&&__pbCoop.tickShots(this,e)'),
    build: (anchor) =>
      `,globalThis.__pbCoop&&__pbCoop.tickShots&&__pbCoop.tickShots(this,e)${anchor}`,
  },
  {
    id: 'L8-hurt-number',
    why:
      'Teammate damage numbers: host broadcasts damage taken by enemies so guests '
      + 'can render popups at the exact world coordinates.',
    anchors: [':n.hp[e]-=t}'],
    marker: guard('__pbCoop.damageNumber'),
    build: (anchor) =>
      `:n.hp[e]-=t,globalThis.__pbCoop&&__pbCoop.damageNumber&&__pbCoop.damageNumber(this.run,n.x[e],n.y[e],n.z[e],t)}`,
  },
  {
    id: 'L10-start-gate',
    why:
      '0.8.32+ disables the host Start button until every peer has a live mesh link '
      + '(t.meshReady / unlinkedPair). On networks that block direct connections the '
      + 'session falls back to our room-signal relay, but the gate never notices, so a '
      + 'ready party can never start. Optional: builds without the gate are skipped.',
    optional: true,
    anchors: ['disabled:!!te||a,onclick:async()=>{'],
    marker: guard('__pbCoop.relayReady'),
    build: (anchor) =>
      'disabled:(!!te&&!(globalThis.__pbCoop&&__pbCoop.relayReady&&__pbCoop.relayReady()))||a,onclick:async()=>{',
  },
  {
    id: 'L9-expose-run',
    why:
      'The co-op bootstrap (public/net/coop-page-0.8.29.mjs) needs the live run and session. '
      + 'Upstream keeps them private, so the page cannot find run.coop / run.pickups and never '
      + 'boots. Exposing the run is read-only; co-op stays inert until a session attaches.',
    anchors: [
      'this.run=new nE(this.r,this.input,M,this.hud,this.meta,e)',
      'this.run=new wE(this.r,this.input,N,this.hud,this.meta,e)',
    ],
    marker: 'globalThis.__pb=globalThis.__pb||{}',
    build: (anchor) =>
      `${anchor},globalThis.__pb=globalThis.__pb||{},globalThis.__pb.run=this.run`,
  },
];

/**
 * Applies the patch set to bundle source.
 *
 * Per patch: already-applied (marker present) is skipped, a missing anchor throws,
 * a non-unique anchor throws. Returns `{ source, applied, skipped }`.
 */
export function applyCoopPatches(source, patches = COOP_PATCHES) {
  let out = source;
  const applied = [];
  const skipped = [];

  for (const patch of patches) {
    if (out.includes(patch.marker)) {
      skipped.push(patch.id);
      continue;
    }
    const candidates = patch.anchors ?? [patch.anchor];
    let anchor = null;
    for (const cand of candidates) {
      const hits = out.split(cand).length - 1;
      if (hits === 1) { anchor = cand; break; }
      if (hits > 1) {
        throw new Error(`[${patch.id}] anchor not unique (${hits} matches): ${JSON.stringify(cand)}`);
      }
    }
    if (!anchor) {
      if (patch.optional) { skipped.push(patch.id); continue; }
      throw new Error(
        `[${patch.id}] anchor not found in this build; tried ${JSON.stringify(candidates)}`,
      );
    }
    out = out.replace(anchor, patch.build(anchor));
    applied.push(patch.id);
  }

  return { source: out, applied, skipped };
}
