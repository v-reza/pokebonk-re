import test from 'node:test';
import assert from 'node:assert/strict';

test('default values are the new build (mvl14oup / 0.8.29)', async () => {
  const bt = await import('./build-target.mjs');
  assert.strictEqual(bt.BUILD, 'mvlr7rzv');
  assert.strictEqual(bt.VERSION, '0.8.34');
  assert.strictEqual(bt.ENTRY, 'main-CwXNXC4E-mvlr7rzv.js');
  assert.strictEqual(bt.GAME, 'main-CPuTGAQ--mvlr7rzv.js');
  assert.strictEqual(bt.INDEX, 'index.html');
});

test('env overrides win via resolveBuildTarget', async () => {
  const { resolveBuildTarget } = await import('./build-target.mjs');
  const custom = resolveBuildTarget({
    PB_BUILD: 'custom-build',
    PB_VERSION: '0.9.1',
    PB_ENTRY: 'entry-custom.js',
    PB_GAME: 'game-custom.js',
    PB_INDEX: 'index-custom.html',
  });
  assert.strictEqual(custom.BUILD, 'custom-build');
  assert.strictEqual(custom.VERSION, '0.9.1');
  assert.strictEqual(custom.ENTRY, 'entry-custom.js');
  assert.strictEqual(custom.GAME, 'game-custom.js');
  assert.strictEqual(custom.INDEX, 'index-custom.html');
});

test('env overrides win on dynamic module import', async () => {
  const origBuild = process.env.PB_BUILD;
  const origVersion = process.env.PB_VERSION;
  try {
    process.env.PB_BUILD = 'test-override-build';
    process.env.PB_VERSION = '0.99.0';
    const dyn = await import(`./build-target.mjs?test_env_override=${Date.now()}`);
    assert.strictEqual(dyn.BUILD, 'test-override-build');
    assert.strictEqual(dyn.VERSION, '0.99.0');
  } finally {
    if (origBuild === undefined) delete process.env.PB_BUILD;
    else process.env.PB_BUILD = origBuild;
    if (origVersion === undefined) delete process.env.PB_VERSION;
    else process.env.PB_VERSION = origVersion;
  }
});

test('LEGACY still reports the old build (mvilprw2 / 0.8.13)', async () => {
  const { LEGACY } = await import('./build-target.mjs');
  assert.strictEqual(LEGACY.BUILD, 'mvilprw2');
  assert.strictEqual(LEGACY.VERSION, '0.8.13');
  assert.strictEqual(LEGACY.ENTRY, 'main-BcyzVqXo-mvilprw2.js');
  assert.strictEqual(LEGACY.GAME, 'main-D5OUVqGK-mvilprw2.js');
  assert.strictEqual(LEGACY.INDEX, 'index.html');
});

test('updated tools import cleanly in-process without throwing, network, or FS writes', async () => {
  const pull = await import('./pull.mjs');
  assert.strictEqual(typeof pull.main, 'function');
  assert.strictEqual(typeof pull.enqueue, 'function');

  const probe = await import('./probe.mjs');
  assert.strictEqual(typeof probe.main, 'function');

  const mirror = await import('./mirror.mjs');
  assert.strictEqual(typeof mirror.main, 'function');
  assert.strictEqual(typeof mirror.add, 'function');

  const prepatch = await import('./prepatch.mjs');
  assert.strictEqual(typeof prepatch.main, 'function');
  assert.strictEqual(typeof prepatch.patchAndAssertIndexHtml, 'function');

  const patchIndex = await import('./patch-index-local.mjs');
  assert.strictEqual(typeof patchIndex.main, 'function');
});

test('prepatch.mjs patchAndAssertIndexHtml behavior', async () => {
  const { patchAndAssertIndexHtml } = await import('./prepatch.mjs');

  // Secures unconstrained anchor
  const unconstrained = "foo\nglobalThis.__pbUseLocal = qs.has('local') || qs.get('coop') === 'local';\nbar";
  const secured = patchAndAssertIndexHtml(unconstrained);
  assert.match(secured, /isLocalHost && \(qs\.has\('local'\) \|\| qs\.get\('coop'\) === 'local'\);/);
  assert.doesNotMatch(secured, /globalThis\.__pbUseLocal = qs\.has\('local'\) \|\| qs\.get\('coop'\) === 'local';/);

  // Idempotent on already secured
  const securedAgain = patchAndAssertIndexHtml(secured);
  assert.strictEqual(securedAgain, secured);

  // Passes 0.8.29 content without throwing
  const clean0829 = '<!doctype html><html><head><title>PokéBonk</title></head><body></body></html>';
  assert.strictEqual(patchAndAssertIndexHtml(clean0829), clean0829);
});

test('tools dry-run invocations do not write or throw', async () => {
  const prepatch = await import('./prepatch.mjs');
  const prepatchResult = await prepatch.main(['--dry-run']);
  assert.strictEqual(prepatchResult.dryRun, true);
  assert.ok(Array.isArray(prepatchResult.wouldTouch));

  const patchIndex = await import('./patch-index-local.mjs');
  const patchIndexResult = await patchIndex.main(['--dry-run']);
  assert.strictEqual(patchIndexResult.dryRun, true);

  const pull = await import('./pull.mjs');
  const pullResult = await pull.main({ dryRun: true });
  assert.strictEqual(pullResult.dryRun, true);

  const probe = await import('./probe.mjs');
  const probeResult = await probe.main({ dryRun: true });
  assert.strictEqual(probeResult.dryRun, true);

  const mirror = await import('./mirror.mjs');
  const mirrorResult = await mirror.main({ dryRun: true });
  assert.strictEqual(mirrorResult.dryRun, true);
});
