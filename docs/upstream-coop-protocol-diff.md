# Upstream co-op wire protocol vs `net/` — diff

> The full rebase inventory (infrastructure, backend stubs, decisions, risks, order of
> work) lives in `docs/rebase-0.8.29-plan.md`. This file covers the wire protocol, the
> redundancy matrix and the level-gate patches only.

Evidence base: live `pokebonk.com` build `mvl14oup` (`version.json` → `0.8.29`) vs local
mirror build `mvilprw2` (`0.8.13`). All upstream facts below were read out of
`main-DEBvJLhQ-mvl14oup.js` (2,059,921 B, `node --check` clean), not from patch notes.
Local facts are from `net/coop.mjs`, `net/net.mjs`, `net/codec.mjs`, `net/INTEGRATION.md`.

Upstream added co-op between `0.8.14` and `0.8.29`: the `0.8.13` app chunk contains zero
`peer` / `coopRoom` identifiers, `0.8.29` contains 192 `coop` occurrences, class `GT`
(the run session) and class `Dk` (the peer link).

## 1. Upstream architecture

Control plane is **server**, data plane is **P2P mesh**.

| Layer | Upstream |
|---|---|
| Room registry, membership, invites, chat, presence | HTTP under `/coop/*`: `POST /rooms`, `POST /rooms/{code}/join`, `POST /rooms/{code}/me`, `POST /rooms/{code}/chat`, `GET /rooms/{code}?after=<seq>&chat=<seq>` (poll), `POST /rooms/{code}/access`, `POST /invites`, `GET /invites` |
| Signaling | Their backend: `signal(id, 'offer'/'answer', sdp)`; offers retried when `signalingState !== 'stable'` |
| ICE | `stun:stun.l.google.com:19302`, `stun1.l.google.com:19302`, `stun:stun.cloudflare.com:3478` — **no TURN, no relay** |
| Transport | Per-peer `RTCPeerConnection` with two negotiated channels |
| Channel `ctl` | id 0, ordered, reliable, **JSON** (`JSON.stringify`), plus `_ping`/`_pong` RTT |
| Channel `snap` | id 1, `ordered: false`, `maxRetransmits: 0`, **binary** (`arraybuffer`), dropped when `bufferedAmount > 196608` |
| Topology | Full mesh: every peer sends its own `snap` to every other peer, and every peer is authoritative for the enemies **it** simulates |
| Enemy authority | Per-peer, not centralised. Enemies that exist only in a peer's snapshot are created as **proxies** flagged `R.Remote` on the receiver; the combat class refuses to damage or kill them locally and forwards instead (`hitProxy`, `statusProxy`). Boss authority is a separate slot (`bossAuth`) that defaults to the host and is reassigned when its holder leaves |
| Room authority | `isHost` = **lowest open slot** (`slot < mySlot` check) |
| Party size | 2–4 (`spawnMul` / `hpMul` keyed by `size`) |
| Difficulty | `spawnMul {1:1, 2:.85, 3:.8, 4:.75}`, `hpMul {1:1, 2:1.25, 3:1.5, 4:1.75}`, `bossHpMul = (1 + .8·(size−1)) / hpMul` |

### 1.1 `ctl` message types (JSON, reliable)

Read from the `switch` in `GT.onCtl`:

| `t` | Payload | Direction | Meaning |
|---|---|---|---|
| `en` | `l:[…]` | host → each peer | enemy **descriptors** for keys the peer does not know (chunks of ≤1080 numbers) |
| `want` | `l:[key]` | peer → host | peer no longer needs these keys (≤400 per message) |
| `hit` | `l:[…]` | peer → host | that peer's hits on enemies |
| `dead` | `l:[key]` | host → all | enemy deaths, batched once per tick |
| `xp` | `x, z, v` | any → all | XP share at a position |
| `boss` | `st, x, z, a` | peer → host | boss called by that peer |
| `bd` | `s, d` | peer → host | boss damage, acked back inside `snap` |
| `bdown` | `st` | host → all | boss down |
| `go` | `st` | host → all | stage transition |
| `end` | `v` | host → all | run finished (`v` = win) |
| `bye` | – | any → all | peer left the run |
| `down` | – | any → all | peer downed (toast: stay close to revive) |
| `up` | – | any → all | peer revived |
| `portal` | – | any → all | peer entered the portal |
| `fx` | `k, ty, r` | any → all | cast FX (capped 8/frame) |
| `ult` | `n` | any → all | ultimate pose |
| `mark` | `x, z` | any → all | map mark/ping |
| `_ping` / `_pong` | `s` | both | RTT probe |

Room layer additionally uses `room-start`; `snap` carries no message type byte, only the
version byte `1`.

### 1.2 `snap` byte layout (unreliable, 15 Hz)

Writer `kT.begin(ts, player, input?, stage)` then `kT.finish(rows, MAX)`:

```
u8   1                      // format version
u8   hasInput | (stage&15)<<4
f32  ts
f32  x, y, z                // sender's world position
i8   aimX*127, i8 aimZ*127
u8   face
u8   anim
u16  species
u8   hp*255
u16  level
u8   flags                  // xT bitset
u8   revive*255
u8   ceil(bleed)
--- if hasInput ---
f32  x, y, z                // boss position this peer is authoritative for
u8   face, u8 anim
f64  hp, f64 maxHp
u8   nAcks, then nAcks × (u8 slot, u16 amount)
--- always ---
u16  count
count × 11 bytes:
     u16 key                // ST(slot, gen)
     i16 x*20, i16 z*20, i16 y*20
     u8  hp*255
     u8  st                 // bT bitset
     u8  (dirRow<<3) | (anim&7)
```

`flags` (`xT`): `downed`, `out`, `bubble` (modal/typing), `blink` (iframes), `shiny`,
`spectral`, `portal`, `attack`.
`st` (`bT`): `burn 1`, `poison 2`, `para 4`, `frozen 8`, `sleep 16`, `wet 32`, `curse 64`,
`slow 12` (chill/root).

Constants: `15 Hz`, `MAX rows 170`, `near radius 52 m`, `interp delay .11 s`,
`descriptor TTL 1 s`, `XP share interval .5 s`, `snap buffered cap 196608 B`,
`FX cap 8/frame`.

### 1.3 Enemy identity, the part that matters

Upstream does **not** send slot indices. The key is
`ST(slot, gen) = ((gen & 15) << 12) | (slot & 4095)` — a 4-bit generation counter folded
into a 12-bit slot index (max 4096 slots, 16 generations); a descriptor block (`en`)
describes each new key once
(species, flags mask, maxHp, dmg, scale, x/y/z world pos, 10–20 msgs), rows then carry only
the key plus quantised motion/hp/status. `want` + a 1 s TTL (`IT`) let a peer drop keys it
no longer needs, and `dropStale` unmaps anything unseen. Slot reuse is therefore harmless.

### 1.4 Who owns an enemy (the part a rebase must respect)

Upstream is **not** host-authoritative over enemies. Each peer simulates its own world; an
enemy another peer reports is materialised as a **proxy**:

```
r.spawnProxy(species, x, y, z, flags & VT | R.Remote, gen)   // R.Remote = 65536
```

The combat class treats proxies as read-only mirrors:

| Combat method | Proxy (`flags & R.Remote`) | Locally simulated |
|---|---|---|
| `takeHp(slot, dmg)` | `coop.hitProxy(slot, dmg)`, HP clamped to ≥1 | `hp[slot] -= dmg` |
| `killEnemy(slot)` | HP clamped to ≥1, never dies | dies; `coop.bossDefeated()` when it is the boss |
| `applyStatus(slot, kind, v)` | `coop.statusProxy(slot, kind, v)` | applied locally |
| `remoteHit(slot, dmg, statuses, crit, x, z, ownerSlot)` | — | applies another peer's forwarded hit |
| `creditRemote(proxySlot, species, killed, …)` | — | credits the kill to the remote owner |

So "reusing their hits and deaths" is not porting two functions: it is adopting the proxy
model. A peer never damages an enemy it does not own, it forwards and the owner decides.
Deaths arrive as one batch per tick (`deaths.push(key, killed, species, flags, x, z)` →
`ctl {t:'dead'}`), descriptors arrive once per unknown key (`ctl {t:'en'}`), and rows unseen
for `FT = 1.6 s` or explicitly dropped via `want` are unmapped by `dropStale`.

## 2. Local `net/` protocol

| Layer | Local |
|---|---|
| Channels | **one** channel `g`, `ordered: true`, JSON or packed (custom `codec.mjs`) |
| Signaling | Firebase (`signaling-firebase.mjs`) or local dev server (`signaling-local.mjs`) |
| Relay | Firebase RTDB queue `rooms/{room}/q/{to}/{id}`, 3 Hz |
| TURN | off (`TURN_ON=false`), direct channel timeout 9 s |
| Topology | **star**: guests → host only, host → all guests |
| Authority | host simulates enemies, pickups, team XP, clock; guests own only their own Pokémon |

Constants: `NEAR 70 m`, `NEAR_HURT 45 m`, `RATE_FAST 1/15`, `RATE_SLOW 1/3`,
`DIRECT_TIMEOUT 9000`, `ALLOW_RELAY true`.

Frames:

```
guest → host  { k:'f', p:[16 floats], ev:[[kind, …]] }
host  → guest { k:'f', t, lv, xp, xn, ki, bo, co, sg, st,
                p:{uid:[16 floats]}, e:[[slot,x,y,hp,anim,dir,status]], ev:[…] }
host  → all   { k:'start', seed, host, members:[{uid,name,dex,shiny}] }
```

Player array: `[x, y, angle, walking, hp, maxHp, dead, level, aim, xpMul, reviveT,
choosing, doneSeq, watching, dex, shiny]`.

Event kinds (`coop.mjs`, both `outEv` producers and `case` consumers):
`ne` enemy new, `ed` enemy dead, `eg` enemy gone, `hn` hurt number, `h` hit, `s` status,
`c` cast, `es` enemy shot, `pk` pickup add, `pc` pickup gone, `say` dialogue, `sh` shiny,
`lu` level-up start, `lw` level wait, `lr` level resume, `lp` local pick, `ha` host away,
`gd` gold delta, `mag` magnet, `ov` game over, `pf` player frame (near peers), `bye` gone,
`start` seed/host/members.

## 3. Redundancy matrix

Verdicts: **superseded** = upstream now ships an equivalent on the wire; **keep** = no
upstream equivalent, still your differentiator; **differs** = both exist but semantics
differ, pick one.

| Local item | Upstream equivalent | Verdict |
|---|---|---|
| `start` (seed, host, members, dex, shiny) | run ticket/seed from backend + `room-start` + room member list | **superseded** |
| host frame `e:[slot,…]` enemy rows | `snap` rows + `en` descriptors | **superseded** (upstream adds generation keys + `want` culling) |
| `ne` / `eg` / `ed` spawn/despawn/death events | `en` descriptors, `dead` batch, presence in `snap`, `want` | **superseded** |
| `h` hit forwarding (guest → host) | `hit` | **superseded** |
| `s` status replication | `st` bitset (8 statuses vs your 4: has para/frozen/sleep/wet/curse, lacks `shield`) | **differs** |
| host frame `p:{uid:[…]}` teammate states | each peer sends its own `snap` (mesh, not relayed by host) | **superseded** |
| host frame `t` clock | `snap` `ts` + `interpPeers` | **superseded** |
| `lv` / `xp` / `xn`, host frame | `xp` ctl + `shareXp` at 2 Hz | **superseded** |
| `lu` / `lw` / `lr` / `lp` level-up handshake | none — upstream only broadcasts the `bubble` flag and lets each peer pick locally | **keep (decided)** — party-wide barrier stays, see §6 |
| `bo` / `co` boss fields | `boss`, `bd`, `bdown`, boss block in `snap` with damage acks | **superseded** |
| `sg` / `st` state + stage | `go`, `end` + `stage` nibble in `snap` | **superseded** |
| `reviveT`, downed state | `down`, `up`, `revive*255` in `snap`, `downedTick` | **superseded** |
| `pk` / `pc` pickups | **none** — `snap`/`ctl` carry no pickup rows | **keep** |
| `hn` hurt numbers | **none** (only `fx`/`ult` casts) | **keep** |
| `es` enemy shots | **none** as rows; projectile visuals ride `fx` | **differs** |
| `c` cast | `fx` (`k, ty, r`) | **superseded** |
| `say` dialogue | room chat is backend `/coop/rooms/{code}/chat`, wiped at run start | **superseded** |
| `ha` host away | none explicit (`link` state + `down` toast) | **keep** |
| `gd` gold delta / `mag` | none | **keep** |
| `sh` shiny caught | `shiny` flag in `snap`/descriptors only | **differs** |
| `pf` near-only player frame | player state goes to every open peer in `snap`; only enemy rows are distance-culled per recipient (`near radius 52 m`) | **differs** |
| `ov` game over | `end` | **superseded** |
| relay fallback at 3 Hz | **none** — upstream is STUN-only, symmetric-NAT peers simply fail | **keep** (this is a real advantage) |
| `watching` (spectate uid) | `chaseX/chaseZ` spectate camera when dead, plus `slot` ordering | **differs** |
| party HP bars | `HF` (`coopHud`) at 1898893: `.coop-team` card per peer with `--hp` bar, `Nv. {lvl}`, states `down`/`out`/`portal`/`lost`, plus floating `.coop-tag` with `.coop-hp` | **superseded** |
| map member indicators | minimap draws every active peer portrait, tinted `#ff5a6a` when `flags & 3` (downed/out) else `#7aff9a` (~1943050: `if(e.coop){ … e.coop.active() … portraits/${t.species}.png … }`) | **superseded** |

## 4. Measured frame cost

Same 170 enemy rows, local codec (`net/codec.mjs` `encode`) vs upstream row format:

| Encoding | Bytes for 170 rows + header |
|---|---|
| Local host frame (2 players + 170 rows, JSON codec) | **2806** |
| Upstream `snap` (30 B header + 170 × 11 B) | **1870** |
| Ratio | **1.45×** |

At 15 Hz that is ~42 KB/s per guest locally vs ~28 KB/s per peer upstream. The bigger gap
is not size, it is transport: local frames ride an **ordered** channel, so one lost packet
stalls every later snapshot (head-of-line blocking); upstream snapshots ride
`ordered:false, maxRetransmits:0` and simply drop.

## 5. What the merge actually costs

1. **Drop `start` / `e` / `ne` / `eg` / `ed` / `p{}` / `t`**: upstream's `snap` + `en` +
   `want` + generation keys replace all of it, and fix the slot-reuse hazard called out in
   `net/INTEGRATION.md` §"Slot stability assumption" — that whole section becomes obsolete,
   `R.Remote` + `ST(slot, gen)` is the upstream answer.
2. **Keep `lu`/`lw`/`lr`/`lp`, `pk`/`pc`, `hn`, `ha`, `gd`, `mag`, and the relay path** —
   nothing upstream carries them. The level-card barrier in particular is stricter than
   upstream's `bubble` flag.
3. **Your HUD work is now redundant** — upstream's `HF` covers party HP bars with
   `down`/`out`/`portal`/`lost` states, and the minimap already tints peer portraits red
   when `flags & 3`. Drop the party HUD patch; keep only what `HF` does not show (see §7).
   Correcting an earlier read: `partyHp`/`teammate`/`partyBar`/`partyMarker` identifiers are
   absent, but the feature ships under `coopHud`/`coop-team`/`coop-tag` and inline minimap
   drawing.
4. **Ordering matters**: if the fork keeps its own star topology it inherits head-of-line
   blocking; if it adopts upstream's mesh, the `net/` relay becomes the fallback layer for
   peers that never get a direct channel — which upstream lacks entirely.

## 6. Decisions

### 6.1 Level-ups stay party-wide (decided)

Upstream lets each peer pick its own card behind the `bubble` flag: no barrier, no shared
sequence, no resume token. The fork keeps `net/coop.mjs`'s barrier instead — every level-up
pauses the whole party until every connected member has picked.

Current implementation (`net/coop.mjs`, verified by
`net/coop.test.mjs`: "two queued level-ups: a guest pick counts for one card only",
"a teammate leaving while owed cards releases the wait",
"a guest never runs the shared level-up or sends host frames"):

| Step | Wire | Owner | Effect |
|---|---|---|---|
| `levelStart(level)` | `lu [level, seq]` | host only | `owed` counter incremented per connected member; `waiting` = everyone owed |
| `sendWaiting()` | `lw [names]` | host | HUD shows who the party is waiting on |
| guest pick | `lp` | guest → host | guest never runs `levelStart`; it only reports the pick |
| `picked(uid)` | – | host | decrements that member's `owed`; on empty `waiting` → |
| resume | `lr` | host | barrier released, run continues |

Invariants that must survive the rebase:

1. **Host-only ownership.** A guest calling `levelStart` flushes host frames at the host
   (that bug is why the host gate exists). On the upstream base, `DC.doLevelUp` must be
   inert on guests and open the card only from `lu`.
2. **Per-player owed counters, not a Set reset.** Two queued level-ups must not let a pick
   for the first card clear the second.
3. **Silent-peer release.** A teammate that disconnects while owed must drop out of
   `waiting` or the party stalls forever.
4. **Run-state authority carries the pause.** `coop.mjs` only tracks *who owes a card*; the
   actual freeze comes from the host entering its run's modal state (`DC.doLevelUp` →
   `state='modal'` + `game.levelStart`). Guests inherit the freeze for free because they
   never advance the clock — they render the host's `t`. Keeping the barrier on the upstream
   base therefore requires upstream run state to stay host-owned; if per-peer pacing is
   adopted instead, the barrier silently stops freezing guests.

Patch surface on the upstream base (`mvl14oup`):

- `GT.tick` / run update: host emits `lu` on each level-up and gates run advance on
  `waiting.size === 0`.
- Level-card open: host broadcasts `lu` + `lw`; guest opens only from `lu`.
- Card confirm: guest sends `lp`; host calls `picked(uid)`.
- `bubble` (`xT.bubble`) stays for other input-blocking modals; it is not the card signal.
- Upstream `xp` share (2 Hz) can drive team XP while the barrier pauses the run — it is
  orthogonal to the card barrier and does not replace it.

## 7. Patch inventory for a rebase onto `mvl14oup`

All 0.8.13 minified symbols used by `net/INTEGRATION.md` are **gone** from `0.8.29`; every
anchor in that document has to be re-derived. Symbols verified in `mvl14oup`:

| Role | `mvl14oup` | Evidence |
|---|---|---|
| Run | `nE=class` | fields `enemies;projectiles;pickups;combat;zones;boss;player;coop` |
| Enemies | `kf` | `kill(e){this.alive[e]&&(this.alive[e]=0,this.flags[e]&65536?this.remotes--:this.count--,…` |
| Projectiles | `Xp` | `this.projectiles=new Xp(this)` |
| Pickups | `sm` | `sm=class{…alive=new Uint8Array(rm);kind…}` |
| Combat | `Gg` | `remoteHit(e,t,n,r,i,a,o){…}`, `n.hp[e]-=t` |
| Zones / boss / player | `N_` / `wy` / `gv` | run constructor |
| Minibosses / events / director | `Yy` / `Qy` / `vv` | run constructor |
| UI | `oI` | `minimap; mm; marks=[]; pins=[]` |
| Co-op HUD | `HF` | `coop-team`, `coop-tag`, `--hp` |
| Co-op session / link / snap | `GT` / `Dk` / `kT`+`AT` | §1 |
| Enemy remote flag | `Remote=65536` | `this.flags[e]&65536` |

### 7.1 Author these (no upstream equivalent)

| # | Feature | Anchor in `mvl14oup` | Patch |
|---|---|---|---|
| P1 | Party-wide level barrier (**decided, §6.1**) | card open `this.ui.showLevelUp(this,e,(e,r)=>{…})` at 1421091; card close `this.pendingLevels=Math.max(0,this.pendingLevels-1),this.noResumeGrace=!e,this.ui.hideModal()` at 1420652 | host emits `lu [lv,seq]` and gates resume on `waiting.size===0`; guest opens only from `lu`; guest confirms with `lp`; host emits `lw`/`lr` |
| P2 | Relay fallback for peers with no direct channel | `Dk.sendCtl` / `Dk.sendSnap` return `false` when the channel is not open; `GT.tick` already tolerates that | route dropped frames through `net.mjs`'s relay (Firebase queue, or the room backend `GET /coop/rooms/{code}?after=`) at 3 Hz |
| P3 | Pickup replication (`pk`/`pc`) | `sm=class` (no pickup rows in `snap`, no ctl type) | host hooks `sm.spawn`/removal, guests mirror rows; decide whether guests may collect |
| P4 | Hurt numbers (`hn`) | combat damage path `n.hp[e]-=t` | host-side only, near guests, as today |
| P5 | Shared gold (`gd`) | run field `gold=0`; 39 `gold` refs in the run, **none** in `GT` | patch `addGold` if gold should be party-wide |
| P6 | Enemy shots (`es`) | `fx` kinds are cast visuals (`shot`,`strike`,`nova`,`smite`,`meteor`,…), not enemy projectiles | host replicates `Xp` spawns near guests |
| P7 | Host-away toast (`ha`) | `HF` already renders `lost` per peer card | optional; HUD covers the state |

### 7.2 Delete from `net/` (superseded by upstream)

`start`, guest→host `p`, host→guest `e` rows, `t` clock, `p:{uid}` teammate states,
`ne`/`eg`/`ed`, `h` (`Gg.remoteHit` exists), `s` statuses (upstream 8-bit `st`), `lv`/`xp`/`xn`
(`xp` ctl + 2 Hz share), `bo`/`co` (`boss`/`bd`/`bdown` + boss snap block), `sg`/`st`
(`go`/`end`), `reviveT` (`down`/`up`/`revive` field), `c` (`fx`), `say` (room chat via
`/coop/rooms/{code}/chat`), `ov` (`end`), and the whole party HUD (upstream `HF` +
minimap portraits).

Also obsolete: `net/INTEGRATION.md` §"Slot stability assumption" and the `ne`/`eg`/`ed`
reconciliation — upstream keys enemies as `ST(slot,gen)` and culls with `want` + 1 s TTL.

### 7.3 Two decisions this inventory forces

1. **Transport**: adopt `GT`'s mesh (generation keys, `want` culling, boss authority,
   per-peer culling at 52 m) or keep `net/`'s star. Adopting `GT` costs P1's spawn point
   (the barrier rides `ctl` instead of `{k:'f'}`) but removes P2–P6's data plumbing.
2. **Pickups and gold** are per-peer in upstream today. If the party should share them,
   that is new work with no upstream reference implementation.

### 7.4 Implemented: the one-pass patch kit for `mvl14oup`

| File | Role |
|---|---|
| `tools/bundle-patches-0.8.29.mjs` | the patch set: `L1-host-announce`, `L2-pick-confirm`, `L3-guest-gate` — every insertion gated on `globalThis.__pbCoop` |
| `tools/apply-bundle-patches.mjs` | one-pass applier: verifies each anchor occurs **exactly once**, refuses to write on a mismatch, skips already-applied patches, re-parses the result with `node --check` before committing |
| `tools/apply-bundle-patches.test.mjs` | 7 tests: apply-once, idempotent re-run, guest-gate shape, missing anchor, duplicated anchor, co-op-off inertness, plus the real bundle when `PB_UPSTREAM_BUNDLE` is set |

```
node tools/apply-bundle-patches.mjs --in <app.js> --out <app.patched.js>
# or: npm run patch:0.8.29 -- --in <app.js>
```

Verified against the real `mvl14oup` chunk (2,059,921 B):

| Check | Result |
|---|---|
| anchors unique | 1 occurrence each for all three |
| patches applied | 3/3 |
| size delta | +298 B |
| `node --check` on patched output | parses |
| second pass | 0 applied, 3 skipped, byte-identical output |

Anchors, for the record:

| Patch | Anchor | Inserted |
|---|---|---|
| `L1-host-announce` | `a(bb(this,t))}` | `globalThis.__pbCoop&&__pbCoop.levelStart&&__pbCoop.levelStart(this.player.level),` |
| `L2-pick-confirm` | `catch(e){rc(\`levelup\`,e)}finally{n()}}):r()};` | `finally{…__pbCoop.localPicked(),n()}` |
| `L3-guest-gate` | `a=e=>{e.length?` | `if(globalThis.__pbCoop&&__pbCoop.isGuest&&__pbCoop.isGuest())return void(…__pbCoop.hostCard(this.player.level));` |

**Still required before a co-op run works on the new base:** the `globalThis.__pbCoop`
bridge itself — `isGuest()`, `levelStart(level)`, `localPicked()`, `hostCard(level)` — bound to
the new run object, plus the `lu`/`lw`/`lr`/`lp` handlers already unit-tested in
`net/coop.mjs` (36 tests). The patch kit deliberately does not guess at that binding: it
needs a two-tab run to validate, which is the next step. P2–P7 (§7.1) are not yet anchored
on `mvl14oup`.
