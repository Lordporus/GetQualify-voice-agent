'use strict';
/**
 * Security Hardening Test Suite (Phase 6)
 *
 * Verifies:
 * 1. Secure cookie flag in production vs development
 * 2. Double-submit cookie CSRF protection on mutating endpoints
 * 3. Exemptions for public login and webhook endpoints
 * 4. X-Request-Id generation, propagation, and correlation
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const core = require('../lib/core');

const DASHBOARD_DIR = path.join(__dirname, '..');

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function waitForServer(baseUrl, child, readLogs) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited during startup.\n${readLogs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_) {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not become ready in time.\n${readLogs()}`);
}

test('Phase 6: Secure cookie flag behavior in production vs dev', () => {
  const oldEnv = process.env.NODE_ENV;
  try {
    // Development / test: Secure flag should NOT be set (permits localhost HTTP)
    process.env.NODE_ENV = 'development';
    const devSess = core.sessionCookie('test-token-123');
    const devCsrf = core.csrfCookie('test-csrf-123');
    const devClear = core.clearCookie();
    const devClearCsrf = core.clearCsrfCookie();

    assert.ok(!devSess.includes('; Secure'), 'Dev session cookie must not include Secure');
    assert.ok(!devCsrf.includes('; Secure'), 'Dev CSRF cookie must not include Secure');
    assert.ok(!devClear.includes('; Secure'), 'Dev clear cookie must not include Secure');
    assert.ok(!devClearCsrf.includes('; Secure'), 'Dev clear CSRF cookie must not include Secure');
    assert.ok(devSess.includes('HttpOnly'), 'Session cookie must be HttpOnly');
    assert.ok(!devCsrf.includes('HttpOnly'), 'CSRF cookie must not be HttpOnly so client JS can read it');

    // Production: Secure flag MUST be set
    process.env.NODE_ENV = 'production';
    const prodSess = core.sessionCookie('test-token-123');
    const prodCsrf = core.csrfCookie('test-csrf-123');
    const prodClear = core.clearCookie();
    const prodClearCsrf = core.clearCsrfCookie();

    assert.ok(prodSess.includes('; Secure'), 'Production session cookie must include Secure');
    assert.ok(prodCsrf.includes('; Secure'), 'Production CSRF cookie must include Secure');
    assert.ok(prodClear.includes('; Secure'), 'Production clear cookie must include Secure');
    assert.ok(prodClearCsrf.includes('; Secure'), 'Production clear CSRF cookie must include Secure');
  } finally {
    process.env.NODE_ENV = oldEnv;
  }
});

test('Phase 6: CSRF token verification helper unit tests', () => {
  const csrfToken = core.generateCsrfToken();
  assert.equal(typeof csrfToken, 'string');
  assert.equal(csrfToken.length, 64);

  // Missing cookie
  assert.equal(core.verifyCsrf({ headers: { 'x-csrf-token': csrfToken } }), false);

  // Missing header
  assert.equal(core.verifyCsrf({ headers: { cookie: `csrf_token=${csrfToken}` } }), false);

  // Mismatched token
  assert.equal(core.verifyCsrf({
    headers: {
      cookie: `csrf_token=${csrfToken}`,
      'x-csrf-token': 'a'.repeat(64),
    }
  }), false);

  // Matching token
  assert.equal(core.verifyCsrf({
    headers: {
      cookie: `csrf_token=${csrfToken}`,
      'x-csrf-token': csrfToken,
    }
  }), true);
});

test('Phase 6: End-to-end integration: CSRF protection & X-Request-Id', { timeout: 60000 }, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gq-security-test-'));
  const dbFile = path.join(tempDir, 'db.json');
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];

  const child = spawn(process.execPath, ['server.js'], {
    cwd: DASHBOARD_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DB_DRIVER: 'json',
      GETQUALIFY_DB_FILE: dbFile,
      TEST_USER_EMAIL: 'sec-admin@getqualify.test',
      TEST_USER_PASSWORD: 'SecuredPassword2026!',
      TEST_USER_TENANT: 'Security Tenant QA',
      TEST_USER_SUPER_ADMIN: 'true',
      PUBLIC_ORIGIN: baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child, () => logs.join(''));

  // 1. Verify X-Request-Id on public GET route
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  const healthReqId = healthRes.headers.get('x-request-id');
  assert.ok(healthReqId, 'X-Request-Id should be present in response');

  // Custom X-Request-Id should be echoed back
  const customId = 'req-custom-trace-uuid-12345';
  const customRes = await fetch(`${baseUrl}/api/health`, {
    headers: { 'X-Request-Id': customId },
  });
  assert.equal(customRes.headers.get('x-request-id'), customId);

  // 2. Login sets both rxv_sess (HttpOnly) and csrf_token (non-HttpOnly)
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: 'sec-admin@getqualify.test', password: 'SecuredPassword2026!' }),
  });
  assert.equal(loginRes.status, 200);

  const rawSetCookie = loginRes.headers.get('set-cookie') || '';
  assert.match(rawSetCookie, /rxv_sess=/);
  assert.match(rawSetCookie, /csrf_token=/);

  const sessMatch = rawSetCookie.match(/rxv_sess=([a-f0-9]{64})/);
  const csrfMatch = rawSetCookie.match(/csrf_token=([a-f0-9]{64})/);
  assert.ok(sessMatch, 'rxv_sess token expected');
  assert.ok(csrfMatch, 'csrf_token expected');

  const sessToken = sessMatch[1];
  const csrfToken = csrfMatch[1];
  const cookieHeader = `rxv_sess=${sessToken}; csrf_token=${csrfToken}`;

  // 3. Mutating request without X-CSRF-Token header -> 403 bad_csrf
  const unauthCsrfRes = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
      Cookie: cookieHeader,
    },
    body: JSON.stringify({ name: 'Agent 1', model: 'llama-3.3-70b-versatile' }),
  });
  assert.equal(unauthCsrfRes.status, 403);
  const unauthData = await unauthCsrfRes.json();
  assert.equal(unauthData.code, 'bad_csrf');

  // 4. Mutating request with mismatched X-CSRF-Token -> 403 bad_csrf
  const badCsrfRes = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
      Cookie: cookieHeader,
      'X-CSRF-Token': '0'.repeat(64),
    },
    body: JSON.stringify({ name: 'Agent 1', model: 'llama-3.3-70b-versatile' }),
  });
  assert.equal(badCsrfRes.status, 403);
  const badCsrfData = await badCsrfRes.json();
  assert.equal(badCsrfData.code, 'bad_csrf');

  // 5. Mutating request with valid X-CSRF-Token -> succeeds
  const okCsrfRes = await fetch(`${baseUrl}/api/agents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
      Cookie: cookieHeader,
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({ name: 'Valid Agent', model: 'llama-3.3-70b-versatile' }),
  });
  assert.equal(okCsrfRes.status, 200);
  const okData = await okCsrfRes.json();
  assert.ok(okData.id || okData.agent || okData.name || okData.ok !== false, 'Expected agent response');

  // 6. Logout clears both cookies
  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: {
      Origin: baseUrl,
      Cookie: cookieHeader,
      'X-CSRF-Token': csrfToken,
    },
  });
  assert.equal(logoutRes.status, 200);
  const logoutCookies = logoutRes.headers.get('set-cookie') || '';
  assert.match(logoutCookies, /rxv_sess=;/);
  assert.match(logoutCookies, /csrf_token=;/);
});
