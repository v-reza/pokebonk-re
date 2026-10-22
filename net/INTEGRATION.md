# PokéBonk co-op integration plan

This is the concrete patch plan for wiring `net/net.mjs` + `net/coop.mjs` into the
minified client bundle (`pokebonk-re/main.pretty.js`, the beautified copy of the
served Vite bundle). All line numbers below were read from `main.pretty.js` and
verified by grepping/reading the file — they are current as of this write.

Architecture (host-authoritative state replication, per the assignment):

- The **HOST** browser simulates enemies (`Sd`), pickups (`Xf`), team XP/level and
  the clock, and streams state at 15 Hz (direct) / 3 Hz (relay) over WebRTC
  DataChannels. Each guest simulates only its own Pokémon and forwards its hits.
- Guests render remote copies of the host's enemies and remote copies of their
  teammates; they never simulate enemies, pickups, team XP or the clock.
- Firebase RTDB carries only signaling (SDP/ICE) plus the 3 msg/s relay fallback.
  TURN off, relay on (`TURN_ON=false`, `ALLOW_RELAY=true`).
- **No RNG refactor.** `kc` and the ~717 `Math.random()` sites stay exactly as they
  are. The host's seeded RNG produces the world; guests just consume its state.

## Loading the modules

The bundle is a single self-contained IIFE script. The net modules are ES modules
and must be imported from the page. Minimal non-invasive entry: add an import map +
module script to `public/index.html` (this is a `public/` edit, hence deferred — see
"Integration status" at the bottom):

```html
<script type="importmap">{
  "imports": { "coop": "/net/coop.mjs", "net": "/net/net.mjs", "codec": "/net/codec.mjs" }
}</script>
<script type="module">
  import * as Net from 'net';
  import { Coop, serializePlayerState, serializeEnemyFrame, readEnemyFrame } from 'coop';
  window.__Net = Net; window.__Coop = { Coop, serializePlayerState, serializeEnemyFrame, readEnemyFrame };
</script>
```

`init(db, uid)` needs a Firebase RTDB handle (`db.rtdb`, `db.uid`). PokéBonk has no
Firebase client today; the server (`server.mjs`) must mint an RTDB handle + uid for
the session (or the page loads the Firebase JS SDK). That dependency is outside
`net/` and is the main environmental blocker for live play.

## Slot stability assumption (read this first)

`Sd` (enemy manager, `main.pretty.js:11814`) keeps every enemy as a row across ~66
parallel typed arrays, addressed by **slot index** (0..2199). There are no per-enemy
objects and no ids. `Sd.kill(slot)` (line 11923) frees the slot onto `free` and
`Sd.spawn` (line 11896) pops from `free`, so a slot can be reused.

`coop.mjs` therefore transmits the **slot index**, not an id. This is only valid if
slots are stable for the lifetime of a live enemy. The required changes:

1. **Make slots stable.** In `Sd.spawn`, when reusing a `free` slot, the remote
   copies on guests still reference the old (dead) enemy by that slot. Two options:
   - (a) Never reuse a slot for a *different* logical enemy within the same run
     window (append-only until compact, then a full re-sync); or
   - (b) Emit a `['eg', slot]` (enemy-gone) on every `Sd.kill` and a `['ne', …]`
     (enemy-new) on every `Sd.spawn` (this plan does exactly that — see hooks H3/H4),
     and have guests add/remove their remote rows on those events, so slot reuse is
     harmless.
2. **Remote sidecar (guest only).** The guest's `Sd` is used only for the *remote*
   copies. It needs a small sidecar, added to the `Sd` constructor:
   ```js
   this.remote = new Uint8Array(fd);   // 1 => this slot is a host remote enemy
   this.net = new Float32Array(fd * 5); // net.x, net.y, net.vx, net.vy, net.last (interp)
   ```
   The field mapping and the exact sidecar layout are documented in
   `net/coop.mjs` (the `collectEnemySlots`/`enemyRowOf` header comment).

## Wire field mapping (summary)

Defined and unit-tested in `net/coop.mjs`. Enemy row
`[slot, x, y, hp, anim, dir, status]`:

| wire | PokéBonk `Sd` array | note |
|---|---|---|
| slot | (slot index) | stable per §"slot stability" |
| x    | `Sd.x[slot]` | world X |
| y    | `Sd.z[slot]` | world depth Z; height `Sd.y` is NOT sent (guest re-derives from terrain) |
| hp   | `ceil(Sd.hp[slot])` | |
| anim | 0 walk / 1 attack / 2 idle / 3 hurt | derived: hurt=`dying>0`, attack=`atkAnim>0`, idle=`frozen||sleep`, else walk |
| dir  | `dirOf(Sd.fx[slot], Sd.fz[slot])` | 8-way sprite row |
| status | bitmask 1 burn 2 poison 4 shield 8 slow | `burn>0`, `poison>0`, `shield>0`, `hazSlow<1` |

Player state `[x,y,angle,walking,hp,maxHp,dead,level,aim,xpMul,reviveT,choosing,doneSeq,watching]`
— see `net/coop.mjs` `P` table (x=`pos.x`, y=`pos.z`, angle=`atan2(facing.x,facing.z)`, …).

## Hook-by-hook patch plan

Legend: **H** = host only, **G** = guest only, **both** = both. The string after
`anchor:` is a verbatim, unique substring of the file at that line.

### 1. Run start — host/guest handshake, seed from ticket

**File line 82409** `App.openRun` — after the ticket resolves and before the run is
constructed. Anchor (line 82421):

```
return e = {
    ...e,
    seed: t.seed,
    boosts: t.boosts ?? []
   }, cO(), this.lastCfg = {
```

The ticket `t` (from `meta.beginRun`, line 82413) carries `seed` and `boosts`. On
`openRun` you have the full picture: `t.seed`, the host/guest role, and room members.
Insert, immediately after `this.lastCfg = { ...e, boosts: [] }`:

```js
// co-op: begin/join the room from the ticket + room members
if (e.coop) {                    // { host, room, members:[{uid,name,dex,shiny}] }
  Net.init(db, e.coop.uid);
  Net.open(e.coop.room, e.coop.uid === e.coop.host, e.coop.host);
  this.runCoop = new Coop(Net, gameAdapter(this));
  this.runCoop.onStart = msg => { /* seed = msg.seed, host = msg.host, members */ };
}
```

Anchor for the seed overwrite itself — **line 61414** in the `DC` constructor:

```
this.seed = a.seed ?? Ac(Date.now().toString()) ^ Math.random() * 1e9
```

For co-op the seed must come from the host's `k:'start'` message (it is already
`t.seed` on the host; on a guest it is overwritten once the host's `start` arrives,
before the first `buildStage`). Patch: in `DC` constructor, if `a.seed == null && a.coopHost` is a guest, leave it unseeded until the host `start` arrives, then call
`this.seed = seed; this.buildStage(true)`.

`meta.beginRun` is at **line 65412** (`this.ticket = await this.backend.startRun(...)`),
and the backend `startRun` is at **line 81460** — this is where `seed`, `room`, and
member list must be produced server-side.

### 2. Per-frame state send (15 Hz)

**File line 62674** `DC.update`. This runs every frame regardless of state, so it is
the right place for the co-op tick (the host must keep streaming during the level-up
modal). Anchor (line 62705, the tail of `update`):

```
this.ui.hud(this), this.state === `play` && this.pendingLevels > 0 && this.evoHold <= 0) this.doLevelUp();
```

Insert just before `this.ui.hud(this)`:

```js
this.coop?.tick(this.realDt);      // 15 Hz host stream / guest upload, level/away reconcile
```

(`realDt` is set at the top of `update`, line 62676.)

### 3. Enemy spawn forwarding — **H**

**File line 11896** `Sd.spawn`. Anchor:

```
spawn(e, t, n, r, i, a = 0) {
```

`spawn` returns the slot (or -1). At the end of `spawn`, just before it returns the
slot, emit the enemy-added event so guests create a remote row:

```js
this.run.coop?.enemyAdded({ slot: o, species: e, x: this.x[o], z: this.z[o],
  boss: !!(x & 4), shiny: !!this.run.shinySlot?.[o], maxHp: g, dmg: this.dmg[o], behavior: x });
```

(`x` is the final flags word assigned at line 11921: `this.flags[o] = x`.)

### 4. Enemy despawn forwarding — **H**

**File line 11923** `Sd.kill`. Anchor:

```
kill(e) {
   this.alive[e] && (this.alive[e] = 0, this.count--, this.free.push(e))
```

Insert at the top of `kill` (a non-death removal):

```js
this.run.coop?.enemyGone({ slot: e }, false);   // 'eg'
```

### 5. Enemy damage + death forwarding — **both / H**

**File line 31584** `kh.strike` (the combat system, `kh = class` at line 31564) is
where a Pokémon's attack reduces `Sd.hp[e]`.

- **Guest** must NOT mutate local (remote) enemy HP; instead forward the hit to the
  host. Insert at **line 31682** (anchor `i.hp[e] -= s,`), gated so only the guest
  forwards:
  ```js
  if (this.run.coop && !this.run.coop.isHost && this.run.enemies.remote[e]) {
    this.run.coop.hit(e, x, this.run.ui.typesColor?.(i.typesOf(e)[0]) ?? 16777215,
      (n.dirX ?? 0), (n.dirZ ?? 0), n.knock ?? 0);
    return x; // no local damage on the guest's remote copy
  }
  ```
- **Host** applies damage normally (as today) and, on death, emits the death event.
  **File line 31942** `kh.killEnemy`. Anchor:
  ```
  killEnemy(e, t) {
  ```
  In the branch that actually dies (around `r.dying[e] = .35, r.hp[e] = 0` inside
  `killEnemy`), add:
  ```js
  this.run.coop?.enemyGone({ slot: e }, true);   // 'ed'
  ```
- **Host** forwards damage-number popups for near guests: `Coop.hurtShown` (see
  `net/coop.mjs`) — call after `i.hp[e] -= s` on the host path.

### 6. Remote enemy rendering — **G**

**File line 12078** `Sd.render`. Anchor (unique to `Sd.render`):

```
render() {
   let e = this.run,
    t = e.sprites,
    n = e.focusIdx;
```

After the existing local-enemy loop, add a loop over remote slots
(`this.remote[i] === 1`) drawing the same sprite at the interpolated position from
the sidecar (`this.net`). Position/hp/anim/dir/status arrive every host frame and are
interpolated in `Sd.update`:

**File line 11929** `Sd.update`. Anchor (unique to `Sd.update`):

```
update(e) {
   let t = this.run,
    n = t.player,
    r = t.terrain,
```

In the per-slot loop, before the movement code, branch for remote slots: set
`this.x[l] += net.vx * e` toward the last received `net.x/net.y` (the same
interpolation pokesurvivor uses in `coop.js` `onHostFrame`), then `continue`.

### 7. Remote player (second `Yg` that does not own stats/XP) — **both**

**File line 61489** (`DC.buildStage`). Anchor:

```
this.enemies = new Sd(this), this.projectiles = new Vf(this), this.pickups = new Xf(this), this.combat = new kh(this), this.zones = new fg(this), this.boss = new rv(this), this.player = new Yg(this, this.startSpecies, this.meta.labStats()), this.allies = new mp(this), this.ult = new gC(this)
```

After `this.player = new Yg(...)`, create one extra `Yg` per remote teammate from the
`k:'start'` `members` list (host creates them for guests; guest creates them for the
host and other guests):

```js
this.remotePlayers = (this.coop?.members ?? []).filter(m => m.uid !== Net.getUid())
  .map(m => { const p = new Yg(this, m.dex, this.meta.labStats()); p.remote = true; return p; });
```

`Yg = class` is at **line 35871**. The remote `Yg` must be a **puppet**: its `update`,
`recompute`, `gainLevel`/`addXp`, and every `this.run.stats.*` mutation must be
guarded so it never owns stats/XP/team state (the Coop `puppets()`/`mates` API in
`net/coop.mjs` drives its `pos`/`facing`/`hp`/`dead` from the wire instead). The
simplest robust form is to give the remote player `p.remote = true` and early-return
in `Yg.update` / `gainLevel` / `addXp` when `remote` is set, plus skip it in the HUD.

### 8. Level-up card sync — **both**

**File line 62355** `DC.doLevelUp` (host pauses everyone; guests only open the card
when told). Anchor:

```
doLevelUp() {
   if (this.pendingLevels <= 0 || this.tryEvolve()) return;
```

On the host, replace the local `this.state = 'modal'` with `this.coop.levelStart(level)`
(which emits `['lu', level, seq]` and waits for every member). On a guest, `doLevelUp`
must be inert — the guest opens the card only from the host's `lu`/`lu` frame fields
(handled by `Coop.onHostFrame` in `net/coop.mjs`).

The card choice callback is at **file line 62388** (`this.ui.showLevelUp(this, e, (e, r) => {`) …
the `i(e)` apply at ~62391–62396. Add `this.coop?.localPicked()` at the end of that
callback (host: `picked(me)`; guest: `['lp']` flush). The card UI itself is
`showLevelUp` at **line 79105**.

`Yg.gainLevel` (line 36209) and `Yg.addXp` (line 36212) are where team XP is applied
— on the host they feed `stats.kills/level/xp` that `Coop.hostFrame` reads via the
`team()` adapter; on guests `addXp` must be a no-op (the host's `xp`/`lv` fields in
the `k:'f'` frame drive the HUD).

### 9. HUD showing teammates — **both**

**File line 78385** `eM.hud` (`eM = class` at line 77515). Anchor:

```
hud(e) {
   this.runRef = e;
   let t = e.player,
```

Append a teammates block after the existing HUD updates (end of `hud`, after
`this.trackSeen(e), this.tickMarks(e), this.leftoverHud(e), this.drawMinimap(e), this.worldLabels(e)`, line 78543):

```js
this.drawCoop(e);   // reads e.coop.mates / e.remotePlayers: name tag + hp bar per teammate
```

`Coop.players()` / `Coop.puppets()` (in `net/coop.mjs`) provide the teammate list with
`tagColor`/`name`; the block renders the same HP-bar pattern already used for
`e.player`.

### 10. Run finish / reconnect — **both**

**File line 62319** `DC.finish`. Anchor:

```
finish(e, t = !1) {
   if (this.state === `over`) return Promise.resolve();
```

At the top of `finish`, emit the over/summary event and tear the room down:

```js
if (this.coop?.active) {
  this.coop.over({ /* summary */ why: this.endHow ?? (this.victory ? 'win' : 'lose') });
  Net.close();
}
```

Reconnect/leave: `Coop.onPeer` (in `net/coop.mjs`) already handles `closed`/`failed`
peer transitions — on a guest whose host dropped it calls `lost(msg)`; on a host it
calls `mateGone`. `Coop.leave()` covers voluntary exit; `Coop.broadcast()`/`toHost()`
cover the rest. `DC.checkpoint` (line 62189) and `DC.finish` are the two save points.

## Integration status — APPLIED (patched served bundle)

The bundle hooks are no longer just a plan. `main.pretty.js` (the beautified copy,
semantically identical to the served chunk) was patched and copied over
`public/assets/main-D5OUVqGK-mvilprw2.js` (same filename, so the entry chunk's
dynamic import still resolves; original minified saved as
`main-D5OUVqGK-mvilprw2.js.bak`). Every hook is a guarded no-op (`this.coop` /
`this.run.coop` is undefined in single-player), so the single-player build is
unaffected.

Applied hooks (verified by grep on the served bundle):

| Hook | Where | What |
|---|---|---|
| E1 sidecar | `Sd` fields (~11883) | `remote = new Uint8Array(fd)`, `net = new Float32Array(fd*4)` |
| E2 spawn emit | `Sd.spawn` (~11923) | `coop.enemyAdded({slot,species,x,z,boss,shiny:0,maxHp,dmg,behavior})` before `return` |
| E3 despawn emit | `Sd.kill` (~11927) | `coop.enemyGone({slot}, false)` inside the `alive` guard |
| E4 interp | `Sd.update` (~11932/11949) | `coopRemoteUpdate` helper + `if (this.remote[l]) { …; continue }` branch |
| E5 hit forward | `kh.strike` (~31610) | `if (i.remote[e]) { coop.hit(e, t, …); return 0 }` |
| E6 death emit | `kh.killEnemy` (~31964) | `coop.enemyGone({slot}, true)` in the actually-died branch |
| E7 puppet guard | `Yg.update`/`gainLevel`/`addXp` (~36911/36227/36231) | remote puppet follows `this.net`; remote+guest never gain XP/level |
| E8 15 Hz tick | `DC.update` (~62725) | `this.coop && this.coop.tick(this.realDt)` every frame |
| E9 finish | `DC.finish` (~62341) | `coop.over(...)` + clears `__pb.run`/`__pb.coop` |
| E10 level sync | `DC.doLevelUp` (~62378) | host `coop.levelStart(this.player.level)` |
| E12 run bridge | `App.openRun` (~82455) | `globalThis.__pb.run = this.run` |
| E13 puppets | module tail (~82603) | `globalThis.__pbMakePuppets(run, members, meUid)` creates remote `Yg` puppets |
| E14 world split | `DC.simulate` (~62785) | guest (`coop && !isHost`) skips director/boss/minibosses/events/capture/mewtwo/allies/pickups; keeps `enemies.update` (remote interp) + `terrain.update` |

Bridge: `public/index.html` now has an importmap (`net`, `coop`, `signaling`) and a
module bootstrap that exposes `globalThis.__pbStartCoop(cfg)`, `__pbMakePuppets`,
and the `gameAdapter` mapping (team stats, enemy list/remote lifecycle, hit/status
application, reseed on `start`). Co-op is inert until `__pbStartCoop` is called.

Signaling: `net/signaling-local.mjs` implements the `{ rtdb.ref(path).on/.off/.push }`
shape net.mjs expects, over a new dependency-free in-memory relay in `server.mjs`
(SSE `GET /signaling/stream`, POST `/signaling/send`), which also serves `/net/*.mjs`.
This local relay IS the relay-fallback channel and carries both SDP/ICE signaling and
3 Hz relay frames.

Not yet wired (documented gaps, no UI entry point to start co-op yet):
- Level-up card pick callback → `coop.localPicked()` (anchor `DC.doLevelUp`,
  `showLevelUp` callback ~62388).
- HUD teammates block (`eM.hud` ~78543; `Coop.players()` provides the data).
- Shiny flag in `enemyAdded` is hardcoded 0 (no `Sd` shiny lookup yet).
- Damage-number popups (`hurtShown`) and ghost casts are stubs in the gameAdapter.

## Verification (actually run)

- `node --check public/assets/main-D5OUVqGK-mvilprw2.js` → parses as an ES module (OK).
- `node --check` on `net.mjs` / `coop.mjs` / `codec.mjs` / `signaling-local.mjs` → OK.
- `node --test net/codec.test.mjs` → 14/14 pass.
- `node --test net/signaling.test.mjs` → 4/4 pass (boots `server.mjs`, asserts the
  bridge in `index.html`, the co-op hooks + applied string patches in the served
  bundle, `/net/*.mjs` serving, and a create→join→send→deliver relay round-trip).
- Serve-time string patches still match: both literals are intact single-line in the
  beautified output (`https://api.pokebonk.com` at line 81991,
  `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` at line
  81196), and the served bundle shows `/turnstile-stub.js` + no `api.pokebonk.com`,
  proving `server.mjs`'s `split/join` still matches.
- Live two-browser co-op play was NOT verified (no browser automation available).
