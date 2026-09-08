'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dograh = require('../lib/dograh');

test('Dograh workflow definition conforms strictly to DTO schema and referential integrity', () => {
  const agent = {
    name: 'Payal - Salon Test',
    persona: 'You are Payal, a friendly receptionist in Bangalore.',
    greeting: 'Namaste! Welcome to our salon.',
    tts: {
      provider: 'rumik',
      model: 'mulberry',
      speaker: 'speaker_2',
      tone: 'friendly',
      description: 'Warm and courteous tone',
    },
  };

  const def = dograh.buildWorkflowDefinition(agent);

  // Nodes validation
  assert.equal(Array.isArray(def.nodes), true);
  assert.equal(def.nodes.length, 3);

  const startNode = def.nodes.find((n) => n.id === '1');
  assert.ok(startNode);
  assert.equal(startNode.type, 'startCall');
  assert.equal(startNode.data.is_start, true);
  assert.equal(startNode.data.prompt, agent.greeting);

  const agentNode = def.nodes.find((n) => n.id === '2');
  assert.ok(agentNode);
  assert.equal(agentNode.type, 'agentNode');
  assert.ok(agentNode.data.prompt.includes(agent.persona));
  assert.ok(agentNode.data.prompt.includes('[Voice Style & Tone Directive:'));

  const endNode = def.nodes.find((n) => n.id === '3');
  assert.ok(endNode);
  assert.equal(endNode.type, 'endCall');
  assert.equal(endNode.data.is_end, true);
  assert.ok(endNode.data.prompt.length > 0);

  // Edges validation
  assert.equal(Array.isArray(def.edges), true);
  assert.equal(def.edges.length, 2);

  const nodeIds = new Set(def.nodes.map((n) => n.id));
  for (const edge of def.edges) {
    assert.ok(nodeIds.has(edge.source), `Edge source ${edge.source} must exist in nodes`);
    assert.ok(nodeIds.has(edge.target), `Edge target ${edge.target} must exist in nodes`);
    assert.ok(edge.data && edge.data.label && edge.data.condition);
  }
});

test('Dograh workflow definition fallbacks when agent fields are missing', () => {
  const def = dograh.buildWorkflowDefinition({});

  assert.equal(def.nodes.length, 3);
  assert.equal(def.nodes[0].data.prompt, 'Hello! How can I assist you today?');
  assert.equal(def.nodes[1].data.prompt, 'You are a helpful voice assistant.');
  assert.equal(def.nodes[2].data.prompt, 'Thank you for calling. Have a great day!');
});

test('Dograh syncAgentWorkflow fails soft when API key is missing', async () => {
  const originalKey = process.env.DOGRAH_API_KEY;
  try {
    delete process.env.DOGRAH_API_KEY;
    const result = await dograh.syncAgentWorkflow({ name: 'Test' });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
  } finally {
    process.env.DOGRAH_API_KEY = originalKey;
  }
});

test('Dograh syncAgentWorkflow can be disabled via DISABLE_DOGRAH_SYNC', async () => {
  const originalToggle = process.env.DISABLE_DOGRAH_SYNC;
  try {
    process.env.DISABLE_DOGRAH_SYNC = 'true';
    const result = await dograh.syncAgentWorkflow({ name: 'Test' });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
  } finally {
    process.env.DISABLE_DOGRAH_SYNC = originalToggle;
  }
});
