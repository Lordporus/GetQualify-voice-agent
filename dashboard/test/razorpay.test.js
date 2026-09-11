'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const razorpay = require('../lib/razorpay');

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

test('Razorpay Unit Tests: Configuration, Order Creation, & Signature Verification', async (t) => {
  await t.test('isConfigured() reflects environment credentials', () => {
    const origKey = process.env.RAZORPAY_KEY_ID;
    const origSec = process.env.RAZORPAY_KEY_SECRET;
    try {
      delete process.env.RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_SECRET;
      assert.strictEqual(razorpay.isConfigured(), false);

      process.env.RAZORPAY_KEY_ID = 'rzp_test_123';
      assert.strictEqual(razorpay.isConfigured(), false);

      process.env.RAZORPAY_KEY_SECRET = 'secret_abc';
      assert.strictEqual(razorpay.isConfigured(), true);
    } finally {
      if (origKey) process.env.RAZORPAY_KEY_ID = origKey; else delete process.env.RAZORPAY_KEY_ID;
      if (origSec) process.env.RAZORPAY_KEY_SECRET = origSec; else delete process.env.RAZORPAY_KEY_SECRET;
    }
  });

  await t.test('createOrder() rejects when not configured', async () => {
    const origKey = process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_ID;
    try {
      await assert.rejects(
        () => razorpay.createOrder({ amountPaise: 20000 }),
        (err) => err instanceof razorpay.RazorpayError && err.code === 'not_configured'
      );
    } finally {
      if (origKey) process.env.RAZORPAY_KEY_ID = origKey;
    }
  });

  await t.test('createOrder() rejects invalid amounts', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
    process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';
    try {
      await assert.rejects(
        () => razorpay.createOrder({ amountPaise: 0 }),
        (err) => err instanceof razorpay.RazorpayError && err.code === 'invalid_amount'
      );
      await assert.rejects(
        () => razorpay.createOrder({ amountPaise: -500 }),
        (err) => err instanceof razorpay.RazorpayError && err.code === 'invalid_amount'
      );
    } finally {
      delete process.env.RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_SECRET;
    }
  });

  await t.test('verifyPaymentSignature() verifies valid HMAC and rejects tampering', () => {
    const secret = 'rzp_secret_xyz123';
    process.env.RAZORPAY_KEY_SECRET = secret;
    try {
      const orderId = 'order_test_987';
      const paymentId = 'pay_test_654';
      const validSig = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

      assert.strictEqual(razorpay.verifyPaymentSignature({ orderId, paymentId, signature: validSig }), true);
      assert.strictEqual(razorpay.verifyPaymentSignature({ orderId, paymentId, signature: 'tampered_signature' }), false);
      assert.strictEqual(razorpay.verifyPaymentSignature({ orderId: 'other_order', paymentId, signature: validSig }), false);
    } finally {
      delete process.env.RAZORPAY_KEY_SECRET;
    }
  });
});

test('Razorpay Integration: Order API, Webhook Reconciliation, & Idempotency', async (t) => {
  const DASHBOARD_DIR = path.join(__dirname, '..');
  const dbFile = path.join(DASHBOARD_DIR, `test-rzp-${Date.now()}.json`);
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  const webhookSecret = 'test_rzp_wh_sec_' + Date.now();
  const rzpKeyId = 'rzp_test_keyid_' + Date.now();
  const rzpKeySec = 'rzp_test_keysec_' + Date.now();

  const child = spawn(process.execPath, ['server.js'], {
    cwd: DASHBOARD_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DB_DRIVER: 'json',
      GETQUALIFY_DB_FILE: dbFile,
      TEST_USER_EMAIL: 'rzp.admin@getqualify.test',
      TEST_USER_PASSWORD: 'Password123!',
      TEST_USER_TENANT: 'Razorpay Test Tenant',
      PUBLIC_ORIGIN: base,
      RAZORPAY_KEY_ID: rzpKeyId,
      RAZORPAY_KEY_SECRET: rzpKeySec,
      RAZORPAY_WEBHOOK_SECRET: webhookSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  t.after(async () => {
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

  // Authenticate as owner
  const loginRes = await req('POST', `${base}/api/auth/login`, {
    email: 'rzp.admin@getqualify.test',
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

  // 1. Check wallet balance initially
  const initialWalletRes = await req('GET', `${base}/api/wallet`, null, authHeaders);
  assert.strictEqual(initialWalletRes.status, 200);
  const initialBalance = initialWalletRes.body.wallet.balancePaise || 0;

  // 2. Mock https.request in Razorpay library inside child:
  // Instead of actually reaching api.razorpay.com on the network, we test validation & webhook processing.
  await t.test('POST /api/billing/razorpay/order: validates packId', async () => {
    const badPack = await req('POST', `${base}/api/billing/razorpay/order`, { packId: 'nonexistent' }, authHeaders);
    assert.strictEqual(badPack.status, 422);
    assert.strictEqual(badPack.body.code, 'bad_pack');
  });

  // 3. Webhook reconciliation & Idempotency
  const testPaymentId = 'pay_rzp_capture_' + Date.now();
  const testOrderId = 'order_rzp_ord_' + Date.now();
  const amountPaise = 20000; // Starter pack: ₹200 = 20000 paise
  const tenantId = loginRes.body.user.tenantId;

  const webhookPayload = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: testPaymentId,
          order_id: testOrderId,
          amount: amountPaise,
          currency: 'INR',
          status: 'captured',
          notes: {
            tenant_id: tenantId,
            pack_id: 'starter',
          },
        },
      },
    },
  });

  const webhookSig = crypto.createHmac('sha256', webhookSecret).update(webhookPayload).digest('hex');

  await t.test('POST /api/webhooks/razorpay: credits wallet on payment.captured', async () => {
    const whRes = await req('POST', `${base}/api/webhooks/razorpay`, webhookPayload, {
      'Content-Type': 'application/json',
      'x-razorpay-signature': webhookSig,
    });
    assert.strictEqual(whRes.status, 200, JSON.stringify(whRes.body));
    assert.strictEqual(whRes.body.ok, true);

    // Verify wallet updated
    const afterWalletRes = await req('GET', `${base}/api/wallet`, null, authHeaders);
    assert.strictEqual(afterWalletRes.status, 200);
    const newBalance = afterWalletRes.body.wallet.balancePaise;
    assert.strictEqual(newBalance, initialBalance + amountPaise, 'Wallet must be credited with 20000 paise');

    // Verify ledger entry
    const ledger = afterWalletRes.body.ledger || [];
    const entry = ledger.find((l) => l.idempotencyKey === testPaymentId || l.type === 'razorpay_payment');
    assert.ok(entry, 'Ledger entry for razorpay_payment must exist');
    assert.strictEqual(Number(entry.amountPaise), amountPaise);
  });

  await t.test('POST /api/webhooks/razorpay: idempotent duplicate does not double credit', async () => {
    // Send identical webhook payload
    const whDup = await req('POST', `${base}/api/webhooks/razorpay`, webhookPayload, {
      'Content-Type': 'application/json',
      'x-razorpay-signature': webhookSig,
    });
    assert.strictEqual(whDup.status, 200);
    assert.strictEqual(whDup.body.duplicate, true, 'Duplicate webhook must be detected');

    // Balance must remain unchanged
    const afterDupWalletRes = await req('GET', `${base}/api/wallet`, null, authHeaders);
    const dupBalance = afterDupWalletRes.body.wallet.balancePaise;
    assert.strictEqual(dupBalance, initialBalance + amountPaise, 'Balance must NOT increase on duplicate webhook');
  });

  await t.test('PayU payment intent endpoint continues working unchanged', async () => {
    const payuRes = await req('POST', `${base}/api/payment-intents`, { packId: 'growth' }, authHeaders);
    assert.strictEqual(payuRes.status, 201, 'PayU payment intent creation must succeed');
    assert.ok(payuRes.body.paymentIntent, 'Payment intent object must be returned');
    assert.strictEqual(payuRes.body.paymentIntent.provider, 'payu');
    assert.strictEqual(payuRes.body.paymentIntent.packId, 'growth');
  });
});
