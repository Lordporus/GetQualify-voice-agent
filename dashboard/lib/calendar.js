'use strict';

const crypto = require('crypto');
const { google } = require('googleapis');
const core = require('./core');
const db = require('./db');
const sms = require('./sms');

class CalendarError extends Error {
  constructor(message, status = 500, code = 'calendar_error', detail = null) {
    super(message);
    this.name = 'CalendarError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

/**
 * Resolves or derives a 32-byte key for AES-256-GCM encryption.
 */
function getEncryptionKey() {
  const raw = process.env.CALENDAR_ENCRYPTION_KEY;
  if (!raw) {
    throw new CalendarError('CALENDAR_ENCRYPTION_KEY is not configured', 503, 'missing_encryption_key');
  }
  if (raw.length === 64 && /^[0-9a-fA-F]+$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Encrypts an object or string using AES-256-GCM.
 * Output format: iv_hex:authTag_hex:ciphertext_hex
 */
function encryptCredentials(data) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
  let encrypted = cipher.update(jsonStr, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypts an AES-256-GCM string (iv_hex:authTag_hex:ciphertext_hex).
 */
function decryptCredentials(encryptedString) {
  if (!encryptedString) return null;
  const parts = String(encryptedString).split(':');
  if (parts.length !== 3) {
    throw new CalendarError('Invalid encrypted credentials format', 500, 'corrupt_credentials');
  }
  const [ivHex, authTagHex, encryptedHex] = parts;
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

/**
 * Initializes and returns a new OAuth2 client using environment variables.
 */
function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.CALENDAR_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new CalendarError(
      'Google Calendar OAuth credentials not configured (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, CALENDAR_REDIRECT_URI)',
      503,
      'calendar_not_configured'
    );
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Generates the Google OAuth2 consent URL.
 */
function getAuthUrl(tenantId, { state = '' } = {}) {
  if (!tenantId) {
    throw new CalendarError('tenantId is required to generate auth url', 422, 'missing_tenant');
  }
  const oauth2Client = getOAuth2Client();
  const statePayload = Buffer.from(JSON.stringify({ tenantId, state, timestamp: Date.now() })).toString('base64url');

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // guarantees refresh_token on initial or re-consent
    scope: SCOPES,
    state: statePayload,
  });
}

/**
 * Persists encrypted calendar credentials to client_settings table (Postgres or JSON).
 */
async function saveCalendarCredentials(tenantId, tokens) {
  const enc = encryptCredentials(tokens);
  const now = new Date().toISOString();

  if (db.isPostgres) {
    await db.query(
      `INSERT INTO client_settings (tenant_id, calendar_provider, calendar_credentials_enc, updated_at)
       VALUES ($1, 'google', $2, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         calendar_provider = 'google',
         calendar_credentials_enc = EXCLUDED.calendar_credentials_enc,
         updated_at = NOW()`,
      [tenantId, enc]
    );
  } else {
    await core.mutate((d) => {
      if (!d.clientSettings) d.clientSettings = [];
      let cs = d.clientSettings.find((s) => s.tenantId === tenantId || s.tenant_id === tenantId);
      if (!cs) {
        cs = { tenantId, tenant_id: tenantId, timezone: 'Asia/Kolkata', businessHours: {} };
        d.clientSettings.push(cs);
      }
      cs.calendarProvider = 'google';
      cs.calendar_provider = 'google';
      cs.calendarCredentialsEnc = enc;
      cs.calendar_credentials_enc = enc;
      cs.updatedAt = now;
      cs.updated_at = now;
    });
  }

  return enc;
}

/**
 * Retrieves and decrypts calendar credentials for a tenant.
 */
async function getCalendarCredentials(tenantId) {
  if (!tenantId) return null;

  let enc = null;
  let timezone = 'Asia/Kolkata';

  if (db.isPostgres) {
    const res = await db.query(
      `SELECT calendar_provider, calendar_credentials_enc, timezone FROM client_settings WHERE tenant_id = $1`,
      [tenantId]
    ).catch(() => ({ rows: [] }));
    if (res.rows.length > 0) {
      enc = res.rows[0].calendar_credentials_enc || res.rows[0].calendarCredentialsEnc;
      if (res.rows[0].timezone) timezone = res.rows[0].timezone;
    }
  } else {
    const d = core.loadDb();
    const cs = (d.clientSettings || []).find((s) => s.tenantId === tenantId || s.tenant_id === tenantId);
    if (cs) {
      enc = cs.calendarCredentialsEnc || cs.calendar_credentials_enc;
      if (cs.timezone) timezone = cs.timezone;
    }
  }

  if (!enc) return null;
  const tokens = decryptCredentials(enc);
  return { tokens, timezone };
}

/**
 * Checks if a tenant has an active Google Calendar integration.
 */
async function isConnected(tenantId) {
  const creds = await getCalendarCredentials(tenantId);
  return Boolean(creds && creds.tokens && (creds.tokens.refresh_token || creds.tokens.access_token));
}

/**
 * Returns an authenticated Google Calendar API instance with automatic token persistence.
 */
async function getCalendarClient(tenantId) {
  const creds = await getCalendarCredentials(tenantId);
  if (!creds || !creds.tokens) {
    throw new CalendarError('Google Calendar is not connected for this tenant', 404, 'calendar_not_connected');
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials(creds.tokens);

  // When tokens refresh, persist the updated tokens back to the database
  oauth2Client.on('tokens', async (newTokens) => {
    try {
      const merged = { ...creds.tokens, ...newTokens };
      await saveCalendarCredentials(tenantId, merged);
    } catch (saveErr) {
      console.error(`[calendar] Failed to persist refreshed tokens for tenant ${tenantId}:`, saveErr.message);
    }
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  return { calendar, oauth2Client, timezone: creds.timezone };
}

/**
 * Exchanges OAuth authorization code for credentials and saves them.
 */
async function exchangeCode(tenantId, code) {
  if (!code) {
    throw new CalendarError('Authorization code is required', 422, 'missing_code');
  }
  const oauth2Client = getOAuth2Client();
  let tokens;
  try {
    const res = await oauth2Client.getToken(code);
    tokens = res.tokens;
  } catch (err) {
    throw new CalendarError(`Failed to exchange code with Google: ${err.message}`, 502, 'token_exchange_failed', err);
  }

  await saveCalendarCredentials(tenantId, tokens);
  return { ok: true, tenantId, connected: true };
}

/**
 * Clears calendar credentials for a tenant (disconnect).
 */
async function disconnect(tenantId) {
  if (db.isPostgres) {
    await db.query(
      `UPDATE client_settings
       SET calendar_provider = NULL, calendar_credentials_enc = NULL, updated_at = NOW()
       WHERE tenant_id = $1`,
      [tenantId]
    );
  } else {
    await core.mutate((d) => {
      const cs = (d.clientSettings || []).find((s) => s.tenantId === tenantId || s.tenant_id === tenantId);
      if (cs) {
        cs.calendarProvider = null;
        cs.calendar_provider = null;
        cs.calendarCredentialsEnc = null;
        cs.calendar_credentials_enc = null;
        cs.updatedAt = new Date().toISOString();
        cs.updated_at = cs.updatedAt;
      }
    });
  }
  return { ok: true, disconnected: true };
}

/**
 * Refreshes the access token using the stored refresh_token.
 */
async function refreshAccessToken(tenantId) {
  const creds = await getCalendarCredentials(tenantId);
  if (!creds || !creds.tokens || !creds.tokens.refresh_token) {
    throw new CalendarError('No refresh token available for tenant', 401, 'reauth_required');
  }

  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: creds.tokens.refresh_token });

  try {
    const { credentials } = await oauth2Client.refreshAccessToken();
    const merged = { ...creds.tokens, ...credentials };
    await saveCalendarCredentials(tenantId, merged);
    return merged;
  } catch (err) {
    throw new CalendarError('Calendar credentials expired or revoked, re-authentication required', 401, 'reauth_required', err);
  }
}

/**
 * Queries Google Calendar for free/busy intervals between timeMin and timeMax.
 */
async function getAvailability(tenantId, { timeMin, timeMax }) {
  if (!timeMin || !timeMax) {
    throw new CalendarError('timeMin and timeMax are required parameters', 422, 'missing_date_range');
  }

  const { calendar, timezone } = await getCalendarClient(tenantId);

  let freebusyRes;
  try {
    freebusyRes = await calendar.freebusy.query({
      requestBody: {
        timeMin: new Date(timeMin).toISOString(),
        timeMax: new Date(timeMax).toISOString(),
        timeZone: timezone,
        items: [{ id: 'primary' }],
      },
    });
  } catch (err) {
    if (err.code === 401 || (err.message && err.message.includes('invalid_grant'))) {
      // Refresh token and retry once
      await refreshAccessToken(tenantId);
      const retryClient = await getCalendarClient(tenantId);
      freebusyRes = await retryClient.calendar.freebusy.query({
        requestBody: {
          timeMin: new Date(timeMin).toISOString(),
          timeMax: new Date(timeMax).toISOString(),
          timeZone: timezone,
          items: [{ id: 'primary' }],
        },
      });
    } else {
      throw new CalendarError(`Google Calendar availability query failed: ${err.message}`, 502, 'freebusy_failed', err);
    }
  }

  const busySlots = (freebusyRes.data.calendars && freebusyRes.data.calendars.primary && freebusyRes.data.calendars.primary.busy) || [];
  return {
    ok: true,
    timezone,
    timeMin,
    timeMax,
    busy: busySlots,
  };
}

/**
 * Creates an appointment event in the tenant's primary Google Calendar,
 * updates linked lead status to 'booked', and sends confirmation SMS.
 */
async function bookAppointment(tenantId, {
  summary = 'Consultation Appointment',
  description = '',
  start,
  end,
  attendeeEmail = null,
  attendeeName = 'Valued Client',
  attendeePhone = null,
  leadId = null,
} = {}) {
  if (!start || !end) {
    throw new CalendarError('start and end datetime are required for booking', 422, 'missing_booking_time');
  }

  const { calendar, timezone } = await getCalendarClient(tenantId);

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime()) || startDate >= endDate) {
    throw new CalendarError('Invalid start or end date sequence', 422, 'invalid_time_range');
  }

  const eventPayload = {
    summary,
    description: description || `Booked via GetQualify AI Voice Agent Platform.\nAttendee: ${attendeeName}\nPhone: ${attendeePhone || 'N/A'}\nEmail: ${attendeeEmail || 'N/A'}`,
    start: {
      dateTime: startDate.toISOString(),
      timeZone: timezone,
    },
    end: {
      dateTime: endDate.toISOString(),
      timeZone: timezone,
    },
    attendees: attendeeEmail ? [{ email: attendeeEmail, displayName: attendeeName }] : [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 },
        { method: 'popup', minutes: 30 },
      ],
    },
  };

  let eventRes;
  try {
    eventRes = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: eventPayload,
    });
  } catch (err) {
    if (err.code === 409) {
      throw new CalendarError('Selected time slot conflicts with an existing event', 409, 'slot_conflict', err);
    }
    if (err.code === 401 || (err.message && err.message.includes('invalid_grant'))) {
      await refreshAccessToken(tenantId);
      const retryClient = await getCalendarClient(tenantId);
      eventRes = await retryClient.calendar.events.insert({
        calendarId: 'primary',
        requestBody: eventPayload,
      });
    } else {
      throw new CalendarError(`Failed to create Google Calendar event: ${err.message}`, 502, 'booking_failed', err);
    }
  }

  const createdEvent = eventRes.data;

  // 1. Update lead status to 'booked' in CRM if leadId or attendeePhone is provided
  try {
    if (leadId) {
      if (db.isPostgres) {
        await db.query(`UPDATE leads SET status = 'booked', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`, [leadId, tenantId]);
      } else {
        await core.mutate((d) => {
          const lead = (d.leads || []).find((l) => l.id === leadId && (l.tenantId === tenantId || l.tenant_id === tenantId));
          if (lead) lead.status = 'booked';
        });
      }
    } else if (attendeePhone) {
      const cleanPhone = String(attendeePhone).replace(/[^0-9]/g, '').slice(-10);
      if (cleanPhone) {
        if (db.isPostgres) {
          await db.query(`UPDATE leads SET status = 'booked', updated_at = NOW() WHERE phone LIKE $1 AND tenant_id = $2`, [`%${cleanPhone}`, tenantId]);
        } else {
          await core.mutate((d) => {
            const lead = (d.leads || []).find((l) => String(l.phone || '').includes(cleanPhone) && (l.tenantId === tenantId || l.tenant_id === tenantId));
            if (lead) lead.status = 'booked';
          });
        }
      }
    }
  } catch (leadErr) {
    console.warn('[calendar] Warning: could not update lead status to booked:', leadErr.message);
  }

  // 2. Fire SMS confirmation if attendeePhone is provided (non-blocking)
  if (attendeePhone) {
    let businessName = 'GetQualify';
    if (!db.isPostgres) {
      const d = core.loadDb();
      const t = (d.tenants || []).find((x) => x.id === tenantId);
      if (t && t.name) businessName = t.name;
    }
    sms.sendAppointmentConfirmation(attendeePhone, {
      businessName,
      appointmentTime: startDate.toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }),
      agentName: 'AI Voice Assistant',
    }).catch((err) => {
      console.warn('[calendar] SMS booking confirmation dispatch error:', err.message);
    });
  }

  return {
    ok: true,
    eventId: createdEvent.id,
    htmlLink: createdEvent.htmlLink,
    start: startDate.toISOString(),
    end: endDate.toISOString(),
    summary,
    attendeeName,
    attendeeEmail,
  };
}

module.exports = {
  CalendarError,
  getEncryptionKey,
  encryptCredentials,
  decryptCredentials,
  getOAuth2Client,
  getAuthUrl,
  exchangeCode,
  saveCalendarCredentials,
  getCalendarCredentials,
  isConnected,
  getCalendarClient,
  disconnect,
  refreshAccessToken,
  getAvailability,
  bookAppointment,
};
