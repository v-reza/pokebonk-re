// LEGACY 0.8.13 harness — targets public/index-0.8.13.html
//
// The 0.8.13 client is frozen: it is kept only for reference and for the legacy
// signalling tests. This script refuses to run against anything else, then does a
// minimal smoke of the legacy bridge (`__pbStartCoop`, `signaling-local.mjs`,
// `__pbMakePuppets`) without driving the old lobby flow (that flow needs the
// legacy co-op UI which the 0.8.29 default page replaces).
//
// Usage:  node tools/test-coop-e2e.mjs [base-url]
//         PB_BASE=http://127.0.0.1:8199 node tools/test-coop-e2e.mjs
// Exit:   0 ok · 2 not a 0.8.13 build · 1 failure

const BASE = (process.argv[2] || process.env.PB_BASE || 'http://127.0.0.1:8199').replace(/\/$/, '');
const LEGACY_PATH = '/index-0.8.13.html';

const log = (...a) => console.log('[legacy-e2e]', ...a);

async function fetchText(pathname) {
  const r = await fetch(BASE + pathname).catch(() => null);
  return r && r.ok ? r.text() : null;
}

async function main() {
  const html = await fetchText(LEGACY_PATH);
  if (!html) {
    log(`cannot read ${BASE}${LEGACY_PATH}`);
    process.exit(1);
  }

  const build = html.match(/meta\s+name=["']pokebonk-build["']\s+content=["']([^"']+)["']/i)?.[1] || null;
  if (build !== 'mvilprw2') {
    log(`build at ${LEGACY_PATH} is ${build ?? 'unknown'}, not 0.8.13 (mvilprw2)`);
    log('legacy harness: build is not 0.8.13, refusing to run');
    process.exit(2);
  }

  const checks = [
    ['legacy bridge entry', /__pbStartCoop/],
    ['legacy signalling', /signaling-local\.mjs/],
    ['legacy puppet factory', /__pbMakePuppets/],
    ['legacy entry chunk', /main-BcyzVqXo-mvilprw2\.js/],
  ];

  let failed = 0;
  for (const [name, re] of checks) {
    const ok = re.test(html);
    log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) failed++;
  }

  const bundle = await fetchText('/assets/main-D5OUVqGK-mvilprw2.js');
  const patched = !!bundle && /__pbMakePuppets/.test(bundle) && /turnstile-stub\.js/.test(bundle);
  log(`${patched ? 'ok  ' : 'FAIL'} legacy bundle served with string patches applied`);
  if (!patched) failed++;

  if (failed) {
    log(`${failed} check(s) failed`);
    process.exit(1);
  }
  log('legacy harness: PASS');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
