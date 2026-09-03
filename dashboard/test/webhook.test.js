'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

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

test('Dograh post-call webhook lifecycle and security', { timeout: 60000 }, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gq-webhook-test-'));
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
      DOGRAH_WEBHOOK_SECRET: 'test-webhook-secret-xyz',
      TEST_USER_EMAIL: 'demo@getqualify.test',
      TEST_USER_PASSWORD: 'DemoPassword2026!',
      TEST_USER_SUPER_ADMIN: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const readLogs = () => logs.join('');
  child.stdout.on('data', (c) => logs.push(c.toString('utf8')));
  child.stderr.on('data', (c) => logs.push(c.toString('utf8')));

  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  await waitForServer(baseUrl, child, readLogs);

  // 1. Missing secret should be rejected with 401
  const unauthRes = await fetch(`${baseUrl}/api/webhooks/dograh/call-completed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ call_id: 'call_1' }),
  });
  assert.equal(unauthRes.status, 401);
  const unauthBody = await unauthRes.json();
  assert.equal(unauthBody.code, 'unauthorized_webhook');

  // 2. Wrong secret should be rejected with 401
  const wrongSecretRes = await fetch(`${baseUrl}/api/webhooks/dograh/call-completed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Dograh-Webhook-Secret': 'wrong-secret',
    },
    body: JSON.stringify({ call_id: 'call_1' }),
  });
  assert.equal(wrongSecretRes.status, 401);

  // 3. Valid secret with external origin header passes (exempt from CSRF/origin check)
  const missedRes = await fetch(`${baseUrl}/api/webhooks/dograh/call-completed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Dograh-Webhook-Secret': 'test-webhook-secret-xyz',
      'Origin': 'https://app.dograh.com',
    },
    body: JSON.stringify({
      call_id: 'call_missed_100',
      caller_number: '9876543210',
      called_number: '+911140001000',
      duration: 0,
      disposition: 'no-answer',
      gathered_context: { name: 'Priya Sharma' },
    }),
  });
  assert.equal(missedRes.status, 200);
  const missedBody = await missedRes.json();
  assert.equal(missedBody.ok, true);
  assert.equal(missedBody.call_id, 'call_missed_100');
  assert.equal(missedBody.status, 'missed');
  assert.ok(missedBody.lead_id);

  // 4. Verify DB file has the new lead and call
  const dbData = JSON.parse(await readFile(dbFile, 'utf8'));
  const lead = (dbData.leads || []).find((l) => l.phone === '9876543210');
  assert.ok(lead, 'Lead should be created in DB');
  assert.equal(lead.name, 'Priya Sharma');
  assert.equal(lead.status, 'new');

  const call = (dbData.calls || []).find((c) => c.id === 'call_missed_100');
  assert.ok(call, 'Call should be created in DB');
  assert.equal(call.status, 'missed');
  assert.equal(call.leadId, lead.id);

  // 5. Completed call update for the same phone number updates lead to contacted
  const completedRes = await fetch(`${baseUrl}/api/webhooks/dograh/call-completed`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Dograh-Webhook-Secret': 'test-webhook-secret-xyz',
    },
    body: JSON.stringify({
      call_id: 'call_completed_200',
      caller_number: '9876543210',
      called_number: '+911140001000',
      duration: 125,
      disposition: 'answered',
      transcript: 'Customer asked about our annual maintenance packages.',
    }),
  });
  assert.equal(completedRes.status, 200);
  const completedBody = await completedRes.json();
  assert.equal(completedBody.ok, true);
  assert.equal(completedBody.status, 'completed');
  assert.equal(completedBody.lead_id, lead.id);

  const dbDataAfter = JSON.parse(await readFile(dbFile, 'utf8'));
  const updatedLead = (dbDataAfter.leads || []).find((l) => l.id === lead.id);
  assert.equal(updatedLead.status, 'contacted');
});
