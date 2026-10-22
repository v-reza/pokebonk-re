# PokéBonk co-op integration plan

> Note: Quoted Spanish strings throughout this document (e.g. `Jugar`, `¡Te elijo a ti!`, `¡Empezar!`, `Liga`, `Elige región`) are literal upstream bundle identifiers/selectors, not prose.
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

## Integration status — hooks in the mirror, fixes at serve time

Two different things, and confusing them cost a debugging session:

- **The co-op hooks are already in the mirrored bundle on disk.**
  `public/assets/main-D5OUVqGK-mvilprw2.js` (2.6 MB, CRLF, tracked in git) contains
  every hook the protocol needs. It is NOT rebuilt or rewritten at serve time.
- **`server.mjs` only applies a handful of small string patches** at serve time,
  because those specific behaviours could not be expressed in the mirror.

The entry chunk `main-BcyzVqXo-mvilprw2.js` (9 KB) only does
`import('./main-D5OUVqGK-mvilprw2.js')`, so `main-D5OUVqGK` **is** the game; the
`serveStatic` gate on `rel.includes('main-D5OUVqGK')` matches the file that is
actually loaded.

### Hooks verified present in the mirror

| Hook | Where | What |
|---|---|---|
| E1 sidecar | `Sd` fields (L11877) | `remote = new Uint8Array(fd)`, `net = new Float32Array(fd*4)` |
| E2 spawn emit | `Sd.spawn` (L11923) | `coop.enemyAdded({slot,species,x,z,boss,shiny:0,maxHp,dmg,behavior})` |
| E3 despawn emit | `Sd.kill` (L11927) | `coop.enemyGone({slot}, false)` inside the `alive` guard |
| E4 interp | `Sd.update` (L11950) + `coopRemoteUpdate` (L11932) | remote rows interpolate toward `net`, never simulate |
| E5 hit forward | `kh.strike` (L31610) | `if (i.remote[e]) { coop.hit(e, …); return 0 }` |
| E6 death emit | `kh.killEnemy` (L31964) | `coop.enemyGone({slot}, true)` in the died branch |
| E7 puppet guards | `Yg.update` (L36911), `gainLevel`/`addXp` (L36227/36231) | puppet follows `this.net`; remote + guest never gain XP/level |
| E8 per-frame tick | `DC.update` (L62734) | `this.coop && this.coop.tick(this.realDt)` — runs in every state, incl. the modal |
| E9 finish | `DC.finish` (L62348) | `coop.over(...)` + clears `__pb.run` |
| E10 level start | `DC.doLevelUp` (L62385) | host `coop.levelStart(this.player.level)` |
| E11 puppet render | `DC.renderWorld` → `renderCoopPlayers` (L63050/63058) | draws `coop.puppets()` from `pl.net` |
| E12 run bridge | `App.openRun` (L82492) | `globalThis.__pb.run = this.run` |
| E13 puppet factory | module tail (L82632) | `globalThis.__pbMakePuppets(run, members, meUid)` |
| E14 world split | `DC.simulate` (L62785) | guest skips director/boss/events/capture/pickups/clock |

`assertMirrorHooks()` in `server.mjs` re-checks all of these on the first bundle
request and logs `[pb-patch] mirror hook missing: …` if the mirror ever changes.

### Serve-time patches (`server.mjs` → `serveStatic`)

Applied once, cached in `PATCHED`, anchored on unique substrings. A missing anchor
logs `[pb-patch] anchor not found: …`; a duplicated one logs
`[pb-patch] anchor not unique: …`. The bundle is never written to disk.

| # | Anchor | Replacement | Why |
|---|---|---|---|
| 0 | `https://api.pokebonk.com` | `/api` | offline backend |
| 0 | `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit` | `/turnstile-stub.js` | offline Turnstile |
| A1 | `const p = new Yg(run, m.dex ?? run.startSpecies ?? 1, run.meta.labStats());` | `(m.dex \| 0) \|\| run.startSpecies \|\| 1` | the invisible-teammate bug, below |
| A2 | `this.player = new Yg(this, this.startSpecies, this.meta.labStats()), this.allies = new mp(this)` | inserts `__pbBuildPuppets(this),` | build puppets inside `buildStage`, so a reseed rebuilds them |
| A3 | `renderCoopPlayers(e) {… let list = c.puppets();` | filters to one renderable entry per uid | never draw a stale placeholder twice |
| A4 | `this.renderWorld(i ? r : 0), this.vfx.update(` | inserts `__pbSyncPuppets(this),` | copy wire → world position every frame |
| A5 | `let a = Math.min(1, (now - s.t) / 66), …` | `let x = s.x, z = s.z,` | remove the interpolation clock that froze puppets |
| A6 | `n = (e = !0) => { … this.ui.hideModal(), …` | inserts `this.coop && this.coop.localPicked(),` | level-up card tells the session; without it the host deadlocks |
| A7 | `credit(e, t, n) {\r\n   let r = this.run,\r\n    i = r.enemies,` | guard before `let` | a guest must never credit a remote copy |
| A8 | `  render() {\r\n   let e = this.run,\r\n    t = e.sprites.get(this.speciesId),` + the sprite/shadow push lines | draw-time `_dx/_dz` from `__pbDrawOffset` | separate overlapping sprites **without touching `pl.pos`** |

> **A7 gotcha.** The guard has to go *before* `let r = …, i = …, a = …`. Splicing a
> `;` into that declaration list turns `a = i.flags[e]` into a bare assignment and
> throws `Assignment to constant variable` inside `credit` — which silently skips
> `killEnemy` and makes forwarded guest hits do damage that never kills.

## The two bugs that made teammates invisible

### 1. `dex: 0` made `__pbMakePuppets` throw

`coop-ui.mjs` sends `dex: myDex()`, and `myDex()` reads `localStorage['pb.save']` —
a key the bundle never writes — so the room stored `dex: 0` for every member.
The factory did `new Yg(run, m.dex ?? run.startSpecies ?? 1, …)`; `0 ?? x` keeps
`0`, so `O.get(0)` returned `undefined` and `Yg`'s constructor died on
`this.data.types`.

That throw escaped `beginCoop()`'s factory loop, so `coop.mates[*].pl` stayed as the
placeholders `Coop.begin()` creates — `{uid, name, remote, x, y, dead}`, with no
`pos`, `render` or `net`. `renderCoopPlayers` skips exactly those, so nothing was
drawn.

Observed directly in a live run:

```
__pbMakePuppets(run, [{uid:'other', dex:0}], 'me')
  -> THROW: Cannot read properties of undefined (reading 'types')
__pbMakePuppets(run, [{uid:'other', dex:4}], 'me')
  -> [{ hasRender: 'function', remote: true, speciesId: 4, hp: 104 }]
```

**Lesson:** a numeric field with `0` as a legitimate "unset" must not go through
`??`. Use `| 0` + `||`.

### 2. Stale `coop.local` after the guest reseeds

A guest receives the host's `start` (seed) and calls `buildStage(true)`, which
creates a **new** `Yg` for `run.player`. `Coop.begin()` had captured the old one in
`this.local`, so the guest kept broadcasting the old object's frozen position: the
host's puppet never moved (observed: guest at `z=0.34`, host `net` stayed `{0,0}`).
`__pbBuildPuppets` now re-points `coop.local = run.player` on every call, and
`startCoop` only reseeds when the seed actually differs.

### 3. Guest and host slot indices are different namespaces

`addRemoteEnemy` used `sd.spawn()`, which allocates from the **guest's own** free
list — not the host's slot id from the `ne` event. The wire protocol (and every
`'h'` hit the guest sends back) speaks host slot ids, so without a mapping a guest
hit landed on whatever unrelated row happened to share that index. The bridge now
keeps `sd.hostSlot[local] = host` and translates in both directions
(`coop.localSlotOf` / `coop.hostSlotOf`, with `coop.hit`/`coop.status` wrapped).

### 4. `applyHit` was not `silent`, and slot 0 was dropped as falsy

Two independent bugs in the forwarded-hit path, both of which made guest kills
invisible. They had to be fixed together — fixing either alone still left
`stats.kills` at 0.

**(a) `if (!e) break` in `Coop.onClientFrame`.** `game.getEnemy(slot)` returns the
**slot number**, not an object, so a truthiness test rejects slot `0` — the first
enemy of every run, and the slot any freshly spawned test enemy lands on:

```js
case 'h': {
  const e = this.game.getEnemy ? this.game.getEnemy(ev[1]) : null;
  if (!e) break;            // <-- slot 0 is falsy: the hit is silently dropped
```

Fixed to `if (e == null) break` in both the `'h'` and `'s'` cases. This is the same
class of mistake as the `dex: 0` bug above: **`0` is a valid id, so never test ids
for truthiness.**

**(b) `applyHit` did not pass `silent: true`.** Without it the host ran the local
damage-number/audio block, which needs a move definition for `n.slot` that a
forwarded hit does not have. It threw and skipped the
`i.hp[e] <= 0 && this.killEnemy(e, n)` tail: damage landed but the enemy never died
(host HP 30 → 8.6, kills stayed 0).

Verified end to end on host slot 0, both entry points:

```
guest slot mapping  {"hostSlot":0,"local":0,"isRemote":true,"hostSlotOfLocal":0}
guest normal attack {"strikeReturn":0,"outEvAdded":1,"outEv":[["h",0,99999,16777215,0,0,0]]}
host after          {"kills":1,"hp":0,"dying":0.20}
guest raw coop.hit  {"outEvAdded":1,"outEv":[["h",0,99999,16777215,0,0,0]]}
host after          {"kills":2,"hp":0,"dying":0.25}
```

The full chain, for the record: guest `kh.hit` → `strike` sees `i.remote[slot]` →
`coop.hit(localSlot)` (wrapped to translate to the host slot) → `outEv.push(['h',…])`
→ `flushClient` → `net.toHost` → host `onClientFrame` `case 'h'` → `game.getEnemy`
→ `applyHit` → `combat.hit(slot, dmg, {fixed, silent})` → `killEnemy` → `credit`
→ `stats.kills++`, then the host's `k:'f'` frame carries `ki` back to the guest.

### 5. The guest's level-up card closed itself

`Coop.onHostFrame` closes the local card whenever a frame arrives without an `lu`
field — which on the guest is *every* frame. The adapter's `inLevelUp()` reported
`true` while the card was open, so the card vanished one frame after opening. The
guest's card is now closed only by the host's explicit `'lr'`.

## Verification (actually run)

- `node --test net/codec.test.mjs net/signaling.test.mjs net/signaling-local.test.mjs`
  → 24/24 pass.
- `node --check` on the served (patched) bundle → parses as an ES module.
- `.coop-verify/coop-drive.mjs` — two **separate** Playwright browser contexts,
  driven **only** through the in-game screens (friends → invite → lobby → Start).
  `coop-ui.mjs`'s `startLocalRun()` walks menu → League (`Liga`) → region screen → run by
  itself; the driver never clicks `.mm-item`, `.ls-go` or `.rg-go`.
  Per run it asserts: both contexts reach `state === 'play'`; 5 position samples
  match in both directions; a guest-caused kill increments the host's counter; a
  host level-up freezes both, shows the guest a usable card, and resumes both;
  puppets stay at level 1 / 0 XP; zero uncaught console errors.
- Region-screen selector verified against the bundle, not guessed:
  `<div class="rg-go"><button class="btn big red" onclick=T>` at L73997;
  `.rg-go` is unique in the bundle.

## Still not wired

- HUD teammates block (`eM.hud`); `Coop.players()` has the data.
- `enemyAdded` hardcodes `shiny: 0` (no `Sd` shiny lookup).
- Ghost casts (`ghostCast`) and remote pickup events are stubs in the bridge adapter.
