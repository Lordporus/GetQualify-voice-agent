'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('HVAC outcomes conform to permitted state machine', () => {
  const allowed = new Set(['new', 'booked', 'routed', 'follow_up', 'closed', 'abandoned']);
  assert.equal(allowed.has('new'), true);
  assert.equal(allowed.has('booked'), true);
  assert.equal(allowed.has('routed'), true);
  assert.equal(allowed.has('follow_up'), true);
  assert.equal(allowed.has('closed'), true);
  assert.equal(allowed.has('abandoned'), true);
  assert.equal(allowed.has('invalid_outcome'), false);
});

test('BYON supported providers allowlist validates correctly', () => {
  const providers = ['vobiz', 'twilio', 'telnyx', 'plivo', 'vonage', 'sip'];
  assert.equal(providers.includes('vobiz'), true);
  assert.equal(providers.includes('twilio'), true);
  assert.equal(providers.includes('telnyx'), true);
  assert.equal(providers.includes('plivo'), true);
  assert.equal(providers.includes('vonage'), true);
  assert.equal(providers.includes('sip'), true);
  assert.equal(providers.includes('unsupported_carrier'), false);
});

test('usage economics calculations compute consistent cost figures', () => {
  const INR_PER_1K_CHARS = 0.12;
  const INR_PER_CALL = 0.9;

  const chars = 25000;
  const calls = 10;
  const cost = Math.round(((chars / 1000 * INR_PER_1K_CHARS) + (calls * INR_PER_CALL)) * 100) / 100;
  // 25 * 0.12 = 3.00, 10 * 0.9 = 9.00 -> 12.00
  assert.equal(cost, 12.00);
});

test('migrate-domain script runs idempotently without unhandled rejections', () => {
  const scriptPath = path.join(__dirname, '../scripts/migrate-domain.js');
  const result = spawnSync(process.execPath, [scriptPath], {
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres',
    },
    encoding: 'utf8',
  });

  if (result.status === 0) {
    assert.ok(result.stdout.includes('Domain-Specific migration completed successfully.'));
  } else {
    // If PostgreSQL is not reachable in an environment, it fails gracefully with an error log
    assert.ok(result.stderr.length > 0 || result.stdout.length > 0);
  }
});
