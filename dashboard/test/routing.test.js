'use strict';
/**
 * Agent Call Routing Test Suite (Phase 5)
 *
 * Verifies:
 * 1. GET /api/routing requires authentication (401)
 * 2. GET /api/routing returns default routing state & agent projection with telephonyReady flag
 * 3. POST /api/routing/update rejects missing fields with 422
 * 4. POST /api/routing/update rejects web-only agents (no dograh_workflow_id) with 422
 * 5. POST /api/routing/update rejects cross-tenant agent assignment with 403 forbidden
 * 6. POST /api/routing/update successfully persists routing for valid telephony-ready agents
 * 7. POST /api/telephony/dial resolves tenant's configured outbound workflow and supports agentId override
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execSync } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const core = require('../lib/core');
core.loadEnv();

const DASHBOARD_DIR = path.join(__dirname, '..');
const TEST_EMAIL_A = `routing_a_${Date.now()}@routing.test`;
const TEST_EMAIL_B = `routing_b_${Date.now()}@routing.test`;
const TEST_PASS = 'RoutingTest@2026!';

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      probe.close((e) => { if (e) reject(e); else resolve(addr.port); });
    });
  });
}

async function waitForServer(baseUrl, child, readLogs) {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited during startup (code ${child.exitCode}).\nLogs:\n${readLogs()}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`Server not ready after 30s.\nLogs:\n${readLogs()}`);
}

function req(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: u.port,
      path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', ...headers },
    };
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d), headers: res.headers }); }
        catch (_) { resolve({ status: res.statusCode, body: d, headers: res.headers }); }
      });
    });
    r.on('error', reject);
    if (body !== undefined && body !== null) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

const extractCsrf = (setCookie) => {
  if (!setCookie) return '';
  const joined = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
  const m = joined.match(/csrf_token=([a-f0-9]{64})/);
  return m ? m[1] : '';
};

const extractSess = (setCookie) => {
  if (!setCookie) return '';
  const joined = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
  const m = joined.match(/rxv_sess=([a-f0-9]{64})/);
  return m ? m[1] : '';
};

test('Agent Call Routing: Inbound & Outbound Configuration, Security, and Dial Wiring', { timeout: 120000 }, async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gq-routing-test-'));
  const dbFile = path.join(tempDir, 'db.json');
  const rootDbUrl = process.env.TEST_ROOT_DATABASE_URL;

  let dbDriver = 'json';
  let finalTestDbUrl = '';
  let testDbName = '';

  if (rootDbUrl) {
    dbDriver = 'postgres';
    testDbName = `gq_rt_${Date.now()}`;
    const u = new URL(rootDbUrl);
    u.pathname = `/${testDbName}`;
    finalTestDbUrl = u.toString();
    execSync(`psql "${rootDbUrl}" -c "CREATE DATABASE ${testDbName};"`, { stdio: 'ignore' });
    execSync(`psql "${finalTestDbUrl}" -f "${path.join(DASHBOARD_DIR, '..', 'schema.sql')}"`, { stdio: 'ignore' });
  }

  // Spin up mock Dograh API server
  const mockDograhPort = await reservePort();
  const mockDograhBase = `http://127.0.0.1:${mockDograhPort}`;
  let lastDograhPut = null;
  let lastDograhDial = null;

  const mockDograhServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'PUT' && req.url.includes('/phone-numbers/')) {
        lastDograhPut = { url: req.url, body: JSON.parse(body || '{}') };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, inbound_workflow_id: lastDograhPut.body.inbound_workflow_id }));
      }
      if (req.method === 'POST' && req.url.includes('/initiate-call')) {
        lastDograhDial = { url: req.url, body: JSON.parse(body || '{}') };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ call_id: 'call_mock_123', status: 'initiated' }));
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  await new Promise((r) => mockDograhServer.listen(mockDograhPort, '127.0.0.1', r));

  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  const logs = [];

  const child = spawn(process.execPath, ['server.js'], {
    cwd: DASHBOARD_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DB_DRIVER: dbDriver,
      DATABASE_URL: finalTestDbUrl || '',
      GETQUALIFY_DB_FILE: dbFile,
      TEST_USER_EMAIL: 'admin.routing@getqualify.test',
      TEST_USER_PASSWORD: TEST_PASS,
      TEST_USER_TENANT: 'Routing Test Agency',
      TEST_USER_SUPER_ADMIN: 'true',
      PUBLIC_ORIGIN: base,
      DOGRAH_BASE_URL: mockDograhBase,
      DOGRAH_ALLOW_HTTP: 'true',
      DOGRAH_API_KEY: 'mock-dgr-key',
      DOGRAH_WORKFLOW_ID: '1',
      DOGRAH_TELEPHONY_CONFIG_ID: '5',
      DOGRAH_PHONE_NUMBER_ID: '1',
      VOBIZ_NUMBER: '+918065354620',
      REDIS_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (c) => { logs.push(c.toString()); });
  child.stderr.on('data', (c) => { logs.push(c.toString()); });

  t.after(async () => {
    mockDograhServer.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((r) => child.once('exit', r)),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    }
    await rm(tempDir, { recursive: true, force: true });
    if (dbDriver === 'postgres' && testDbName) {
      try { execSync(`psql "${rootDbUrl}" -c "DROP DATABASE IF EXISTS ${testDbName};"`, { stdio: 'ignore' }); } catch (_) {}
    }
  });

  const readLogs = () => logs.join('');
  await waitForServer(base, child, readLogs);

  // ─── 1. Setup Tenant A ───────────────────────────────────────────────────
  const signupResA = await req('POST', `${base}/api/auth/signup`, {
    email: TEST_EMAIL_A, password: TEST_PASS, businessName: 'Tenant A Dental'
  });
  assert.equal(signupResA.status, 200, 'Tenant A signup should succeed');
  const sessA = extractSess(signupResA.headers['set-cookie']);
  const csrfA = extractCsrf(signupResA.headers['set-cookie']);
  const headersA = {
    Cookie: `rxv_sess=${sessA}; csrf_token=${csrfA}`,
    'X-CSRF-Token': csrfA,
    Origin: base,
  };

  // ─── 2. Setup Tenant B ───────────────────────────────────────────────────
  const signupResB = await req('POST', `${base}/api/auth/signup`, {
    email: TEST_EMAIL_B, password: TEST_PASS, businessName: 'Tenant B HVAC'
  });
  assert.equal(signupResB.status, 200, 'Tenant B signup should succeed');
  const sessB = extractSess(signupResB.headers['set-cookie']);
  const csrfB = extractCsrf(signupResB.headers['set-cookie']);
  const headersB = {
    Cookie: `rxv_sess=${sessB}; csrf_token=${csrfB}`,
    'X-CSRF-Token': csrfB,
    Origin: base,
  };

  // ─── 3. Unauthenticated GET /api/routing -> 401 ─────────────────────────
  const unauthRes = await req('GET', `${base}/api/routing`);
  assert.equal(unauthRes.status, 401, 'GET /api/routing requires authentication');

  // ─── 4. GET /api/routing default state for Tenant A ──────────────────────
  const defaultRoutingRes = await req('GET', `${base}/api/routing`, null, headersA);
  assert.equal(defaultRoutingRes.status, 200, 'GET /api/routing should succeed for authenticated tenant');
  assert.ok(defaultRoutingRes.body.routing, 'Response must include routing object');
  assert.ok(Array.isArray(defaultRoutingRes.body.availableAgents), 'Response must include availableAgents array');
  assert.ok(defaultRoutingRes.body.routing.phoneNumber, 'Routing must include a phone number');

  // ─── 5. Create agents under Tenant A: one telephony-ready, one web-only ──
  // Telephony-ready agent (Payal with dograhWorkflowId: 2)
  const agentPayalRes = await req('POST', `${base}/api/agents`, {
    name: 'Payal - Front Desk',
    role: 'Dental Receptionist',
    systemPrompt: 'You are Payal, a friendly receptionist at Tenant A Dental clinic.',
    dograhWorkflowId: 2,
  }, headersA);
  assert.equal(agentPayalRes.status, 200, 'Creating Payal agent should succeed');
  const agentPayalId = (agentPayalRes.body.agent && agentPayalRes.body.agent.id) || agentPayalRes.body.id;

  // Telephony-ready outbound agent (Lead Qual with dograhWorkflowId: 1)
  const agentQualRes = await req('POST', `${base}/api/agents`, {
    name: 'Lead Qualification Bot',
    role: 'Lead Qualifier',
    systemPrompt: 'You qualify leads for Tenant A Dental clinic.',
    dograhWorkflowId: 1,
  }, headersA);
  assert.equal(agentQualRes.status, 200, 'Creating Lead Qual agent should succeed');
  const agentQualId = (agentQualRes.body.agent && agentQualRes.body.agent.id) || agentQualRes.body.id;

  // Web-only agent (no dograhWorkflowId)
  const agentWebRes = await req('POST', `${base}/api/agents`, {
    name: 'Web Chat Assistant',
    role: 'Website Chatbot',
    systemPrompt: 'You assist website visitors via text chat.',
  }, headersA);
  assert.equal(agentWebRes.status, 200, 'Creating Web Chat agent should succeed');
  const agentWebId = (agentWebRes.body.agent && agentWebRes.body.agent.id) || agentWebRes.body.id;

  // ─── 6. Create telephony agent under Tenant B ────────────────────────────
  const agentTenantBRes = await req('POST', `${base}/api/agents`, {
    name: 'Tenant B Bot',
    role: 'HVAC Agent',
    systemPrompt: 'HVAC bot for Tenant B.',
    dograhWorkflowId: 2,
  }, headersB);
  assert.equal(agentTenantBRes.status, 200);
  const agentTenantBId = (agentTenantBRes.body.agent && agentTenantBRes.body.agent.id) || agentTenantBRes.body.id;

  // ─── 7. Verify agent projection on GET /api/routing ─────────────────────
  const routingAfterAgents = await req('GET', `${base}/api/routing`, null, headersA);
  assert.equal(routingAfterAgents.status, 200);
  const agentsList = routingAfterAgents.body.availableAgents;
  const payalProj = agentsList.find((a) => a.id === agentPayalId);
  const webProj = agentsList.find((a) => a.id === agentWebId);

  assert.ok(payalProj, 'Payal must be listed in availableAgents');
  assert.equal(payalProj.telephonyReady, true, 'Payal with workflow 2 must be telephonyReady: true');
  assert.equal(payalProj.dograhWorkflowId, 2, 'Payal dograhWorkflowId must be 2');

  assert.ok(webProj, 'Web agent must be listed in availableAgents');
  assert.equal(webProj.telephonyReady, false, 'Web agent without workflow must be telephonyReady: false');
  assert.equal(webProj.dograhWorkflowId, null, 'Web agent dograhWorkflowId must be null');

  // ─── 8. Validation: missing fields -> 422 ────────────────────────────────
  const missingRes = await req('POST', `${base}/api/routing/update`, {
    inboundAgentId: agentPayalId,
  }, headersA);
  assert.equal(missingRes.status, 422, 'Missing outboundAgentId must return 422');
  assert.equal(missingRes.body.code, 'missing_routing_agents');

  // ─── 9. Validation: unmapped web-only agent -> 422 ───────────────────────
  const unmappedInboundRes = await req('POST', `${base}/api/routing/update`, {
    inboundAgentId: agentWebId,
    outboundAgentId: agentPayalId,
  }, headersA);
  assert.equal(unmappedInboundRes.status, 422, 'Unmapped inbound agent must return 422');
  assert.equal(unmappedInboundRes.body.code, 'agent_not_telephony_ready');

  const unmappedOutboundRes = await req('POST', `${base}/api/routing/update`, {
    inboundAgentId: agentPayalId,
    outboundAgentId: agentWebId,
  }, headersA);
  assert.equal(unmappedOutboundRes.status, 422, 'Unmapped outbound agent must return 422');
  assert.equal(unmappedOutboundRes.body.code, 'agent_not_telephony_ready');

  // ─── 10. Security: Cross-tenant agent selection -> 403 Forbidden ─────────
  const crossTenantRes = await req('POST', `${base}/api/routing/update`, {
    inboundAgentId: agentPayalId,
    outboundAgentId: agentTenantBId, // Belongs to Tenant B
  }, headersA);
  assert.equal(crossTenantRes.status, 403, 'Cross-tenant agent assignment must be blocked with 403');
  assert.equal(crossTenantRes.body.code, 'forbidden');

  // ─── 11. Happy Path: Set valid telephony routing ─────────────────────────
  const updateRes = await req('POST', `${base}/api/routing/update`, {
    inboundAgentId: agentPayalId,
    outboundAgentId: agentQualId,
    phoneNumber: '+918065354620',
  }, headersA);
  assert.equal(updateRes.status, 200, 'Valid routing update must return 200');
  assert.equal(updateRes.body.success, true);
  assert.equal(updateRes.body.routing.inboundAgentId, agentPayalId);
  assert.equal(updateRes.body.routing.outboundAgentId, agentQualId);
  assert.equal(updateRes.body.routing.dograhInboundWorkflowId, 2);
  assert.equal(updateRes.body.routing.dograhOutboundWorkflowId, 1);
  assert.ok(lastDograhPut, 'Dograh sync PUT must be invoked on routing update');
  assert.equal(lastDograhPut.body.inbound_workflow_id, 2, 'Dograh must receive inbound_workflow_id 2');

  // Subsequent GET confirms persistence
  const getPersisted = await req('GET', `${base}/api/routing`, null, headersA);
  assert.equal(getPersisted.status, 200);
  assert.equal(getPersisted.body.routing.inboundAgentId, agentPayalId);
  assert.equal(getPersisted.body.routing.outboundAgentId, agentQualId);
  assert.equal(getPersisted.body.routing.dograhInboundWorkflowId, 2);
  assert.equal(getPersisted.body.routing.dograhOutboundWorkflowId, 1);

  // ─── 12. Outbound Dial Wiring (apiTelephonyDial) ─────────────────────────
  // A) Dial without confirm returns 400 needs_confirm
  const noConfirmRes = await req('POST', `${base}/api/telephony/dial`, {
    number: '9876543210',
    confirm: false,
  }, headersA);
  assert.equal(noConfirmRes.status, 400, 'Dial without confirm must return 400');
  assert.equal(noConfirmRes.body.code, 'needs_confirm');

  // B) Dial with invalid number returns 422 bad_number
  const badNumRes = await req('POST', `${base}/api/telephony/dial`, {
    number: '123',
    confirm: true,
  }, headersA);
  assert.equal(badNumRes.status, 422, 'Dial with invalid number must return 422 bad_number');
  assert.equal(badNumRes.body.code, 'bad_number');

  // C) Tenant A places call -> resolves configured outbound workflow (Lead Qual -> workflow 1)
  const dialResA = await req('POST', `${base}/api/telephony/dial`, {
    number: '9876543210',
    confirm: true,
  }, headersA);
  assert.equal(dialResA.status, 200, 'Dial with confirm must succeed');
  assert.ok(lastDograhDial, 'Dograh initiate-call must be invoked');
  assert.equal(lastDograhDial.body.workflow_id, 1, 'Dial should resolve Tenant A outbound agent workflow_id: 1');
  assert.equal(lastDograhDial.body.phone_number, '+919876543210');

  // D) Tenant A places call with explicit agentId override -> resolves Payal workflow (workflow 2)
  const dialOverrideRes = await req('POST', `${base}/api/telephony/dial`, {
    number: '9876543210',
    confirm: true,
    agentId: agentPayalId,
  }, headersA);
  assert.equal(dialOverrideRes.status, 200, 'Dial with agentId override must succeed');
  assert.equal(lastDograhDial.body.workflow_id, 2, 'Dial with override should resolve Payal workflow_id: 2');

  // ─── 13. Phase 2: Single Active Inbound Agent & Derived Status ──────────
  // A) GET /api/agents derives isActiveInbound correctly for Tenant A
  const agentsListRes1 = await req('GET', `${base}/api/agents`, null, headersA);
  assert.equal(agentsListRes1.status, 200, 'GET /api/agents must return 200');
  const payalAgent1 = agentsListRes1.body.agents.find((a) => a.id === agentPayalId);
  const qualAgent1 = agentsListRes1.body.agents.find((a) => a.id === agentQualId);
  assert.equal(payalAgent1.isActiveInbound, true, 'Payal should have isActiveInbound: true as configured inbound agent');
  assert.equal(qualAgent1.isActiveInbound, false, 'Qual bot should have isActiveInbound: false');

  // B) Atomically reassign inbound to Lead Qual Bot (Agent B)
  const reassignRes = await req('POST', `${base}/api/routing/update`, {
    inboundAgentId: agentQualId,
    outboundAgentId: agentQualId,
    phoneNumber: '+918065354620',
  }, headersA);
  assert.equal(reassignRes.status, 200, 'Reassigning inbound agent must succeed');
  assert.equal(reassignRes.body.routing.inboundAgentId, agentQualId);

  // C) GET /api/agents now derives isActiveInbound: true for Agent B and false for Agent A
  const agentsListRes2 = await req('GET', `${base}/api/agents`, null, headersA);
  assert.equal(agentsListRes2.status, 200);
  const payalAgent2 = agentsListRes2.body.agents.find((a) => a.id === agentPayalId);
  const qualAgent2 = agentsListRes2.body.agents.find((a) => a.id === agentQualId);
  assert.equal(qualAgent2.isActiveInbound, true, 'Lead Qual Bot should now be isActiveInbound: true');
  assert.equal(payalAgent2.isActiveInbound, false, 'Payal should now be automatically unassigned (isActiveInbound: false)');

  // D) Verify Dograh was synced with Lead Qual Bot's workflow (workflow 1)
  assert.equal(lastDograhPut.body.inbound_workflow_id, 1, 'Dograh sync must receive new inbound workflow 1');
});

