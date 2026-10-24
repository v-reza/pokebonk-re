# Rebase `pokebonk-re` onto upstream `0.8.34` (`mvlr7rzv`) — plan

Source base: `0.8.13` (`mvilprw2`) · Target base: `0.8.34` (`mvlr7rzv`) · previous target `0.8.29` (`mvl14oup`) kept in `public/assets` for reference
Companion doc: `docs/upstream-coop-protocol-diff.md` (wire protocol, redundancy matrix, patch inventory §7).

Legend: ✅ done and verified · ⬜ pending · 🔒 blocked on a decision

## A. Done

| # | Item | Where | Proof |
|---|---|---|---|
| A1 | Party-wide level gate: owed counters, host-only ownership, leave-release, `lu`/`lw`/`lr`/`lp` | `net/level-barrier.mjs` | 8 tests (`net/level-barrier.test.mjs`) |
| A2 | Bridge `__pbCoop`: `openLevel`, `localPicked`, `attachSession`, `bindNet`, `receive`, `resume`, `skipSpawns`, `attachPickups`, `pickupCollected`, `tick` | `net/coop-bridge-0.8.29.mjs` | 16 tests (`net/coop-bridge-0.8.29.test.mjs`) |
| A3 | Patch set for the modern builds: `L1`–`L9`, all gated on `globalThis.__pbCoop` | `tools/bundle-patches-0.8.29.mjs` | **applies to both** `mvl14oup` (0.8.29) and `mvlr7rzv` (0.8.34) via per-patch anchor candidates; 9/9, +689 B on each, parses, idempotent |
| A4 | One-pass applier + npm script | `tools/apply-bundle-patches.mjs`, `npm run patch:0.8.29` | 7 tests |
| A5 | `POST /profile/actions` batched reducer; the 5 economy routes rewired to it in both backends | `firebase/shared.mjs`, `firebase/backend.mjs`, `server.mjs` | 4 tests + live HTTP |
| A6 | Clans: create, join (open/request/requirements), status, search, guide, notice, settings, invite, uninvite, kick, role, leave, disband, rename, emblem, mute, chat, activity | `firebase/clans.mjs` + both backends | 6 tests + live HTTP |
| A7 | Leader succession: idle 7 days → officer active in 3 days with most points → else most-pointed member | `maintainClan()` in `firebase/clans.mjs` | 2 tests |
| A8 | Wardrobe + Team persistence: `skins`, `team` in `PUT /profile/prefs`; profile defaults `skins/classics/team` | `firebase/shared.mjs` | 1 round-trip test |
| A10 | Shared pickups + shared gold: host snapshot (5 Hz) with party gold, ghost materialisation on guests, collect intent + single credit, removal broadcast | `net/pickups-sync-0.8.29.mjs` | 7 module tests + 2 bridge integration tests |
| A11 | `/coop/*` room service (F1=A): access, ice config, rooms create/join/poll, signals, chat, me/settings, kick, invite, start, leave, invites, standing, board | `firebase/coop.mjs` | 13 tests + live lobby and full two-browser run |
| A12 | Party-scoped run seed (shared world under their mesh) | `/runs` handler in both backends | covered by the coop test suite |
| A13 | ctl transport for the fork's messages: `net/coop-ctl-0.8.29.mjs` + patch `L6-ctl-receive` (forwards unknown `ctl` types to `__pbCoop.receive`) | `net/coop-ctl-0.8.29.mjs`, `tools/bundle-patches-0.8.29.mjs` | kit is now 8 patches (L1–L8), +624 B, parses true, idempotent (`L7`/`L8` covered by A16/A17); tests `net/coop-ctl-0.8.29.test.mjs` |
| A14 | bootstrap `net/coop-boot-0.8.29.mjs` (`bootCoop`/`bootInfo`) + page wiring in `public/index.html` (`?pbcoop=1` loads `public/net/coop-page-0.8.29.mjs`; the module also auto-loads) | `net/coop-boot-0.8.29.mjs`, `public/index.html` | `net/coop-boot-0.8.29.test.mjs` |
| A15 | Relay fallback under F1=A: `roomSignalTransport` (posts `{kind:'pb'}` via the room signal endpoint, cursor advanced once) + page watchdog that swaps the bridge transport when the mesh never opens, plus runtime `setSend` on barrier/pickups/shots | `net/coop-ctl-0.8.29.mjs`, `net/coop-bridge-0.8.29.mjs`, `public/net/coop-page-0.8.29.mjs` | `net/coop-ctl-0.8.29.test.mjs`, and the two-browser run (`relay: true` on both, barrier round-trip 18/18) |
| A16 | Enemy projectiles replicated: `net/coop-shots-0.8.29.mjs` (`ShotSync`, `esn`/`esc` on ctl, host 10 Hz sample capped) + patch `L7-shot-tick` | `net/coop-shots-0.8.29.mjs`, `tools/bundle-patches-0.8.29.mjs` | `net/coop-shots-0.8.29.test.mjs` |
| A17 | Teammate damage numbers: bridge `damageNumber()` (host-only broadcast `hn`, guests render one `ui.popup`) + patch `L8-hurt-number` | `net/coop-bridge-0.8.29.mjs`, `tools/bundle-patches-0.8.29.mjs` | bridge tests |
| A9 | Suite: `node tools/verify-all.mjs` → 15 test files, 141 tests pass, 9/9 patches, +689 B, idempotent, API integration 10/10; plus `npm run test:e2e` 18/18 | `tools/verify-all.mjs` | see §I |

## B. Co-op features to port (upstream has no equivalent)

| # | Feature | Hook target in `mvl14oup` | Notes |
|---|---|---|---|
| B1 | Relay fallback | `roomSignalTransport` in `net/coop-ctl-0.8.29.mjs` + page watchdog (8 s without an open mesh link engages it) | ✅ implemented and **observed working in the browser**: both clients reported `relay: true` and exchanged barrier messages over room signals |
| B2 | Shared pickups | class `sm`: collect funnels through `collect(slot)`; ghosts materialised with `spawn(kind,x,y,z,value)` | ✅ implemented (A10): hooks `L4`/`L5`; `collect(e){…}` guard verified unique |
| B3 | Shared gold | run `addGold(n)` (host-only writer now) | ✅ implemented (A10): party gold rides the pickup snapshot + `gd`; guests render the host total |
| B4 | Enemy projectiles | class `Xp` (SoA: `x,y,z,vx,vy,vz,life,rad,dmg,…,slot`), cull via `enemies.within(x,z,r,out)` | ✅ implemented (A16): `ShotSync` on ctl (`esn`/`esc`, host 10 Hz capped), hook `L7-shot-tick` |
| B5 | Teammate damage numbers | `ui.popup(x, y, z, text, color, scale)` | ✅ implemented (A17): bridge `damageNumber()`, host broadcast `hn`, hook `L8-hurt-number` |

✅ **Decided (F2):** a guest may collect, the host credits. Sequence: guest touches a coin → sends a collect intent → host removes the coin, calls `addGold` once, broadcasts `pc` + `gd`, and acks the intent. Duplicate intents for the same pickup id must be ignored on the host (idempotent by pickup id). Guest never calls `addGold` itself.

## C. Infrastructure to re-point

| # | Item | What breaks |
|---|---|---|
| C1 | Base swap | ✅ **assets re-mirrored to 0.8.34** (`main-CwXNXC4E` entry, `main-CPuTGAQ-` game chunk, locales, CSS, `three`); `public/index.html` is the 0.8.34 page with the co-op bootstrap re-injected, legacy kept as `index-0.8.13.html`. `server.mjs` patches both modern chunks (`main-CPuTGAQ-`, `main-DEBvJLhQ`) |
| C2 | `tools/bundle-patches.mjs` A1–A8 + the two redirects (`api.pokebonk.com` → `/api`, Turnstile stub) | ✅ **audited** (`docs/reanchor-0.8.29-audit.md`): 22 items → 16 SUPERSEDED, 5 OBSOLETE, 1 STILL_NEEDED (`A8` sprite separation, candidate anchors listed in the audit), 0 without anchor. Redirects apply cleanly to both builds. |
| C3 | `assertMirrorHooks()` E1–E14 | ✅ **audited** (`docs/reanchor-0.8.29-audit.md`): all 14 assertions check 0.8.13 minified symbols (`Sd`, `Xf`, `kh`, `Yg`, `DC`, `eM`) that no longer exist in `mvl14oup`; must never run against `mvl14oup` and already does not (`server.mjs` branch). |
| C4 | Default page switch & bridge bootstrap (`public/index.html` + `net/coop-page-0.8.29.mjs`) | ✅ **done**: `public/index.html` is now the 0.8.29 page with the bridge module auto-loaded; the legacy page moved to `public/index-0.8.13.html` and the legacy test now fetches that path; `tools/check-default-page.mjs` proves `/` is 0.8.29, all its assets are 200, the legacy page still points at `main-BcyzVqXo-mvilprw2.js`, and the served 0.8.29 chunk contains the patched hooks. |
| C5 | `/coop/*` room service | ✅ **implemented** (`firebase/coop.mjs`, 15 endpoints: access, rooms create/join/poll/chat/me/settings/signal/kick/invite/start/leave, invites list/decline, board). Wired into both backends. 11 tests. Live browser: menu shows **Co-op**, lobby creates **Room XQ2EV** with slots, map/difficulty, invite box |
| C5b | ✅ **Host-gated enemy spawning** (patch `L3-host-spawns`, anchor unique): guests skip `director.update(dt)`, so only the host spawns and guests display the host's enemies as proxies. `enemies.update()` still runs on guests so mirrors move | done (static); browser proof pending at C8 |
| C5a | Party-scoped run seed | ✅ **implemented**: `/runs` with `party` returns the party's single seed and the room announces the same one at start. Upstream `ctl` carries no seed and room object has none; without party seed, each player generated a different map. One shared seed = identical terrain/decoration map (`new Tl(seed ^ 11259375)`). |
| C6 | Tooling re-point: `tools/build-target.mjs` with `PB_BUILD/PB_VERSION/PB_ENTRY/PB_GAME/PB_INDEX` overrides + `LEGACY` | ✅ **implemented**: `tools/pull.mjs`, `tools/probe.mjs`, `tools/mirror.mjs`, `tools/prepatch.mjs`, `tools/patch-index-local.mjs` updated to import resolved build target; dry-run default with `--write` support; verified by `tools/build-target.test.mjs` (7 tests). `node tools/verify-all.mjs` (npm `verify`) is the single verification entry point; `npm run test:api` runs the HTTP-level co-op scenario (`tools/test-coop-0.8.29.mjs`, 10 steps). |
| C7 | `.coop-verify/coop-drive.mjs`, `tools/test-coop-e2e.mjs` | ⬜ pending: 0.8.27 replaced the picker with League screen + Team + Wardrobe. Playwright MCP is unmounted in this environment; runtime proof must run where a browser is available. `tools/check-default-page.mjs` and `tools/test-coop-0.8.29.mjs` cover everything that can be proven without one. |
| C8 | Two-tab runtime proof | ✅ **validated on 0.8.34** — `npm run test:e2e` passes **17/17** against two real browsers: same build, room create → invite → join, identical party seed, host/guest roles, relay fallback engaged (mesh never opens in this sandbox), and the party barrier round-trip (announce → guest waiting list → guest pick → host waiting 1 → host pick → 0) |

## D. Free with the swap (no work, no patch)

- **0.8.30–0.8.34**: co-op room redone (destination, team, large chat, ladder position for map+difficulty, invitations on the entry screen, change Pokémon from your card, bug report from the room); co-op ladder on the entry screen; **server relay when a direct P2P connection is blocked** ("no more getting stuck on «Connecting…»"); room filters maps/difficulties to what the whole team unlocked and flags teammates on an old client version; enemies chase the nearest trainer and bosses attack whoever is closest; shared portals, altars and captures; teammate HP numbers, attacks and big-map markers; smooth spectate (Space switches teammate); revive by holding E; FPS limit setting; boss status icons; level display fix (1000 no longer shown as 423); Mastery Look challenge rework; "Enemies drawn" setting; mobile stick/fullscreen fixes.

- **0.8.27**: Wardrobe, 2 Mastery Looks per Pokémon + "Looks" achievement category, Classic Shiny, Team favourites (6 stars).
- **0.8.29**: clan guide, join requirements, leader succession, clan management UI, co-op chat, co-op picker on the League screen, invite search + "invite everyone online", B/T/Q big numbers, trainer-card labels, fusion caps, Lavender Tower fixes.
- **0.8.28**: late-save rejection fix, anti-cheat tightening (26 more suspensions).
- **0.8.24–0.8.26**: phone archive presets, shiny filter for un-recruited Pokémon, iPhone sound, faster claims/purchases, anti-cheat precision, long Tower runs savable, loot beams, Bill's Machine every 3 floors, revive/level-up/ultimate/fusion fixes.
- **0.8.15–0.8.18**: connection-safe server updates, fusion projectile fixes, DPS meter, 3 archive templates, map zoom, event ranking revamp.
- **Co-op core**: hits, deaths, 8 statuses, boss authority + damage acks, XP share, down/revive, fx/ult, party HP cards, minimap member markers, lobby, chat, invites, co-op-only leaderboard, generation-keyed enemies (`((gen&15)<<12)|(slot&4095)`), 52 m per-peer culling, 15 Hz snapshots.

## E. Backend still stubbed (deliberate)

| Route | Today | Needs |
|---|---|---|
| `GET /clans/board` | `{entries: [], info}` | real season ladder data |
| `POST /clans/claim` | 400 | season rewards model |
| `POST /clans/expand` | 400 | capacity purchase model |
| `/coop/*` | ✅ implemented (C5); `GET /coop/access` answers 200 and the client's **Co-op** entry appears | — |
| `/leaderboard`, `/records*`, `/seasons*` | minimal/empty | unchanged from before this work |

## F. Decisions

| # | Decision | Options | Effect |
|---|---|---|---|
| F1 | Transport | ✅ **decided: (a) adopt their `GT` mesh** | our star layer is deleted later; the level gate, pickups, gold, shared world and the three remaining features ride their `ctl` channel; our relay is kept and bolted on as the fallback; implemented: ctl transport `L6`, relay fallback, shots, damage numbers |
| F4 | World sharing | ✅ decided: map **and monsters** must be identical for every player (not just the map) | map is seed-derived (C5a); identical monsters need host-gated spawning (C5b) which is free under our engine and one hook under theirs |
| F2 | Coin credit | ✅ decided: guest collects, host credits (intent → remove + `addGold` + `pc`/`gd` + ack, idempotent by pickup id) | see B2/B3 |
| F3 | Old co-op UI (`public/net/coop-ui.mjs` + its index bootstrap) | delete most of it, keep the fetch/lobby helpers only if needed (standing recommendation under F1=A) | under F1=A upstream owns lobby/picker/chat/invites; replaced by upstream's lobby |

## G. Risks

- 0.8.34 asks the server for ICE servers (`GET /coop/ice`) and for the room's ladder standing (`GET /coop/rooms/:code/standing`); both are served now (STUN-only by default, `COOP_ICE_SERVERS` adds TURN). A malformed ICE url makes the client throw when constructing a peer connection — the validation run caught exactly that.

- `clans` Firestore queries (`nameLower ==`, `memberIds array-contains`) are unexercised — no SDK in this environment; MemoryDB and the JSON store are the tested paths.
- `data/store.json` gains a `clans` key on first write (additive; old files still load).
- The patcher fails closed (missing → refuse, duplicate → refuse), so a stale anchor list cannot silently half-patch.
- Co-op behaviour is unit-tested **and** browser-proven (C8). The browser run also caught three real bugs that unit tests missed: 5-character room codes (client requires 4 from `[ABCDEFGHJKMNPQRSTUVWXYZ2-9]`), roles derived from `GT.isHost` flickering to host on both peers, and the barrier never clearing its waiting list on release.
- ctl message types we invent (`{'t':'pb'}`) are dropped by any future upstream build that stops falling through the switch default; the `L6` patch anchor must be re-verified on every build bump.
- the legacy 0.8.13 page is still served at `public/index-0.8.13.html` for reference/tests; it must not be linked from the default page.

## H. Order of work
1. ✅ **C1 → C2 → C3**: base swap mirrored, audit complete, serve-time string patches & redirects active.
2. ✅ **B1 (relay fallback)**: `roomSignalTransport` implemented under F1=A (A15).
3. ✅ **B5 → B4 (plumbing)**: teammate damage numbers (A17) and replicated enemy projectiles (A16) implemented.
4. ✅ **B2 + B3 (shared pickups & gold)**: single credit path + snapshot sync implemented (A10).
5. ✅ **C4 (index switch & bridge bootstrap)**: default `public/index.html` switched to 0.8.29 with bridge auto-load; legacy saved to `public/index-0.8.13.html`.
6. ✅ **C6 (tooling & verification)**: `tools/build-target.mjs`, `tools/verify-all.mjs` (npm `verify`), and `tools/test-coop-0.8.29.mjs` (npm `test:api`) implemented.
7. ⬜ **C7 / C8 (two-tab runtime proof)**: Playwright MCP unmounted in this environment; requires browser runner.
8. ⬜ **E**: clan board/claim/expand when season data exists.

## I. Verification commands

```bash
# single verification entry point (unit tests, bundle applier, idempotency, API integration)
npm run verify

# standalone HTTP-level co-op integration test
npm run test:api

node --test firebase/backend.test.mjs firebase/clans.test.mjs firebase/coop.test.mjs \
  net/coop.test.mjs net/codec.test.mjs net/signaling.test.mjs \
  net/signaling-local.test.mjs net/level-barrier.test.mjs \
  net/coop-bridge-0.8.29.test.mjs net/coop-ctl-0.8.29.test.mjs \
  net/coop-boot-0.8.29.test.mjs net/pickups-sync-0.8.29.test.mjs \
  net/coop-shots-0.8.29.test.mjs tools/apply-bundle-patches.test.mjs \
  tools/build-target.test.mjs

# served default page + assets + patched chunk
node tools/check-default-page.mjs

# skip-path proof
PB_SKIP_API=1 npm run verify

# real bundle (anchors unique + patched output parses)
PB_UPSTREAM_BUNDLE=<path to main-DEBvJLhQ-mvl14oup.js> \
  node --test tools/apply-bundle-patches.test.mjs

# one-pass patch of a mirrored bundle
node tools/apply-bundle-patches.mjs --in <app.js> --out <app.patched.js>

# two-browser runtime proof (needs Playwright + a Chromium; exits 2 when unavailable)
npm run test:e2e   # 18/18 expected

# legacy 0.8.13 smoke (refuses to run unless the page is mvilprw2)
npm run test:e2e:legacy
```
