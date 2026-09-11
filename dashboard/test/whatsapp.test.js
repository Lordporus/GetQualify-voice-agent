'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const whatsapp = require('../lib/whatsapp');
const core = require('../lib/core');

test('WhatsApp Adapter Unit Tests: Normalization, Helpers, & Audit Trail', async (t) => {
  await t.test('normalizePhone() normalizes Indian and international numbers to digits without +', () => {
    assert.strictEqual(whatsapp.normalizePhone('9876543210'), '919876543210');
    assert.strictEqual(whatsapp.normalizePhone('+919876543210'), '919876543210');
    assert.strictEqual(whatsapp.normalizePhone('09876543210'), '919876543210');
    assert.strictEqual(whatsapp.normalizePhone('+14155552671'), '14155552671');
    assert.strictEqual(whatsapp.normalizePhone(''), '');
  });

  await t.test('isConfigured() checks environment credentials', () => {
    const origToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const origId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    try {
      delete process.env.WHATSAPP_ACCESS_TOKEN;
      delete process.env.WHATSAPP_PHONE_NUMBER_ID;
      assert.strictEqual(whatsapp.isConfigured(), false);

      process.env.WHATSAPP_ACCESS_TOKEN = 'mock_token';
      assert.strictEqual(whatsapp.isConfigured(), false);

      process.env.WHATSAPP_PHONE_NUMBER_ID = '123456789';
      assert.strictEqual(whatsapp.isConfigured(), true);
    } finally {
      if (origToken) process.env.WHATSAPP_ACCESS_TOKEN = origToken; else delete process.env.WHATSAPP_ACCESS_TOKEN;
      if (origId) process.env.WHATSAPP_PHONE_NUMBER_ID = origId; else delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    }
  });

  await t.test('verifyChallenge() validates Meta webhook challenge', () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'secret_verify_token_123';
    try {
      const goodReq = {
        url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=secret_verify_token_123&hub.challenge=challenge_code_999',
      };
      assert.strictEqual(whatsapp.verifyChallenge(goodReq), 'challenge_code_999');

      const badReq = {
        url: '/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong_token&hub.challenge=challenge_code_999',
      };
      assert.strictEqual(whatsapp.verifyChallenge(badReq), null);
    } finally {
      delete process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    }
  });

  await t.test('verifyWebhookSignature() validates HMAC-SHA256 signature', () => {
    const appSecret = 'meta_app_secret_abc';
    process.env.WHATSAPP_APP_SECRET = appSecret;
    try {
      const payload = '{"object":"whatsapp_business_account"}';
      const sig = 'sha256=' + crypto.createHmac('sha256', appSecret).update(payload).digest('hex');

      assert.strictEqual(whatsapp.verifyWebhookSignature(payload, sig), true);
      assert.strictEqual(whatsapp.verifyWebhookSignature(payload, 'sha256=invalid_sig'), false);
    } finally {
      delete process.env.WHATSAPP_APP_SECRET;
    }
  });

  await t.test('logMessage() records message into audit store', async () => {
    const tenantId = 'ten_test_' + Date.now();
    const phone = '919876543210';
    const templateName = 'booking_confirmation';

    const msgId = await whatsapp.logMessage({
      tenantId,
      recipientPhone: phone,
      templateName,
      status: 'sent',
      metaMessageId: 'wamid.HBgLMTIzNDU2',
      payload: { customerName: 'Ravi Kumar', serviceName: 'AC Service' },
    });

    assert.ok(msgId.startsWith('wamsg_'), 'Message ID must be generated with wamsg_ prefix');

    // Verify in JSON database store
    const dbData = core.db();
    const recorded = (dbData.whatsappMessages || []).find((m) => m.id === msgId);
    assert.ok(recorded, 'Message must be recorded in whatsappMessages collection');
    assert.strictEqual(recorded.tenantId, tenantId);
    assert.strictEqual(recorded.recipientPhone, phone);
    assert.strictEqual(recorded.templateName, templateName);
    assert.strictEqual(recorded.status, 'sent');
    assert.strictEqual(recorded.metaMessageId, 'wamid.HBgLMTIzNDU2');
  });

  await t.test('sendBookingConfirmation() and sendCallFollowup() record audit logs even without credentials', async () => {
    delete process.env.WHATSAPP_ACCESS_TOKEN;
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;

    const tenantId = 'ten_booking_' + Date.now();
    const phone = '9876543210';

    // 1. sendBookingConfirmation
    const bookRes = await whatsapp.sendBookingConfirmation(phone, {
      tenantId,
      customerName: 'Aarav',
      serviceName: 'Hair Cut',
      timeString: 'Tomorrow at 4:00 PM',
      address: 'Shop 4, Bandra West',
    });
    assert.strictEqual(bookRes.code, 'missing_credentials');

    const dbData = core.db();
    const bookingAudit = (dbData.whatsappMessages || []).find((m) => m.tenantId === tenantId && m.templateName === 'booking_confirmation');
    assert.ok(bookingAudit, 'Booking confirmation must log audit record even on missing creds');
    assert.strictEqual(bookingAudit.status, 'failed');

    // 2. sendCallFollowup
    const followRes = await whatsapp.sendCallFollowup(phone, {
      tenantId,
      customerName: 'Priya',
      summary: 'Discussed 3 BHK apartment in Whitefield',
    });
    assert.strictEqual(followRes.code, 'missing_credentials');

    const followAudit = (dbData.whatsappMessages || []).find((m) => m.tenantId === tenantId && m.templateName === 'call_followup');
    assert.ok(followAudit, 'Call followup must log audit record');
    assert.strictEqual(followAudit.status, 'failed');
  });
});
