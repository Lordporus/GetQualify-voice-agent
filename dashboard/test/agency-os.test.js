'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execSync } = require('node:child_process');
const { mkdtemp, readFile, rm, stat } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const DASHBOARD_DIR = path.join(__dirname, '..');
const ADMIN_EMAIL = 'agency.qa@getqualify.in';
const ADMIN_PASSWORD = 'Admin-QA-Only-2026!';
const CLIENT_EMAIL = 'owner.qa@getqualify.in';
const CLIENT_PASSWORD = 'Client-QA-Only-2026!';

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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Agency OS server exited during startup.\n${readLogs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (_) {
      // The server has not bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Agency OS server did not become ready.\n${readLogs()}`);
}

function futureDate(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

test('agency OS APIs complete the lifecycle and preserve tenant isolation', { timeout: 30000 }, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'getqualify-agency-os-'));
  const dbFile = path.join(tempDir, 'db.json');
  const rootDbUrl = process.env.TEST_ROOT_DATABASE_URL;
  if (!rootDbUrl) {
    throw new Error('TEST_ROOT_DATABASE_URL is required to run tests. Set it to a postgres url (e.g. postgresql://postgres:password@localhost:5432/postgres) with privileges to create databases.');
  }

  const testDbName = `gq_test_${Date.now()}`;
  // Uses the standard URL parser to just swap the database path.
  const testDbUrl = new URL(rootDbUrl);
  testDbUrl.pathname = `/${testDbName}`;
  const finalTestDbUrl = testDbUrl.toString();

  // Provision disposable database
  execSync(`psql "${rootDbUrl}" -c "CREATE DATABASE ${testDbName};"`, { stdio: 'ignore' });
  execSync(`psql "${finalTestDbUrl}" -f "${path.join(DASHBOARD_DIR, '..', 'schema.sql')}"`, { stdio: 'ignore' });

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: DASHBOARD_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DB_DRIVER: 'postgres',
      DATABASE_URL: finalTestDbUrl,
      GETQUALIFY_DB_FILE: dbFile,
      TEST_USER_EMAIL: ADMIN_EMAIL,
      TEST_USER_PASSWORD: ADMIN_PASSWORD,
      TEST_USER_TENANT: 'GetQualify Agency QA',
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
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    await rm(tempDir, { recursive: true, force: true });
    // Guaranteed to run even if the test fails midway.
    execSync(`psql "${rootDbUrl}" -c "DROP DATABASE ${testDbName} WITH (FORCE);"`, { stdio: 'ignore' });
  });

  await waitForServer(baseUrl, child, () => logs.join(''));

  const legacyConsole = await fetch(`${baseUrl}/console.html`, { redirect: 'manual' });
  assert.equal(legacyConsole.status, 302);
  assert.equal(legacyConsole.headers.get('location'), '/app.html');

  async function request(cookie, pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    let body = options.body;
    if (body !== undefined && typeof body !== 'string') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers, body });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch (_) {
      throw new Error(`${options.method || 'GET'} ${pathname} returned non-JSON status ${response.status}: ${text}`);
    }
    return { response, json };
  }

  async function login(email, password) {
    const result = await request('', '/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    assert.equal(result.response.status, 200, result.json.error);
    const setCookie = result.response.headers.get('set-cookie');
    assert.match(setCookie || '', /^rxv_sess=[a-f0-9]{64};/);
    return { ...result.json, cookie: setCookie.split(';')[0] };
  }

  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(admin.user.role, 'super_admin');
  assert.equal(admin.tenant.name, 'GetQualify Agency QA');

  const rejectedSocketStatus = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stt/stream`, {
      headers: { Cookie: admin.cookie, Origin: 'https://evil.127.0.0.1.sslip.io' },
    });
    ws.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    ws.once('open', () => reject(new Error('Cross-origin WebSocket unexpectedly opened.')));
    ws.once('error', (error) => {
      if (!String(error.message).includes('Unexpected server response')) reject(error);
    });
  });
  assert.equal(rejectedSocketStatus, 403);

  const wrongSchemePrompt = await request(admin.cookie, '/api/agency/prompt', {
    method: 'POST',
    headers: { Origin: `https://127.0.0.1:${port}` },
    body: { prompt: 'The configured origin must include the correct scheme.' },
  });
  assert.equal(wrongSchemePrompt.response.status, 403);
  assert.equal(wrongSchemePrompt.json.code, 'bad_origin');

  const created = await request(admin.cookie, '/api/admin/tenants', {
    method: 'POST',
    body: {
      name: 'Northstar Dental Group',
      ownerName: 'Maya Fernandes',
      ownerEmail: CLIENT_EMAIL,
      password: CLIENT_PASSWORD,
    },
  });
  assert.equal(created.response.status, 201, created.json.error);
  assert.equal(created.json.tenant.name, 'Northstar Dental Group');
  assert.equal(created.json.tenant.status, 'active');
  assert.equal(created.json.owner.email, CLIENT_EMAIL);
  assert.equal(created.json.owner.role, 'owner');
  assert.equal(created.json.note, 'No email was sent.');
  const clientTenantId = created.json.tenant.id;

  const approached = await request(admin.cookie, '/api/admin/client-approach', {
    method: 'POST',
    body: {
      tenantId: clientTenantId,
      channel: 'whatsapp',
      summary: 'Discussed the receptionist pilot and agreed to review call outcomes on Friday.',
    },
  });
  assert.equal(approached.response.status, 201, approached.json.error);
  assert.equal(approached.json.activity.tenantId, clientTenantId);
  assert.equal(approached.json.activity.channel, 'whatsapp');

  const detail = await request(admin.cookie, `/api/admin/tenant-detail?tenantId=${encodeURIComponent(clientTenantId)}`);
  assert.equal(detail.response.status, 200, detail.json.error);
  assert.ok(detail.json.activities.some((row) => row.id === approached.json.activity.id));
  assert.ok(detail.json.activities.some((row) => row.type === 'workspace_created'));

  const issueDate = futureDate(0);
  const dueDate = futureDate(14);
  const clientAmountPaise = 185000;
  const clientInvoice = await request(admin.cookie, '/api/invoices', {
    method: 'POST',
    body: {
      tenantId: clientTenantId,
      clientName: 'Northstar Dental Group',
      clientEmail: 'accounts@northstardental.example',
      description: 'AI receptionist implementation and first month support',
      amountPaise: clientAmountPaise,
      issueDate,
      dueDate,
      issueNow: false,
    },
  });
  assert.equal(clientInvoice.response.status, 201, clientInvoice.json.error);
  assert.equal(clientInvoice.json.invoice.storedStatus, 'draft');
  assert.equal(clientInvoice.json.invoice.deliveryStatus, 'not_sent');
  assert.match(clientInvoice.json.invoice.invoiceNumber, /^RX-\d{4}-\d{4}$/);
  const clientInvoiceId = clientInvoice.json.invoice.id;

  const skippedInvoiceState = await request(admin.cookie, '/api/invoices/status', {
    method: 'POST',
    body: { invoiceId: clientInvoiceId, status: 'paid' },
  });
  assert.equal(skippedInvoiceState.response.status, 409);
  assert.equal(skippedInvoiceState.json.code, 'invalid_transition');

  const issued = await request(admin.cookie, '/api/invoices/status', {
    method: 'POST',
    body: { invoiceId: clientInvoiceId, status: 'issued' },
  });
  assert.equal(issued.response.status, 200, issued.json.error);
  assert.equal(issued.json.invoice.storedStatus, 'issued');
  assert.ok(issued.json.invoice.issuedAt);

  const replayedInvoiceState = await request(admin.cookie, '/api/invoices/status', {
    method: 'POST',
    body: { invoiceId: clientInvoiceId, status: 'issued' },
  });
  assert.equal(replayedInvoiceState.response.status, 409);
  assert.equal(replayedInvoiceState.json.code, 'invalid_transition');

  const paid = await request(admin.cookie, '/api/invoices/status', {
    method: 'POST',
    body: { invoiceId: clientInvoiceId, status: 'paid' },
  });
  assert.equal(paid.response.status, 200, paid.json.error);
  assert.equal(paid.json.invoice.storedStatus, 'paid');
  assert.ok(paid.json.invoice.paidAt);

  const finalInvoiceMutation = await request(admin.cookie, '/api/invoices/status', {
    method: 'POST',
    body: { invoiceId: clientInvoiceId, status: 'void' },
  });
  assert.equal(finalInvoiceMutation.response.status, 409);
  assert.equal(finalInvoiceMutation.json.code, 'invoice_final');

  const invalidInvoice = await request(admin.cookie, '/api/invoices', {
    method: 'POST',
    body: {
      tenantId: clientTenantId,
      clientName: 'Northstar Dental Group',
      description: 'Invalid zero value invoice',
      amountPaise: 0,
      issueDate,
      dueDate,
    },
  });
  assert.equal(invalidInvoice.response.status, 422);
  assert.equal(invalidInvoice.json.code, 'bad_amount');

  const adminAmountPaise = 240000;
  const adminInvoice = await request(admin.cookie, '/api/invoices', {
    method: 'POST',
    body: {
      tenantId: admin.tenant.id,
      clientName: 'GetQualify Agency QA',
      clientEmail: ADMIN_EMAIL,
      description: 'Agency OS operations retainer',
      amountPaise: adminAmountPaise,
      issueDate,
      dueDate,
      issueNow: true,
    },
  });
  assert.equal(adminInvoice.response.status, 201, adminInvoice.json.error);
  assert.equal(adminInvoice.json.invoice.storedStatus, 'issued');
  const adminInvoiceId = adminInvoice.json.invoice.id;

  const overview = await request(admin.cookie, '/api/agency/overview');
  assert.equal(overview.response.status, 200, overview.json.error);
  assert.equal(overview.json.dataMode, 'live_staging');
  assert.equal(overview.json.currency, 'INR');
  assert.equal(overview.json.kpis.clients, 2);
  assert.equal(overview.json.kpis.activeClients, 2);
  assert.equal(overview.json.kpis.invoicedPaise, clientAmountPaise + adminAmountPaise);
  assert.equal(overview.json.kpis.paidPaise, clientAmountPaise);
  assert.equal(overview.json.kpis.outstandingPaise, adminAmountPaise);
  const today = overview.json.days.find((row) => row.date === issueDate);
  assert.ok(today);
  assert.equal(today.invoicedPaise, clientAmountPaise + adminAmountPaise);
  assert.equal(today.paidPaise, clientAmountPaise);
  assert.ok(overview.json.recent.some((row) => row.id === approached.json.activity.id));

  const adminIntegrationsBefore = await request(admin.cookie, '/api/integrations');
  assert.equal(adminIntegrationsBefore.response.status, 200, adminIntegrationsBefore.json.error);
  assert.deepEqual(
    adminIntegrationsBefore.json.integrations.map((row) => [row.id, row.status]),
    [['whatsapp-business', 'setup_required'], ['meta-ad-library', 'setup_required']],
  );

  const adminIntegrationRequest = await request(admin.cookie, '/api/integrations/request', {
    method: 'POST',
    body: { integrationId: 'whatsapp-business' },
  });
  assert.equal(adminIntegrationRequest.response.status, 201, adminIntegrationRequest.json.error);
  assert.equal(adminIntegrationRequest.json.request.status, 'requested');
  assert.equal(adminIntegrationRequest.json.note, 'Request recorded. The integration is not connected.');

  const adminIntegrationsAfter = await request(admin.cookie, '/api/integrations');
  assert.equal(adminIntegrationsAfter.response.status, 200, adminIntegrationsAfter.json.error);
  assert.equal(adminIntegrationsAfter.json.integrations.find((row) => row.id === 'whatsapp-business').status, 'requested');
  assert.equal(adminIntegrationsAfter.json.integrations.find((row) => row.id === 'meta-ad-library').status, 'setup_required');

  const adminPromptBefore = await request(admin.cookie, '/api/agency/prompt');
  assert.equal(adminPromptBefore.response.status, 200, adminPromptBefore.json.error);
  assert.equal(adminPromptBefore.json.prompt, '');
  assert.equal(adminPromptBefore.json.version, 0);

  const crossOriginPrompt = await request(admin.cookie, '/api/agency/prompt', {
    method: 'POST',
    headers: { Origin: 'https://evil.127.0.0.1.sslip.io', 'Content-Type': 'text/plain' },
    body: JSON.stringify({ prompt: 'This cross-origin write must never be persisted.' }),
  });
  assert.equal(crossOriginPrompt.response.status, 403);
  assert.equal(crossOriginPrompt.json.code, 'bad_origin');

  const textPlainPrompt = await request(admin.cookie, '/api/agency/prompt', {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'text/plain' },
    body: JSON.stringify({ prompt: 'This non-JSON request must never be persisted.' }),
  });
  assert.equal(textPlainPrompt.response.status, 415);
  assert.equal(textPlainPrompt.json.code, 'bad_content_type');

  const firstPrompt = 'Prioritize consent-safe outreach, qualified opportunities, and clear client handoffs.';
  const adminPromptOne = await request(admin.cookie, '/api/agency/prompt', {
    method: 'POST',
    body: { prompt: firstPrompt },
  });
  assert.equal(adminPromptOne.response.status, 200, adminPromptOne.json.error);
  assert.equal(adminPromptOne.json.prompt, firstPrompt);
  assert.equal(adminPromptOne.json.version, 1);

  const secondPrompt = `${firstPrompt} Never invent delivery, invoice, integration, or campaign state.`;
  const adminPromptTwo = await request(admin.cookie, '/api/agency/prompt', {
    method: 'POST',
    body: { prompt: secondPrompt },
  });
  assert.equal(adminPromptTwo.response.status, 200, adminPromptTwo.json.error);
  assert.equal(adminPromptTwo.json.version, 2);

  const adminPromptPersisted = await request(admin.cookie, '/api/agency/prompt');
  assert.equal(adminPromptPersisted.response.status, 200, adminPromptPersisted.json.error);
  assert.equal(adminPromptPersisted.json.prompt, secondPrompt);
  assert.equal(adminPromptPersisted.json.version, 2);

  const client = await login(CLIENT_EMAIL, CLIENT_PASSWORD);
  assert.equal(client.user.role, 'owner');
  assert.equal(client.tenant.id, clientTenantId);

  const clientInvoices = await request(client.cookie, '/api/invoices');
  assert.equal(clientInvoices.response.status, 200, clientInvoices.json.error);
  assert.deepEqual(clientInvoices.json.invoices.map((row) => row.id), [clientInvoiceId]);
  assert.ok(!clientInvoices.json.invoices.some((row) => row.id === adminInvoiceId));

  const forbiddenInvoiceCreate = await request(client.cookie, '/api/invoices', {
    method: 'POST',
    body: {
      tenantId: clientTenantId,
      description: 'Owner-created revenue must be rejected.',
      amountPaise: 99999900,
      issueDate,
      dueDate,
      status: 'issued',
    },
  });
  assert.equal(forbiddenInvoiceCreate.response.status, 403);
  assert.equal(forbiddenInvoiceCreate.json.code, 'forbidden');

  const forbiddenOwnInvoiceMutation = await request(client.cookie, '/api/invoices/status', {
    method: 'POST',
    body: { invoiceId: clientInvoiceId, status: 'void' },
  });
  assert.equal(forbiddenOwnInvoiceMutation.response.status, 403);
  assert.equal(forbiddenOwnInvoiceMutation.json.code, 'forbidden');

  const crossTenantInvoiceMutation = await request(client.cookie, '/api/invoices/status', {
    method: 'POST',
    body: { invoiceId: adminInvoiceId, status: 'paid' },
  });
  assert.equal(crossTenantInvoiceMutation.response.status, 403);
  assert.equal(crossTenantInvoiceMutation.json.code, 'forbidden');

  const clientOverview = await request(client.cookie, '/api/agency/overview');
  assert.equal(clientOverview.response.status, 200, clientOverview.json.error);
  assert.equal(clientOverview.json.kpis.clients, 1);
  assert.equal(clientOverview.json.kpis.invoicedPaise, clientAmountPaise);
  assert.equal(clientOverview.json.kpis.paidPaise, clientAmountPaise);
  assert.equal(clientOverview.json.kpis.outstandingPaise, 0);
  assert.ok(clientOverview.json.comparisons.every((row) => row.tenantId === clientTenantId));
  assert.deepEqual(clientOverview.json.recent, []);

  const forbiddenApproach = await request(client.cookie, '/api/admin/client-approach', {
    method: 'POST',
    body: { tenantId: admin.tenant.id, channel: 'email', summary: 'This must be denied.' },
  });
  assert.equal(forbiddenApproach.response.status, 403);
  assert.equal(forbiddenApproach.json.code, 'forbidden');

  const clientIntegrationsBefore = await request(client.cookie, '/api/integrations');
  assert.equal(clientIntegrationsBefore.response.status, 200, clientIntegrationsBefore.json.error);
  assert.equal(clientIntegrationsBefore.json.integrations.find((row) => row.id === 'whatsapp-business').status, 'setup_required');
  assert.equal(clientIntegrationsBefore.json.integrations.find((row) => row.id === 'meta-ad-library').status, 'setup_required');

  const clientIntegrationRequest = await request(client.cookie, '/api/integrations/request', {
    method: 'POST',
    body: { integrationId: 'meta-ad-library' },
  });
  assert.equal(clientIntegrationRequest.response.status, 201, clientIntegrationRequest.json.error);
  assert.equal(clientIntegrationRequest.json.request.tenantId, clientTenantId);

  const clientIntegrationsAfter = await request(client.cookie, '/api/integrations');
  assert.equal(clientIntegrationsAfter.response.status, 200, clientIntegrationsAfter.json.error);
  assert.equal(clientIntegrationsAfter.json.integrations.find((row) => row.id === 'whatsapp-business').status, 'setup_required');
  assert.equal(clientIntegrationsAfter.json.integrations.find((row) => row.id === 'meta-ad-library').status, 'requested');

  const clientPromptBefore = await request(client.cookie, '/api/agency/prompt');
  assert.equal(clientPromptBefore.response.status, 200, clientPromptBefore.json.error);
  assert.equal(clientPromptBefore.json.prompt, '');
  assert.equal(clientPromptBefore.json.version, 0);

  const clientPromptText = 'Use a warm dental receptionist voice and escalate clinical questions to a human team member.';
  const clientPromptSaved = await request(client.cookie, '/api/agency/prompt', {
    method: 'POST',
    body: { prompt: clientPromptText },
  });
  assert.equal(clientPromptSaved.response.status, 200, clientPromptSaved.json.error);
  assert.equal(clientPromptSaved.json.version, 1);

  const clientPromptPersisted = await request(client.cookie, '/api/agency/prompt');
  assert.equal(clientPromptPersisted.response.status, 200, clientPromptPersisted.json.error);
  assert.equal(clientPromptPersisted.json.prompt, clientPromptText);
  assert.equal(clientPromptPersisted.json.version, 1);

  const badPrompt = await request(client.cookie, '/api/agency/prompt', {
    method: 'POST',
    body: { prompt: 'too short' },
  });
  assert.equal(badPrompt.response.status, 422);
  assert.equal(badPrompt.json.code, 'bad_prompt');

  const persisted = JSON.parse(await readFile(dbFile, 'utf8'));
  assert.equal(persisted.invoices.length, 2);
  assert.equal(persisted.invoices.find((row) => row.id === clientInvoiceId).status, 'paid');
  assert.equal(persisted.invoices.find((row) => row.id === adminInvoiceId).status, 'issued');
  assert.ok(persisted.invoiceEvents.some((row) => row.invoiceId === clientInvoiceId && row.type === 'paid'));
  assert.ok(persisted.clientActivities.some((row) => row.id === approached.json.activity.id));
  assert.equal(persisted.integrationRequests.length, 2);
  assert.equal(persisted.agencyPrompts.length, 2);
  if (process.platform !== 'win32') {
    assert.equal((await stat(dbFile)).mode & 0o777, 0o600);
  }
});
