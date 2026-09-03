'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const DASHBOARD_DIR = path.join(__dirname, '..');
const ADMIN_EMAIL = 'super.admin@getqualify.test';
const ADMIN_PASSWORD = 'SuperAdminPassword2026!';

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

test('provisioning and lightweight CRM lifecycle', { timeout: 60000 }, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gq-provision-test-'));
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
      TEST_USER_EMAIL: ADMIN_EMAIL,
      TEST_USER_PASSWORD: ADMIN_PASSWORD,
      TEST_USER_TENANT: 'Platform HQ',
      TEST_USER_SUPER_ADMIN: 'true',
      PUBLIC_ORIGIN: baseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (c) => logs.push(c.toString()));
  child.stderr.on('data', (c) => logs.push(c.toString()));

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((res) => child.once('exit', res)),
        new Promise((res) => setTimeout(res, 1500)),
      ]);
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  await waitForServer(baseUrl, child, () => logs.join(''));

  // 1. Login as super admin
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  assert.equal(loginRes.status, 200);
  const adminCookie = loginRes.headers.get('set-cookie');
  assert.ok(adminCookie, 'Expected session cookie on login');
  const adminCsrf = (adminCookie.match(/csrf_token=([a-f0-9]{64})/) || [])[1] || '';

  // 2. Unknown industry template -> 422
  const badIndustryRes = await fetch(`${baseUrl}/api/admin/tenants/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, Cookie: adminCookie, 'X-CSRF-Token': adminCsrf },
    body: JSON.stringify({
      name: 'Acme Mining',
      ownerEmail: 'acme.owner@mining.test',
      password: 'ClientPassword123!',
      industry: 'unknown_mining',
    }),
  });
  assert.equal(badIndustryRes.status, 422);
  const badIndustryData = await badIndustryRes.json();
  assert.equal(badIndustryData.code, 'invalid_industry');

  // 3. Provision new tenant with industry: 'dental' -> 201 creates all 5 entities
  const provisionRes = await fetch(`${baseUrl}/api/admin/tenants/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, Cookie: adminCookie, 'X-CSRF-Token': adminCsrf },
    body: JSON.stringify({
      name: 'Smile Care Dental',
      ownerEmail: 'dr.smith@smilecare.test',
      password: 'DentalClinicPassword2026!',
      industry: 'dental',
      timezone: 'America/New_York',
    }),
  });
  assert.equal(provisionRes.status, 201);
  const provisionData = await provisionRes.json();
  assert.ok(provisionData.tenant && provisionData.tenant.id);
  assert.equal(provisionData.tenant.name, 'Smile Care Dental');
  assert.ok(provisionData.owner && provisionData.owner.id);
  assert.equal(provisionData.owner.email, 'dr.smith@smilecare.test');
  assert.equal(provisionData.owner.role, 'owner');
  assert.ok(provisionData.agent && provisionData.agent.id);
  assert.equal(provisionData.agent.presetId, 'preset_dental_v1');
  assert.ok(provisionData.agent.greeting.includes('Smile Care Dental'), 'Greeting should substitute {business_name}');
  assert.ok(provisionData.demoLink && provisionData.demoLink.id);
  assert.ok(provisionData.sharePath);

  const newTenantId = provisionData.tenant.id;

  // 4. Duplicate owner email -> 409
  const dupEmailRes = await fetch(`${baseUrl}/api/admin/tenants/provision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, Cookie: adminCookie, 'X-CSRF-Token': adminCsrf },
    body: JSON.stringify({
      name: 'Another Clinic',
      ownerEmail: 'dr.smith@smilecare.test',
      password: 'AnotherPassword2026!',
      industry: 'dental',
    }),
  });
  assert.equal(dupEmailRes.status, 409);
  const dupEmailData = await dupEmailRes.json();
  assert.equal(dupEmailData.code, 'email_taken');

  // 5. Client settings GET & PATCH
  const settingsGetRes = await fetch(`${baseUrl}/api/admin/tenants/${newTenantId}/settings`, {
    headers: { Origin: baseUrl, Cookie: adminCookie },
  });
  assert.equal(settingsGetRes.status, 200);
  const settingsGetData = await settingsGetRes.json();
  assert.equal(settingsGetData.settings.industry, 'dental');
  assert.equal(settingsGetData.settings.timezone, 'America/New_York');

  const settingsPatchRes = await fetch(`${baseUrl}/api/admin/tenants/${newTenantId}/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, Cookie: adminCookie, 'X-CSRF-Token': adminCsrf },
    body: JSON.stringify({
      knowledgeBase: 'We accept Delta Dental and MetLife.',
    }),
  });
  assert.equal(settingsPatchRes.status, 200);
  const settingsPatchData = await settingsPatchRes.json();
  assert.equal(settingsPatchData.settings.knowledgeBase, 'We accept Delta Dental and MetLife.');

  // 6. Login as the newly provisioned tenant owner
  const clientLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: 'dr.smith@smilecare.test', password: 'DentalClinicPassword2026!' }),
  });
  assert.equal(clientLoginRes.status, 200);
  const clientCookie = clientLoginRes.headers.get('set-cookie');
  assert.ok(clientCookie);
  const clientCsrf = (clientCookie.match(/csrf_token=([a-f0-9]{64})/) || [])[1] || '';

  // 7. Save HVAC job -> auto-creates lead
  const hvacJobRes = await fetch(`${baseUrl}/api/hvac/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, Cookie: clientCookie, 'X-CSRF-Token': clientCsrf },
    body: JSON.stringify({
      callerName: 'Patient Alice',
      phone: '+15551234567',
      email: 'alice@example.com',
      service: 'Tooth Cleaning',
      urgency: 'normal',
      outcome: 'new',
      notes: 'First time visit',
    }),
  });
  assert.equal(hvacJobRes.status, 200);
  const hvacJobData = await hvacJobRes.json();
  assert.ok(hvacJobData.job.id);
  assert.ok(hvacJobData.job.leadId, 'HVAC job should be linked to an auto-created lead');

  const leadId = hvacJobData.job.leadId;

  // 8. Verify lead exists via GET /api/leads
  const leadsListRes = await fetch(`${baseUrl}/api/leads`, {
    headers: { Origin: baseUrl, Cookie: clientCookie },
  });
  assert.equal(leadsListRes.status, 200);
  const leadsListData = await leadsListRes.json();
  assert.equal(leadsListData.leads.length, 1);
  assert.equal(leadsListData.leads[0].id, leadId);
  assert.equal(leadsListData.leads[0].name, 'Patient Alice');
  assert.equal(leadsListData.leads[0].phone, '+15551234567');

  // 9. Save another job with same phone -> updates lead, doesn't duplicate
  const secondJobRes = await fetch(`${baseUrl}/api/hvac/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, Cookie: clientCookie, 'X-CSRF-Token': clientCsrf },
    body: JSON.stringify({
      callerName: 'Alice Updated',
      phone: '+15551234567',
      email: 'alice.new@example.com',
      service: 'Follow-up',
      outcome: 'booked',
    }),
  });
  assert.equal(secondJobRes.status, 200);
  const secondJobData = await secondJobRes.json();
  assert.equal(secondJobData.job.leadId, leadId, 'Same phone should link to existing lead');

  const leadsListAgain = await fetch(`${baseUrl}/api/leads`, {
    headers: { Origin: baseUrl, Cookie: clientCookie },
  });
  const leadsListAgainData = await leadsListAgain.json();
  assert.equal(leadsListAgainData.leads.length, 1, 'Should not create duplicate leads for same phone');
  assert.equal(leadsListAgainData.leads[0].status, 'booked');

  // 10. GET /api/leads/:id returns linked jobs
  const leadGetRes = await fetch(`${baseUrl}/api/leads/${leadId}`, {
    headers: { Origin: baseUrl, Cookie: clientCookie },
  });
  assert.equal(leadGetRes.status, 200);
  const leadGetData = await leadGetRes.json();
  assert.equal(leadGetData.lead.id, leadId);
  assert.ok(Array.isArray(leadGetData.hvacJobs));
  assert.equal(leadGetData.hvacJobs.length, 2);

  // 11. PATCH /api/leads/:id  // 12. Patch lead status
  const patchRes = await fetch(`${baseUrl}/api/leads/${leadId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, Cookie: clientCookie, 'X-CSRF-Token': clientCsrf },
    body: JSON.stringify({ notes: 'VIP Patient', assignedTo: 'Dr. Smith' }),
  });
  assert.equal(patchRes.status, 200);
  const patchData = await patchRes.json();
  assert.equal(patchData.lead.notes, 'VIP Patient');
  assert.equal(patchData.lead.assignedTo, 'Dr. Smith');

  // 12. DELETE /api/leads/:id  // 13. Delete lead
  const deleteRes = await fetch(`${baseUrl}/api/leads/${leadId}`, {
    method: 'DELETE',
    headers: { Origin: baseUrl, Cookie: clientCookie, 'X-CSRF-Token': clientCsrf },
  });
  assert.equal(deleteRes.status, 200);
  const deleteData = await deleteRes.json();
  assert.equal(deleteData.success, true);
  assert.equal(deleteData.lead.status, 'closed');
});
