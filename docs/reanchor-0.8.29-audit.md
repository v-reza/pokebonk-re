# Re-Anchor Audit: Upstream 0.8.13 to 0.8.29 Bundle Migration

## Overview

- **Target Chunk:** `public/assets/main-DEBvJLhQ-mvl14oup.js` (2,059,921 bytes, build 0.8.29)
- **Baseline:** Upstream build 0.8.13 (`public/assets/main-D5OUVqGK-mvilprw2.js`) patched via `tools/bundle-patches.mjs` and `net/INTEGRATION.md`
- **Scope:** Item-by-item audit of the 8 original table patches (**A1–A8**) and the 14 mirror hook assertions (**E1–E14** from `assertMirrorHooks`)

### Upstream 0.8.29 Architecture Shift

Upstream PokéBonk 0.8.29 introduced an internal, native peer-to-peer multiplayer co-op architecture:
- `nE`: Main run class (contains `enemies, projectiles, pickups, combat, zones, boss, player, coop, director`)
- `GT`: Native co-op session manager (`this.coop = new GT(this, a.coop)`)
- `Dk`: WebRTC peer link abstraction
- `kT` / `AT`: Binary delta snapshot writer and reader
- `kf`: Enemy manager, using distributed peer proxies via `placeProxy(e)` and `R.Remote` flags
- `Gg`: Combat manager, featuring native `remoteHit(...)`, proxy hit queueing (`hitProxy`), and death broadcasts (`onDeath`)
- `gv`: Local player class (remote teammates are plain descriptor records in `GT.peers`, not `gv` puppet instances)
- `wy`: Boss manager with peer authority negotiation (`bossAuthority`, `isBossMirror`)
- `HF`: Native party HP and co-op status HUD
- `oI`: UI system including minimap peer dots (`drawMinimap` / `minimap`)

Because upstream 0.8.29 natively implements multi-client replication, combat hit forwarding, death broadcasts, 8 status effects, XP sharing, downed/revive states, minimap markers, and co-op UI, the vast majority of 0.8.13 mirror patches and hook assertions are **SUPERSEDED** or **OBSOLETE**.

---

## Classification Summary

| Classification | Count | Description |
|---|:---:|---|
| **SUPERSEDED** | **16** | Upstream 0.8.29 natively implements this behavior; verified by concrete symbol/literal evidence. |
| **STILL_NEEDED** | **1** | Behavior is absent in upstream 0.8.29; verified with a unique candidate anchor (count = 1). |
| **OBSOLETE** | **5** | Target code/architecture no longer exists (e.g. `Yg` puppet factory, external window bridge). |
| **NO_ANCHOR_FOUND** | **0** | No items lacked viable candidate anchors. |
| **Total** | **22** | All 8 patch table items and 14 hook assertions evaluated. |

*(Note: The 2 redirect patches in `REDIRECT_PATCHES`—API proxy and Turnstile stub—are also **STILL_NEEDED**; see §Consequences).*

---

## Detailed Audit Table

### 1. Patch Table Items (A1–A8)

| Item | What it did (one line) | Classification | Evidence (symbol / literal) | Candidate Anchor (count = 1) or Reason |
|---|---|:---:|---|---|
| **A1** | Guarded `__pbMakePuppets` against `dex === 0` starter placeholder throwing in `O.get(0)` | **OBSOLETE** | `species:e.species,member:e.species,skin:e.skin??null` in `GT.constructor` | The old puppet factory `__pbMakePuppets` and `new Yg(run, m.dex...)` pattern no longer exist. `GT.constructor` initializes peer records directly from room member objects. |
| **A2** | Injected `__pbBuildPuppets(this)` into `buildStage` after local player creation to rebuild teammates on stage reseed | **OBSOLETE** | `this.buildStage(!1),this.coop?.onStage(),await this.openStage()` | Remote players are no longer instantiated as `Yg` puppet instances during `buildStage`. Peer session state persists across stages in `this.coop` (`GT`), which hooks stage transitions via `this.coop?.onStage()`. |
| **A3** | Deduplicated puppet list by `p.uid` with a `Set` in `renderCoopPlayers` to avoid drawing duplicate or stale stubs | **SUPERSEDED** | `*active(){for(let e of this.peers.values())!e.gone&&e.last&&e.stage===this.run.stage&&this.run.realTime-e.lastAt<12` in `GT` | `renderCoopPlayers` is deleted. Upstream `GT.render()` iterates `this.active()`, which yields from `this.peers` (`Map` keyed by peer ID), guaranteeing strict uniqueness and filtering out gone/stale peers. |
| **A4** | Injected `__pbSyncPuppets(this)` before `renderWorld` to copy puppet positions every frame deterministically | **SUPERSEDED** | `if(this.interpPeers(),this.inputBlocked?` in `GT.tick(e)` | `GT.tick(e)` runs every frame from `nE.update` (`this.coop?.tick(e)`), executing `this.interpPeers()` to interpolate snapshot buffer coordinates into `e.x, e.y, e.z` before `renderWorld`. |
| **A5** | Removed `(now - s.t) / 66` interpolation in `renderCoopPlayers` to prevent fighting `__pbSyncPuppets` | **SUPERSEDED** | `i.push(t.x,t.y,t.z,s,a?1:s===\`attack\`?.5:t.animT,c,1,l?.5:0,0,u,0,d?.82:1,d?.66:1,d?1.35:1,d?.68:0,a\|\|s===\`attack\`,r?Kl(t.member,r):0)` | `renderCoopPlayers` is gone. Upstream `GT.render()` natively pushes precomputed coordinates `t.x, t.y, t.z` from `interpPeers` without render-time interpolation. |
| **A6** | Notified session on level-up card selection (`coop.localPicked()` / `__pbLevelPicked`) to unblock host wait-set | **SUPERSEDED** | `this.inputBlocked&&this.modalT<8&&(n\|=xT.bubble)` and `modalT<8&&!t.player.dead&&(t.player.iframes=Math.max(t.player.iframes,.12))` | Upstream 0.8.29 does not pause peers on level-up; level-ups run asynchronously in real-time, granting the choosing player an 8-second iframe bubble (`xT.bubble`). No lockstep wait-set exists. |
| **A7** | Early returned in `credit` for remote enemies on guests to avoid crediting kills, stats, or research | **SUPERSEDED** | `credit(e,t,n){let r=this.run,i=r.enemies,a=i.flags[e],o=t.remote==null;o&&this.tally(i.species[e],a,t.slot??-1)` in `Gg.credit` | Upstream combat natively guards stats/research credit with `o = t.remote == null; o && this.tally(...)`, preventing remote proxy kills from being credited locally. |
| **A8** | Shifted overlapping player sprites and shadows at draw time via `_dx, _dz` from `__pbDrawOffset` | **STILL_NEEDED** | `GT.render()` and `gv.render()` both render at exact world positions without visual separation | **Anchor 1 (start of peer render loop, count = 1):** `render(){let e=this.run;for(let t of this.active()){let n=t.last;if(n.flags&xT.out)continue;`<br>**Anchor 2 (shadow push, count = 1):** `e.sprites.shadows.push(t.x,f,t.z,1.4)` |

---

### 2. Mirror Hook Assertions (E1–E14)

| Item | Needle in `assertMirrorHooks` | Classification | Evidence (symbol / literal) | Candidate Anchor (count = 1) or Reason |
|---|---|:---:|---|---|
| **E1** | `this.coop && this.coop.tick(this.realDt)` | **SUPERSEDED** | `this.coop?.tick(e)` in `nE.update` (offset 1428806) | Upstream natively invokes `this.coop?.tick(e)` in `nE.update` on every frame, including during modal/pause states. |
| **E2** | `this.run.coop && this.run.coop.enemyAdded(` | **SUPERSEDED** | `a.coop?.placeProxy(e)` in `kf.update` / `GT.sendSnapshots` | Upstream replaced JSON `enemyAdded` events with binary snapshot streams (`kT.sendSnapshots` / `AT`) that instantiate proxies via `placeProxy(e)`. |
| **E3** | `this.run.coop && this.run.coop.enemyGone({ slot: e }, !1)` | **SUPERSEDED** | `e.kill(n),this.unmap(n)` / `GT.dropStale` | Despawn notifications are superseded by `GT.dropStale()` and proxy unmapping when snapshots stop reporting an enemy slot. |
| **E4** | `n.coop && n.coop.enemyGone({ slot: e }, !0)` | **SUPERSEDED** | `r.dying[e]=.35,r.hp[e]=0,i&&i.onDeath(e,t.remote??i.mySlot)` in `Gg.killEnemy` | Enemy deaths in combat natively call `coop.onDeath(...)`, which pushes to `this.deaths` and broadcasts to all peers via `this.broadcast({t:"dead",l:this.deaths})`. |
| **E5** | `coopRemoteUpdate(l, e) {` | **SUPERSEDED** | `placeProxy(e){let t=this.run.enemies,n=this.bySlot.get(this.pSlot[e]);if(!n)return;let r=this.pT0[e],i=this.pT1[e],a=1;` in `GT` | Remote enemy interpolation is natively handled by `GT.placeProxy(e)` using timestamps `pT0` and `pT1`. |
| **E6** | `if (this.remote[l]) {` | **SUPERSEDED** | `a.coop?.placeProxy(e),this.burn[e]-=t` in `kf.update` | The enemy update loop calls `a.coop?.placeProxy(e)` for proxy enemies flagged with `R.Remote`. |
| **E7** | `r.coop && !r.coop.isHost && r.coop.hit(e, t, 16777215, 0, 0, 0);` | **SUPERSEDED** | `r&&n.flags[e]&R.Remote?(r.hitProxy(e,t),n.hp[e]=Math.max(1,n.hp[e]-t))` in `Gg.takeHp` and `Gg.remoteHit(...)` | Hits on remote enemies are recorded via `r.hitProxy(e, t)`, flushed in batches (`flushHits`), and applied authoritatively via `Gg.remoteHit(...)`. |
| **E8** | `this.coop && !this.coop.isHost;` | **SUPERSEDED** | `get isHost(){for(let e of this.peers.values())if(!e.gone&&e.link===\`open\`&&e.slot<this.mySlot)return!1;return!0}` in `GT` | Upstream abandoned the asymmetric "guest simulates nothing" model; all peers run the director and simulation cooperatively, arbitrating authority via `GT.isHost` and `GT.bossAuthority`. |
| **E9** | `this.renderCoopPlayers(e)` | **SUPERSEDED** | `this.player.render(),this.coop?.render(),this.mewtwo.active\|\|this.allies.render()` in `nE.renderWorld` | Native peer rendering is invoked via `this.coop?.render()` in `nE.renderWorld`. |
| **E10** | `if (this.remote) {\r\n    if (this.net) {` | **OBSOLETE** | `interpPeers(){for(let e of this.peers.values()){if(!e.buf.length)continue;let t=this.renderTs(e)` in `GT` | Remote players are no longer instances of `gv` (Player) with `.remote` or `.net` fields. Peer interpolation is handled strictly within `GT.interpPeers()`. |
| **E11** | `if (this.remote \|\| (this.run.coop && !this.run.coop.isHost)) return;` | **SUPERSEDED** | `s.pickups.spawnXp(r,i,a,u),s.coop?.shareXp(u)` in `Gg.onAllyKill` and `GT.onShare` | Puppets do not exist, and XP sharing is handled natively via `r.coop?.shareXp(t)` and `GT.onShare()`. |
| **E12** | `globalThis.__pb && (globalThis.__pb.run = this.run)` | **OBSOLETE** | `this.run=new nE(this.r,this.input,M,this.hud,this.meta,e)` (count = 1) | Upstream co-op is completely self-contained; `GT` receives `run` in its constructor. The global window bridge is no longer required for gameplay. *(Note: If test harnesses require `__pb.run`, anchor is available in `App.openRun`).* |
| **E13** | `this.coop && this.coop.levelStart(this.player.level)` | **SUPERSEDED** | `get inputBlocked(){let e=this.run.state;return e===\`modal\`\|\|e===\`paused\`}` in `GT` | Collective pause on level-up is eliminated in favor of real-time async modal protection (`xT.bubble`). |
| **E14** | `globalThis.__pbMakePuppets = (run, members, meUid) =>` | **OBSOLETE** | `this.peers.set(e.id,t),this.bySlot.set(e.slot,t),this.known.set(e.id,new Map)` in `GT.constructor` | The puppet factory concept is obsolete; peers are tracked as plain state records inside `GT.peers`. |

---

## Consequences for Rebase Migration

### 1. Files / Routines That Must Stop Being Applied

- **`assertMirrorHooks(src)` in `tools/bundle-patches.mjs`:**
  Must be retired immediately when serving `main-DEBvJLhQ-mvl14oup.js`. All 14 needles in `assertMirrorHooks` evaluate to `0` occurrences because minified identifiers changed and upstream implemented native co-op.
- **Obsolete String Patches in `BUNDLE_PATCHES`:**
  - **A1, A2, A3, A4, A5, A6, A7:** These patches target dead code or symbols that no longer exist (`renderCoopPlayers`, `__pbMakePuppets`, `this.enemies.remote`, etc.). Applying them against 0.8.29 will throw anchor-not-found errors.
  - **A9–A18, B1–B5, C1–C7 (Later 0.8.13 Patches):**
    All later patches added for 0.8.13 co-op (host-chase B1, shared projectiles B3, nearest pickup B4, downed/revive B5, minimap A9, big map C5, altars C6, boss altars A18) are superseded by native 0.8.29 equivalents (`GT.downedTick`, `GT.revive`, `GT.wakeAltars`, `GT.shareXp`, `kf.placeProxy`, `oI.minimap`). They must not be applied.
- **`net/coop.mjs` and `public/net/coop-ui.mjs` (Custom Firebase Signaling):**
  Upstream 0.8.29 provides native lobby, party codes, chat, and WebRTC signaling (`Dk`). The custom Firebase signaling layer and DOM overlays from 0.8.13 should not be injected into 0.8.29 runs.

### 2. Patches That Still Need a Port

1. **`REDIRECT_PATCHES` (Mandatory):**
   Both existing redirects remain 100% active and unique in `main-DEBvJLhQ-mvl14oup.js`:
   - `['https://api.pokebonk.com', '/api']` (occurrence count: 1)
   - `['https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', '/turnstile-stub.js']` (occurrence count: 1)
2. **Patch A8 (Sprite Separation at Draw Time — Optional UX Enhancement):**
   If the visual separation of overlapping sprites is still desired (to prevent players standing on the exact same tile from completely obscuring each other in screenshots), port A8 into `GT.render()`:
   - **Anchor:** `render(){let e=this.run;for(let t of this.active()){let n=t.last;if(n.flags&xT.out)continue;` (occurrence count: 1)
   - **Target Push:** `e.sprites.shadows.push(t.x,f,t.z,1.4)` (occurrence count: 1)
3. **Hook E12 (`globalThis.__pb.run` — Diagnostic / E2E Harness Only):**
   If automated test scripts (like `tools/test-coop-e2e.mjs`) still need external access to the active `run` object:
   - **Anchor:** `this.run=new nE(this.r,this.input,M,this.hud,this.meta,e)` (occurrence count: 1)

---

## Probe Log

All candidates and evidence strings tested against `public/assets/main-DEBvJLhQ-mvl14oup.js` (2,059,921 B):

| Probe Identifier | Tested String Literal | Count | Status |
|---|---|:---:|---|
| `REDIRECT-1 (api)` | `https://api.pokebonk.com` | **1** | Valid candidate anchor |
| `REDIRECT-2 (turnstile)` | `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` | **1** | Valid candidate anchor |
| `A1-old` | `const p = new Yg(run, m.dex ?? run.startSpecies ?? 1, run.meta.labStats());` | **0** | Obsolete |
| `A1-evidence` | `species:e.species,member:e.species,skin:e.skin??null` | **1** | Verified in `GT.constructor` |
| `A2-old` | `this.player = new Yg(this, this.startSpecies, this.meta.labStats()), this.allies = new mp(this)` | **0** | Obsolete |
| `A2-evidence` | `this.buildStage(!1),this.coop?.onStage(),await this.openStage()` | **1** | Verified in `nE.openStage` |
| `A3-old` | `renderCoopPlayers(e)` | **0** | Obsolete |
| `A3-evidence` | `*active(){for(let e of this.peers.values())!e.gone&&e.last&&e.stage===this.run.stage&&this.run.realTime-e.lastAt<12` | **1** | Verified in `GT.*active` |
| `A4-old` | `this.renderWorld(i ? r : 0), this.vfx.update(` | **0** | Obsolete |
| `A4-evidence` | `if(this.interpPeers(),this.inputBlocked?` | **1** | Verified in `GT.tick` |
| `A5-old` | `let a = Math.min(1, (now - s.t) / 66)` | **0** | Obsolete |
| `A5-evidence` | `i.push(t.x,t.y,t.z,s,a?1:s===\`attack\`?.5:t.animT,c,1,l?.5:0,0,u,0,d?.82:1,d?.66:1,d?1.35:1,d?.68:0,a\|\|s===\`attack\`,r?Kl(t.member,r):0)` | **1** | Verified in `GT.render` |
| `A6-old` | `n=(e=!0)=>{this.pendingLevels=Math.max(0,this.pendingLevels-1),this.noResumeGrace=!e,this.ui.hideModal(),this.pendingLevels>0?this.state=\`play\`:this.resume()}` | **1** | Old closure remains, but lockstep pause is superseded |
| `A6-evidence` | `this.inputBlocked&&this.modalT<8&&(n\|=xT.bubble)` | **1** | Verified in `GT.myFlags` |
| `A7-old` | `credit(e, t, n) {\r\n   let r = this.run,\r\n    i = r.enemies,` | **0** | Obsolete |
| `A7-evidence` | `credit(e,t,n){let r=this.run,i=r.enemies,a=i.flags[e],o=t.remote==null;o&&this.tally(` | **1** | Verified in `Gg.credit` |
| `A8-cand-1` | `render(){let e=this.run;for(let t of this.active()){let n=t.last;if(n.flags&xT.out)continue;` | **1** | Valid candidate anchor |
| `A8-cand-2` | `e.sprites.shadows.push(t.x,f,t.z,1.4)` | **1** | Valid candidate anchor |
| `E1-old` | `this.coop && this.coop.tick(this.realDt)` | **0** | Obsolete |
| `E1-evidence` | `this.coop?.tick(e)` | **1** | Verified in `nE.update` |
| `E2-old` | `this.run.coop && this.run.coop.enemyAdded(` | **0** | Obsolete |
| `E2-evidence` | `a.coop?.placeProxy(e)` | **1** | Verified in `kf.update` |
| `E3-old` | `this.run.coop && this.run.coop.enemyGone({ slot: e }, !1)` | **0** | Obsolete |
| `E3-evidence` | `e.kill(n),this.unmap(n)` | **1** | Verified in `GT.dropStale` |
| `E4-old` | `n.coop && n.coop.enemyGone({ slot: e }, !0)` | **0** | Obsolete |
| `E4-evidence` | `r.dying[e]=.35,r.hp[e]=0,i&&i.onDeath(e,t.remote??i.mySlot)` | **1** | Verified in `Gg.killEnemy` |
| `E5-old` | `coopRemoteUpdate(l, e) {` | **0** | Obsolete |
| `E5-evidence` | `placeProxy(e){let t=this.run.enemies,n=this.bySlot.get(this.pSlot[e]);if(!n)return;let r=this.pT0[e],i=this.pT1[e],a=1;` | **1** | Verified in `GT.placeProxy` |
| `E6-old` | `if (this.remote[l]) {` | **0** | Obsolete |
| `E6-evidence` | `a.coop?.placeProxy(e),this.burn[e]-=t` | **1** | Verified in `kf.update` |
| `E7-old` | `r.coop && !r.coop.isHost && r.coop.hit(e, t, 16777215, 0, 0, 0);` | **0** | Obsolete |
| `E7-evidence-1` | `r&&n.flags[e]&R.Remote?(r.hitProxy(e,t),n.hp[e]=Math.max(1,n.hp[e]-t))` | **1** | Verified in `Gg.takeHp` |
| `E7-evidence-2` | `remoteHit(e,t,n,r,i,a,o){let s=this.run,c=s.enemies;if(!c.isAlive(e)\|\|c.parked(e)\|\|c.flags[e]&R.Boss&&s.boss.immune)return;` | **1** | Verified in `Gg.remoteHit` |
| `E8-old` | `this.coop && !this.coop.isHost;` | **0** | Obsolete |
| `E8-evidence` | `get isHost(){for(let e of this.peers.values())if(!e.gone&&e.link===\`open\`&&e.slot<this.mySlot)return!1;return!0}` | **1** | Verified in `GT.isHost` |
| `E9-old` | `this.renderCoopPlayers(e)` | **0** | Obsolete |
| `E9-evidence` | `this.player.render(),this.coop?.render(),this.mewtwo.active\|\|this.allies.render()` | **1** | Verified in `nE.renderWorld` |
| `E10-old` | `if (this.remote) {\r\n    if (this.net) {` | **0** | Obsolete |
| `E10-evidence` | `interpPeers(){for(let e of this.peers.values()){if(!e.buf.length)continue;let t=this.renderTs(e)` | **1** | Verified in `GT.interpPeers` |
| `E11-old` | `if (this.remote \|\| (this.run.coop && !this.run.coop.isHost)) return;` | **0** | Obsolete |
| `E11-evidence` | `s.pickups.spawnXp(r,i,a,u),s.coop?.shareXp(u)` | **1** | Verified in `Gg.onAllyKill` |
| `E12-old` | `globalThis.__pb && (globalThis.__pb.run = this.run)` | **0** | Obsolete |
| `E12-cand` | `this.run=new nE(this.r,this.input,M,this.hud,this.meta,e)` | **1** | Valid candidate anchor in `App.openRun` |
| `E13-old` | `this.coop && this.coop.levelStart(this.player.level)` | **0** | Obsolete |
| `E13-evidence` | `get inputBlocked(){let e=this.run.state;return e===\`modal\`\|\|e===\`paused\`}` | **1** | Verified in `GT.inputBlocked` |
| `E14-old` | `globalThis.__pbMakePuppets = (run, members, meUid) =>` | **0** | Obsolete |
| `E14-evidence` | `this.peers.set(e.id,t),this.bySlot.set(e.slot,t),this.known.set(e.id,new Map)` | **1** | Verified in `GT.constructor` |
