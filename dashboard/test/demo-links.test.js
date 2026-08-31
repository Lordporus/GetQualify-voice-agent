'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const demoLinks = require('../lib/demo-links');

test('demo tokens are random, URL safe, and resolved by hash only', () => {
  const first = demoLinks.createDemoToken();
  const second = demoLinks.createDemoToken();
  assert.notEqual(first.token, second.token);
  assert.match(first.token, /^[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(first.token.includes(first.tokenHash), false);
  const database = { demoLinks: [{ id: first.id, tokenHash: first.tokenHash }] };
  assert.equal(demoLinks.findDemoLink(database, first.token).id, first.id);
  assert.equal(demoLinks.findDemoLink(database, second.token), null);
  assert.equal(demoLinks.findDemoLink(database, first.id + '.not-a-valid-secret'), null);
});

test('demo limits are server clamped and status fails closed', () => {
  const now = Date.parse('2026-08-09T00:00:00.000Z');
  const limits = demoLinks.normalizeDemoLimits({ expiresInDays: 900, maxSessionSeconds: 9999, maxStarts: 0 }, now);
  assert.equal(limits.expiresAt, '2026-09-08T00:00:00.000Z');
  assert.equal(limits.maxSessionSeconds, 600);
  assert.equal(limits.maxStarts, 1);
  const active = { status: 'active', expiresAt: '2026-08-10T00:00:00.000Z', starts: 0, maxStarts: 1 };
  assert.equal(demoLinks.demoLinkStatus(active, now), 'active');
  assert.equal(demoLinks.demoLinkStatus({ ...active, starts: 1 }, now), 'exhausted');
  assert.equal(demoLinks.demoLinkStatus({ ...active, status: 'revoked' }, now), 'revoked');
  assert.equal(demoLinks.demoLinkStatus({ ...active, expiresAt: '2026-08-08T00:00:00.000Z' }, now), 'expired');
});

test('public link projection never returns the token hash or tenant identifiers', () => {
  const link = {
    id: '0123456789abcdef', tokenHash: 'secret-hash', tenantId: 'tenant-secret', agentId: 'agent-1',
    label: 'Sales demo', status: 'active', expiresAt: '2099-01-01T00:00:00.000Z',
    maxSessionSeconds: 300, maxStarts: 25, starts: 2, createdAt: '2026-08-09T00:00:00.000Z',
  };
  const output = demoLinks.publicDemoLink(link, Date.parse('2026-08-09T00:00:00.000Z'));
  assert.equal(output.tokenHash, undefined);
  assert.equal(output.tenantId, undefined);
  assert.equal(output.agentId, 'agent-1');
});
