'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { mkdtemp, rm } = require('node:fs/promises');
const { google } = require('googleapis');

const calendar = require('../lib/calendar');
const core = require('../lib/core');
const sms = require('../lib/sms');

test('AES-256-GCM credentials encryption and decryption', async () => {
  process.env.CALENDAR_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  const tokens = {
    access_token: 'ya29.mock_access_token_123',
    refresh_token: '1//mock_refresh_token_456',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    token_type: 'Bearer',
    expiry_date: Date.now() + 3600000,
  };

  const encrypted = calendar.encryptCredentials(tokens);
  assert.ok(typeof encrypted === 'string');
  assert.equal(encrypted.split(':').length, 3); // iv:authTag:cipher

  const decrypted = calendar.decryptCredentials(encrypted);
  assert.deepEqual(decrypted, tokens);

  // Tampering with ciphertext throws error
  const parts = encrypted.split(':');
  const tampered = `${parts[0]}:${parts[1]}:deadbeef`;
  assert.throws(() => calendar.decryptCredentials(tampered));
});

test('Google Calendar OAuth2 flow, availability, booking, and disconnect lifecycle', async (t) => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gq-calendar-test-'));
  const dbFile = path.join(tempDir, 'db.json');
  const origEnv = { ...process.env };

  process.env.GETQUALIFY_DB_FILE = dbFile;
  process.env.DB_DRIVER = 'json';
  process.env.CALENDAR_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
  process.env.CALENDAR_REDIRECT_URI = 'http://localhost:8787/api/integrations/calendar/callback';

  const tenantId = 't_cal_test';
  const leadId = 'lead_booking_target';

  // Seed tenant and lead in db
  await core.mutate((d) => {
    d.tenants.push({ id: tenantId, name: 'Apex Cooling', slug: 'apex-cooling' });
    d.leads.push({
      id: leadId,
      tenantId,
      name: 'Vikas Gupta',
      phone: '+919876543210',
      status: 'contacted',
    });
  });

  // Mock google OAuth2 methods and calendar API
  let capturedInsert = null;
  let capturedFreebusy = null;

  const mockOAuth2Client = {
    generateAuthUrl: ({ state }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&client_id=${process.env.GOOGLE_CLIENT_ID}`,
    getToken: async (code) => ({
      tokens: {
        access_token: `mock_access_for_${code}`,
        refresh_token: 'mock_refresh_token_999',
        expiry_date: Date.now() + 3600000,
      },
    }),
    setCredentials: () => {},
    on: () => {},
  };

  const origOAuth2 = google.auth.OAuth2;
  google.auth.OAuth2 = function () {
    return mockOAuth2Client;
  };

  const origCalendar = google.calendar;
  google.calendar = function () {
    return {
      freebusy: {
        query: async (params) => {
          capturedFreebusy = params;
          return {
            data: {
              calendars: {
                primary: {
                  busy: [
                    {
                      start: '2026-09-04T10:00:00Z',
                      end: '2026-09-04T11:00:00Z',
                    },
                  ],
                },
              },
            },
          };
        },
      },
      events: {
        insert: async (params) => {
          capturedInsert = params;
          return {
            data: {
              id: 'gcal_event_555',
              htmlLink: 'https://www.google.com/calendar/event?eid=gcal_event_555',
              status: 'confirmed',
            },
          };
        },
      },
    };
  };

  // Mock sms.sendAppointmentConfirmation
  let capturedSms = null;
  const origSms = sms.sendAppointmentConfirmation;
  sms.sendAppointmentConfirmation = async (to, params) => {
    capturedSms = { to, ...params };
    return { ok: true };
  };

  t.after(async () => {
    google.auth.OAuth2 = origOAuth2;
    google.calendar = origCalendar;
    sms.sendAppointmentConfirmation = origSms;
    process.env = origEnv;
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  // 1. Generate auth URL
  const authUrl = calendar.getAuthUrl(tenantId, { state: 'settings' });
  assert.ok(authUrl.includes('accounts.google.com'));
  assert.ok(authUrl.includes('client_id=test-client-id.apps.googleusercontent.com'));

  // 2. Not connected before code exchange
  assert.equal(await calendar.isConnected(tenantId), false);

  // 3. Exchange code
  const exchangeRes = await calendar.exchangeCode(tenantId, 'auth_code_xyz');
  assert.equal(exchangeRes.ok, true);
  assert.equal(await calendar.isConnected(tenantId), true);

  // 4. Query availability (free/busy)
  const avail = await calendar.getAvailability(tenantId, {
    timeMin: '2026-09-04T00:00:00Z',
    timeMax: '2026-09-04T23:59:59Z',
  });
  assert.equal(avail.ok, true);
  assert.equal(avail.busy.length, 1);
  assert.equal(avail.busy[0].start, '2026-09-04T10:00:00Z');
  assert.equal(capturedFreebusy.requestBody.items[0].id, 'primary');

  // 5. Book appointment
  const booking = await calendar.bookAppointment(tenantId, {
    summary: 'HVAC Duct Cleaning Consultation',
    description: 'Quarterly checkup requested',
    start: '2026-09-04T14:00:00Z',
    end: '2026-09-04T15:00:00Z',
    attendeeEmail: 'vikas@gupta.com',
    attendeeName: 'Vikas Gupta',
    attendeePhone: '+919876543210',
    leadId,
  });

  assert.equal(booking.ok, true);
  assert.equal(booking.eventId, 'gcal_event_555');
  assert.ok(booking.htmlLink.includes('gcal_event_555'));

  // Verify event payload passed to Google Calendar API
  assert.equal(capturedInsert.calendarId, 'primary');
  assert.equal(capturedInsert.requestBody.summary, 'HVAC Duct Cleaning Consultation');
  assert.equal(capturedInsert.requestBody.attendees[0].email, 'vikas@gupta.com');

  // Verify lead status updated to 'booked' in DB
  const dAfter = core.loadDb();
  const updatedLead = (dAfter.leads || []).find((l) => l.id === leadId);
  assert.equal(updatedLead.status, 'booked');

  // Verify SMS confirmation was triggered
  assert.ok(capturedSms);
  assert.equal(capturedSms.to, '+919876543210');

  // 6. Disconnect integration
  const discRes = await calendar.disconnect(tenantId);
  assert.equal(discRes.ok, true);
  assert.equal(await calendar.isConnected(tenantId), false);
});
