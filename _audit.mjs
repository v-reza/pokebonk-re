import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://pokebonk-re.vercel.app';

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (/\.(png|webp|jpe?g|svg)$/i.test(e.name)) out.push(f);
  }
  return out;
};

const files = walk('public').map((f) => '/' + f.split(path.sep).join('/').replace(/^public\//, ''));
console.log('images:', files.length, '| sample:', files.slice(0, 3).join(' '));

let i = 0;
const bad = [];
let done = 0;
const worker = async () => {
  while (i < files.length) {
    const f = files[i++];
    try {
      const r = await fetch(BASE + f, { method: 'HEAD' });
      if (r.status !== 200) bad.push(`${r.status} ${f}`);
    } catch {
      bad.push(`ERR ${f}`);
    }
    if (++done % 1000 === 0) console.log('checked', done);
  }
};
await Promise.all(Array.from({ length: 25 }, worker));
console.log('checked', files.length, '| failures:', bad.length);
console.log(bad.slice(0, 15).join('\n'));
