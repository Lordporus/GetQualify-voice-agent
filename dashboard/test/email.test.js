'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { mkdtemp, rm } = require('node:fs/promises');
const sgMail = require('@sendgrid/mail');

const email = require('../lib/email');
const core = require('../lib/core');

test('SendGrid email adapter configuration and fail-closed validation', async (t) => {
  const origEnv = { ...process.env };
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gq-email-test-'));
  const dbFile = path.join(tempDir, 'db.json');

  process.env.GETQUALIFY_DB_FILE = dbFile;
  process.env.DB_DRIVER = 'json';
  delete process.env.SENDGRID_API_KEY;

  t.after(async () => {
    process.env = origEnv;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  assert.equal(email.isConfigured(), false);

  // Missing API key throws 503 and logs failed notification
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
  process.env.SENDGRID_API_KEY = 'SG.mock-test-key';
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

test('SendGrid sendCallSummary, sendBookingConfirmation, and sendInvoiceNotification with mocked send', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gq-email-test2-'));
  const dbFile = path.join(tempDir, 'db.json');
  const origEnv = { ...process.env };

  process.env.GETQUALIFY_DB_FILE = dbFile;
  process.env.DB_DRIVER = 'json';
  process.env.SENDGRID_API_KEY = 'SG.mock-test-key-12345';
  process.env.SENDGRID_FROM_EMAIL = 'voice@getqualify.ai';

  const tenantId = 't_email_suite';

  // Seed demo owner in JSON db so getTenantOwnerEmail can resolve
  await core.mutate((d) => {
    d.tenants.push({ id: tenantId, name: 'Acme HVAC', slug: 'acme-hvac' });
    d.users.push({ id: 'u_owner_1', tenantId, email: 'owner@acmehvac.com', role: 'owner', status: 'active' });
  });

  // Mock sgMail.send
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

  // 1. Test sendCallSummary (auto-resolves owner email)
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
  assert.equal(summaryRes.sendgridId, 'msg_sg_mock_999');

  assert.equal(capturedMsg.to, 'owner@acmehvac.com');
  assert.equal(capturedMsg.from, 'voice@getqualify.ai');
  assert.ok(capturedMsg.subject.includes('Sunita Rao'));
  assert.ok(capturedMsg.html.includes('Sunita Rao'));
  assert.ok(capturedMsg.html.includes('2m 5s'));
  assert.ok(capturedMsg.html.includes('lead_abc123'));
  assert.ok(capturedMsg.html.includes('https://blr1.vultrobjects.com/recordings/audio.wav'));

  // 2. Test sendBookingConfirmation
  const bookingRes = await email.sendBookingConfirmation(tenantId, {
    recipientEmail: 'client@customer.com',
    clientName: 'Sunita Rao',
    appointmentTime: 'Friday, Sept 5 at 10:00 AM IST',
    agentName: 'Aarti (AI Assistant)',
    calendarEventUrl: 'https://calendar.google.com/event?eid=123',
    businessName: 'Acme HVAC',
    notes: 'Please keep outdoor unit accessible.',
  });

  assert.equal(bookingRes.ok, true);
  assert.equal(capturedMsg.to, 'client@customer.com');
  assert.ok(capturedMsg.subject.includes('Confirmed'));
  assert.ok(capturedMsg.html.includes('Friday, Sept 5 at 10:00 AM IST'));
  assert.ok(capturedMsg.html.includes('Aarti (AI Assistant)'));
  assert.ok(capturedMsg.html.includes('Please keep outdoor unit accessible.'));

  // 3. Test sendInvoiceNotification
  const invoiceRes = await email.sendInvoiceNotification(tenantId, {
    invoiceId: 'INV-2026-09',
    amountInr: 4500,
    period: 'August 2026',
    dueDate: 'Sept 15, 2026',
    downloadUrl: 'https://getqualify.ai/billing/invoices/INV-2026-09.pdf',
  });

  assert.equal(invoiceRes.ok, true);
  assert.equal(capturedMsg.to, 'owner@acmehvac.com');
  assert.ok(capturedMsg.subject.includes('INV-2026-09'));
  assert.ok(capturedMsg.html.includes('₹4,500'));
  assert.ok(capturedMsg.html.includes('Sept 15, 2026'));

  // 4. Verify all notifications are logged in the DB for this tenant
  const dAfter = core.loadDb();
  const suiteNotifs = (dAfter.notifications || []).filter((n) => n.tenantId === tenantId || n.tenant_id === tenantId);
  assert.equal(suiteNotifs.length, 3);
  const types = suiteNotifs.map((n) => n.type);
  assert.deepEqual(types, ['call_summary', 'booking_confirmation', 'invoice_notification']);
  for (const notif of suiteNotifs) {
    assert.equal(notif.status, 'sent');
    assert.equal(notif.sendgridId, 'msg_sg_mock_999');
  }
});
