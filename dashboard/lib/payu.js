/**
 * PayU India Hosted Checkout primitives.
 *
 * This module creates payment intents and verifies PayU messages. It never
 * mutates a wallet. The server must persist the returned intent before
 * checkout, call verifyPayment after a valid callback, then credit the stored
 * intent once inside its own atomic and idempotent transaction.
 */
'use strict';

const crypto = require('crypto');
const https = require('https');

const ENDPOINTS = Object.freeze({
  test: Object.freeze({
    payment: 'https://test.payu.in/_payment',
    postservice: 'https://test.payu.in/merchant/postservice?form=2',
  }),
  production: Object.freeze({
    payment: 'https://secure.payu.in/_payment',
    postservice: 'https://info.payu.in/merchant/postservice.php?form=2',
  }),
});

function sha512(value) {
  return crypto.createHash('sha512').update(String(value), 'utf8').digest('hex');
}

function requiredString(value, name, max = 255) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(`invalid ${name}`);
  }
  if (/[|\r\n]/.test(value)) throw new Error(`invalid ${name}`);
  return value;
}

function canonicalAmount(value) {
  const raw = typeof value === 'number' ? value.toFixed(2) : String(value);
  if (!/^(?:0|[1-9]\d{0,8})\.\d{2}$/.test(raw) || raw === '0.00') {
    throw new Error('invalid amount');
  }
  return raw;
}

function httpsUrl(value, name) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
  return parsed.toString();
}

function validateConfig(config) {
  const env = config && config.env === 'production' ? 'production' : 'test';
  return {
    env,
    key: requiredString(config && config.key, 'PayU key'),
    salt: requiredString(config && config.salt, 'PayU salt'),
    paymentUrl: httpsUrl((config && config.paymentUrl) || ENDPOINTS[env].payment, 'PayU payment URL'),
    postserviceUrl: httpsUrl((config && config.postserviceUrl) || ENDPOINTS[env].postservice, 'PayU postservice URL'),
  };
}

function resolvePack(packId, packs) {
  requiredString(packId, 'pack id', 64);
  if (!packs || typeof packs !== 'object' || Array.isArray(packs)) {
    throw new Error('server pack catalog required');
  }
  const pack = packs[packId];
  if (!pack || typeof pack !== 'object') throw new Error('unknown pack');
  return Object.freeze({
    id: packId,
    amount: canonicalAmount(pack.amount),
    currency: pack.currency || 'INR',
    credits: Number(pack.credits),
    productinfo: requiredString(pack.productinfo || `RapidX Voice credits, ${packId}`, 'productinfo', 100),
  });
}

/**
 * The caller supplies only packId and identity. Amount and credits always come
 * from the server-owned catalog passed as packs.
 */
function createPaymentIntent({ packId, packs, tenantId, userId, now = new Date() }) {
  const pack = resolvePack(packId, packs);
  if (pack.currency !== 'INR') throw new Error('PayU pack currency must be INR');
  if (!Number.isSafeInteger(pack.credits) || pack.credits <= 0) throw new Error('invalid credits');
  const createdAt = new Date(now).toISOString();
  return Object.freeze({
    txnid: `rxv_${crypto.randomBytes(16).toString('hex')}`,
    intentToken: crypto.randomBytes(32).toString('base64url'),
    tenantId: requiredString(tenantId, 'tenant id', 128),
    userId: requiredString(userId, 'user id', 128),
    packId: pack.id,
    amount: pack.amount,
    currency: pack.currency,
    credits: pack.credits,
    productinfo: pack.productinfo,
    status: 'pending',
    createdAt,
  });
}

function buildRequestHash(fields, salt) {
  const preimage = [
    fields.key, fields.txnid, fields.amount, fields.productinfo,
    fields.firstname, fields.email, fields.udf1 || '', fields.udf2 || '',
    fields.udf3 || '', fields.udf4 || '', fields.udf5 || '',
    '', '', '', '', '', salt,
  ].join('|');
  return sha512(preimage);
}

function buildCheckout({ intent, customer, successUrl, failureUrl, config }) {
  const cfg = validateConfig(config);
  if (!intent || intent.status !== 'pending') throw new Error('invalid payment intent');
  const fields = {
    key: cfg.key,
    txnid: requiredString(intent.txnid, 'txnid', 50),
    amount: canonicalAmount(intent.amount),
    productinfo: requiredString(intent.productinfo, 'productinfo', 100),
    firstname: requiredString(customer && customer.firstname, 'firstname', 60),
    email: requiredString(customer && customer.email, 'email', 120),
    phone: customer && customer.phone ? requiredString(String(customer.phone), 'phone', 20) : '',
    surl: httpsUrl(successUrl, 'success URL'),
    furl: httpsUrl(failureUrl, 'failure URL'),
    udf1: requiredString(intent.intentToken, 'intent token', 128),
    udf2: '', udf3: '', udf4: '', udf5: '',
  };
  fields.hash = buildRequestHash(fields, cfg.salt);
  return Object.freeze({ url: cfg.paymentUrl, fields: Object.freeze(fields) });
}

function callbackHash(payload, salt) {
  const parts = [];
  const extra = payload.additionalCharges ?? payload.additional_charges;
  if (extra !== undefined && extra !== null && String(extra) !== '') parts.push(String(extra));
  parts.push(
    salt, payload.status || '', '', '', '', '', '',
    payload.udf5 || '', payload.udf4 || '', payload.udf3 || '', payload.udf2 || '', payload.udf1 || '',
    payload.email || '', payload.firstname || '', payload.productinfo || '', payload.amount || '',
    payload.txnid || '', payload.key || '',
  );
  return sha512(parts.join('|'));
}

function safeEqualHex(a, b) {
  if (!/^[a-f0-9]{128}$/i.test(String(a)) || !/^[a-f0-9]{128}$/i.test(String(b))) return false;
  const left = Buffer.from(String(a).toLowerCase(), 'hex');
  const right = Buffer.from(String(b).toLowerCase(), 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Validate the callback against the persisted intent and checkout snapshot.
 * `creditable` only means eligible for verify_payment, never credit now.
 */
function verifyCallback({ payload, intent, customer, config }) {
  const cfg = validateConfig(config);
  if (!payload || !intent || !customer) return { valid: false, creditable: false, reason: 'missing data' };
  if (!safeEqualHex(payload.hash, callbackHash(payload, cfg.salt))) {
    return { valid: false, creditable: false, reason: 'invalid hash' };
  }
  const expected = {
    key: cfg.key,
    txnid: intent.txnid,
    amount: canonicalAmount(intent.amount),
    productinfo: intent.productinfo,
    firstname: customer.firstname,
    email: customer.email,
    udf1: intent.intentToken,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (String(payload[key] || '') !== String(value)) {
      return { valid: false, creditable: false, reason: `mismatched ${key}` };
    }
  }
  const captured = String(payload.status).toLowerCase() === 'success'
    && String(payload.unmappedstatus || '').toLowerCase() === 'captured';
  return { valid: true, creditable: captured, reason: captured ? 'requires verify_payment' : 'not captured' };
}

function buildVerifyPaymentForm(txnid, config) {
  const cfg = validateConfig(config);
  const command = 'verify_payment';
  const var1 = requiredString(txnid, 'txnid', 50);
  return {
    url: cfg.postserviceUrl,
    fields: { key: cfg.key, command, var1, hash: sha512(`${cfg.key}|${command}|${var1}|${cfg.salt}`) },
  };
}

function postForm(url, fields, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const body = new URLSearchParams(fields).toString();
    const req = https.request(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) return req.destroy(new Error('PayU response too large'));
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('PayU timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

async function verifyPayment({ intent, config, transport = postForm }) {
  const request = buildVerifyPaymentForm(intent.txnid, config);
  const response = await transport(request.url, request.fields);
  if (!response || response.status < 200 || response.status >= 300) {
    return { verified: false, reason: 'PayU HTTP failure' };
  }
  let parsed;
  try { parsed = typeof response.body === 'string' ? JSON.parse(response.body) : response.body; }
  catch (_) { return { verified: false, reason: 'invalid PayU JSON' }; }
  const detail = parsed && parsed.transaction_details && parsed.transaction_details[intent.txnid];
  if (!detail) return { verified: false, reason: 'transaction not found' };
  const amount = detail.amt ?? detail.amount;
  const state = String(detail.unmappedstatus || detail.status || '').toLowerCase();
  const payuId = detail.mihpayid ?? detail.mihpayupid;
  if (canonicalAmount(amount) !== canonicalAmount(intent.amount)) return { verified: false, reason: 'amount mismatch' };
  if (state !== 'captured') return { verified: false, reason: `not captured, ${state || 'unknown'}` };
  if (!payuId) return { verified: false, reason: 'missing PayU ID' };
  return { verified: true, reason: 'captured', payuId: String(payuId), detail };
}

function classifyBrowserReturn() {
  return Object.freeze({ credit: false, status: 'pending_verification' });
}

module.exports = {
  ENDPOINTS,
  canonicalAmount,
  createPaymentIntent,
  buildCheckout,
  buildRequestHash,
  callbackHash,
  verifyCallback,
  buildVerifyPaymentForm,
  verifyPayment,
  classifyBrowserReturn,
};
