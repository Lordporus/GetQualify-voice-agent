'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('https');
const EventEmitter = require('events');
const hubspot = require('../lib/hubspot');

// Helper to mock https.request
function mockHttpsRequest(handler) {
  const origRequest = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.write = (chunk) => {
      req._body = (req._body || '') + chunk;
    };
    req.end = () => {
      setImmediate(() => {
        handler(opts, req._body, (status, responseData) => {
          const res = new EventEmitter();
          res.statusCode = status;
          cb(res);
          res.emit('data', JSON.stringify(responseData));
          res.emit('end');
        });
      });
    };
    return req;
  };
  return () => {
    https.request = origRequest;
  };
}

test('HubSpot Unit Tests: Configuration, Contact Sync, & Call Engagement', async (t) => {
  await t.test('isConfigured() returns false when no env var or tenant settings', () => {
    const origEnv = process.env.HUBSPOT_ACCESS_TOKEN;
    try {
      delete process.env.HUBSPOT_ACCESS_TOKEN;
      assert.strictEqual(hubspot.isConfigured(), false);
      assert.strictEqual(hubspot.isConfigured({}), false);
      assert.strictEqual(hubspot.isConfigured({ hubspot_token: '' }), false);
    } finally {
      if (origEnv) process.env.HUBSPOT_ACCESS_TOKEN = origEnv;
    }
  });

  await t.test('isConfigured() returns true when HUBSPOT_ACCESS_TOKEN or tenant token is set', () => {
    const origEnv = process.env.HUBSPOT_ACCESS_TOKEN;
    try {
      process.env.HUBSPOT_ACCESS_TOKEN = 'pat-global-123';
      assert.strictEqual(hubspot.isConfigured(), true);
      assert.strictEqual(hubspot.getAccessToken(), 'pat-global-123');

      // Tenant setting overrides global
      assert.strictEqual(hubspot.getAccessToken({ hubspot_token: 'pat-tenant-456' }), 'pat-tenant-456');
    } finally {
      if (origEnv) process.env.HUBSPOT_ACCESS_TOKEN = origEnv;
      else delete process.env.HUBSPOT_ACCESS_TOKEN;
    }
  });

  await t.test('syncContact() sends correct POST payload and returns { contactId }', async () => {
    let capturedOpts, capturedBody;
    const restore = mockHttpsRequest((opts, body, respond) => {
      capturedOpts = opts;
      capturedBody = JSON.parse(body);
      respond(201, { id: 'contact_98765' });
    });

    try {
      const res = await hubspot.syncContact('pat-token-abc', {
        email: 'test@example.com',
        phone: '+919876543210',
        firstname: 'Aarav',
        lastname: 'Sharma',
      });
      assert.strictEqual(res.contactId, 'contact_98765');
      assert.strictEqual(capturedOpts.method, 'POST');
      assert.strictEqual(capturedOpts.path, '/crm/v3/objects/contacts');
      assert.strictEqual(capturedOpts.headers.Authorization, 'Bearer pat-token-abc');
      assert.strictEqual(capturedBody.properties.email, 'test@example.com');
      assert.strictEqual(capturedBody.properties.phone, '+919876543210');
      assert.strictEqual(capturedBody.properties.firstname, 'Aarav');
      assert.strictEqual(capturedBody.properties.lastname, 'Sharma');
    } finally {
      restore();
    }
  });

  await t.test('syncContact() handles 409 Conflict and extracts existing ID', async () => {
    const restore = mockHttpsRequest((opts, body, respond) => {
      respond(409, {
        status: 'error',
        message: 'Contact already exists. Existing ID: 55443322',
        category: 'CONFLICT',
      });
    });

    try {
      const res = await hubspot.syncContact('pat-token-abc', {
        email: 'duplicate@example.com',
        phone: '+919876543210',
      });
      assert.strictEqual(res.contactId, '55443322');
    } finally {
      restore();
    }
  });

  await t.test('logCallEngagement() sends correct POST with duration in ms and association', async () => {
    let capturedOpts, capturedBody;
    const restore = mockHttpsRequest((opts, body, respond) => {
      capturedOpts = opts;
      capturedBody = JSON.parse(body);
      respond(201, { id: 'call_engagement_1122' });
    });

    try {
      const res = await hubspot.logCallEngagement('pat-token-abc', {
        contactId: 'contact_98765',
        duration: 45, // seconds
        transcript: 'Customer wants a hair cut appointment tomorrow.',
        summary: 'Salon appointment request',
        recordingUrl: 'https://storage.getqualify.com/recordings/call_1.mp3',
        callDisposition: 'COMPLETED',
      });
      assert.strictEqual(res.engagementId, 'call_engagement_1122');
      assert.strictEqual(capturedOpts.method, 'POST');
      assert.strictEqual(capturedOpts.path, '/crm/v3/objects/calls');
      assert.strictEqual(capturedBody.properties.hs_call_duration, '45000');
      assert.strictEqual(capturedBody.properties.hs_call_recording_url, 'https://storage.getqualify.com/recordings/call_1.mp3');
      assert.strictEqual(capturedBody.properties.hs_call_body, 'Salon appointment request');
      assert.strictEqual(capturedBody.properties.hs_call_status, 'COMPLETED');
      assert.strictEqual(capturedBody.associations[0].to.id, 'contact_98765');
      assert.strictEqual(capturedBody.associations[0].types[0].associationTypeId, 194);
    } finally {
      restore();
    }
  });

  await t.test('both functions throw HubSpotError on API error responses', async () => {
    const restore = mockHttpsRequest((opts, body, respond) => {
      respond(500, { message: 'Internal HubSpot Server Error' });
    });

    try {
      await assert.rejects(
        () => hubspot.syncContact('pat-token-abc', { email: 'fail@example.com' }),
        (err) => err instanceof hubspot.HubSpotError && err.status === 502
      );

      await assert.rejects(
        () => hubspot.logCallEngagement('pat-token-abc', { contactId: '123' }),
        (err) => err instanceof hubspot.HubSpotError && err.status === 502
      );
    } finally {
      restore();
    }
  });
});
