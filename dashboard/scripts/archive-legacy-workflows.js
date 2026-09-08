#!/usr/bin/env node
/**
 * Archive Legacy Dograh Workflows (Workflow #1 & #2)
 *
 * Idempotently and safely archives unmanaged Dograh workflows #1 ("Sam") and #2 ("Payal Legacy")
 * via Dograh's official status update endpoint: PUT /api/v1/workflow/{id}/status.
 *
 * Usage:
 *   node scripts/archive-legacy-workflows.js --dry-run
 *   node scripts/archive-legacy-workflows.js --live
 */

'use strict';

const core = require('../lib/core');
core.loadEnv();

const db = require('../lib/db');

const urlArgIdx = process.argv.indexOf('--url');
const cliBaseUrl = urlArgIdx !== -1 && process.argv[urlArgIdx + 1] ? process.argv[urlArgIdx + 1] : null;
const DOGRAH_BASE = String(cliBaseUrl || process.env.DOGRAH_BASE_URL || 'https://dograh.getqualify.in').replace(/\/$/, '');
const keyArgIdx = process.argv.indexOf('--key');
const cliApiKey = keyArgIdx !== -1 && process.argv[keyArgIdx + 1] ? process.argv[keyArgIdx + 1] : null;
const DOGRAH_KEY = String(cliApiKey || process.env.DOGRAH_API_KEY || '').trim();

const TARGET_WORKFLOW_IDS = [1, 2];

async function dograhRequest(method, endpoint, body = null) {
  const url = `${DOGRAH_BASE}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': DOGRAH_KEY,
    },
    signal: AbortSignal.timeout(10000),
  };
  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: res.status, ok: res.ok, data: json || text };
}

async function main() {
  const isLive = process.argv.includes('--live');
  const isDryRun = process.argv.includes('--dry-run') || !isLive;

  console.log('=== Legacy Dograh Workflows Archival Utility ===');
  console.log('Target Base URL:', DOGRAH_BASE);
  console.log('Mode:', isDryRun ? 'DRY RUN (Preview only, no state changes)' : 'LIVE (Will archive workflows)');
  console.log('----------------------------------------------------');

  if (!DOGRAH_KEY) {
    console.error('ERROR: DOGRAH_API_KEY is not set in environment.');
    process.exit(1);
  }

  for (const wfId of TARGET_WORKFLOW_IDS) {
    console.log(`\nInspecting Workflow #${wfId}...`);
    try {
      const fetchRes = await dograhRequest('GET', `/api/v1/workflow/fetch/${wfId}`);
      if (!fetchRes.ok) {
        console.log(`  [Workflow #${wfId}] Fetch returned HTTP ${fetchRes.status}: ${JSON.stringify(fetchRes.data)}`);
        continue;
      }
      const wf = fetchRes.data;
      const currentStatus = wf.status || 'unknown';
      console.log(`  Name:   "${wf.name}"`);
      console.log(`  Status: ${currentStatus}`);

      if (currentStatus === 'archived') {
        console.log(`  -> Workflow #${wfId} is ALREADY archived. Nothing to do.`);
        continue;
      }

      if (isDryRun) {
        console.log(`  [DRY RUN] Would call: PUT /api/v1/workflow/${wfId}/status with { "status": "archived" }`);
      } else {
        console.log(`  [LIVE] Archiving Workflow #${wfId}...`);
        const archRes = await dograhRequest('PUT', `/api/v1/workflow/${wfId}/status`, { status: 'archived' });
        if (archRes.ok) {
          console.log(`  -> SUCCESS: Workflow #${wfId} is now archived!`);
        } else {
          console.error(`  -> FAILED: HTTP ${archRes.status}`, archRes.data);
        }
      }
    } catch (err) {
      console.error(`  Error processing Workflow #${wfId}:`, err.message);
    }
  }

  // Check phone number 1 hygiene
  console.log('\nInspecting Telephony Phone Number #1 (+918065354620)...');
  try {
    const phoneRes = await dograhRequest('GET', '/api/v1/organizations/telephony-configs/5/phone-numbers');
    const phoneList = Array.isArray(phoneRes.data) ? phoneRes.data : (phoneRes.data && phoneRes.data.phone_numbers) || [];
    if (phoneRes.ok && phoneList.length > 0) {
      const ph1 = phoneList.find((p) => p.id === 1);
      if (ph1) {
        console.log(`  Number 1 current inbound_workflow_id: ${ph1.inbound_workflow_id}`);
        if (ph1.inbound_workflow_id === 1 || ph1.inbound_workflow_id === 2) {
          if (isDryRun) {
            console.log('  [DRY RUN] Would call: PUT /api/v1/organizations/telephony-configs/5/phone-numbers/1 with { "inbound_workflow_id": 19 }');
          } else {
            console.log('  [LIVE] Updating phone number 1 to inbound_workflow_id: 19...');
            const updatePhRes = await dograhRequest('PUT', '/api/v1/organizations/telephony-configs/5/phone-numbers/1', { inbound_workflow_id: 19 });
            if (updatePhRes.ok) console.log('  -> SUCCESS: Phone number 1 updated to workflow 19.');
            else console.error('  -> FAILED to update phone number 1:', updatePhRes.data);
          }
        } else {
          console.log(`  -> Phone number 1 is already pointing to workflow ${ph1.inbound_workflow_id}.`);
        }
      }
    }
  } catch (err) {
    console.error('  Error checking phone number 1:', err.message);
  }

  console.log('\n----------------------------------------------------');
  if (isDryRun) {
    console.log('DRY RUN COMPLETE. No workflows were modified.');
    console.log('Run with --live to apply the archival.');
  } else {
    console.log('ARCHIVAL EXECUTION COMPLETE.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
