'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dograh = require('../lib/dograh');

test('isRumikAgent identifies Rumik agents by provider or model', () => {
  assert.equal(dograh.isRumikAgent({ tts: { provider: 'rumik', model: 'mulberry' } }), true);
  assert.equal(dograh.isRumikAgent({ tts: { provider: 'rumik', model: 'muga' } }), true);
  assert.equal(dograh.isRumikAgent({ tts: { model: 'muga' } }), true);
  assert.equal(dograh.isRumikAgent({ tts_model: 'mulberry' }), true);
  assert.equal(dograh.isRumikAgent({ tts_provider: 'rumik' }), true);

  // Deepgram / ElevenLabs agents should return false
  assert.equal(dograh.isRumikAgent({ tts: { provider: 'deepgram', model: 'aura-asteria-en' } }), false);
  assert.equal(dograh.isRumikAgent({ tts_provider: 'deepgram' }), false);
  assert.equal(dograh.isRumikAgent({}), false);
  assert.equal(dograh.isRumikAgent(null), false);
});

test('buildWorkflowConfigurations returns null for non-Rumik agents', () => {
  const deepgramAgent = {
    name: 'Payal - Salon',
    tts: { provider: 'deepgram', model: 'aura-asteria-en' },
  };
  const config = dograh.buildWorkflowConfigurations(deepgramAgent);
  assert.equal(config, null);
});

test('buildWorkflowConfigurations generates valid model_configuration_v2_override for Rumik agent', () => {
  const rumikAgent = {
    name: 'Apex Health Clinic',
    tts: {
      provider: 'rumik',
      model: 'mulberry',
      voice: 'ira',
      description: 'warm professional doctor receptionist',
    },
  };

  const config = dograh.buildWorkflowConfigurations(rumikAgent);
  assert.ok(config);
  assert.ok(config.model_configuration_v2_override);

  const override = config.model_configuration_v2_override;
  assert.equal(override.mode, 'byok');
  assert.equal(override.version, 2);
  assert.ok(override.byok && override.byok.pipeline);

  const pipeline = override.byok.pipeline;
  assert.equal(pipeline.tts.provider, 'rumik');
  assert.equal(pipeline.tts.model, 'mulberry');
  assert.equal(pipeline.tts.voice, 'ira');
  assert.equal(pipeline.tts.description, 'warm professional doctor receptionist');
  assert.ok(pipeline.tts.gateway_url);

  // STT and LLM pipeline parts should also be configured
  assert.equal(pipeline.stt.provider, 'deepgram');
  assert.equal(pipeline.llm.provider, 'groq');
});
