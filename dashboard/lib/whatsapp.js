'use strict';

/**
 * WhatsApp Business Cloud API v19 adapter.
 * 
 * Supports template message dispatching, dynamic parameter replacement,
 * and Meta webhook challenge verification + receipt processing.
 * Zero external SDK — pure Node https.
 */

const https = require('https');
const crypto = require('crypto');
const db = require('./db');
const core = require('./core');

const GRAPH_API_HOST = 'graph.facebook.com';
const GRAPH_API_VERSION = 'v19.0';

class WhatsAppError extends Error {
  constructor(message, status = 502, code = 'whatsapp_error', detail = null) {
    super(message);
    this.name = 'WhatsAppError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function getCredentials() {
  return {
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
  };
}

function isConfigured() {
  const { accessToken, phoneNumberId } = getCredentials();
  return Boolean(accessToken && phoneNumberId);
}

/**
 * Logs a message attempt into the whatsapp_messages table.
 */
async function logMessage({ id, tenantId, recipientPhone, templateName, status = 'sent', metaMessageId = null, payload = {} }) {
  const msgId = id || core.genId('wamsg_');
  const now = new Date().toISOString();
  try {
    if (db.isPostgres) {
      await db.query(
        `INSERT INTO whatsapp_messages (id, tenant_id, recipient_phone, template_name, status, meta_message_id, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, meta_message_id = COALESCE(EXCLUDED.meta_message_id, whatsapp_messages.meta_message_id)`,
        [msgId, tenantId || null, recipientPhone, templateName, status, metaMessageId, JSON.stringify(payload), now]
      );
    } else {
      await core.mutate((d) => {
        if (!d.whatsappMessages) d.whatsappMessages = [];
        const existing = d.whatsappMessages.find((m) => m.id === msgId);
        if (existing) {
          existing.status = status;
          if (metaMessageId) existing.metaMessageId = metaMessageId;
        } else {
          d.whatsappMessages.push({
            id: msgId,
            tenantId: tenantId || null,
            recipientPhone,
            templateName,
            status,
            metaMessageId,
            payload,
            createdAt: now,
          });
        }
      });
    }
  } catch (err) {
    console.warn('[whatsapp] Error logging message to audit store:', err.message);
  }
  return msgId;
}

/**
 * Normalizes phone number to E.164 without leading '+':
 * WhatsApp Cloud API expects country code + digits (e.g. 919876543210 or 14155552671).
 */
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  return digits;
}

/**
 * Sends a pre-approved template message via Meta Cloud API v19.
 * @param {string} to - Recipient phone number
 * @param {string} templateName - Meta-approved template name
 * @param {string} [languageCode='en_US'] - Template language code
 * @param {Array} [components=[]] - Dynamic template components (body, header, buttons)
 * @returns {Promise<Object>}
 */
function sendTemplateMessage(to, templateName, languageCode = 'en_US', components = []) {
  const { accessToken, phoneNumberId } = getCredentials();
  if (!accessToken || !phoneNumberId) {
    return Promise.resolve({ error: 'not_configured', code: 'missing_credentials' });
  }

  const cleanTo = normalizePhone(to);
  if (!cleanTo || cleanTo.length < 10) {
    return Promise.reject(new WhatsAppError('Invalid recipient phone number', 422, 'bad_number'));
  }

  const payload = JSON.stringify({
    messaging_product: 'whatsapp',
    to: cleanTo,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components: Array.isArray(components) ? components : [],
    },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: GRAPH_API_HOST,
      path: `/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (resp.statusCode >= 400) {
            return reject(new WhatsAppError(
              parsed.error?.message || 'WhatsApp API error',
              resp.statusCode,
              parsed.error?.code || 'api_error',
              parsed
            ));
          }
          resolve(parsed);
        } catch (_) {
          resolve({ raw: data, status: resp.statusCode });
        }
      });
    });

    req.on('error', (err) => reject(new WhatsAppError(err.message, 502, 'network_error')));
    req.write(payload);
    req.end();
  });
}

/**
 * Verifies Meta webhook subscription challenge.
 * Returns challenge string on match, or null if verification fails.
 * @param {Object} req - HTTP request
 * @returns {string|null}
 */
function verifyChallenge(req) {
  const { verifyToken } = getCredentials();
  const q = new URL(req.url || '/', 'http://localhost').searchParams;
  const mode = q.get('hub.mode');
  const token = q.get('hub.verify_token');
  const challenge = q.get('hub.challenge');

  if (mode === 'subscribe' && verifyToken && token === verifyToken) {
    return challenge;
  }
  return null;
}

/**
 * Verifies X-Hub-Signature-256 for inbound webhook payloads.
 * @param {string|Buffer} rawBody
 * @param {string} signatureHeader - value of X-Hub-Signature-256
 * @returns {boolean}
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const { appSecret } = getCredentials();
  if (!appSecret || !signatureHeader) return true; // fail-open if app secret not configured

  try {
    const expectedSig = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSig));
  } catch (_) {
    return false;
  }
}

/**
 * Pre-formatted helper: Booking Confirmation.
 */
async function sendBookingConfirmation(to, { tenantId, customerName, serviceName, timeString, address } = {}) {
  const components = [{
    type: 'body',
    parameters: [
      { type: 'text', text: customerName || 'Customer' },
      { type: 'text', text: serviceName || 'Appointment' },
      { type: 'text', text: timeString || '' },
      { type: 'text', text: address || 'Your location' },
    ],
  }];
  try {
    const res = await sendTemplateMessage(to, 'booking_confirmation', 'en_US', components);
    const metaId = (res && res.messages && res.messages[0] && res.messages[0].id) || null;
    await logMessage({
      tenantId: tenantId || null,
      recipientPhone: to,
      templateName: 'booking_confirmation',
      status: (res && res.error) ? 'failed' : 'sent',
      metaMessageId: metaId,
      payload: { customerName, serviceName, timeString, address, response: res },
    });
    return res;
  } catch (err) {
    await logMessage({
      tenantId: tenantId || null,
      recipientPhone: to,
      templateName: 'booking_confirmation',
      status: 'failed',
      metaMessageId: null,
      payload: { customerName, serviceName, timeString, address, error: err.message },
    });
    throw err;
  }
}

/**
 * Pre-formatted helper: Appointment Reminder.
 */
async function sendAppointmentReminder(to, { tenantId, customerName, serviceName, timeString } = {}) {
  const components = [{
    type: 'body',
    parameters: [
      { type: 'text', text: customerName || 'Customer' },
      { type: 'text', text: serviceName || 'Appointment' },
      { type: 'text', text: timeString || '' },
    ],
  }];
  try {
    const res = await sendTemplateMessage(to, 'appointment_reminder', 'en_US', components);
    const metaId = (res && res.messages && res.messages[0] && res.messages[0].id) || null;
    await logMessage({
      tenantId: tenantId || null,
      recipientPhone: to,
      templateName: 'appointment_reminder',
      status: (res && res.error) ? 'failed' : 'sent',
      metaMessageId: metaId,
      payload: { customerName, serviceName, timeString, response: res },
    });
    return res;
  } catch (err) {
    await logMessage({
      tenantId: tenantId || null,
      recipientPhone: to,
      templateName: 'appointment_reminder',
      status: 'failed',
      metaMessageId: null,
      payload: { customerName, serviceName, timeString, error: err.message },
    });
    throw err;
  }
}

/**
 * Pre-formatted helper: Call Follow-up.
 */
async function sendCallFollowup(to, { tenantId, customerName, summary } = {}) {
  const components = [{
    type: 'body',
    parameters: [
      { type: 'text', text: customerName || 'Customer' },
      { type: 'text', text: summary || 'Thank you for speaking with us today.' },
    ],
  }];
  try {
    const res = await sendTemplateMessage(to, 'call_followup', 'en_US', components);
    const metaId = (res && res.messages && res.messages[0] && res.messages[0].id) || null;
    await logMessage({
      tenantId: tenantId || null,
      recipientPhone: to,
      templateName: 'call_followup',
      status: (res && res.error) ? 'failed' : 'sent',
      metaMessageId: metaId,
      payload: { customerName, summary, response: res },
    });
    return res;
  } catch (err) {
    await logMessage({
      tenantId: tenantId || null,
      recipientPhone: to,
      templateName: 'call_followup',
      status: 'failed',
      metaMessageId: null,
      payload: { customerName, summary, error: err.message },
    });
    throw err;
  }
}

module.exports = {
  WhatsAppError,
  isConfigured,
  logMessage,
  sendTemplateMessage,
  verifyChallenge,
  verifyWebhookSignature,
  sendBookingConfirmation,
  sendAppointmentReminder,
  sendCallFollowup,
  normalizePhone,
};
