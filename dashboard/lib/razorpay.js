'use strict';

/**
 * Razorpay Payment Gateway Adapter.
 * Zero external SDKs — native Node.js https + crypto.
 */

const https = require('https');
const crypto = require('crypto');

const RAZORPAY_API_HOST = 'api.razorpay.com';

class RazorpayError extends Error {
  constructor(message, status = 502, code = 'razorpay_error', detail = null) {
    super(message);
    this.name = 'RazorpayError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function getCredentials() {
  return {
    keyId: String(process.env.RAZORPAY_KEY_ID || '').trim(),
    keySecret: String(process.env.RAZORPAY_KEY_SECRET || '').trim(),
  };
}

function isConfigured() {
  const { keyId, keySecret } = getCredentials();
  return Boolean(keyId && keySecret);
}

/**
 * Creates an order in Razorpay.
 * @param {Object} params
 * @param {number} params.amountPaise - Amount in smallest currency sub-unit (paise for INR)
 * @param {string} [params.currency='INR'] - 3-letter ISO currency code
 * @param {string} [params.receipt] - Unique receipt ID for bookkeeping
 * @param {Object} [params.notes={}] - Key-value metadata passed through to payment webhooks
 * @returns {Promise<Object>} Razorpay Order Object
 */
function createOrder({ amountPaise, currency = 'INR', receipt, notes = {} }) {
  const { keyId, keySecret } = getCredentials();
  if (!keyId || !keySecret) {
    return Promise.reject(new RazorpayError('Razorpay is not configured (missing key or secret)', 503, 'not_configured'));
  }

  const amount = parseInt(amountPaise, 10);
  if (!amount || amount <= 0) {
    return Promise.reject(new RazorpayError('Invalid order amount (must be positive integer in paise)', 422, 'invalid_amount'));
  }

  const payload = JSON.stringify({
    amount,
    currency,
    receipt: receipt || undefined,
    notes: notes || {},
  });

  const authHeader = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: RAZORPAY_API_HOST,
      path: '/v1/orders',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            return reject(new RazorpayError(
              parsed.error?.description || parsed.error?.message || 'Razorpay order creation failed',
              res.statusCode,
              parsed.error?.code || 'order_creation_failed',
              parsed
            ));
          }
          resolve(parsed);
        } catch (e) {
          reject(new RazorpayError('Failed to parse Razorpay API response', 502, 'bad_response', data));
        }
      });
    });

    req.on('error', (err) => reject(new RazorpayError(err.message, 502, 'network_error')));
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new RazorpayError('Razorpay order creation request timed out', 504, 'timeout'));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Verifies Razorpay payment signature after frontend checkout completion.
 * @param {Object} params
 * @param {string} params.orderId - razorpay_order_id
 * @param {string} params.paymentId - razorpay_payment_id
 * @param {string} params.signature - razorpay_signature
 * @returns {boolean}
 */
function verifyPaymentSignature({ orderId, paymentId, signature }) {
  const { keySecret } = getCredentials();
  if (!keySecret || !orderId || !paymentId || !signature) return false;

  try {
    const body = `${orderId}|${paymentId}`;
    const expectedSig = crypto.createHmac('sha256', keySecret).update(body).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));
  } catch (_) {
    return false;
  }
}

module.exports = {
  RazorpayError,
  isConfigured,
  createOrder,
  verifyPaymentSignature,
};
