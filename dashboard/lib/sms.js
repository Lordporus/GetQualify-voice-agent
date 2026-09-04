'use strict';

const core = require('./core');

const MSG91_HOST = 'api.msg91.com';
const MSG91_FLOW_PATH = '/api/v5/flow/';

class SmsError extends Error {
  constructor(message, status = 502, code = 'sms_error', detail = null) {
    super(message);
    this.name = 'SmsError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Normalizes phone numbers for MSG91:
 * MSG91 expects country code without '+' (e.g. 919876543210 or 14155552671).
 * Bare 10-digit Indian numbers get prefixed with 91.
 */
function normalizePhoneForMsg91(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  return digits;
}

/**
 * Core send method using MSG91 Flow API.
 * @param {Object} params
 * @param {string} params.to - recipient phone number
 * @param {string} params.templateId - MSG91 template ID
 * @param {Object} [params.variables] - dynamic template variables
 * @param {string} [params.senderId] - optional sender ID override
 */
async function send({ to, templateId, variables = {}, senderId = process.env.MSG91_SENDER_ID }) {
  const authKey = process.env.MSG91_AUTH_KEY;
  if (!authKey) {
    throw new SmsError('MSG91_AUTH_KEY is not configured', 503, 'sms_not_configured');
  }
  const cleanTo = normalizePhoneForMsg91(to);
  if (!cleanTo || cleanTo.length < 10) {
    throw new SmsError('Invalid recipient phone number', 422, 'bad_number');
  }
  if (!templateId) {
    throw new SmsError('Template ID is required', 422, 'missing_template');
  }

  const payload = {
    template_id: templateId,
    short_url: '0',
    recipients: [
      {
        mobiles: cleanTo,
        ...variables,
      },
    ],
  };
  if (senderId) payload.sender = senderId;

  const bodyBuf = Buffer.from(JSON.stringify(payload));
  const headers = {
    authkey: authKey,
    'Content-Type': 'application/json',
    'Content-Length': bodyBuf.length,
  };

  const res = await core.httpsPost(MSG91_HOST, MSG91_FLOW_PATH, headers, bodyBuf);
  let parsed = {};
  try {
    parsed = JSON.parse(res.buffer.toString('utf8') || '{}');
  } catch (_) {
    parsed = {};
  }

  if (res.status < 200 || res.status >= 300 || parsed.type === 'error') {
    const msg = parsed.message || parsed.msg || 'MSG91 API error';
    throw new SmsError(`MSG91 dispatch failed: ${msg}`, res.status >= 400 && res.status < 500 ? res.status : 502, 'upstream_sms_error', parsed);
  }

  return { status: res.status, data: parsed, to: cleanTo };
}

/**
 * Send missed-call text-back to a caller within seconds of a missed call.
 */
async function sendMissedCallTextBack(to, { businessName = 'GetQualify', callbackNumber = '' } = {}) {
  const templateId = process.env.MSG91_MISSED_CALL_TEMPLATE_ID;
  if (!templateId) {
    console.warn('[sms] MSG91_MISSED_CALL_TEMPLATE_ID not configured; skipping missed-call text-back');
    return null;
  }
  return send({
    to,
    templateId,
    variables: {
      business_name: businessName,
      callback_number: callbackNumber,
    },
  });
}

/**
 * Send appointment confirmation SMS upon successful calendar booking.
 */
async function sendAppointmentConfirmation(to, { businessName = 'GetQualify', appointmentTime = '', agentName = '' } = {}) {
  const templateId = process.env.MSG91_BOOKING_TEMPLATE_ID;
  if (!templateId) {
    console.warn('[sms] MSG91_BOOKING_TEMPLATE_ID not configured; skipping booking confirmation');
    return null;
  }
  return send({
    to,
    templateId,
    variables: {
      business_name: businessName,
      appointment_time: appointmentTime,
      agent_name: agentName,
    },
  });
}

/**
 * Send appointment reminder SMS (scheduled).
 * Note: Recurring/delayed reminder queue uses BullMQ (deferred to Phase 7).
 */
async function sendAppointmentReminder(to, { businessName = 'GetQualify', appointmentTime = '' } = {}) {
  const templateId = process.env.MSG91_REMINDER_TEMPLATE_ID;
  if (!templateId) {
    console.warn('[sms] MSG91_REMINDER_TEMPLATE_ID not configured; skipping reminder');
    return null;
  }
  return send({
    to,
    templateId,
    variables: {
      business_name: businessName,
      appointment_time: appointmentTime,
    },
  });
}

module.exports = {
  SmsError,
  normalizePhoneForMsg91,
  send,
  sendMissedCallTextBack,
  sendAppointmentConfirmation,
  sendAppointmentReminder,
  // Phase 7: international fallback
  sendViaTwilio,
  sendSms,
};

/* ==========================================================================
   Phase 7: Twilio SMS — international fallback (non-+91 numbers)
   Uses Node core https only, no Twilio SDK.
   ========================================================================== */

/**
 * Send SMS via Twilio REST API (Basic Auth, no SDK).
 * @param {string} to  - E.164 number e.g. +14155552671
 * @param {string} body - message text (max 1600 chars)
 */
async function sendViaTwilio(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    throw new SmsError('Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER missing)', 503, 'twilio_not_configured');
  }

  const params = new URLSearchParams({ To: to, From: from, Body: String(body).slice(0, 1600) });
  const payload = params.toString();
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  const path = `/2010-04-01/Accounts/${sid}/Messages.json`;

  const { https } = require('https');
  const result = await new Promise((resolve, reject) => {
    const req = require('https').request({
      hostname: 'api.twilio.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (resp) => {
      let data = '';
      resp.on('data', (c) => { data += c; });
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, data: JSON.parse(data) }); }
        catch (_) { resolve({ status: resp.statusCode, data: { raw: data } }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  if (result.status < 200 || result.status >= 300) {
    const msg = result.data?.message || result.data?.raw || 'Twilio API error';
    throw new SmsError(`Twilio dispatch failed: ${msg}`, result.status >= 400 && result.status < 500 ? result.status : 502, 'upstream_sms_error', result.data);
  }

  return { status: result.status, data: result.data, to };
}

/**
 * Unified SMS router:
 *  - Numbers starting with +91 → MSG91 Flow API
 *  - All other E.164 numbers → Twilio
 *
 * @param {string} to    - recipient phone (E.164 preferred)
 * @param {string} text  - SMS body (up to 1600 chars)
 */
async function sendSms(to, text) {
  const normalized = String(to || '').trim();
  // Detect Indian number: +91xxxxxxxxxx or 10-digit (MSG91 path)
  const isIndian = /^\+91/.test(normalized) || /^[6-9]\d{9}$/.test(normalized.replace(/\D/g, '').replace(/^91/, ''));
  if (isIndian) {
    // MSG91 free-form text: fall back to missed-call template with body substituted
    // MSG91 doesn't support raw body SMS without a registered template.
    // Log a warning and use Twilio if MSG91_AUTH_KEY supports transactional text.
    const authKey = process.env.MSG91_AUTH_KEY;
    if (authKey) {
      const digits = normalizePhoneForMsg91(normalized);
      const bodyBuf = Buffer.from(JSON.stringify({ sender: process.env.MSG91_SENDER_ID || 'MSGIND', route: '4', country: '91', sms: [{ message: text.slice(0, 400), to: [digits] }] }));
      const result = await core.httpsPost('api.msg91.com', '/api/sendhttp.php', { authkey: authKey, 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length }, bodyBuf).catch(() => null);
      if (result && result.status >= 200 && result.status < 300) return { via: 'msg91', to: normalized };
    }
  }
  // International or MSG91 unavailable → Twilio
  return sendViaTwilio(normalized, text).then((r) => ({ ...r, via: 'twilio' }));
}
