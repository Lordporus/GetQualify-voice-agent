#!/usr/bin/env node
/**
 * Sync Dograh Workflows CLI Script
 * Scans PostgreSQL `agents` table for rows missing `dograh_workflow_id` or `dograh_embed_token`,
 * builds the corresponding workflow definition, publishes it in Dograh, and stores the IDs.
 *
 * Usage:
 *   node scripts/sync-dograh-workflows.js [--dry-run] [--force]
 */

'use strict';

const core = require('../lib/core');
core.loadEnv();

const db = require('../lib/db');
const dograh = require('../lib/dograh');

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const isForce = process.argv.includes('--force');

  console.log('=== Dograh Workflow Sync Tool ===');
  console.log('Mode:', isDryRun ? 'DRY RUN (no DB writes)' : 'LIVE SYNC');
  console.log('Force overwrite:', isForce);

  if (!db.isPostgres) {
    console.log('Running in non-PostgreSQL environment. Checking in-memory agents...');
    const agents = core.db().agents || [];
    console.log(`Found ${agents.length} agent(s) in local JSON DB.`);
    return;
  }

  const query = isForce
    ? 'SELECT * FROM agents ORDER BY created_at ASC'
    : 'SELECT * FROM agents WHERE dograh_workflow_id IS NULL OR dograh_embed_token IS NULL ORDER BY created_at ASC';

  const res = await db.query(query);
  const agents = res.rows || [];

  console.log(`Found ${agents.length} agent(s) requiring Dograh sync.`);
  if (agents.length === 0) {
    console.log('All agents are up to date. Exiting.');
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const row of agents) {
    const agent = {
      id: row.id,
      name: row.name,
      persona: row.persona,
      greeting: row.greeting,
      tts: row.tts,
      dograhWorkflowId: isForce ? null : (row.dograhWorkflowId || row.dograh_workflow_id),
      dograhEmbedToken: isForce ? null : (row.dograhEmbedToken || row.dograh_embed_token),
    };

    console.log(`\nSyncing Agent [${agent.id}] "${agent.name}"...`);

    if (isDryRun) {
      const def = dograh.buildWorkflowDefinition(agent);
      console.log(`[DRY RUN] Generated definition with ${def.nodes.length} nodes and ${def.edges.length} edges.`);
      successCount++;
      continue;
    }

    const syncRes = await dograh.syncAgentWorkflow(agent);
    if (syncRes && syncRes.ok) {
      await db.query(
        'UPDATE agents SET dograh_workflow_id = $1, dograh_embed_token = $2 WHERE id = $3',
        [syncRes.workflowId, syncRes.embedToken, agent.id]
      );
      console.log(`  -> Synced successfully! Workflow ID: ${syncRes.workflowId}, Token: ${syncRes.embedToken.slice(0, 12)}...`);
      successCount++;
    } else {
      console.error(`  -> Sync failed: ${syncRes ? syncRes.error : 'Unknown error'}`);
      failCount++;
    }

    // Small 250ms pause between syncs to be polite to the Dograh API
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  console.log(`\n=== Sync Finished: ${successCount} succeeded, ${failCount} failed ===`);
}

main().catch((err) => {
  console.error('Fatal sync error:', err);
  process.exit(1);
});
