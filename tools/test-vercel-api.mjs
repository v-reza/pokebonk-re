// tools/test-vercel-api.mjs — test harness for Vercel serverless function api/[...path].mjs.
import http from 'node:http';
import assert from 'node:assert/strict';
import handler, { setBackendForTest } from '../api/[...path].mjs';
import { createBackend, MemoryDB } from '../firebase/backend.mjs';

console.log('--- Test 1: Cold start initialization failure handling ---');
{
  // When firebase-admin is not installed or credentials missing,
  // handler must return a clean 500 JSON without crashing or looping.
  const req = {
    method: 'GET',
    url: '/api/status',
    headers: { host: '127.0.0.1:3000' },
  };

  let statusCode = 0;
  let headers = {};
  let bodyBuffer = Buffer.alloc(0);

  const res = {
    writableEnded: false,
    writeHead(code, h) {
      statusCode = code;
      headers = h;
    },
    end(data) {
      if (data) bodyBuffer = Buffer.from(data);
      this.writableEnded = true;
    },
  };

  await handler(req, res);

  assert.equal(statusCode, 500, 'Cold failure must return HTTP 500');
  const body = JSON.parse(bodyBuffer.toString('utf8'));
  assert.equal(body.error, 'Database backend initialization failed.');
  console.log('✔ Cold initialization failure cleanly produces 500 JSON:', body);
}

console.log('\n--- Test 2: Local HTTP server mounting api/[...path].mjs with in-memory backend ---');
{
  // Inject the MemoryDB backend fake (same contract used in backend.test.mjs)
  const memBackend = createBackend(new MemoryDB());
  setBackendForTest(memBackend);

  const server = http.createServer((req, res) => {
    handler(req, res);
  });

  const PORT = 8898;
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${PORT}`;

  try {
    // 2a. CORS preflight OPTIONS
    const optRes = await fetch(`${baseUrl}/api/status`, { method: 'OPTIONS' });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('access-control-allow-origin'), '*');
    console.log('✔ OPTIONS /api/status -> 204 with CORS headers');

    // 2b. GET /api/status
    const statusRes = await fetch(`${baseUrl}/api/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.maintenance.on, false);
    assert.equal(statusJson.season.n, 2);
    console.log('✔ GET /api/status -> 200 JSON:', JSON.stringify(statusJson).slice(0, 70) + '...');

    // 2c. GET /api/version.json
    const verRes = await fetch(`${baseUrl}/api/version.json`);
    assert.equal(verRes.status, 200);
    const verJson = await verRes.json();
    assert.equal(verJson.build, 'firebase');
    console.log('✔ GET /api/version.json -> 200 JSON:', verJson);

    // 2d. POST /api/auth/guest
    const guestRes = await fetch(`${baseUrl}/api/auth/guest`, { method: 'POST' });
    assert.equal(guestRes.status, 200);
    const guestJson = await guestRes.json();
    assert.ok(guestJson.id);
    assert.ok(guestJson.token);
    assert.equal(guestJson.guest, true);
    console.log('✔ POST /api/auth/guest -> 200 JSON:', guestJson);

    // 2e. POST /api/auth/register (Testing JSON body passing through adapter)
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'AshKetchum', password: 'SecretPassword123' }),
    });
    assert.equal(regRes.status, 200);
    const regJson = await regRes.json();
    assert.equal(regJson.name, 'AshKetchum');
    assert.equal(regJson.guest, false);
    console.log('✔ POST /api/auth/register (body parsing) -> 200 JSON:', regJson);

    // 2f. GET /api/auth/name?name=AshKetchum -> taken should be true
    const nameRes = await fetch(`${baseUrl}/api/auth/name?name=AshKetchum`);
    assert.equal(nameRes.status, 200);
    const nameJson = await nameRes.json();
    assert.equal(nameJson.ok, false); // already taken
    console.log('✔ GET /api/auth/name?name=AshKetchum -> 200 JSON ok: false (name taken)');

    // 2g. 404 for unknown route
    const notFoundRes = await fetch(`${baseUrl}/api/unknown_route`);
    assert.equal(notFoundRes.status, 404);
    const notFoundJson = await notFoundRes.json();
    assert.equal(notFoundJson.error, 'Not found.');
    console.log('✔ GET /api/unknown_route -> 404 JSON:', notFoundJson);

    console.log('\nAll Vercel serverless adapter tests PASSED!');
  } finally {
    server.close();
  }
}
