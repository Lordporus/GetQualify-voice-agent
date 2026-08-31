'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../lib/core');

test('schema migration is additive and normalizes roles', () => {
  const old = { tenants: [{ id: 't1' }], users: [{ id: 'u1', role: 'unknown' }], agents: [{ id: 'a1' }] };
  const migrated = core.migrateDb(old);
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(migrated.agents.length, 1);
  assert.equal(migrated.users[0].role, 'member');
  assert.equal(migrated.tenants[0].status, 'active');
  assert.equal(migrated.tenants[0].privacyMode, 'standard');
  for (const key of ['wallets', 'ledger', 'paymentIntents', 'paymentEvents', 'supportTickets', 'supportMessages', 'auditEvents', 'presets', 'byonConnections', 'hvacJobs', 'hvacSettings', 'demoLinks', 'invoices', 'invoiceEvents', 'integrationRequests', 'agencyPrompts', 'clientActivities', 'tenantStatusEvents']) assert.ok(Array.isArray(migrated[key]));
});

test('password hashes verify and role hierarchy is enforced', () => {
  const hash = core.hashPassword('a safe password');
  assert.equal(core.verifyPassword('a safe password', hash), true);
  assert.equal(core.verifyPassword('wrong', hash), false);
  assert.equal(core.hasRole({ role: 'super_admin' }, 'admin'), true);
  assert.equal(core.hasRole({ role: 'owner' }, 'admin'), false);
  assert.equal(core.hasRole({ role: 'member' }, 'member'), true);
});
