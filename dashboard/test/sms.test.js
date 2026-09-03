'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const smsPath = require.resolve('../lib/sms');
const corePath = require.resolve('../lib/core');
const originalEnv = { ...process.env };

function resetEnv(values = {}) {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv, values);
  for (const key of ['MSG91_AUTH_KEY', 'MSG91_SENDER_ID', 'MSG91_MISSED_CALL_TEMPLATE_ID', 'MSG91_BOOKING_TEMPLATE_ID', 'MSG91_REMINDER_TEMPLATE_ID']) {
    if (!(key in values)) delete process.env[key];
  }
}

function loadSms(httpsPost) {
  delete require.cache[smsPath];
  delete require.cache[corePath];
  const core = require(corePath);
  if (httpsPost) core.httpsPost = httpsPost;
  require.cache[corePath].exports = core;
  return require(smsPath);
}

test.afterEach(() => {
  resetEnv();
  delete require.cache[smsPath];
  delete require.cache[corePath];
});

test('normalizePhoneForMsg91 normalizes bare Indian, prefixed, and international numbers', () => {
  const sms = loadSms();
  assert.equal(sms.normalizePhoneForMsg91('9876543210'), '919876543210');
  assert.equal(sms.normalizePhoneForMsg91('09876543210'), '919876543210');
  assert.equal(sms.normalizePhoneForMsg91('+919876543210'), '919876543210');
  assert.equal(sms.normalizePhoneForMsg91('919876543210'), '919876543210');
  assert.equal(sms.normalizePhoneForMsg91('+14155552671'), '14155552671');
  assert.equal(sms.normalizePhoneForMsg91(''), '');
});

test('sms send validates environment and parameters fail-closed', async () => {
  resetEnv(); // No MSG91_AUTH_KEY
  const sms = loadSms();

  await assert.rejects(
    () => sms.send({ to: '9876543210', templateId: 'tpl_123' }),
    (err) => err.code === 'sms_not_configured',
  );

  resetEnv({ MSG91_AUTH_KEY: 'test-key' });
  const configuredSms = loadSms();

  await assert.rejects(
    () => configuredSms.send({ to: '123', templateId: 'tpl_123' }),
    (err) => err.code === 'bad_number',
  );

  await assert.rejects(
    () => configuredSms.send({ to: '9876543210', templateId: '' }),
    (err) => err.code === 'missing_template',
  );
});

test('sms send makes mocked HTTPS post to MSG91 flow API with correct structure', async () => {
  resetEnv({ MSG91_AUTH_KEY: 'secret-auth-key', MSG91_SENDER_ID: 'RAPIDX' });
  let request;
  const sms = loadSms(async (host, path, headers, body) => {
    request = { host, path, headers, payload: JSON.parse(body.toString('utf8')) };
    return {
      status: 200,
      headers: {},
      buffer: Buffer.from(JSON.stringify({ type: 'success', message: 'SMS sent successfully' })),
    };
  });

  const res = await sms.send({
    to: '+91 98765 43210',
    templateId: 'tpl_test_flow',
    variables: { client_name: 'Aditi', amount: '500' },
  });

  assert.equal(request.host, 'api.msg91.com');
  assert.equal(request.path, '/api/v5/flow/');
  assert.equal(request.headers.authkey, 'secret-auth-key');
  assert.equal(request.headers['Content-Type'], 'application/json');
  assert.equal(request.payload.template_id, 'tpl_test_flow');
  assert.equal(request.payload.sender, 'RAPIDX');
  assert.equal(request.payload.recipients[0].mobiles, '919876543210');
  assert.equal(request.payload.recipients[0].client_name, 'Aditi');
  assert.equal(res.status, 200);
});

test('sms helper methods format missed-call and booking payloads', async () => {
  resetEnv({
    MSG91_AUTH_KEY: 'auth-key',
    MSG91_MISSED_CALL_TEMPLATE_ID: 'tpl_missed',
    MSG91_BOOKING_TEMPLATE_ID: 'tpl_booked',
  });

  let lastPayload;
  const sms = loadSms(async (_h, _p, _hd, body) => {
    lastPayload = JSON.parse(body.toString('utf8'));
    return { status: 200, buffer: Buffer.from(JSON.stringify({ type: 'success' })) };
  });

  // Missed call text back
  await sms.sendMissedCallTextBack('9876543210', {
    businessName: 'Acme HVAC',
    callbackNumber: '+919999999999',
  });
  assert.equal(lastPayload.template_id, 'tpl_missed');
  assert.equal(lastPayload.recipients[0].mobiles, '919876543210');
  assert.equal(lastPayload.recipients[0].business_name, 'Acme HVAC');
  assert.equal(lastPayload.recipients[0].callback_number, '+919999999999');

  // Booking confirmation
  await sms.sendAppointmentConfirmation('+14155552671', {
    businessName: 'Dr. Smile Dental',
    appointmentTime: 'Tomorrow at 10 AM',
    agentName: 'Aarav',
  });
  assert.equal(lastPayload.template_id, 'tpl_booked');
  assert.equal(lastPayload.recipients[0].mobiles, '14155552671');
  assert.equal(lastPayload.recipients[0].business_name, 'Dr. Smile Dental');
  assert.equal(lastPayload.recipients[0].appointment_time, 'Tomorrow at 10 AM');
  assert.equal(lastPayload.recipients[0].agent_name, 'Aarav');
});
