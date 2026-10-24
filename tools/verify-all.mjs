#!/usr/bin/env node
// tools/verify-all.mjs — single verification entry point for the repository.
import { readdir } from 'node:fs/promises';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { COOP_PATCHES } from './bundle-patches-0.8.29.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

async function findTestFiles(dir = ROOT) {
  const entries = await readdir(dir, { withFileTypes: true });
  const tests = [];
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      tests.push(...await findTestFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      tests.push(full);
    }
  }
  return tests;
}

function formatTable(rows) {
  const col1Width = Math.max(...rows.map((r) => r[0].length));
  const col2Width = Math.max(...rows.map((r) => String(r[1]).length));
  const pad = (str, len) => str + ' '.repeat(Math.max(0, len - str.length));

  const borderTop = `┌─${'─'.repeat(col1Width)}─┬─${'─'.repeat(col2Width)}─┐`;
  const borderMid = `├─${'─'.repeat(col1Width)}─┼─${'─'.repeat(col2Width)}─┤`;
  const borderBot = `└─${'─'.repeat(col1Width)}─┴─${'─'.repeat(col2Width)}─┘`;

  const lines = [borderTop];
  for (let i = 0; i < rows.length; i++) {
    const [c1, c2] = rows[i];
    lines.push(`│ ${pad(c1, col1Width)} │ ${pad(String(c2), col2Width)} │`);
    if (i === 0) lines.push(borderMid);
  }
  lines.push(borderBot);
  return lines.join('\n');
}

export async function main() {
  const { GAME } = await import('./build-target.mjs');
  const defaultBundle = path.join(ROOT, 'public', 'assets', GAME);
  const bundlePath = process.env.PB_UPSTREAM_BUNDLE
    ? path.resolve(process.env.PB_UPSTREAM_BUNDLE)
    : (existsSync(defaultBundle) ? path.resolve(defaultBundle) : null);

  console.log('[verify] Target upstream bundle:', bundlePath || '(none found)');

  // 1. Discover and run every test file
  const testFiles = await findTestFiles(ROOT);
  testFiles.sort();
  console.log(`[verify] Discovered ${testFiles.length} test files:`);
  for (const tf of testFiles) {
    console.log(`  - ${path.relative(ROOT, tf).replace(/\\/g, '/')}`);
  }

  let testOutput = '';
  let testError = null;
  try {
    testOutput = execFileSync(
      process.execPath,
      ['--test', ...testFiles],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          ...(bundlePath ? { PB_UPSTREAM_BUNDLE: bundlePath } : {}),
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
  } catch (err) {
    testError = err;
    testOutput = (err.stdout || '') + '\n' + (err.stderr || '');
    console.error('[verify] Test run failed:\n', testOutput);
  }

  const passMatch = testOutput.match(/ℹ pass (\d+)/);
  const failMatch = testOutput.match(/ℹ fail (\d+)/);
  const skipMatch = testOutput.match(/ℹ skipped (\d+)/);
  const passCount = passMatch ? Number(passMatch[1]) : 0;
  const failCount = failMatch ? Number(failMatch[1]) : (testError ? 1 : 0);
  const skipCount = skipMatch ? Number(skipMatch[1]) : 0;

  // 2. Run bundle applier pass 1 & pass 2
  let patchSuccess = false;
  let patchCount = 0;
  let byteDelta = 0;
  let isIdempotent = false;
  let patchError = null;

  if (!bundlePath || !existsSync(bundlePath)) {
    patchError = new Error(`Upstream bundle not found: ${bundlePath}`);
  } else {
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'pb-verify-'));
    const tmpOut1 = path.join(tmpDir, 'bundle-pass1.js');
    const tmpOut2 = path.join(tmpDir, 'bundle-pass2.js');

    try {
      // Pass 1: raw bundle -> patched bundle
      const applierScript = path.join(ROOT, 'tools', 'apply-bundle-patches.mjs');
      const pass1Raw = execFileSync(
        process.execPath,
        [applierScript, '--in', bundlePath, '--out', tmpOut1],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const pass1Json = JSON.parse(pass1Raw.trim());

      const expectedIds = COOP_PATCHES.map((p) => p.id);
      if (pass1Json.parses !== true) {
        throw new Error(`Pass 1: bundle does not parse as valid ES module`);
      }
      for (const id of expectedIds) {
        if (!pass1Json.applied.includes(id)) {
          throw new Error(`Pass 1: patch ${id} was not in applied list: ${JSON.stringify(pass1Json.applied)}`);
        }
      }

      patchCount = pass1Json.applied.length;
      byteDelta = pass1Json.bytesAdded;

      // Pass 2: patched bundle -> second output (idempotence verification)
      const pass2Raw = execFileSync(
        process.execPath,
        [applierScript, '--in', tmpOut1, '--out', tmpOut2],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const pass2Json = JSON.parse(pass2Raw.trim());

      if (pass2Json.parses !== true) {
        throw new Error(`Pass 2: re-patched bundle does not parse as valid ES module`);
      }
      if (pass2Json.applied.length !== 0) {
        throw new Error(`Pass 2: expected applied: [], got: ${JSON.stringify(pass2Json.applied)}`);
      }
      for (const id of expectedIds) {
        if (!pass2Json.skipped.includes(id)) {
          throw new Error(`Pass 2: patch ${id} was not skipped: ${JSON.stringify(pass2Json.skipped)}`);
        }
      }

      // Check byte-identical
      const bytes1 = readFileSync(tmpOut1);
      const bytes2 = readFileSync(tmpOut2);
      if (!bytes1.equals(bytes2)) {
        throw new Error(`Pass 2: byte comparison failed between pass 1 and pass 2`);
      }

      isIdempotent = true;
      patchSuccess = true;
    } catch (err) {
      patchError = err;
      console.error('[verify] Patch verification failed:', err.message || err);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  // 3. Run API integration test (tools/test-coop-0.8.29.mjs)
  let apiSuccess = false;
  let apiOutput = '';
  let apiError = null;
  let apiStepPassCount = 0;
  let apiStepTotalCount = 0;
  const skipApi = process.env.PB_SKIP_API === '1';

  if (skipApi) {
    console.log('[verify] PB_SKIP_API=1 is set; skipping API integration stage.');
  } else {
    console.log('[verify] Running API integration test (tools/test-coop-0.8.29.mjs)...');
    const apiScript = path.join(ROOT, 'tools', 'test-coop-0.8.29.mjs');
    try {
      apiOutput = execFileSync(
        process.execPath,
        [apiScript],
        {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      apiSuccess = true;
    } catch (err) {
      apiError = err;
      apiOutput = (err.stdout || '') + '\n' + (err.stderr || '');
      console.error('[verify] API integration test failed:');
      const lines = apiOutput.trim().split('\n');
      console.error(lines.slice(-40).join('\n'));
    }

    const stepMatches = [...apiOutput.matchAll(/│\s*([a-z])\s*│[^│]+│\s*(\w+)\s*│/g)];
    if (stepMatches.length > 0) {
      apiStepTotalCount = stepMatches.length;
      apiStepPassCount = stepMatches.filter((m) => m[2] === 'PASS').length;
    }
  }

  let apiResultStr;
  if (skipApi) {
    apiResultStr = 'skipped';
  } else if (apiStepTotalCount > 0) {
    apiResultStr = `${apiStepPassCount}/${apiStepTotalCount} steps ${apiSuccess ? 'PASS' : 'FAIL'}`;
  } else {
    apiResultStr = `(unparsed) ${apiSuccess ? 'PASS' : 'FAIL'}`;
  }

  // 4. Compact summary table
  const allPassed = !testError && failCount === 0 && patchSuccess && isIdempotent && (skipApi || apiSuccess);
  const tableData = [
    ['Metric', 'Result'],
    ['Upstream Bundle', bundlePath ? path.relative(ROOT, bundlePath).replace(/\\/g, '/') : 'none'],
    ['Test Files Discovered', testFiles.length],
    ['Tests Passed', passCount],
    ['Tests Failed', failCount],
    ['Tests Skipped', skipCount],
    ['Patches Applied', `${patchCount} / ${COOP_PATCHES.length}`],
    ['Byte Delta', `+${byteDelta} B`],
    ['Idempotent', isIdempotent ? 'YES (byte-identical)' : 'NO'],
    ['API integration', apiResultStr],
    ['Overall Status', allPassed ? 'PASS' : 'FAIL'],
  ];

  console.log('\n' + formatTable(tableData) + '\n');

  if (!allPassed) {
    if (testError) console.error('[verify] Tests encountered errors.');
    if (patchError) console.error('[verify] Patch assertion error:', patchError.message || patchError);
    if (!skipApi && !apiSuccess) console.error('[verify] API integration stage failed.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[verify] FATAL:', err);
  process.exit(1);
});
