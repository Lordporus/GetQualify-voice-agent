'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

function req(method, urlStr, body, headers = {}) {
  const u = new URL(urlStr);
  const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
  const h = { ...headers };
  if (data) {
    if (!h['Content-Type']) h['Content-Type'] = 'application/json';
    h['Content-Length'] = Buffer.byteLength(data);
  }
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: h,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function reservePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test('Zapier & n8n Outbound Webhook Lifecycle, Ping, & Event Dispatches', async (t) => {
  const DASHBOARD_DIR = path.join(__dirname, '..');
  const dbFile = path.join(DASHBOARD_DIR, `test-wh-${Date.now()}.json`);
  const serverPort = await reservePort();
  const receiverPort = await reservePort();
  const base = `http://127.0.0.1:${serverPort}`;
  const dograhSecret = 'dograh_test_sec_' + Date.now();

  // 1. Setup mock receiver server (simulating Zapier / n8n webhook URL)
  const receivedRequests = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch (_) { parsed = body; }
      receivedRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsed,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ received: true }));
    });
  });

  await new Promise((resolve) => receiver.listen(receiverPort, '127.0.0.1', resolve));

  // 2. Start GetQualify server
  const child = spawn(process.execPath, ['server.js'], {
    cwd: DASHBOARD_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(serverPort),
      DB_DRIVER: 'json',
      GETQUALIFY_DB_FILE: dbFile,
      TEST_USER_EMAIL: 'wh.admin@getqualify.test',
      TEST_USER_PASSWORD: 'Password123!',
      TEST_USER_TENANT: 'Webhook Test Tenant',
      PUBLIC_ORIGIN: base,
      DOGRAH_WEBHOOK_SECRET: dograhSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
    receiver.close();
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((r) => child.once('exit', r)),
        new Promise((r) => setTimeout(r, 4000)),
      ]);
    }
    try { fs.unlinkSync(dbFile); } catch (_) {}
  });

  // Wait for server ready
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const h = await req('GET', `${base}/api/health`);
      if (h.status === 200) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(ready, 'Server failed to start');

  // Authenticate as tenant owner
  const loginRes = await req('POST', `${base}/api/auth/login`, {
    email: 'wh.admin@getqualify.test',
    password: 'Password123!',
  });
  assert.strictEqual(loginRes.status, 200, 'Login failed');
  const setCookie = loginRes.headers['set-cookie'] || [];
  const joinedCookie = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie);
  const sessMatch = joinedCookie.match(/rxv_sess=([^;]+)/);
  const csrfMatch = joinedCookie.match(/csrf_token=([^;]+)/);
  const sessionCookie = `${sessMatch ? sessMatch[0] : ''}; ${csrfMatch ? csrfMatch[0] : ''}`;
  const csrfToken = csrfMatch ? csrfMatch[1] : '';
  const authHeaders = {
    Cookie: sessionCookie,
    'X-CSRF-Token': csrfToken,
  };

  const userTenantId = loginRes.body.tenant?.id || loginRes.body.user?.tenantId;

  async function waitForRequest(predicate, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const match = receivedRequests.find(predicate);
      if (match) return match;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  const receiverUrl = `http://127.0.0.1:${receiverPort}/webhook-target`;
  let endpointId = '';
  let endpointSecret = '';

  // 3. Register webhook endpoint
  await t.test('POST /api/webhooks/endpoints registers endpoint and returns secret', async () => {
    const regRes = await req('POST', `${base}/api/webhooks/endpoints`, {
      url: receiverUrl,
      events: ['ping', 'call.completed', 'lead.created', 'lead.updated', 'booking.created'],
    }, authHeaders);

    assert.strictEqual(regRes.status, 201, JSON.stringify(regRes.body));
    assert.ok(regRes.body.endpoint);
    assert.ok(regRes.body.secret);
    endpointId = regRes.body.endpoint.id;
    endpointSecret = regRes.body.secret;
  });

  // 4. List webhook endpoints
  await t.test('GET /api/webhooks/endpoints lists registered endpoint', async () => {
    const listRes = await req('GET', `${base}/api/webhooks/endpoints`, null, authHeaders);
    assert.strictEqual(listRes.status, 200);
    assert.ok(Array.isArray(listRes.body.endpoints));
    const found = listRes.body.endpoints.find((ep) => ep.id === endpointId);
    assert.ok(found, 'Registered endpoint must be listed');
    assert.strictEqual(found.url, receiverUrl);
  });

  // 5. Test Ping endpoint
  await t.test('POST /api/webhooks/endpoints/:id/ping dispatches signed ping', async () => {
    const pingRes = await req('POST', `${base}/api/webhooks/endpoints/${encodeURIComponent(endpointId)}/ping`, {}, authHeaders);
    assert.strictEqual(pingRes.status, 200, JSON.stringify(pingRes.body));
    assert.strictEqual(pingRes.body.ok, true);
    assert.strictEqual(pingRes.body.status, 200);
    assert.ok(typeof pingRes.body.latencyMs === 'number');

    // Verify mock receiver received ping
    const pingReq = await waitForRequest((r) => r.body?.event === 'ping');
    assert.ok(pingReq, 'Receiver must receive ping event');
    const sentSig = pingReq.headers['x-getqualify-signature'];
    assert.ok(sentSig, 'X-GetQualify-Signature header must be present');

    const expectedSig = crypto.createHmac('sha256', endpointSecret).update(JSON.stringify(pingReq.body)).digest('hex');
    assert.strictEqual(sentSig, expectedSig, 'Signature must match HMAC-SHA256 of payload');
  });

  // 6. Test lead.created webhook dispatch
  let createdLeadId = '';
  await t.test('POST /api/leads emits lead.created webhook', async () => {
    const createRes = await req('POST', `${base}/api/leads`, {
      name: 'Webhook Lead User',
      phone: '9988776655',
      source: 'api_test',
    }, authHeaders);
    assert.strictEqual(createRes.status, 200);
    createdLeadId = createRes.body.lead.id;

    // Allow async webhook dispatch
    const leadEvent = await waitForRequest((r) => r.body?.event === 'lead.created' && r.body?.data?.phone === '9988776655');
    assert.ok(leadEvent, 'Receiver must receive lead.created event');
  });

  // 7. Test lead.updated webhook dispatch
  await t.test('PATCH /api/leads/:id emits lead.updated webhook', async () => {
    const patchRes = await req('PATCH', `${base}/api/leads/${createdLeadId}`, {
      status: 'contacted',
      notes: 'Spoke with client about pricing',
    }, authHeaders);
    assert.strictEqual(patchRes.status, 200);

    // Allow async webhook dispatch
    const updateEvent = await waitForRequest((r) => r.body?.event === 'lead.updated' && r.body?.data?.leadId === createdLeadId);
    assert.ok(updateEvent, 'Receiver must receive lead.updated event');
  });

  // 8. Test call.completed webhook dispatch from Dograh callback
  await t.test('POST /api/webhooks/dograh/call-completed emits call.completed webhook', async () => {
    const dograhRes = await req('POST', `${base}/api/webhooks/dograh/call-completed`, {
      tenant_id: userTenantId,
      call_id: 'call_test_' + Date.now(),
      caller_number: '919876543210',
      duration: 75,
      status: 'completed',
      gathered_context: { summary: 'Interested in property listing' },
    }, {
      'X-Dograh-Webhook-Secret': dograhSecret,
    });
    assert.strictEqual(dograhRes.status, 200);

    // Allow async webhook dispatch
    const callEvent = await waitForRequest((r) => r.body?.event === 'call.completed');
    assert.ok(callEvent, 'Receiver must receive call.completed event');
  });

  // 9. Delete endpoint
  await t.test('DELETE /api/webhooks/endpoints/:id deletes endpoint', async () => {
    const delRes = await req('DELETE', `${base}/api/webhooks/endpoints/${encodeURIComponent(endpointId)}`, null, authHeaders);
    assert.strictEqual(delRes.status, 200);

    const listResAfter = await req('GET', `${base}/api/webhooks/endpoints`, null, authHeaders);
    const foundAfter = (listResAfter.body.endpoints || []).find((ep) => ep.id === endpointId);
    assert.strictEqual(foundAfter, undefined, 'Endpoint must be deleted');
  });
});
