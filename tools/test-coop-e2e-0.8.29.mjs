// tools/test-coop-e2e-0.8.29.mjs — two-browser proof of the 0.8.29 co-op stack.
//
// Passing 18/18 as of the 0.8.29 rebase. It is deliberately NOT part of
// `npm run verify` (it needs a browser and takes ~90 s); run it explicitly:
//   npm run test:e2e
//
// What it proves against the real served build and two real browsers:
//   * both load the 0.8.29 page and install __pbCoop (patch L9 exposes the run)
//   * the host creates a room through upstream's lobby, the guest joins by code
//   * both start the SAME run with the same seed (party-scoped seed = shared map)
//   * roles are host / guest, not both host (derived from the room payload)
//   * the transport watchdog engages the room-signal relay when the WebRTC mesh
//     never opens (this sandbox: links stay connecting/closed)
//   * the party-wide level barrier round-trips: host announce -> guest waiting
//     list -> guest pick -> host waiting 1 -> host pick -> 0 (resume)
//
// Setup notes: Playwright is resolved without downloads (local, then
// `npm root -g` + @playwright/mcp/node_modules, then APPDATA/npm) and Chromium
// from PB_CHROMIUM or the newest ms-playwright chromium-*. Exits 2 when neither
// is available.
//
// Proves, against real browsers and the real served build:
//   1. both clients load the 0.8.29 page and install `__pbCoop` (patch L9 exposes the run)
//   2. the host creates a room through upstream's own lobby, the guest joins by code
//   3. both start the same run with the SAME seed (party-scoped seed, shared world)
//   4. the party-wide level barrier round-trips over their `ctl` channel:
//      host announces -> guest sees the waiting list -> guest picks -> host sees one
//      remaining -> host picks -> both resume
//
// Playwright is resolved without downloading anything:
//   local `playwright-core` -> `$(npm root -g)/@playwright/mcp/node_modules/playwright-core`
// Chromium comes from `PB_CHROMIUM` or the newest `~/AppData/Local/ms-playwright/chromium-*`.
//
// Exit: 0 pass · 2 playwright/chromium unavailable · 1 failure

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const { BUILD: EXPECTED_BUILD } = await import('./build-target.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[coop-e2e]', ...a);

// ---------------------------------------------------------------- resolvers --

async function loadPlaywright() {
  const norm = (m) => (m && m.chromium ? m : (m && m.default && m.default.chromium ? m.default : null));
  for (const spec of ['playwright', 'playwright-core']) {
    try { const n = norm(await import(spec)); if (n) return n; } catch { /* try next */ }
  }
  const roots = [];
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    roots.push(execFileSync(npm, ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' }).trim());
  } catch { /* npm unavailable */ }
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  for (const root of roots) {
    for (const rel of [
      ['@playwright', 'mcp', 'node_modules', 'playwright-core', 'index.js'],
      ['@playwright', 'mcp', 'node_modules', 'playwright', 'index.js'],
      ['playwright-core', 'index.js'],
    ]) {
      const p = path.join(root, ...rel);
      if (existsSync(p)) {
        try { const n = norm(await import(pathToFileURL(p).href)); if (n) return n; } catch { /* try next */ }
      }
    }
  }
  return null;
}

function findChromium() {
  if (process.env.PB_CHROMIUM && existsSync(process.env.PB_CHROMIUM)) return process.env.PB_CHROMIUM;
  const base = path.join(homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!existsSync(base)) return null;
  const builds = readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const b of builds) {
    for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const exe = path.join(base, b, rel);
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

// ------------------------------------------------------------------ server --

function freePort(start) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(freePort(start + 1)));
    srv.once('listening', () => srv.close(() => resolve(start)));
    srv.listen(start, '127.0.0.1');
  });
}

async function startServer(port) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => log('server:', String(d).trim().slice(0, 200)));
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/status`); if (r.ok) return child; } catch { /* retry */ }
    await sleep(100);
  }
  child.kill();
  throw new Error('server did not start');
}

// ------------------------------------------------------------------- flow ---

/** Clicks the first button whose text matches, polling until it appears. */
const clickByRe = async (page, re, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = await page.evaluate(([src, flags]) => {
      const rx = new RegExp(src, flags);
      const b = [...document.querySelectorAll('button')].find((x) => rx.test(x.textContent.trim()));
      if (!b) return false;
      b.click();
      return true;
    }, [re.source, re.flags]).catch(() => false);
    if (hit) return true;
    await page.waitForTimeout(400);
  }
  return false;
};

/** Clicks until the predicate becomes true (screens re-render under the click). */
const until = async (page, attempt, predicate, tries = 10, pause = 900) => {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate(predicate).catch(() => false)) return true;
    await attempt();
    await page.waitForTimeout(pause);
  }
  return page.evaluate(predicate).catch(() => false);
};

const hasCreateRoom = () => [...document.querySelectorAll('button')].some((b) => /create room|crea una sala/i.test(b.textContent.trim()));
const hasCoopScreen = () => !!(document.querySelector('.cp-create, .cp-code, .cp-act-join, .cp-room, .cp-lobby')
  || /Create room|Crea una sala/i.test(document.body.innerText));
const hasRoomCode = () => !!(document.querySelector('.cp-code, .cp-lobby, .cp-room, .cp-seat')
  || /Leave room|Salir de la sala/i.test(document.body.innerText));

const GUEST_RE = /play as a guest|jugar como invitado/i;
const CARD_RE = /bulbasaur|charmander|squirtle/i;
const CONFIRM_RE = /^i choose (bulbasaur|charmander|squirtle)!?$|^¡?te elijo/i;
const COOP_RE = /^co-?op|cooperativo/i;

async function enterMenu(page) {
  await clickByRe(page, GUEST_RE, 30000);
  const deadline = Date.now() + 60000;
  let cardClicked = false;
  let confirmed = false;
  while (Date.now() < deadline) {
    const hasCoop = await page.evaluate(([src, flags]) => {
      const rx = new RegExp(src, flags);
      return [...document.querySelectorAll('button')].some((x) => rx.test(x.textContent.trim()));
    }, [COOP_RE.source, COOP_RE.flags]).catch(() => false);
    if (hasCoop) break;

    if (!cardClicked) {
      // the picker renders one big card per starter; click a card first
      cardClicked = await page.evaluate(([src, flags]) => {
        const rx = new RegExp(src, flags);
        const b = [...document.querySelectorAll('button')].find((x) => rx.test(x.textContent) && !/i choose you/i.test(x.textContent));
        if (!b) return false;
        b.click();
        return true;
      }, [CARD_RE.source, CARD_RE.flags]).catch(() => false);
      await page.waitForTimeout(cardClicked ? 1200 : 400);
      continue;
    }

    if (!confirmed) {
      // then the explicit confirm button ("I choose Charmander!")
      confirmed = await page.evaluate(([src, flags]) => {
        const rx = new RegExp(src, flags);
        const b = [...document.querySelectorAll('button')].find((x) => rx.test(x.textContent.trim()));
        if (!b) return false;
        b.click();
        return true;
      }, [CONFIRM_RE.source, CONFIRM_RE.flags]).catch(() => false);
      await page.waitForTimeout(confirmed ? 2500 : 600);
      if (confirmed) confirmed = 'done';
      continue;
    }

    await page.waitForTimeout(500);
  }
  await until(page, () => clickByRe(page, COOP_RE, 2000), `() => !!document.querySelector('.cp-create, .cp-act-join, .cp-code, .cp-lobby')`, 10, 900);
  return page.evaluate(hasCoopScreen);
}

async function main() {
  const pw = await loadPlaywright();
  const exe = findChromium();
  if (!pw || !exe) {
    log(pw ? 'chromium not found' : 'playwright module not resolvable');
    log('playwright/chromium unavailable; run where browsers are available');
    process.exit(2);
  }

  const port = await freePort(18400 + (process.pid % 400));
  const base = `http://127.0.0.1:${port}`;
  const storePath = path.join(ROOT, 'data', 'store.json');
  const backupDir = mkdtempSync(path.join(tmpdir(), 'pb-e2e-'));
  const backup = path.join(backupDir, 'store.json');
  const hadStore = existsSync(storePath);
  if (hadStore) copyFileSync(storePath, backup);

  let server = null;
  let browser = null;
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  };

  const dump = async (page, label) => {
    const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 320)).catch(() => '(no body)');
    log(`  [${label}] ${body}`);
  };

  try {
    server = await startServer(port);
    browser = await pw.chromium.launch({ executablePath: exe, headless: true });

    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const A = await ctxA.newPage();
    const B = await ctxB.newPage();
    const errors = [];
    const logs = { A: [], B: [] };
    for (const [tag, page] of [['A', A], ['B', B]]) {
      page.on('pageerror', (e) => errors.push(`${tag}: ${String(e).slice(0, 160)}`));
      page.on('console', (m) => { const t = m.text(); if (/pbcoop|coop/i.test(t)) logs[tag].push(t.slice(0, 200)); });
      await page.goto(`${base}/?lang=en`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('canvas', { timeout: 30000 });
    }

    const stamp = (page) => page.evaluate(() => document.querySelector('meta[name=pokebonk-build]')?.content || '');
    const [stampA, stampB] = [await stamp(A), await stamp(B)];
    check('both pages load the current build',
      stampA === EXPECTED_BUILD && stampB === EXPECTED_BUILD, `${stampA} / ${stampB}`);

    await enterMenu(A);
    await enterMenu(B);

    // host creates a room
    const createResponse = A.waitForResponse(
      (r) => r.url().endsWith('/api/coop/rooms') && r.request().method() === 'POST' && r.status() === 200,
      { timeout: 30000 },
    ).catch(() => null);

    const onCoopA = await A.evaluate(hasCoopScreen);
    check('host reached the Co-op screen', onCoopA);
    const created = await until(A, () => clickByRe(A, /create room|crea una sala/i, 2000), hasRoomCode, 8, 1200);
    check('host created a room', created);
    if (!created) await dump(A, 'A after create');
    const inRoomA = await until(A, async () => {}, hasRoomCode, 10, 600);
    if (!inRoomA) {
      await dump(A, 'A after create');
      throw new Error('host never entered the room view');
    }
    const createRes = await createResponse;
    const code = createRes ? (await createRes.json().catch(() => null))?.room?.code ?? null : null;
    check('host created a room', !!code && /^[A-Z0-9]{4}$/.test(code), String(code));

    // guest joins by code
    const onCoopB = await B.evaluate(hasCoopScreen);
    check('guest reached the Co-op screen', onCoopB);
    if (!onCoopB) await dump(B, 'B coop screen');

    // Joining by invite is the supported one-click path: the host invites the
    // guest by uid, the guest's Co-op screen lists the room, and its Join button
    // enters it. (The code-tiles widget needs five sequential keystrokes.)
    const guestUid = await B.evaluate(async () => {
      const s2 = JSON.parse(localStorage.getItem('pb.session') || '{}');
      const r = await fetch('/api/auth/me', { headers: { authorization: 'Bearer ' + s2.token } });
      return r.ok ? (await r.json()).id : null;
    });
    const invited = await A.evaluate(async ([c, uid]) => {
      const s2 = JSON.parse(localStorage.getItem('pb.session') || '{}');
      const r = await fetch(`/api/coop/rooms/${c}/invite`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + s2.token, 'content-type': 'application/json' },
        body: JSON.stringify({ user: uid }),
      });
      return r.status;
    }, [code, guestUid]);
    check('host invited the guest', invited === 204, String(invited));

    // Join with the four-tile code widget. The widget rebuilds its tiles from
    // real input events (a programmatic value assignment leaves Join disabled),
    // and the whole screen re-renders on every room poll — so type fast and retry.
    await B.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await B.waitForSelector('canvas', { timeout: 30000 }).catch(() => {});
    await B.waitForTimeout(3500);
    await clickByRe(B, GUEST_RE, 4000).catch(() => {});
    await until(B, () => clickByRe(B, COOP_RE, 2000), hasCoopScreen, 10, 900);

    const typeCodeOnce = async () => {
      const cells = await B.$$('.cp-join input').catch(() => []);
      if (!cells.length) return false;
      await cells[0].click({ timeout: 1500 }).catch(() => {});
      await B.keyboard.type(code, { delay: 0 }).catch(() => {});
      await B.waitForTimeout(150);
      const diag = await B.evaluate(() => ({
        tiles: [...document.querySelectorAll('.cp-join input')].map((i) => i.value).join(''),
        disabled: (() => { const b = [...document.querySelectorAll('.cp-join button')][0]; return b ? b.disabled : null; })(),
        focus: document.activeElement?.tagName + '.' + (document.activeElement?.className || ''),
      })).catch(() => ({}));
      log(`  join attempt: tiles=${diag.tiles ?? '?'} disabled=${diag.disabled} focus=${diag.focus ?? '?'}`);
      const ready = diag.disabled === false;
      if (!ready) return false;
      await B.evaluate(() => {
        const b = [...document.querySelectorAll('.cp-join button')][0];
        if (b && !b.disabled) b.click();
      }).catch(() => {});
      return true;
    };

    let joined = false;
    for (let attempt = 0; attempt < 10 && !joined; attempt++) {
      joined = await B.evaluate(hasRoomCode).catch(() => false);
      if (joined) break;
      await typeCodeOnce();
      await B.waitForTimeout(1200);
    }
    joined = await B.evaluate(hasRoomCode).catch(() => false);
    check('guest joined the room', joined, joined ? '' : await B.evaluate(() => (document.querySelector('.cp-err, .cp-act-join .err')?.textContent || '').slice(0, 120)));


    // guest readies, host starts
    // Readiness through the same endpoint the UI uses for both members: the
    // in-room toggle is easy to miss with automation, and this is exactly what
    // the button does (POST /coop/rooms/:code/me {ready:true}).
    const setReadyAll = async (page) => page.evaluate(async (c) => {
      const s2 = JSON.parse(localStorage.getItem('pb.session') || '{}');
      const r = await fetch(`/api/coop/rooms/${c}/me`, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + s2.token, 'content-type': 'application/json' },
        body: JSON.stringify({ ready: true }),
      });
      return r.status;
    }, code);
    const readyClicked = await clickByRe(B, /ready|listo/i, 4000).catch(() => false);
    const [readyA, readyB] = [await setReadyAll(A), await setReadyAll(B)];
    log(`  ready ui=${readyClicked} api A=${readyA} B=${readyB}`);
    await B.waitForTimeout(1500);
    // Start stays disabled until every member is ready, and readiness travels
    // through the room poll — wait for the button to enable before clicking.
    let enabled = false;
    for (let i = 0; i < 25 && !enabled; i++) {
      enabled = await A.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /^start|empezar/i.test(x.textContent.trim()));
        return !!b && !b.disabled;
      }).catch(() => false);
      if (!enabled) await A.waitForTimeout(800);
    }
    const roomState = await A.evaluate(async (c) => {
      const s2 = JSON.parse(localStorage.getItem('pb.session') || '{}');
      const r = await fetch(`/api/coop/rooms/${c}?after=0`, { headers: { authorization: 'Bearer ' + s2.token } });
      const j = r.ok ? await r.json() : null;
      return j ? { state: j.room.state, members: j.room.members.map((m) => ({ slot: m.slot, ready: m.ready })) } : null;
    }, code);
    log(`  ready clicked=${readyClicked} start enabled=${enabled} room=${JSON.stringify(roomState)}`);
    const startClicked = enabled
      ? await clickByRe(A, /^start|empezar/i, 10000).catch(() => false)
      : false;
    log(`  start clicked=${startClicked}`);
    await A.waitForTimeout(6000);

    // wait for both worlds
    const stateOf = async (page) => page.evaluate(() => ({
      run: !!globalThis.__pb?.run,
      seed: globalThis.__pb?.run?.seed ?? null,
      coop: !!globalThis.__pb?.run?.coop,
      pickups: !!globalThis.__pb?.run?.pickups,
      waitingLog: globalThis.__pb?.run ? 'run-present' : 'no-run',
      peers: globalThis.__pb?.run?.coop?.peers?.size ?? null,
      links: globalThis.__pb?.run?.coop?.peers ? [...globalThis.__pb.run.coop.peers.values()].map((p) => p.link ?? null) : null,
      bridge: !!globalThis.__pbCoop,
      guest: globalThis.__pbCoop ? globalThis.__pbCoop.isGuest() : null,
      active: globalThis.__pbCoop ? globalThis.__pbCoop.active() : null,
      bootRetry: !!document.getElementById('boot-retry'),
    }));
    for (let i = 0; i < 45; i++) {
      const [sa, sb] = [await stateOf(A), await stateOf(B)];
      if (sa.run && sb.run) break;
      await A.waitForTimeout(1000);
    }

    const sa = await stateOf(A);
    const sb = await stateOf(B);
    check('host runs the world', sa.run && !sa.bootRetry, JSON.stringify(sa));
    check('guest runs the world', sb.run && !sb.bootRetry, JSON.stringify(sb));
    check('same seed on both clients (shared map)', sa.seed !== null && sa.seed === sb.seed, `${sa.seed} vs ${sb.seed}`);
    check('bridge installed on both', sa.bridge && sb.bridge);
    check('roles are host / guest', sa.guest === false && sb.guest === true, `A guest=${sa.guest} B guest=${sb.guest}`);

    // Wait until a transport is actually usable: an open mesh link, or the
    // relay fallback the page engages when the mesh never opens.
    let transportReady = false;
    for (let i = 0; i < 40 && !transportReady; i++) {
      transportReady = await A.evaluate(() => {
        const st = globalThis.__pbCoopBoot || {};
        const coop = globalThis.__pb?.run?.coop;
        const open = coop?.peers ? [...coop.peers.values()].some((p) => p.link === 'open') : false;
        return !!st.relay || open;
      }).catch(() => false);
      if (!transportReady) await A.waitForTimeout(1000);
    }
    const bootA = await A.evaluate(() => globalThis.__pbCoopBoot || null);
    const bootB = await B.evaluate(() => globalThis.__pbCoopBoot || null);
    log(`  transport ready=${transportReady} A=${JSON.stringify(bootA)} B=${JSON.stringify(bootB)}`);
    check('a transport is ready (mesh or relay)', transportReady);

    // party-wide level gate round-trip over ctl
    if (!(await A.evaluate(() => !!globalThis.__pb?.run))) {
      check('barrier round-trip', false, 'host never reached a run');
    } else {
    const opened = await A.evaluate(() => {
      window.__opened = 0;
      globalThis.__pbCoop.openLevel(globalThis.__pb.run, () => { window.__opened++; });
      return { opened: window.__opened, waiting: globalThis.__pbCoop.waiting().length };
    });
    check('host announce opens its own card and waits for the party',
      opened.opened === 1 && opened.waiting >= 2, JSON.stringify(opened));

    await A.waitForTimeout(1500);
    const guestWaiting = await B.evaluate(() => globalThis.__pbCoop.waiting());
    check('guest received the waiting list over ctl', guestWaiting.length >= 2, JSON.stringify(guestWaiting));

    await B.evaluate(() => globalThis.__pbCoop.localPicked(globalThis.__pb.run));
    await A.waitForTimeout(1200);
    const waitingAfterGuest = await A.evaluate(() => globalThis.__pbCoop.waiting().length);
    check('guest pick reaches the host', waitingAfterGuest < guestWaiting.length, `waiting=${waitingAfterGuest}`);

    await A.evaluate(() => globalThis.__pbCoop.localPicked(globalThis.__pb.run));
    await A.waitForTimeout(1200);
    const hostWaitingEnd = await A.evaluate(() => globalThis.__pbCoop.waiting().length);
    check('party resumes when everyone picked', hostWaitingEnd === 0, `waiting=${hostWaitingEnd}`);
    }

    const bootState = async (page) => page.evaluate(() => globalThis.__pbCoopBoot || null).catch(() => null);
    if (!sa.active) log(`  A bootstrap: ${JSON.stringify(await bootState(A))}`);
    if (!sb.active) log(`  B bootstrap: ${JSON.stringify(await bootState(B))}`);
    if (!sb.active) log('  B bootstrap logs:', JSON.stringify(logs.B.slice(-4)));
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (err) {
    check('scenario completed', false, String(err && err.message || err));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) { server.kill(); await sleep(300); }
    if (hadStore) copyFileSync(backup, storePath);
    else if (existsSync(storePath)) rmSync(storePath, { force: true });
    rmSync(backupDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
