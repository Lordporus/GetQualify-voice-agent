const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { compileStructuredPersona, parseLegacyPersona } = require('../lib/prompt-compiler');

describe('Persona Prompt Compiler', () => {
  test('compiles a complete structured agent template into an optimized prompt', () => {
    const template = {
      version: 2,
      identity: {
        roleName: 'Payal, Front Desk Receptionist',
        businessName: 'Envy Salon & Spa',
        businessType: 'Premium Hair & Beauty Salon',
        languageMix: 'Warm, natural Hindi-English (Hinglish) mix',
      },
      rules: [
        'Keep responses to 1-2 spoken sentences',
        'Never say sorry more than once',
      ],
      stages: [
        { id: 'greeting', name: 'Greeting', goal: 'Greet caller and introduce salon', requiredData: [] },
        { id: 'service', name: 'Service Selection', goal: 'Determine haircut or facial', requiredData: ['service_type'] },
      ],
      dataSchema: [
        { fieldKey: 'caller_name', label: 'Customer Name', required: true, description: "Customer's full name" },
        { fieldKey: 'service_type', label: 'Requested Service', required: false, description: 'Haircut, color, or spa' },
      ],
      objections: [
        { trigger: 'Price is too high', response: 'Mention our 15% first-time visitor discount' },
      ],
      guardrails: [
        'No medical advice on skin treatments',
        'Always confirm appointment time twice',
      ],
      exampleDialog: 'Caller: Kitna time lagega?\nPayal: Haircut mein 30-40 minutes lagenge sir.',
    };

    const compiled = compileStructuredPersona(template);

    assert.ok(compiled.includes('You are Payal, Front Desk Receptionist representing Envy Salon & Spa (Premium Hair & Beauty Salon).'));
    assert.ok(compiled.includes('Context: Live real-time telephone call in India.'));
    assert.ok(compiled.includes('LANGUAGE & VOICE RULES:'));
    assert.ok(compiled.includes('- Style: Warm, natural Hindi-English (Hinglish) mix'));
    assert.ok(compiled.includes('- Keep responses to 1-2 spoken sentences'));
    assert.ok(compiled.includes('STAGE 2 (Service Selection): Goal: Determine haircut or facial. Capture: [service_type]'));
    assert.ok(compiled.includes('- Customer Name (caller_name) [REQUIRED]: Customer\'s full name'));
    assert.ok(compiled.includes('* If customer says: "Price is too high" -> Respond: "Mention our 15% first-time visitor discount"'));
    assert.ok(compiled.includes('! No medical advice on skin treatments'));
    assert.ok(compiled.includes('CONVERSATION EXAMPLE:\nCaller: Kitna time lagega?'));
  });

  test('gracefully handles empty or partial templates without breaking', () => {
    assert.equal(compileStructuredPersona(null), '');
    assert.equal(compileStructuredPersona(undefined), '');
    assert.equal(compileStructuredPersona({}), 'Context: Live real-time telephone call in India.');

    const minimal = {
      identity: { roleName: 'Simran', businessName: 'QuickFix' },
    };
    const compiled = compileStructuredPersona(minimal);
    assert.ok(compiled.includes('You are Simran representing QuickFix.'));
    assert.ok(!compiled.includes('CONVERSATION STAGES:'));
    assert.ok(!compiled.includes('OBJECTION HANDLING:'));
  });

  test('parseLegacyPersona initializes a standard structured template preserving raw persona', () => {
    const raw = 'You are a warm receptionist who takes bookings.';
    const parsed = parseLegacyPersona(raw);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.exampleDialog, raw);
    assert.equal(parsed.stages.length, 3);
    assert.ok(parsed.rules.length > 0);
  });
});
