/**
 * Persona Prompt Compiler for GetQualify Structured Agent Templates
 * Compiles structured JSON (identity, voice rules, conversation stages,
 * data schema, objection matrix, guardrails, dialogue) into a production-grade
 * system prompt for Dograh / LLM voice agents.
 */

function compileStructuredPersona(cfg) {
  if (!cfg || typeof cfg !== 'object') return '';

  const sections = [];
  const identity = cfg.identity || {};
  const roleName = String(identity.roleName || '').trim();
  const businessName = String(identity.businessName || '').trim();
  const businessType = String(identity.businessType || '').trim();
  const languageMix = String(identity.languageMix || '').trim();

  // 1. Identity & Context
  const introParts = [];
  if (roleName && businessName) {
    introParts.push(`You are ${roleName} representing ${businessName}${businessType ? ` (${businessType})` : ''}.`);
  } else if (roleName) {
    introParts.push(`You are ${roleName}.`);
  } else if (businessName) {
    introParts.push(`You are an AI assistant representing ${businessName}${businessType ? ` (${businessType})` : ''}.`);
  }
  introParts.push('Context: Live real-time telephone call in India.');
  sections.push(introParts.join('\n'));

  // 2. Language & Voice Rules
  const rules = Array.isArray(cfg.rules) ? cfg.rules.filter(Boolean) : [];
  if (languageMix || rules.length > 0) {
    const lines = ['LANGUAGE & VOICE RULES:'];
    if (languageMix) lines.push(`- Style: ${languageMix}`);
    for (const r of rules) {
      lines.push(`- ${String(r).trim()}`);
    }
    sections.push(lines.join('\n'));
  }

  // 3. Conversation Stages (State Machine)
  const stages = Array.isArray(cfg.stages) ? cfg.stages.filter(Boolean) : [];
  if (stages.length > 0) {
    const lines = ['CONVERSATION STAGES:'];
    stages.forEach((s, idx) => {
      const name = String(s.name || s.id || `Stage ${idx + 1}`).trim();
      const goal = String(s.goal || '').trim();
      const reqData = Array.isArray(s.requiredData) && s.requiredData.length > 0
        ? ` Capture: [${s.requiredData.join(', ')}]`
        : '';
      lines.push(`STAGE ${idx + 1} (${name}): Goal: ${goal}.${reqData}`);
    });
    sections.push(lines.join('\n'));
  }

  // 4. Data to Capture
  const schema = Array.isArray(cfg.dataSchema) ? cfg.dataSchema.filter(Boolean) : [];
  if (schema.length > 0) {
    const lines = ['DATA TO CAPTURE:'];
    for (const d of schema) {
      const label = String(d.label || d.fieldKey || 'Field').trim();
      const key = String(d.fieldKey || '').trim();
      const req = d.required ? ' [REQUIRED]' : '';
      const desc = String(d.description || '').trim();
      lines.push(`- ${label}${key ? ` (${key})` : ''}${req}${desc ? `: ${desc}` : ''}`);
    }
    sections.push(lines.join('\n'));
  }

  // 5. Objection Handling
  const objections = Array.isArray(cfg.objections) ? cfg.objections.filter(Boolean) : [];
  if (objections.length > 0) {
    const lines = ['OBJECTION HANDLING:'];
    for (const o of objections) {
      const trigger = String(o.trigger || '').trim();
      const resp = String(o.response || '').trim();
      if (trigger && resp) {
        lines.push(`* If customer says: "${trigger}" -> Respond: "${resp}"`);
      }
    }
    if (lines.length > 1) sections.push(lines.join('\n'));
  }

  // 6. Strict Guardrails
  const guardrails = Array.isArray(cfg.guardrails) ? cfg.guardrails.filter(Boolean) : [];
  if (guardrails.length > 0) {
    const lines = ['STRICT GUARDRAILS:'];
    for (const g of guardrails) {
      lines.push(`! ${String(g).trim()}`);
    }
    sections.push(lines.join('\n'));
  }

  // 7. Conversation Example
  const exampleDialog = String(cfg.exampleDialog || '').trim();
  if (exampleDialog) {
    sections.push(`CONVERSATION EXAMPLE:\n${exampleDialog}`);
  }

  return sections.join('\n\n');
}

/**
 * Migration helper: converts a legacy raw persona string into a default
 * structured config so users can switch existing agents to Guided Mode smoothly.
 */
function parseLegacyPersona(rawText) {
  const text = String(rawText || '').trim();
  return {
    version: 2,
    identity: {
      roleName: '',
      businessName: '',
      businessType: '',
      languageMix: 'Warm, natural Hindi-English (Hinglish) mix',
    },
    rules: [
      'Keep responses to 1-2 spoken sentences maximum',
      'Never say sorry more than once',
      'Always listen carefully and do not interrupt when customer speaks',
    ],
    stages: [
      { id: 'greeting', name: 'Greeting & Rapport', goal: 'Greet caller politely and ask how to help', requiredData: [] },
      { id: 'need_discovery', name: 'Requirement Discovery', goal: 'Understand customer requirement or inquiry', requiredData: [] },
      { id: 'closing', name: 'Next Steps & Closing', goal: 'Confirm details and wrap up warmly', requiredData: [] },
    ],
    dataSchema: [],
    objections: [],
    guardrails: [
      'Never make up pricing or medical claims',
      'If unsure, offer to have a human team member call back',
    ],
    exampleDialog: text,
  };
}

module.exports = {
  compileStructuredPersona,
  parseLegacyPersona,
};
