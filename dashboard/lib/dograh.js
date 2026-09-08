/**
 * Dograh Workflow Client Module
 * Handles dynamic workflow generation, publishing, and embed-token minting
 * verified against Dograh API schemas (/opt/dograh/api/routes/workflow.py,
 * /opt/dograh/api/services/workflow/dto.py, /opt/dograh/api/routes/workflow_embed.py).
 */

const DEFAULT_DOGRAH_BASE_URL = 'https://dograh.getqualify.in';

function getDograhConfig() {
  const baseUrl = String(process.env.DOGRAH_BASE_URL || DEFAULT_DOGRAH_BASE_URL).replace(/\/$/, '');
  const apiKey = String(process.env.DOGRAH_API_KEY || '').trim();
  return { baseUrl, apiKey };
}

/**
 * Builds a 3-node ReactFlow definition:
 * Node 1: startCall (greeting, is_start: true)
 * Node 2: agentNode (persona + voice tone directive)
 * Node 3: endCall (hangup, is_end: true)
 * Edges: 1 -> 2 (start to agent), 2 -> 3 (agent to end)
 */
function buildWorkflowDefinition(agent = {}) {
  const greeting = String(agent.greeting || '').trim() || 'Hello! How can I assist you today?';
  let personaPrompt = String(agent.persona || '').trim() || 'You are a helpful voice assistant.';

  // Decision 1: Inject voice tone and language directive into agentNode prompt
  const tts = agent.tts || {};
  const toneDirectives = [];
  if (tts.model === 'muga' && tts.tone) {
    toneDirectives.push(`Speak in a ${tts.tone} conversational tone.`);
  } else if (tts.model === 'mulberry') {
    toneDirectives.push('Speak in a warm, polite conversational tone.');
  }
  if (tts.description) {
    toneDirectives.push(tts.description);
  }
  if (toneDirectives.length > 0) {
    personaPrompt += `\n\n[Voice Style & Tone Directive: ${toneDirectives.join(' ')}]`;
  }

  return {
    nodes: [
      {
        id: '1',
        type: 'startCall',
        position: { x: 600, y: 50 },
        data: {
          name: 'Start Call',
          prompt: greeting,
          is_start: true,
        },
      },
      {
        id: '2',
        type: 'agentNode',
        position: { x: 600, y: 300 },
        data: {
          name: 'Agent Conversation',
          prompt: personaPrompt,
        },
      },
      {
        id: '3',
        type: 'endCall',
        position: { x: 600, y: 600 },
        data: {
          name: 'End Call',
          prompt: 'Thank you for calling. Have a great day!',
          is_end: true,
        },
      },
    ],
    edges: [
      {
        id: 'xy-edge__1-2',
        source: '1',
        target: '2',
        type: 'custom',
        animated: true,
        data: {
          condition: 'Always take this route',
          label: 'Start Conversation',
        },
      },
      {
        id: 'xy-edge__2-3',
        source: '2',
        target: '3',
        type: 'custom',
        animated: true,
        data: {
          condition: 'end call',
          label: 'Hangup',
        },
      },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

async function createWorkflowDefinition({ name, definition }) {
  const { baseUrl, apiKey } = getDograhConfig();
  if (!apiKey) throw new Error('DOGRAH_API_KEY is not configured');

  const res = await fetch(`${baseUrl}/api/v1/workflow/create/definition`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({
      name: String(name || 'Agent Workflow'),
      workflow_definition: definition,
    }),
    signal: AbortSignal.timeout(12000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail ? JSON.stringify(data.detail) : `HTTP ${res.status}`;
    throw new Error(`Dograh create workflow failed: ${detail}`);
  }
  return Number(data.id);
}

async function publishWorkflow(workflowId) {
  const { baseUrl, apiKey } = getDograhConfig();
  if (!apiKey) throw new Error('DOGRAH_API_KEY is not configured');

  const res = await fetch(`${baseUrl}/api/v1/workflow/${workflowId}/publish`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(10000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // If no draft exists, the workflow is already in published state
    if (res.status === 400 && String(data.detail || '').includes('No draft to publish')) {
      return { status: 'published', alreadyPublished: true };
    }
    const detail = data.detail ? JSON.stringify(data.detail) : `HTTP ${res.status}`;
    throw new Error(`Dograh publish workflow failed: ${detail}`);
  }
  return data;
}

async function createEmbedToken(workflowId) {
  const { baseUrl, apiKey } = getDograhConfig();
  if (!apiKey) throw new Error('DOGRAH_API_KEY is not configured');

  const res = await fetch(`${baseUrl}/api/v1/workflow/${workflowId}/embed-token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({
      allowed_domains: null,
      settings: {},
      usage_limit: null,
      expires_in_days: null, // Non-expiring token
    }),
    signal: AbortSignal.timeout(10000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail ? JSON.stringify(data.detail) : `HTTP ${res.status}`;
    throw new Error(`Dograh create embed token failed: ${detail}`);
  }
  return String(data.token);
}

async function updateWorkflowDefinition(workflowId, { name, definition }) {
  const { baseUrl, apiKey } = getDograhConfig();
  if (!apiKey) throw new Error('DOGRAH_API_KEY is not configured');

  const body = {
    name: String(name || 'Agent Workflow'),
    workflow_definition: definition,
  };

  const res = await fetch(`${baseUrl}/api/v1/workflow/${workflowId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail ? JSON.stringify(data.detail) : `HTTP ${res.status}`;
    throw new Error(`Dograh update workflow failed: ${detail}`);
  }

  // Every PUT creates a draft that must be published
  await publishWorkflow(workflowId);
  return Number(workflowId);
}

/**
 * Composite orchestrator:
 * - If workflowId exists: update definition + publish
 * - If workflowId does not exist: create definition + publish + mint embed token
 * Fail-soft: returns { ok: false, error } instead of throwing, so agent creation never crashes.
 */
async function syncAgentWorkflow(agent = {}) {
  try {
    if (process.env.DISABLE_DOGRAH_SYNC === 'true') {
      return { ok: false, skipped: true, reason: 'DISABLE_DOGRAH_SYNC is set' };
    }

    const { apiKey } = getDograhConfig();
    if (!apiKey) {
      return { ok: false, skipped: true, reason: 'DOGRAH_API_KEY not configured' };
    }

    const definition = buildWorkflowDefinition(agent);
    const existingWfId = Number(agent.dograhWorkflowId || agent.dograh_workflow_id);

    if (existingWfId && existingWfId > 0) {
      await updateWorkflowDefinition(existingWfId, {
        name: agent.name || 'Agent Workflow',
        definition,
      });

      let embedToken = agent.dograhEmbedToken || agent.dograh_embed_token;
      if (!embedToken) {
        embedToken = await createEmbedToken(existingWfId);
      }
      return { ok: true, workflowId: existingWfId, embedToken };
    }

    // New workflow creation flow:
    const workflowId = await createWorkflowDefinition({
      name: agent.name || 'Agent Workflow',
      definition,
    });
    await publishWorkflow(workflowId);
    const embedToken = await createEmbedToken(workflowId);

    return { ok: true, workflowId, embedToken };
  } catch (err) {
    console.error('[dograh-sync] syncAgentWorkflow failed soft:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  buildWorkflowDefinition,
  createWorkflowDefinition,
  publishWorkflow,
  createEmbedToken,
  updateWorkflowDefinition,
  syncAgentWorkflow,
};
