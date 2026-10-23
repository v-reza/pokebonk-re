#!/usr/bin/env node
// tools/test-coop-0.8.29.mjs — HTTP-level co-op integration test without a browser.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, statSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => {
      s.close(() => resolve(true));
    });
    s.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(basePort, maxTries = 5) {
  for (let i = 0; i < maxTries; i++) {
    const candidate = basePort + i;
    if (await isPortAvailable(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not find an available port in ${maxTries} tries starting from ${basePort}`);
}

function killProcess(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {}
  try {
    child.kill('SIGKILL');
  } catch {}
}

function formatTable(headers, rows) {
  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));

  const borderTop = `┌─${colWidths.map((w) => '─'.repeat(w)).join('─┬─')}─┐`;
  const borderMid = `├─${colWidths.map((w) => '─'.repeat(w)).join('─┼─')}─┤`;
  const borderBot = `└─${colWidths.map((w) => '─'.repeat(w)).join('─┴─')}─┘`;

  const lines = [borderTop];
  lines.push(`│ ${headers.map((h, i) => pad(h, colWidths[i])).join(' │ ')} │`);
  lines.push(borderMid);
  for (const row of rows) {
    lines.push(`│ ${row.map((c, i) => pad(String(c ?? ''), colWidths[i])).join(' │ ')} │`);
  }
  lines.push(borderBot);
  return lines.join('\n');
}

export async function runScenario(baseUrl) {
  const steps = [];

  function assertStep(stepLetter, condition, expected, actual, description) {
    if (!condition) {
      console.error(`\n✖ FAILED step ${stepLetter}: ${description}`);
      console.error('Expected:', JSON.stringify(expected, null, 2));
      console.error('Actual:', JSON.stringify(actual, null, 2));
      const err = new Error(`Step ${stepLetter} assertion failed: ${description}`);
      err.step = stepLetter;
      err.expected = expected;
      err.actual = actual;
      throw err;
    }
    steps.push([stepLetter, description, 'PASS']);
  }

  // --- Step a: two guests: POST /api/auth/guest twice -> tokens A and B
  const resA = await fetch(`${baseUrl}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const guestA = await resA.json();
  const resB = await fetch(`${baseUrl}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const guestB = await resB.json();

  assertStep(
    'a',
    resA.status === 200 && resB.status === 200 &&
    typeof guestA.token === 'string' && typeof guestB.token === 'string' &&
    guestA.id !== guestB.id,
    { statusA: 200, statusB: 200, hasTokenA: true, hasTokenB: true, distinctIds: true },
    { statusA: resA.status, statusB: resB.status, tokenA: Boolean(guestA.token), tokenB: Boolean(guestB.token), idA: guestA.id, idB: guestB.id },
    'Two guests authenticated (tokens A & B)'
  );

  const tokenA = guestA.token;
  const tokenB = guestB.token;

  // --- Step b: A: POST /api/coop/rooms {species:4, skin:null} -> room code
  const createRoomRes = await fetch(`${baseUrl}/api/coop/rooms`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ species: 4, skin: null }),
  });
  const createRoomJson = await createRoomRes.json();
  const code = createRoomJson?.room?.code;

  assertStep(
    'b',
    createRoomRes.status === 200 && typeof code === 'string' && code.length > 0 &&
    createRoomJson.room.host === guestA.id && createRoomJson.room.members.length === 1,
    { status: 200, hasCode: true, host: guestA.id, memberCount: 1 },
    { status: createRoomRes.status, code, host: createRoomJson?.room?.host, memberCount: createRoomJson?.room?.members?.length },
    'Host creates room (code generated)'
  );

  // --- Step c: B: POST /api/coop/rooms/<code>/join {species:7} -> 2 members, slots 0 and 1
  const joinRes = await fetch(`${baseUrl}/api/coop/rooms/${code}/join`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenB}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ species: 7 }),
  });
  const joinJson = await joinRes.json();
  const members = joinJson?.room?.members || [];
  const slots = members.map((m) => m.slot).sort();

  assertStep(
    'c',
    joinRes.status === 200 && members.length === 2 && JSON.stringify(slots) === JSON.stringify([0, 1]),
    { status: 200, memberCount: 2, slots: [0, 1] },
    { status: joinRes.status, memberCount: members.length, slots },
    'Guest joins room (2 members, slots 0 & 1)'
  );

  // --- Step d: B sends signal to A; A polls GET ?after=0 and sees 1 signal; B polls and sees 0
  const signalRes = await fetch(`${baseUrl}/api/coop/rooms/${code}/signal`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenB}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ to: guestA.id, kind: 'offer', data: { sdp: 'x' } }),
  });
  const signalJson = await signalRes.json();

  const pollARes = await fetch(`${baseUrl}/api/coop/rooms/${code}?after=0`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  const pollAJson = await pollARes.json();

  const pollBRes = await fetch(`${baseUrl}/api/coop/rooms/${code}?after=0`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  const pollBJson = await pollBRes.json();

  const signalsForA = pollAJson?.signals || [];
  const signalsForB = pollBJson?.signals || [];

  assertStep(
    'd',
    signalRes.status === 200 &&
    signalsForA.length === 1 && signalsForA[0].from === guestB.id && signalsForA[0].kind === 'offer' &&
    signalsForB.length === 0,
    { signalStatus: 200, aSignalsCount: 1, aSignalKind: 'offer', bSignalsCount: 0 },
    { signalStatus: signalRes.status, aSignalsCount: signalsForA.length, aSignalKind: signalsForA[0]?.kind, bSignalsCount: signalsForB.length },
    'Signal exchange (offer received by A only)'
  );

  // --- Step e: B: POST /api/coop/rooms/<code>/me {species:25, ready:true} -> A's poll shows B ready with species 25
  const meRes = await fetch(`${baseUrl}/api/coop/rooms/${code}/me`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenB}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ species: 25, ready: true }),
  });
  const meJson = await meRes.json();

  const pollAAfterMe = await fetch(`${baseUrl}/api/coop/rooms/${code}`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  const pollAAfterMeJson = await pollAAfterMe.json();
  const memberBInA = pollAAfterMeJson?.room?.members?.find((m) => m.id === guestB.id);

  assertStep(
    'e',
    meRes.status === 200 && memberBInA?.species === 25 && memberBInA?.ready === true,
    { status: 200, bSpecies: 25, bReady: true },
    { status: meRes.status, bSpecies: memberBInA?.species, bReady: memberBInA?.ready },
    'Guest updates readiness (species 25, ready: true)'
  );

  // --- Step f: B attempts POST /api/coop/rooms/<code>/start -> 403; A starts -> state:'started', party & seed
  const startBRes = await fetch(`${baseUrl}/api/coop/rooms/${code}/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenB}` },
  });

  const startARes = await fetch(`${baseUrl}/api/coop/rooms/${code}/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  const startAJson = await startARes.json();
  const roomStarted = startAJson?.room;

  assertStep(
    'f',
    startBRes.status === 403 && startARes.status === 200 &&
    roomStarted?.state === 'started' &&
    typeof roomStarted?.party === 'string' && roomStarted.party.length > 0 &&
    Number.isInteger(roomStarted?.seed),
    { bStatus: 403, aStatus: 200, state: 'started', hasParty: true, hasIntegerSeed: true },
    { bStatus: startBRes.status, aStatus: startARes.status, state: roomStarted?.state, party: roomStarted?.party, seed: roomStarted?.seed },
    'Start room (guest 403, host starts with seed & party)'
  );

  const sharedParty = roomStarted.party;
  const sharedSeed = roomStarted.seed;

  // --- Step g: both: POST /api/runs {party:<party>, species:...} -> identical seed and party echoed
  const runARes = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ party: sharedParty, species: 4, biome: 'forest' }),
  });
  const runAJson = await runARes.json();

  const runBRes = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenB}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ party: sharedParty, species: 25, biome: 'forest' }),
  });
  const runBJson = await runBRes.json();

  assertStep(
    'g',
    runARes.status === 200 && runBRes.status === 200 &&
    runAJson.party === sharedParty && runBJson.party === sharedParty &&
    runAJson.seed === sharedSeed && runBJson.seed === sharedSeed,
    { aStatus: 200, bStatus: 200, party: sharedParty, seed: sharedSeed },
    { aStatus: runARes.status, bStatus: runBRes.status, aParty: runAJson.party, bParty: runBJson.party, aSeed: runAJson.seed, bSeed: runBJson.seed },
    'Seed coordination (both receive identical shared seed)'
  );

  // --- Step h: A: POST /api/profile/actions {actions:[{k:'item',key:'lucky-egg'},{k:'lab',id:'dust'}]}
  const actionsRes = await fetch(`${baseUrl}/api/profile/actions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      actions: [
        { k: 'item', key: 'lucky-egg' },
        { k: 'lab', id: 'dust' },
      ],
    }),
  });
  const actionsJson = await actionsRes.json();
  const profileA = actionsJson?.profile;

  assertStep(
    'h',
    actionsRes.status === 200 && actionsJson.applied === 2 &&
    Array.isArray(profileA?.itemsOwned) && profileA.itemsOwned.includes('lucky-egg') &&
    (profileA?.lab?.dust ?? 0) >= 1,
    { status: 200, applied: 2, hasLuckyEgg: true, hasDustLab: true },
    { status: actionsRes.status, applied: actionsJson?.applied, itemsOwned: profileA?.itemsOwned, labDust: profileA?.lab?.dust },
    'Batched profile actions (item + lab dust applied)'
  );

  // --- Step i: A: POST /api/clans {name:'IT Clan <rand>', tag:'IT'} -> 200 and /api/clans/status shows role leader
  const clanRand = Math.random().toString(36).slice(2, 8);
  const clanName = `IT Clan ${clanRand}`;
  const clanRes = await fetch(`${baseUrl}/api/clans`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: clanName, tag: 'IT' }),
  });
  const clanJson = await clanRes.json();

  const clanStatusRes = await fetch(`${baseUrl}/api/clans/status`, {
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  const clanStatusJson = await clanStatusRes.json();

  assertStep(
    'i',
    clanRes.status === 200 && clanStatusRes.status === 200 &&
    clanStatusJson?.clan?.role === 'leader' && clanStatusJson?.clan?.name === clanName,
    { clanStatus: 200, statusCheckStatus: 200, role: 'leader', clanName },
    { clanStatus: clanRes.status, statusCheckStatus: clanStatusRes.status, role: clanStatusJson?.clan?.role, clanName: clanStatusJson?.clan?.name },
    'Clan creation & status (role: leader)'
  );

  // --- Step j: A: POST /api/coop/rooms/<code>/leave then B's poll must show host handed to B
  const leaveRes = await fetch(`${baseUrl}/api/coop/rooms/${code}/leave`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
  });
  const leaveJson = await leaveRes.json();

  const pollBAfterLeave = await fetch(`${baseUrl}/api/coop/rooms/${code}`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  const pollBAfterLeaveJson = await pollBAfterLeave.json();
  const roomAfterLeave = pollBAfterLeaveJson?.room;

  assertStep(
    'j',
    leaveRes.status === 200 && pollBAfterLeave.status === 200 &&
    roomAfterLeave?.host === guestB.id &&
    roomAfterLeave?.members?.some((m) => m.id === guestB.id) &&
    !roomAfterLeave?.members?.some((m) => m.id === guestA.id),
    { leaveStatus: 200, host: guestB.id, containsB: true, containsA: false },
    { leaveStatus: leaveRes.status, host: roomAfterLeave?.host, members: roomAfterLeave?.members?.map((m) => m.id) },
    'Host leave & migration (host transferred to B)'
  );

  return steps;
}

export async function main() {
  const storePath = path.join(ROOT, 'data', 'store.json');
  const storeExisted = existsSync(storePath);
  const initialStat = storeExisted ? statSync(storePath) : null;

  const tmpDir = mkdtempSync(path.join(tmpdir(), 'pb-coop-test-'));
  const storeBackup = path.join(tmpDir, 'store.json.bak');

  if (storeExisted) {
    copyFileSync(storePath, storeBackup);
  }

  const basePort = 18100 + (process.pid % 500);
  const port = await findAvailablePort(basePort, 5);
  console.log(`[test-coop] Selected server port: ${port}`);

  let serverProcess = null;
  let steps = [];
  let testError = null;

  try {
    serverProcess = spawn(process.execPath, ['server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.on('error', (err) => {
      console.error('[test-coop] Server process error:', err);
    });

    // Wait until GET /api/status answers 200 (poll <= 10s, 100ms interval)
    const t0 = Date.now();
    let ready = false;
    while (Date.now() - t0 < 10000) {
      if (serverProcess.exitCode !== null) {
        throw new Error(`Server process exited prematurely with code ${serverProcess.exitCode}`);
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!ready) {
      throw new Error(`Server failed to answer GET /api/status on port ${port} within 10s`);
    }

    console.log(`[test-coop] Server ready in ${Date.now() - t0}ms. Running scenario...`);
    steps = await runScenario(`http://127.0.0.1:${port}`);
  } catch (err) {
    testError = err;
  } finally {
    // 1. Always kill server child process
    killProcess(serverProcess);

    // 2. Always restore store.json
    let restoredStat = null;
    if (storeExisted && existsSync(storeBackup)) {
      copyFileSync(storeBackup, storePath);
      restoredStat = statSync(storePath);
    } else if (!storeExisted && existsSync(storePath)) {
      unlinkSync(storePath);
    }

    // 3. Remove temp directory
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}

    if (initialStat && restoredStat) {
      console.log(
        `[test-coop] Store restored successfully: ` +
        `size before=${initialStat.size} B, after=${restoredStat.size} B; ` +
        `mtime before=${initialStat.mtime.toISOString()}, restored=${restoredStat.mtime.toISOString()}`
      );
    }
  }

  if (testError) {
    console.error('\n[test-coop] Integration test failed:', testError.message || testError);
    process.exit(1);
  }

  console.log('\n' + formatTable(['Step', 'Description', 'Result'], steps) + '\n');
  console.log('ALL PASS');
}

const isDirectExecution = Boolean(process.argv[1] && path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase());
if (isDirectExecution) {
  main().catch((err) => {
    console.error('[test-coop] FATAL:', err);
    process.exit(1);
  });
}
