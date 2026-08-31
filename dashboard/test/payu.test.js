'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const payu = require('../lib/payu');

const config = { env: 'test', key: 'merchant-key', salt: 'merchant-salt' };
const packs = Object.freeze({
  starter: Object.freeze({ amount: '200.00', credits: 200, currency: 'INR', productinfo: 'Starter voice credits' }),
});
const customer = { firstname: 'Shreyas', email: 'billing@example.com', phone: '9999999999' };

function fixture() {
  const intent = payu.createPaymentIntent({ packId: 'starter', packs, tenantId: 'tenant-1', userId: 'user-1' });
  const checkout = payu.buildCheckout({
    intent, customer, config,
    successUrl: 'https://voice.example.com/api/billing/payu/return',
    failureUrl: 'https://voice.example.com/api/billing/payu/return',
  });
  return { intent, checkout };
}

test('uses only the server pack catalog and creates opaque identifiers', () => {
  const a = payu.createPaymentIntent({ packId: 'starter', packs, tenantId: 'tenant-1', userId: 'user-1' });
  const b = payu.createPaymentIntent({ packId: 'starter', packs, tenantId: 'tenant-1', userId: 'user-1' });
  assert.equal(a.amount, '200.00');
  assert.equal(a.credits, 200);
  assert.notEqual(a.txnid, b.txnid);
  assert.notEqual(a.intentToken, b.intentToken);
  assert.throws(() => payu.createPaymentIntent({ packId: 'missing', packs, tenantId: 't', userId: 'u' }), /unknown pack/);
});

test('builds a signed sandbox checkout without exposing salt', () => {
  const { intent, checkout } = fixture();
  assert.equal(checkout.url, payu.ENDPOINTS.test.payment);
  assert.equal(checkout.fields.udf1, intent.intentToken);
  assert.equal(checkout.fields.udf2, '');
  assert.match(checkout.fields.hash, /^[a-f0-9]{128}$/);
  assert.equal(JSON.stringify(checkout).includes(config.salt), false);
});

test('validates a captured callback and requires server verification', () => {
  const { intent, checkout } = fixture();
  const payload = { ...checkout.fields, status: 'success', unmappedstatus: 'captured' };
  payload.hash = payu.callbackHash(payload, config.salt);
  const result = payu.verifyCallback({ payload, intent, customer, config });
  assert.deepEqual(result, { valid: true, creditable: true, reason: 'requires verify_payment' });
});

test('uses PayU exact request and reverse hash pipe sequences', () => {
  const { checkout } = fixture();
  const requestPreimage = `${checkout.fields.key}|${checkout.fields.txnid}|${checkout.fields.amount}|${checkout.fields.productinfo}|${checkout.fields.firstname}|${checkout.fields.email}|${checkout.fields.udf1}|${checkout.fields.udf2}|${checkout.fields.udf3}|${checkout.fields.udf4}|${checkout.fields.udf5}||||||${config.salt}`;
  assert.equal(checkout.fields.hash, crypto.createHash('sha512').update(requestPreimage).digest('hex'));

  const payload = { ...checkout.fields, status: 'success', unmappedstatus: 'captured' };
  const reversePreimage = `${config.salt}|success||||||${payload.udf5}|${payload.udf4}|${payload.udf3}|${payload.udf2}|${payload.udf1}|${payload.email}|${payload.firstname}|${payload.productinfo}|${payload.amount}|${payload.txnid}|${payload.key}`;
  assert.equal(payu.callbackHash(payload, config.salt), crypto.createHash('sha512').update(reversePreimage).digest('hex'));
});

test('rejects tampering and handles additional charges hash order', () => {
  const { intent, checkout } = fixture();
  const payload = { ...checkout.fields, status: 'success', unmappedstatus: 'captured', additionalCharges: '5.00' };
  payload.hash = payu.callbackHash(payload, config.salt);
  assert.equal(payu.verifyCallback({ payload, intent, customer, config }).valid, true);
  payload.amount = '2000.00';
  assert.equal(payu.verifyCallback({ payload, intent, customer, config }).valid, false);
});

test('builds verify_payment hash and accepts only matching captured results', async () => {
  const { intent } = fixture();
  const request = payu.buildVerifyPaymentForm(intent.txnid, config);
  assert.equal(request.url, payu.ENDPOINTS.test.postservice);
  assert.match(request.fields.hash, /^[a-f0-9]{128}$/);
  const transport = async () => ({
    status: 200,
    body: JSON.stringify({ transaction_details: { [intent.txnid]: { status: 'captured', amt: '200.00', mihpayid: 'payu-123' } } }),
  });
  const result = await payu.verifyPayment({ intent, config, transport });
  assert.equal(result.verified, true);
  assert.equal(result.payuId, 'payu-123');
  const mismatch = async () => ({
    status: 200,
    body: JSON.stringify({ transaction_details: { [intent.txnid]: { status: 'captured', amt: '201.00', mihpayid: 'payu-123' } } }),
  });
  assert.equal((await payu.verifyPayment({ intent, config, transport: mismatch })).verified, false);
});

test('browser return can never credit a wallet', () => {
  assert.deepEqual(payu.classifyBrowserReturn(), { credit: false, status: 'pending_verification' });
});
