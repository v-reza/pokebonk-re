// Pull the PokéBonk client shell into ./public (offline mirror seed).
// Idempotent: existing files are kept. Query strings are dropped on save.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD, VERSION, ENTRY, INDEX } from './build-target.mjs';

const ORIGIN = 'https://pokebonk.com';
const ROOT = path.resolve('public');
const seen = new Set();
const queue = new Set();
const failed = [];
let bytes = 0;

const norm = (u) => u.replace(/^\.\//, '').replace(/\?.*$/, '').replace(/^\//, '');

export function enqueue(raw, base) {
  if (!raw) return;
  if (/^(https?:|data:|blob:|#|mailto:)/.test(raw)) return;
  let u = raw.split('?')[0].split('#')[0];
  if (!u) return;
  if (u.startsWith('./') || u.startsWith('../')) u = path.posix.join(base, u);
  u = norm(u);
  if (!u || u.endsWith('/')) return;
  if (!/^[\w./@-]+$/.test(u)) return;
  queue.add(u);
}

export async function save(u) {
  if (seen.has(u)) return;
  seen.add(u);
  const out = path.join(ROOT, u);
  if (existsSync(out)) { await scanLocal(u); return; }
  const res = await fetch(`${ORIGIN}/${u}`);
  if (!res.ok) { failed.push([u, res.status]); return; }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, buf);
  bytes += buf.length;
  await scanLocal(u, buf);
}

export async function scanLocal(u, buf) {
  if (!/\.(js|css|html|json|webmanifest)$/.test(u)) return;
  const text = buf ? buf.toString('utf8') : await readFile(path.join(ROOT, u), 'utf8').catch(() => '');
  if (!text) return;
  const base = path.posix.dirname(u);
  if (/\.js$/.test(u)) {
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) enqueue(m[1], base);
    for (const m of text.matchAll(/["'](\.\/[\w.-]+\.(?:js|css|json|woff2|png|glb|ogg))["']/g)) enqueue(m[1], base);
    // __vite__mapDeps list
    for (const m of text.matchAll(/"(\.\/[\w.-]+\.(?:js|css))"/g)) enqueue(m[1], base);
  } else if (/\.css$/.test(u)) {
    for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) enqueue(m[1], base);
  } else if (/\.html$/.test(u)) {
    for (const m of text.matchAll(/(?:src|href)="([^"]+)"/g)) enqueue(m[1], base);
  } else if (/\.webmanifest$/.test(u)) {
    for (const m of text.matchAll(/"src"\s*:\s*"([^"]+)"/g)) enqueue(m[1], base);
  }
}

export async function drain() {
  while (queue.size) {
    const batch = [...queue].splice(0, 24);
    batch.forEach((u) => queue.delete(u));
    await Promise.all(batch.map(async (u) => {
      try { await save(u); } catch (e) { failed.push([u, String(e.message || e)]); }
    }));
  }
}

export async function main(options = {}) {
  const isDryRun = options.dryRun ?? (
    process.argv.includes('--dry-run') ||
    process.env.npm_config_dry_run === 'true' ||
    Boolean(process.env.PB_DRY_RUN)
  );

  // seeds
  [
    INDEX,
    'index.html',
    `assets/${ENTRY}`,
    'manifest.webmanifest',
    'favicon.ico',
    'version.json',
    'creditos.txt',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/favicon-96.png',
    'icons/apple-touch-icon.png',
    'data/pokemon.json',
    'data/moves.json',
    'data/learnsets.json',
    'data/abilities.json',
    'data/types.json',
    'data/items.json',
    'data/sprites.json',
    ...['es', 'en', 'pt', 'fr', 'ja', 'zh', 'zht', 'ko', 'ru'].map((l) => `data/i18n/${l}.json`),
  ].forEach((u) => enqueue(u, '.'));

  if (isDryRun) {
    console.log(`[pull] (dry-run) Target build: ${BUILD} (v${VERSION})`);
    console.log(`[pull] (dry-run) Entry chunk: assets/${ENTRY}`);
    console.log(`[pull] (dry-run) Index: ${INDEX}`);
    console.log(`[pull] (dry-run) Seed queue has ${queue.size} items. No network or write operations performed.`);
    return { queue: [...queue], dryRun: true };
  }

  await drain();
  console.log(`shell: ${seen.size} files, ${(bytes / 1048576).toFixed(1)} MiB, ${failed.length} failed`);
  if (failed.length) console.log(failed.slice(0, 20));
  await writeFile('mirror-report.json', JSON.stringify({ files: [...seen], failed }, null, 1));
}

const isDirectExecution = Boolean(process.argv[1] && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase());
if (isDirectExecution) {
  main().catch((err) => {
    console.error('[pull] FATAL:', err.message || err);
    process.exit(1);
  });
}
