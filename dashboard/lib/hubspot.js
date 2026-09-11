'use strict';

/**
 * HubSpot CRM v3 API adapter (Private App Token auth).
 *
 * Supports contact upsert and call engagement logging.
 * No SDK — native Node.js https only.
 * All callers must .catch() — this module never blocks telephony.
 */

const https = require('https');

const HUBSPOT_HOST = 'api.hubapi.com';

class HubSpotError extends Error {
  constructor(message, status = 502, code = 'hubspot_error') {
    super(message);
    this.name = 'HubSpotError';
    this.status = status;
    this.code = code;
  }
}

function getAccessToken(tenantSettings = null) {
  if (tenantSettings && tenantSettings.hubspot_token) {
    return String(tenantSettings.hubspot_token).trim();
  }
  return (process.env.HUBSPOT_ACCESS_TOKEN || '').trim() || null;
}

function isConfigured(tenantSettings = null) {
  return Boolean(getAccessToken(tenantSettings));
}

function hsRequest(method, path, accessToken, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: HUBSPOT_HOST,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, data: {} }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function syncContact(accessToken, { email, phone, firstname = '', lastname = '' } = {}) {
  if (!accessToken) {
    throw new HubSpotError('Missing HubSpot access token', 401, 'missing_access_token');
  }
  const properties = {};
  if (email) properties.email = email;
  if (phone) properties.phone = phone;
  if (firstname) properties.firstname = firstname;
  if (lastname) properties.lastname = lastname;

  const res = await hsRequest('POST', '/crm/v3/objects/contacts', accessToken, { properties });
  if (res.status === 201 || res.status === 200) {
    return { contactId: res.data.id };
  }
  if (res.status === 409) {
    // Duplicate — extract existing ID from error message
    const match = String(res.data?.message || '').match(/existing ID: ([0-9]+)/i);
    if (match) return { contactId: match[1] };
    // Fallback: search by email
    if (email) {
      const searchRes = await hsRequest('POST', '/crm/v3/objects/contacts/search', accessToken, {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: email }] }],
        limit: 1,
      });
      if (searchRes.data?.results && searchRes.data.results.length > 0) {
        return { contactId: searchRes.data.results[0].id };
      }
    }
  }
  throw new HubSpotError(
    `HubSpot contact sync failed: ${res.data?.message || res.status}`,
    res.status >= 500 ? 502 : 422,
    'contact_sync_failed'
  );
}

async function logCallEngagement(accessToken, { contactId, duration = 0, transcript = '', summary = '', recordingUrl = '', callDisposition = 'COMPLETED' } = {}) {
  if (!accessToken) {
    throw new HubSpotError('Missing HubSpot access token', 401, 'missing_access_token');
  }
  if (!contactId) {
    throw new HubSpotError('Missing contactId for call engagement', 422, 'missing_contact_id');
  }

  const durationMs = Math.round((Number(duration) || 0) * 1000);
  const body = {
    properties: {
      hs_call_duration: String(durationMs), // HubSpot expects ms
      hs_call_recording_url: recordingUrl || '',
      hs_call_body: (summary || transcript || '').slice(0, 5000),
      hs_call_status: callDisposition,
      hs_timestamp: String(Date.now()),
    },
    associations: [{
      to: { id: String(contactId) },
      types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }],
    }],
  };
  const res = await hsRequest('POST', '/crm/v3/objects/calls', accessToken, body);
  if (res.status === 201 || res.status === 200) {
    return { engagementId: res.data.id };
  }
  throw new HubSpotError(
    `HubSpot call engagement failed: ${res.data?.message || res.status}`,
    res.status >= 500 ? 502 : 422,
    'call_engagement_failed'
  );
}

module.exports = {
  HubSpotError,
  isConfigured,
  getAccessToken,
  syncContact,
  logCallEngagement,
};
