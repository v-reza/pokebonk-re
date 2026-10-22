// tools/bundle-patches.mjs — shared bundle patches and hook assertions.
// Used by both server.mjs (at serve time) and tools/prepatch.mjs (at build time)
// so the co-op patches and redirects can never drift.

/** Bridge entry point used by the injected `DC.buildStage` hook. */
export const BUILD_PUPPETS_HOOK = '__pbBuildPuppets';

export const BUNDLE_PATCHES = [
  // -- redirect the backend + Turnstile (existing behaviour) ---------------
  ['https://api.pokebonk.com', '/api'],
  ['https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', '/turnstile-stub.js'],

  // -- A1: puppet factory must tolerate a member with no species ------------
  // `__pbMakePuppets` (bundle tail) does `new Yg(run, m.dex ?? run.startSpecies
  // ?? 1, ...)`. A member whose `dex` is 0 — the room placeholder written before
  // that player picked a starter, and the value coop-ui's myDex() sends when
  // `pb.save` is absent — is NOT nullish, so `??` keeps the 0 and Yg's
  // constructor dies in `O.get(0)` (`Cannot read properties of undefined
  // (reading 'types')`). The throw escapes beginCoop()'s factory loop, leaving
  // `coop.mates[*].pl` as the placeholder stubs from Coop.begin() — objects with
  // no `pos`/`render`/`net`, which renderCoopPlayers skips. That is why
  // teammates are invisible. Fall back on any falsy/non-species value.
  [
    'const p = new Yg(run, m.dex ?? run.startSpecies ?? 1, run.meta.labStats());',
    'const p = new Yg(run, (m.dex | 0) || run.startSpecies || 1, run.meta.labStats());',
  ],

  // -- A2: build the puppets as part of buildStage --------------------------
  // INTEGRATION.md §7. `DC.buildStage` creates the local player; right after it
  // the run asks the bridge for one puppet per remote teammate. Doing it here
  // (not only in beginCoop) covers every path that creates a run, and a guest
  // that reseeds via buildStage(true) gets its puppets rebuilt instead of lost.
  // `__pbBuildPuppets` is idempotent and a no-op until a co-op session exists.
  [
    'this.player = new Yg(this, this.startSpecies, this.meta.labStats()), this.allies = new mp(this)',
    'this.player = new Yg(this, this.startSpecies, this.meta.labStats()), '
    + `${BUILD_PUPPETS_HOOK}(this), this.allies = new mp(this)`,
  ],

  // -- A3: the renderer must not draw a puppet twice / from a stale stub ----
  // `renderCoopPlayers` iterates `coop.puppets()` (mate.pl). If a mate's entry
  // was replaced by a real `Yg` while another entry still points at the old
  // placeholder, the same uid would be drawn twice. Keep one entry per uid and
  // skip anything that is not a renderable puppet.
  [
    'renderCoopPlayers(e) {\r\n   let c = this.coop;\r\n   if (!c) return;\r\n   let list = c.puppets();',
    'renderCoopPlayers(e) {\r\n   let c = this.coop;\r\n   if (!c) return;\r\n   let list = c.puppets();\r\n   if (list && list.length) { const seen = new Set; list = list.filter(p => p && p.uid && !seen.has(p.uid) && (seen.add(p.uid), typeof p.render === `function`)) }',
  ],

  // -- A4: copy puppet positions every frame, deterministically -------------
  // `renderCoopPlayers` interpolated with a per-puppet clock seeded from
  // `performance.now()` on first sight, so the first sample after a wire change
  // had `a = (now - s.t)/66 = 0` and the puppet stayed exactly on its old point.
  // Because the guest only renders once per host frame (3-15 Hz) and a fresh
  // puppet is created right after the run starts, that stale point could be the
  // spawn point forever — observed: guest's puppet `pos` (0,0) while `net` was
  // (14,6). Copying `net -> pos` here (before renderWorld, every frame, all
  // states) makes the position a pure function of the latest frame.
  [
    'this.renderWorld(i ? r : 0), this.vfx.update(',
    '__pbSyncPuppets(this), this.renderWorld(i ? r : 0), this.vfx.update(',
  ],

  // -- A5: drop the render-time interpolation (it now fights A4) ------------
  [
    'let a = Math.min(1, (now - s.t) / 66),\r\n     x = s.px + (s.x - s.px) * a,\r\n     z = s.pz + (s.z - s.pz) * a,',
    'let x = s.x,\r\n     z = s.z,',
  ],

  // -- A6: level-up card tells the session the local player chose ----------
  // Every way out of the card (pick, skip, banish, reroll-exhausted) funnels
  // through this `n(...)` helper in DC.doLevelUp, so one hook covers them all.
  // Host: coop.picked(me); guest: sends ['lp'] and closes the host's wait set.
  // Without it the host's `waiting` set never empties and the run deadlocks.
  [
    'n = (e = !0) => {\r\n     this.pendingLevels = Math.max(0, this.pendingLevels - 1), this.noResumeGrace = !e, this.ui.hideModal(), this.pendingLevels > 0 ? this.state = `play` : this.resume()\r\n    },',
    'n = (e = !0) => {\r\n     this.pendingLevels = Math.max(0, this.pendingLevels - 1), this.noResumeGrace = !e, this.ui.hideModal(), '
    + 'this.coop && this.coop.localPicked(), '
    + 'this.pendingLevels > 0 ? this.state = `play` : this.resume()\r\n    },',
  ],

  // -- A7: guest-side kill guard -------------------------------------------
  // A guest's enemies are remote copies; `credit` must never run for them (it
  // bumps stats.kills, research, egg progress and drop tables). kh.strike already
  // returns before damage for remote rows, so this is defence in depth for any
  // other caller (status ticks, ally hits, ult).
  // NOTE: the guard goes BEFORE `let r = …` so the original declaration list
  // (`let r = …, i = …, a = …;`) stays intact. Splicing a `;` into that list
  // turns `a = i.flags[e]` into a bare assignment and throws.
  [
    'credit(e, t, n) {\r\n   let r = this.run,\r\n    i = r.enemies,',
    'credit(e, t, n) {\r\n   if (this.run.enemies.remote[e] && this.run.coop && !this.run.coop.isHost) return;\r\n   let r = this.run,\r\n    i = r.enemies,',
  ],

  // -- A8: separate overlapping sprites AT DRAW TIME ONLY -------------------
  // `pl.pos` must stay the true wire position (interpolation, hit tests and the
  // `net` round-trip all read it). When both players stand on the same spot —
  // same starter, same spawn point — the sprites stack and look like one
  // Pokémon, so a screenshot cannot show two players. Shift the sprite (and its
  // shadow) by a stable per-uid offset while drawing; nothing else sees it.
  // `__pbDrawOffset(this)` returns 0 for the local player and a fixed lateral
  // offset for a remote puppet.
  [
    '  render() {\r\n   let e = this.run,\r\n    t = e.sprites.get(this.speciesId),',
    '  render() {\r\n   let e = this.run,\r\n    _dx = 0, _dz = 0;\r\n'
    + '   if (this.remote) { const _o = globalThis.__pbDrawOffset ? globalThis.__pbDrawOffset(this) : null; if (_o) { _dx = _o[0]; _dz = _o[1] } }\r\n'
    + '   let t = e.sprites.get(this.speciesId),',
  ],
  [
    't.push(this.pos.x, this.pos.y, this.pos.z, n, r, l, this.renderScale,',
    't.push(this.pos.x + _dx, this.pos.y, this.pos.z + _dz, n, r, l, this.renderScale,',
  ],
  [
    'e.sprites.shadows.push(this.pos.x, p, this.pos.z, 1.4)',
    'e.sprites.shadows.push(this.pos.x + _dx, p, this.pos.z + _dz, 1.4)',
  ],

  // -- A9: minimap party indicators ----------------------------------------
  // `drawMinimap(e)` translates and rotates the 2D context for world rendering.
  // Right before restoring the canvas state to draw the local player's arrow,
  // invoke `__pbDrawMinimap(e, t, a, f, h)` so remote teammates' dots are drawn
  // with member colors, dark rings, hollow/pulsing dead states, and circle rim
  // clamping, while preserving the local player's existing marker.
  [
    '   t.fillStyle = `#7aff9a`, t.strokeStyle = `#1d1236`, t.lineWidth = 2;\r\n   for (let n of e.allies.list) {\r\n    let [e, r] = a(n.x, n.z);\r\n    t.beginPath(), t.arc(e, r, 6 * h, 0, 7), t.fill(), t.stroke()\r\n   }',
    '   t.fillStyle = `#7aff9a`, t.strokeStyle = `#1d1236`, t.lineWidth = 2;\r\n   for (let n of e.allies.list) {\r\n    let [e, r] = a(n.x, n.z);\r\n    t.beginPath(), t.arc(e, r, 6 * h, 0, 7), t.fill(), t.stroke()\r\n   }\r\n   globalThis.__pbDrawMinimap && globalThis.__pbDrawMinimap(e, t, a, f, h);',
  ],

  // -- A10: pass real shiny flag to enemyAdded -----------------------------
  // `Sd.spawn` previously hardcoded `shiny: 0` when notifying co-op sessions of
  // a new enemy. Wire the real `L.Shiny` flag (`2048`) from spawn parameter `a` (held in `x`).
  [
    '   let x = a;\r\n   this.run.coop && this.run.coop.enemyAdded({ slot: o, species: this.species[o], x: this.x[o], z: this.z[o], boss: !!(x & 4), shiny: 0, maxHp: this.maxHp[o], dmg: this.dmg[o], behavior: x });',
    '   let x = a;\r\n   this.run.coop && this.run.coop.enemyAdded({ slot: o, species: this.species[o], x: this.x[o], z: this.z[o], boss: !!(x & 4), shiny: !!(x & 2048), maxHp: this.maxHp[o], dmg: this.dmg[o], behavior: x });',
  ],
];

/**
 * Apply patch table to `src`; returns the new source.
 * Fails loudly (throws Error) if an anchor is missing or not unique.
 * Idempotent: running on already-patched source safely returns unchanged src.
 */
export function applyPatches(src, patches = BUNDLE_PATCHES, label = 'bundle') {
  for (const [anchor, replacement] of patches) {
    // Check if patch was already applied
    if (replacement.includes(anchor)) {
      if (src.includes(replacement)) {
        continue;
      }
    } else if (!src.includes(anchor)) {
      if (src.includes(replacement)) {
        continue;
      }
      throw new Error(`[pb-patch] anchor not found: ${JSON.stringify(anchor.slice(0, 90))} (${label})`);
    }

    const at = src.indexOf(anchor);
    if (at < 0) {
      throw new Error(`[pb-patch] anchor not found: ${JSON.stringify(anchor.slice(0, 90))} (${label})`);
    }
    if (src.indexOf(anchor, at + anchor.length) >= 0) {
      throw new Error(`[pb-patch] anchor not unique: ${JSON.stringify(anchor.slice(0, 90))} (${label})`);
    }

    src = src.slice(0, at) + replacement + src.slice(at + anchor.length);
  }
  return src;
}

/** Assert the hooks that must already exist in the mirrored bundle. */
export function assertMirrorHooks(src) {
  const required = [
    // per-frame coop tick, inside DC.update (runs in every state, incl. modal)
    'this.coop && this.coop.tick(this.realDt)',
    // host enemy lifecycle -> guests
    'this.run.coop && this.run.coop.enemyAdded(',
    'this.run.coop && this.run.coop.enemyGone({ slot: e }, !1)',
    'n.coop && n.coop.enemyGone({ slot: e }, !0)',
    // guest: remote enemy rows are interpolated, never simulated
    'coopRemoteUpdate(l, e) {',
    'if (this.remote[l]) {',
    // guest: hits on a remote row are forwarded to the host
    'r.coop && !r.coop.isHost && r.coop.hit(e, t, 16777215, 0, 0, 0);',
    // guest world split (no director/pickups/clock on the guest)
    'this.coop && !this.coop.isHost;',
    // puppets: rendered by DC.renderWorld, driven by net state, never gain XP
    'this.renderCoopPlayers(e)',
    'if (this.remote) {\r\n    if (this.net) {',
    'if (this.remote || (this.run.coop && !this.run.coop.isHost)) return;',
    // run bridge + level sync
    'globalThis.__pb && (globalThis.__pb.run = this.run)',
    'this.coop && this.coop.levelStart(this.player.level)',
    // puppet factory
    'globalThis.__pbMakePuppets = (run, members, meUid) =>',
  ];
  for (const needle of required) {
    if (!src.includes(needle)) {
      throw new Error(`[pb-patch] mirror hook missing: ${JSON.stringify(needle.slice(0, 90))}`);
    }
  }
}
