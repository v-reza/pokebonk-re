import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://pokebonk.com';
const ROOT = path.resolve('public');
const CONCURRENCY = 12;

const queue = new Set();
const seen = new Set();
const failed = [];
let ok = 0, bytes = 0;

function add(u) {
  if (!u) return;
  const clean = u.replace(/^\.\//, '').replace(/\?.*$/, '');
  if (!clean || clean.startsWith('http') || clean.startsWith('blob:') || clean.startsWith('data:')) return;
  if (!/^[\w./@-]+$/.test(clean)) return;
  queue.add(clean);
}

async function download(rel) {
  const out = path.join(ROOT, rel);
  if (existsSync(out)) { seen.add(rel); return; }
  const res = await fetch(`${ORIGIN}/${rel}`);
  if (!res.ok) { failed.push([rel, res.status]); return; }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, buf);
  ok++; bytes += buf.length;
  seen.add(rel);
  if (/\.(js|css)$/.test(rel)) scanText(buf.toString('utf8'), path.posix.dirname(rel));
  if (/\.json$/.test(rel)) scanJson(buf.toString('utf8'), path.posix.dirname(rel));
}

function scanText(s, dir) {
  for (const m of s.matchAll(/["'`](\.{0,2}\/?[\w./@-]+\.(?:js|css|png|glb|ogg|woff2|json))["'`]/g)) {
    let p = m[1];
    if (p.startsWith('http')) continue;
    if (p.startsWith('./') || p.startsWith('../')) p = path.posix.join(dir, p);
    else p = p.replace(/^\//, '');
    add(p);
  }
}

function scanJson(s, dir) {
  for (const m of s.matchAll(/"([\w./@-]+\.(?:png|glb|ogg|json|jpg))"/g)) {
    let p = m[1];
    if (p.startsWith('http')) continue;
    p = p.replace(/^\//, '');
    if (!p.includes('/')) p = path.posix.join(dir, p);
    add(p);
  }
}

async function worker() {
  while (queue.size) {
    const batch = [...queue].slice(0, 40);
    batch.forEach((x) => queue.delete(x));
    await Promise.all(batch.map(async (rel) => {
      try { await download(rel); } catch (e) { failed.push([rel, String(e.message || e)]); }
    }));
    if (ok % 200 < 40) console.log(`ok=${ok} queued=${queue.size} failed=${failed.length}`);
  }
}

const data = JSON.parse(await readFile('../pokebonk-re/mirror/data/sprites.json', 'utf8').catch(() => '{}'));
const items = JSON.parse(await readFile('../pokebonk-re/mirror/data/items.json', 'utf8').catch(() => '{}'));

// seed
[
  'index.html', 'manifest.webmanifest', 'favicon.ico', 'version.json', 'creditos.txt',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-96.png', 'icons/apple-touch-icon.png',
  'assets/main-BcyzVqXo-mvilprw2.js',
  'assets/modulepreload-polyfill-P2Xu9kJm-mvilprw2.js',
  'assets/i18n-Bjw6RPm7-mvilprw2.js',
].forEach(add);

for (const f of ['pokemon', 'moves', 'learnsets', 'abilities', 'types', 'items', 'sprites']) add(`data/${f}.json`);
for (const l of ['es', 'en', 'pt', 'fr', 'ja', 'zh', 'zht', 'ko', 'ru']) add(`data/i18n/${l}.json`);

const biomes = ['common', 'coast', 'desert', 'forest', 'frostlake', 'glacier', 'graveyard', 'ruins', 'sanctum', 'stormcape', 'tower', 'volcano'];
for (const b of biomes) {
  add(`assets/env/${b}/atlas.json`);
  add(`assets/env/${b}/atlas.png`);
  add(`assets/env/${b}/ground.png`);
  add(`assets/env/${b}/cliff.png`);
  add(`assets/env/${b}/path.png`);
}

for (const id of Object.keys(data)) {
  add(`assets/pmd/${id}.png`);
  add(`assets/portraits/${id}.png`);
  add(`assets/icons/${id}.png`);
}
for (let id = 1; id <= 1025; id++) add(`assets/cries/${id}.ogg`);
for (const k of Object.keys(items)) add(`assets/items/${k}.png`);
for (let i = 1; i <= 4; i++) add(`assets/music/ingame${i}.ogg`);
add('assets/music/boss.ogg');
add('assets/music/halloween-menu.ogg');

await mkdir(ROOT, { recursive: true });
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`done ok=${ok} bytes=${bytes} failed=${failed.length}`);
await writeFile('mirror-report.json', JSON.stringify({ ok, bytes, failed }, null, 1));
