// Probe-and-mirror the asset families that are addressed by name at runtime.
// Each candidate is fetched once; hits are written under ./public, misses are reported.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://pokebonk.com';
const ROOT = path.resolve('public');
const CONCURRENCY = 16;
const hits = [];
const misses = [];

const models = JSON.parse(await readFile('../pokebonk-re/models.json', 'utf8'));
const avatars = JSON.parse(await readFile('../pokebonk-re/avatars.json', 'utf8'));
const items = JSON.parse(await readFile('../pokebonk-re/mirror/data/items.json', 'utf8'));
const sprites = JSON.parse(await readFile('../pokebonk-re/mirror/data/sprites.json', 'utf8'));

const TYPES = ['normal', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];
const ICONS = ['aim', 'banish', 'blessing', 'brush', 'bug', 'champion', 'chat', 'check', 'clan', 'coin', 'crown', 'dash', 'egg', 'friend-add', 'friends', 'fullscreen', 'globe', 'gold', 'idea', 'invite', 'jump', 'leave', 'lock', 'mail', 'maldicion', 'map-bill', 'map-boss', 'map-challenge', 'map-portal', 'map-shrine', 'megaphone', 'mission', 'news', 'ofrenda', 'pause', 'pin', 'r-gg', 'r-lol', 'r-love', 'r-fire', 'r-star', 'r-wow', 'record', 'request', 'reroll', 'research', 'rival', 'send', 'shiny-charm', 'skip', 'stardust', 'streak', 'target', 'torre', 'unlock', 'vela', 'rotate', 'poke-ball', 'rare-candy', 'star-piece', 'timer', 'skull', 'flame'];
const RANKS = ['top100', 'top50', 'top25', 'top10', 'elite', 'master'];
const FRAMES = ['dex', 'master', 'mon-ace', 'mon-master', 'top100', 'top50', 'top25', 'top10', 'elite', 'candle', 'spectral', 'tower', 'pioneer', 'berries', 'waves', ...TYPES.map((t) => `type-${t}`)];
const BIOMES = ['common', 'coast', 'desert', 'forest', 'frostlake', 'glacier', 'graveyard', 'ruins', 'sanctum', 'stormcape', 'tower', 'volcano'];
const MUSIC = ['menu', 'halloween-menu', 'ingame1', 'ingame2', 'ingame3', 'ingame4', 'boss'];

const cands = new Set();
const add = (p) => cands.add(p);

for (const m of models) add(`assets/models/${m}.glb`);
for (const m of ['bill', 'billpc', 'tower', 'menu', 'pokeball', 'altar', 'chest', 'egg']) add(`assets/models/${m}.glb`);
for (const t of TYPES) add(`assets/ui/types/${t}.png`);
for (const i of ICONS) add(`assets/ui/icons/${i}.png`);
for (const r of RANKS) add(`assets/ui/ranks/${r}.png`);
for (const f of FRAMES) add(`assets/ui/frames/${f}.png`);
for (const a of avatars) add(`assets/ui/avatars/${a}.png`);
for (const b of BIOMES) for (const f of ['atlas.json', 'atlas.png', 'ground.png', 'cliff.png', 'path.png', 'hazards.png']) add(`assets/env/${b}/${f}`);
for (const m of MUSIC) add(`assets/music/${m}.ogg`);
for (const k of Object.keys(items)) add(`assets/items/${k}.png`);
for (const k of ['paralyze-heal', 'fairy-feather', 'antidote', 'poke-ball', 'rare-candy', 'star-piece', 'oran-berry', 'magnet', 'nugget', 'big-nugget', 'comet-shard', 'repel', 'tm-normal', 'tm-fighting', 'tm-psychic', 'tm-steel', 'tm-electric']) add(`assets/items/${k}.png`);
for (const e of ['tower.jpg', 'tower-card.jpg', 'tower-banner.jpg']) add(`assets/ui/events/${e}`);
for (const id of Object.keys(sprites)) {
  add(`assets/pmd/${id}.png`);
  add(`assets/portraits/${id}.png`);
  add(`assets/icons/${id}.png`);
  add(`assets/front/${id}.png`);
  add(`assets/cries/${id}.ogg`);
}
for (let i = 1; i <= 1025; i++) {
  add(`assets/cries/${i}.ogg`);
  add(`assets/pmd/${i}.png`);
  add(`assets/icons/${i}.png`);
  add(`assets/portraits/${i}.png`);
  add(`assets/front/${i}.png`);
}

const list = [...cands];
let idx = 0;

async function one(p) {
  const out = path.join(ROOT, p);
  if (existsSync(out)) { hits.push(p); return; }
  try {
    const res = await fetch(`${ORIGIN}/${p}`);
    if (!res.ok) { misses.push([p, res.status]); return; }
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, buf);
    hits.push(p);
  } catch (e) { misses.push([p, String(e.message || e)]); }
}

await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (idx < list.length) await one(list[idx++]);
}));

console.log(`probe: ${hits.length} hit, ${misses.length} miss, of ${list.length}`);
const byDir = {};
for (const [p, s] of misses) { const d = p.split('/').slice(0, 3).join('/'); byDir[d] = (byDir[d] || 0) + 1; }
console.log(byDir);
await writeFile('probe-report.json', JSON.stringify({ hits, misses }, null, 1));
