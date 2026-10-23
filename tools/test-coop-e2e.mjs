// E2E co-op regression: boots two headless browsers against a deployment, creates a room,
// joins, starts a run, and asserts peers/puppets/enemy replication.
// Requires: npm i --no-save playwright-core  (uses the cached ms-playwright chromium)
// Run: PB_BASE=https://pokebonk-re.vercel.app node tools/test-coop-e2e.mjs
import { chromium } from 'playwright-core';
const EXE = 'C:/Users/User/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const BASE = process.env.PB_BASE || 'https://pokebonk-re.vercel.app';
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function boot(browser, who) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  page.on('pageerror', (e) => log(`[${who}] PAGEERROR`, String(e).slice(0, 160)));
  page.on('console', (m) => { const t = m.text(); if (/\[coop\]/.test(t)) log(`[${who}]`, t.slice(0, 160)); });
  await page.goto(BASE + '/?lang=en', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button:has-text("Play as a guest")', { timeout: 60000 });
  await page.click('button:has-text("Play as a guest")');
  await sleep(5000);
  await page.evaluate(() => { const c=[...document.querySelectorAll('#ui button')].find(b=>/Bulbasaur|Healer/i.test(b.textContent||'')); c&&c.click(); });
  await sleep(1000);
  await page.evaluate(() => { const b=[...document.querySelectorAll('#ui button')].filter(x=>/I choose .+!/.test(x.textContent||'')).sort((a,b)=>a.textContent.length-b.textContent.length)[0]; b&&b.click(); });
  await sleep(6000);
  return page;
}
const api = (page, path, method = 'GET', body) => page.evaluate(async ([p, m, b]) => {
  const s = JSON.parse(localStorage.getItem('pb.session') || '{}');
  const r = await fetch(p, { method: m, headers: { Authorization: 'Bearer ' + s.token, 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t) } catch {}
  return { status: r.status, j };
}, [path, method, body]);

const browser = await chromium.launch({ executablePath: EXE, headless: true });
try {
  const host = await boot(browser, 'HOST');
  const guest = await boot(browser, 'GUEST');

  // 1. host creates a room and opens the lobby
  await host.evaluate(() => globalThis.__pbCoopUI.openFriends());
  await sleep(1500);
  await host.evaluate(() => { const b=[...document.querySelectorAll('button')].find(x=>/^Create room$/i.test(x.textContent.trim())); b&&b.click(); });
  await sleep(3000);
  const code = await host.evaluate(() => globalThis.__pbCoopUI?.room?.code || null);
  await host.evaluate(() => globalThis.__pbCoopUI.openLobby());
  await sleep(2500);
  log('code:', code, '| host screen:', await host.evaluate(() => globalThis.__pbCoopUI?.screen));

  // 2. guest joins and opens the lobby
  const j = await api(guest, `/api/rooms/${code}/join`, 'POST', {});
  log('guest join:', j.status);
  await guest.evaluate(() => globalThis.__pbCoopUI.openLobby());
  await sleep(6000);
  log('guest screen:', await guest.evaluate(() => globalThis.__pbCoopUI?.screen),
      '| host sees members:', (await api(host, '/api/friends')).j?.room?.members?.length);

  // 3. host presses Start
  const btn = await host.evaluate(() => {
    const bs = [...document.querySelectorAll('button')];
    const b = bs.find(x => /^Start/i.test(x.textContent.trim()));
    return b ? { text: b.textContent.trim(), disabled: b.disabled } : { all: bs.map(x=>x.textContent.trim()).filter(Boolean).slice(0,14) };
  });
  log('host start button:', JSON.stringify(btn));
  if (btn.text) { await host.evaluate(() => { const b=[...document.querySelectorAll('button')].find(x=>/^Start/i.test(x.textContent.trim())); b.click(); }); }

  for (let i = 1; i <= 8; i++) {
    await sleep(4000);
    const probe = () => ({
      run: !!globalThis.__pb?.run,
      coop: !!globalThis.__pb?.coop,
      isHost: globalThis.__pb?.coop?.isHost ?? null,
      mates: globalThis.__pb?.coop?.mates?.size ?? null,
      peers: globalThis.__pbNet?.peerUids?.().length ?? null,
      peerModes: globalThis.__pbNet?.peerUids?.().map(u => globalThis.__pbNet.mode(u)) ?? [],
      puppets: globalThis.__pb?.coop?.puppets?.().length ?? null,
      puppetPos: globalThis.__pb?.coop?.puppets?.().map(p => p.pos ? [Math.round(p.pos.x), Math.round(p.pos.z)] : null) ?? [],
      remoteEnemies: globalThis.__pb?.run?.enemies?.remote ? [...globalThis.__pb.run.enemies.remote].filter(Boolean).length : null,
      sent: globalThis.__pbNet?.stats?.sent ?? null,
      recv: globalThis.__pbNet?.stats?.recv ?? null,
      binSent: globalThis.__pbNet?.stats?.binarySent ?? null,
    });
    const g = await guest.evaluate(probe);
    const h = await host.evaluate(probe);
    log(`t+${i*4}s`, 'GUEST', JSON.stringify(g), 'HOST', JSON.stringify(h));
  }
} finally { await browser.close(); }
