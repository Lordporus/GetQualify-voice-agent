'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { mkdtemp, rm } = require('node:fs/promises');
const sgMail = require('@sendgrid/mail');

const email = require('../lib/email');
const core = require('../lib/core');

test('Email adapter configuration and fail-closed validation', async (t) => {
  const origEnv = { ...process.env };
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gq-email-test-'));
  const dbFile = path.join(tempDir, 'db.json');

  process.env.GETQUALIFY_DB_FILE = dbFile;
  process.env.DB_DRIVER = 'json';
  delete process.env.RESEND_API_KEY;
  delete process.env.SENDGRID_API_KEY;

  t.after(async () => {
    process.env = origEnv;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  assert.equal(email.isConfigured(), false);

  // Missing API keys throws 503 and logs failed notification
  await assert.rejects(
    () => email.sendEmail({
      tenantId: 't_demo_email',
      to: 'client@example.com',
      subject: 'Test Subject',
      text: 'Hello world',
    }),
    (err) => err instanceof email.EmailError && err.code === 'email_not_configured'
  );

  const d = core.loadDb();
  const notif = (d.notifications || []).find((n) => n.recipientEmail === 'client@example.com');
  assert.ok(notif);
  assert.equal(notif.status, 'failed');

  // Bad email throws 422
  process.env.RESEND_API_KEY = 're_mock_test_key';
  assert.equal(email.isConfigured(), true);

  await assert.rejects(
    () => email.sendEmail({
      tenantId: 't_demo_email',
      to: 'invalid-email-no-at',
      subject: 'Test',
      text: 'Hello',
    }),
    (err) => err instanceof email.EmailError && err.code === 'bad_email'
  );
});

test('Resend primary email adapter with mocked global fetch', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gq-resend-test-'));
  const dbFile = path.join(tempDir, 'db.json');
  const origEnv = { ...process.env };
  const origFetch = globalThis.fetch;

  process.env.GETQUALIFY_DB_FILE = dbFile;
  process.env.DB_DRIVER = 'json';
  process.env.RESEND_API_KEY = 're_live_key_98765';
  process.env.RESEND_FROM_EMAIL = 'voice@getqualify.ai';
  delete process.env.SENDGRID_API_KEY;

  const tenantId = 't_email_resend_suite';

  // Seed demo owner in JSON db so getTenantOwnerEmail can resolve
  await core.mutate((d) => {
    d.tenants.push({ id: tenantId, name: 'Acme HVAC', slug: 'acme-hvac' });
    d.users.push({ id: 'u_owner_resend', tenantId, email: 'owner@acmehvac.com', role: 'owner', status: 'active' });
  });

  let capturedRequest = null;
  globalThis.fetch = async function (url, options) {
    capturedRequest = { url, ...options, bodyJson: JSON.parse(options.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 're_msg_resend_12345' }),
    };
  };

  t.after(async () => {
    globalThis.fetch = origFetch;
    process.env = origEnv;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // 1. Test sendCallSummary via Resend
  const summaryRes = await email.sendCallSummary(tenantId, {
    callerName: 'Sunita Rao',
    callerPhone: '+919876543210',
    duration: 125,
    summary: 'Customer needs AC maintenance service on Friday morning.',
    transcript: 'Customer: Hello, do you service Daikin ACs? Agent: Yes, we do.',
    leadId: 'lead_abc123',
    callId: 'call_xyz789',
    recordingUrl: 'https://blr1.vultrobjects.com/recordings/audio.wav',
  });

  assert.equal(summaryRes.ok, true);
  assert.equal(summaryRes.recipientEmail, 'owner@acmehvac.com');
  assert.equal(summaryRes.status, 'sent');
  assert.equal(summaryRes.resendId, 're_msg_resend_12345');

  assert.equal(capturedRequest.url, 'https://api.resend.com/emails');
  assert.equal(capturedRequest.headers.Authorization, 'Bearer re_live_key_98765');
  assert.deepEqual(capturedRequest.bodyJson.to, ['owner@acmehvac.com']);
  assert.equal(capturedRequest.bodyJson.from, 'voice@getqualify.ai');
  assert.ok(capturedRequest.bodyJson.subject.includes('Sunita Rao'));
  assert.ok(capturedRequest.bodyJson.html.includes('Sunita Rao'));
  assert.ok(capturedRequest.bodyJson.html.includes('2m 5s'));
  assert.ok(capturedRequest.bodyJson.html.includes('lead_abc123'));

  // 2. Verify notifications table in DB contains resend_id
  const dAfter = core.loadDb();
  const notif = (dAfter.notifications || []).find((n) => n.id === summaryRes.notificationId);
  assert.ok(notif);
  assert.equal(notif.resendId, 're_msg_resend_12345');
  assert.equal(notif.status, 'sent');
});

test('SendGrid backward-compatible fallback with mocked send', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gq-email-test2-'));
  const dbFile = path.join(tempDir, 'db.json');
  const origEnv = { ...process.env };

  process.env.GETQUALIFY_DB_FILE = dbFile;
  process.env.DB_DRIVER = 'json';
  delete process.env.RESEND_API_KEY;
  process.env.SENDGRID_API_KEY = 'SG.mock-test-key-12345';
  process.env.SENDGRID_FROM_EMAIL = 'voice@getqualify.ai';

  const tenantId = 't_email_suite';

  await core.mutate((d) => {
    d.tenants.push({ id: tenantId, name: 'Acme HVAC', slug: 'acme-hvac' });
    d.users.push({ id: 'u_owner_1', tenantId, email: 'owner@acmehvac.com', role: 'owner', status: 'active' });
  });

  let capturedMsg = null;
  const origSend = sgMail.send;
  sgMail.send = async function (msg) {
    capturedMsg = msg;
    return [{ statusCode: 202, headers: { 'x-message-id': 'msg_sg_mock_999' } }];
  };

  t.after(async () => {
    sgMail.send = origSend;
    process.env = origEnv;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  const summaryRes = await email.sendCallSummary(tenantId, {
    callerName: 'Sunita Rao',
    callerPhone: '+919876543210',
    duration: 125,
    summary: 'Customer needs AC maintenance service on Friday morning.',
    transcript: 'Customer: Hello, do you service Daikin ACs? Agent: Yes, we do.',
  });

  assert.equal(summaryRes.ok, true);
  assert.equal(summaryRes.recipientEmail, 'owner@acmehvac.com');
  assert.equal(summaryRes.status, 'sent');
  assert.equal(summaryRes.sendgridId, 'msg_sg_mock_999');
  assert.equal(capturedMsg.to, 'owner@acmehvac.com');
});
