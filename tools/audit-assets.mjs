// tools/audit-assets.mjs — check that every static asset the client can ask for
// is actually served by a deployment.
//
// WHY THE THROTTLE MATTERS: hammering a Vercel deployment with a few thousand
// rapid requests trips its firewall (responses come back 403 with
// `X-Vercel-Mitigated: deny`, and then *every* path from that IP is denied for a
// while, including images and the API). That looks exactly like "some images
// could not load". This tool therefore defaults to a small concurrency with a
// delay, and reports the mitigation header explicitly instead of blaming the
// assets.
//
// Usage:
//   node tools/audit-assets.mjs [baseUrl] [--concurrency 4] [--delay 40] [--limit N]
//   node tools/audit-assets.mjs https://pokebonk-re.vercel.app --concurrency 2

import { readdirSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};
const baseUrl = (args.find((a) => /^https?:\/\//.test(a)) || 'https://pokebonk-re.vercel.app').replace(/\/$/, '');
const concurrency = Math.max(1, opt('--concurrency', 4));
const delayMs = Math.max(0, opt('--delay', 40));
const limit = opt('--limit', 0);

const ROOT = path.resolve(import.meta.dirname, '..');
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (/\.(png|webp|jpe?g|svg|ico|woff2?|json|webmanifest)$/i.test(e.name)) out.push(f);
  }
  return out;
};

let files = walk(path.join(ROOT, 'public'))
  .map((f) => '/' + path.relative(path.join(ROOT, 'public'), f).split(path.sep).join('/'));
if (limit) files = files.slice(0, limit);

console.log(`[audit] ${files.length} assets against ${baseUrl} (concurrency ${concurrency}, ${delayMs}ms gap)`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let i = 0;
const bad = [];
let mitigated = 0;
let done = 0;

const worker = async () => {
  while (i < files.length) {
    const f = files[i++];
    try {
      const r = await fetch(baseUrl + f, { method: 'GET', headers: { range: 'bytes=0-0' } });
      if (r.status >= 400) {
        if (r.headers.get('x-vercel-mitigated')) mitigated++;
        bad.push(`${r.status} ${f}`);
      }
    } catch (e) {
      bad.push(`ERR ${f} ${e.message || ''}`);
    }
    if (++done % 250 === 0) console.log(`[audit] ${done}/${files.length}`);
    if (delayMs) await sleep(delayMs);
  }
};

await Promise.all(Array.from({ length: concurrency }, worker));

console.log(`[audit] checked ${files.length} | failures ${bad.length}${mitigated ? ` | ${mitigated} denied by the edge firewall` : ''}`);
if (mitigated) {
  console.log('[audit] the deployment is rate-limiting this IP (X-Vercel-Mitigated: deny).');
  console.log('[audit] that is an infrastructure response, not a missing file — wait for it to clear');
  console.log('[audit] and re-run with a lower --concurrency.');
}
console.log(bad.slice(0, 25).join('\n'));
process.exit(bad.length ? 1 : 0);
