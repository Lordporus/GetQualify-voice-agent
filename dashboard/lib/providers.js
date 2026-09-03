/**
 * RapidX Voice. Provider-agnostic engine.
 *
 * Four registries, each a uniform set of implemented adapters:
 *   stt        : deepgram, intentionally fixed
 *   tts        : rumik
 *   llm        : groq + gemini
 *   telephony  : vobiz via Dograh
 *
 * Every adapter declares { id, label, needs:[envKeys], ... }. `live` means the
 * adapter is implemented and configured, never merely that a key exists.
 * LLM_PROVIDER, LLM_MODEL, TTS_PROVIDER and TTS_MODEL select server defaults.
 * A tenant-safe selection contains provider and model IDs only. Secrets remain
 * in process.env and can never be supplied through a tenant request.
 *
 * Deepgram handles streaming and batch transcription, Rumik keeps the verified
 * browser UA, Groq handles the primary reasoning path, and
 * outbound VoBiz calls always go through Dograh. Never call the raw VoBiz API.
 *
 * No em dashes anywhere. Commas and periods only.
 */
'use strict';

const { httpsPost, httpsGet } = require('./core');

// Rumik sits behind Cloudflare, which 403s non-browser user-agents. NEVER remove.
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

const RUMIK_HOST = 'silk-api.rumik.ai';
const GEMINI_HOST = 'generativelanguage.googleapis.com';
const DEEPGRAM_HOST = 'api.deepgram.com';
const GROQ_HOST = 'api.groq.com';
const MAX_TEXT = 2000; // Rumik hard cap

const TTS_MODELS = new Set(['muga', 'mulberry']);
const TTS_SPEAKERS = new Set(['speaker_1', 'speaker_2', 'speaker_3', 'speaker_4']);
const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PROVIDER_LAYERS = new Set(['stt', 'tts', 'llm', 'telephony']);

// A capability error that route handlers can map to an HTTP status cleanly.
class ProviderError extends Error {
  constructor(message, status = 502, code = 'provider_error', detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

// True when EVERY env key in `keys` is present and non-empty.
function hasEnv(keys) {
  return keys.every((k) => !!(process.env[k] && String(process.env[k]).trim()));
}

// Build the standard "this adapter is a stub" error.
function notConfigured(label, needs) {
  return new ProviderError(
    `${label} is not configured. Add ${needs.join(', ')} to .env to enable it.`,
    501,
    'not_configured',
    { needs },
  );
}

function validModelId(value, label = 'model') {
  const model = String(value || '').trim();
  if (!MODEL_ID_RE.test(model)) {
    throw new ProviderError(`${label} is invalid`, 422, 'invalid_model');
  }
  return model;
}

function commaListEnv(name) {
  return String(process.env[name] || '').split(',').map((value) => value.trim()).filter(Boolean);
}

function selectedModel(adapter, requestedModel) {
  const globalModel = adapter.id === configuredDefaultId(adapter.layer)
    ? process.env[`${adapter.layer.toUpperCase()}_MODEL`] : '';
  const model = validModelId(requestedModel || globalModel || adapter.model, `${adapter.label} model`);
  if (adapter.models && !adapter.models.has(model)) {
    throw new ProviderError(`${model} is not supported by ${adapter.label}`, 422, 'unsupported_model');
  }
  const allowed = adapter.modelAllowlistEnv ? commaListEnv(adapter.modelAllowlistEnv) : [];
  if (allowed.length && !allowed.includes(model)) {
    throw new ProviderError(`${model} is not enabled for ${adapter.label}`, 422, 'model_not_enabled');
  }
  return model;
}

/* ==========================================================================
   TTS LAYER
   ========================================================================== */

const ttsRumik = {
  id: 'rumik',
  label: 'Rumik Silk',
  layer: 'tts',
  needs: ['RUMIK_API_KEY'],
  implemented: true,
  models: TTS_MODELS,
  get live() { return hasEnv(this.needs); },
  get model() { return process.env.RUMIK_MODEL || 'mulberry'; },

  // Synthesize one utterance. Returns { buffer (WAV bytes), credits, chars }.
  // Reuses the verified /v1/tts call exactly: Bearer key + browser UA, mulberry
  // takes speaker/f0_up_key/description, both models take optional sampling args.
  async synthesize(opts) {
    const key = process.env.RUMIK_API_KEY;
    if (!key) throw notConfigured(this.label, this.needs);

    const model = selectedModel(this, opts.model);
    const text = String(opts.text || '').slice(0, MAX_TEXT);
    if (!text.trim()) throw new ProviderError('text is required', 422, 'no_text');

    const payload = { model, text };
    if (model === 'mulberry') {
      if (opts.description) payload.description = String(opts.description).slice(0, 500);
      if (opts.speaker && TTS_SPEAKERS.has(opts.speaker)) payload.speaker = opts.speaker;
      if (Number.isFinite(opts.f0_up_key)) {
        payload.f0_up_key = Math.max(-12, Math.min(12, opts.f0_up_key | 0));
      }
    }
    for (const k of ['temperature', 'top_p', 'top_k', 'repetition_penalty', 'max_new_tokens']) {
      if (Number.isFinite(opts[k])) payload[k] = opts[k];
    }

    const buf = Buffer.from(JSON.stringify(payload));
    const up = await httpsPost(RUMIK_HOST, '/v1/tts', {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Content-Length': buf.length,
      'User-Agent': BROWSER_UA,
    }, buf);

    if (up.status !== 200) {
      throw new ProviderError('rumik synthesis failed', up.status, 'upstream',
        up.buffer.toString('utf8').slice(0, 300));
    }
    return {
      buffer: up.buffer,
      credits: up.headers['x-credits-used'] || '',
      chars: text.length,
    };
  },

  // Mint a one-shot streaming session. Returns { ws_url, token } from Rumik.
  async wsConnect(opts) {
    const key = process.env.RUMIK_API_KEY;
    if (!key) throw notConfigured(this.label, this.needs);
    const model = selectedModel(this, opts.model);
    const buf = Buffer.from(JSON.stringify({
      model,
      text: String(opts.text || '').slice(0, MAX_TEXT),
    }));
    const up = await httpsPost(RUMIK_HOST, '/v1/tts/ws-connect', {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Content-Length': buf.length,
      'User-Agent': BROWSER_UA,
    }, buf);
    if (up.status !== 200) {
      throw new ProviderError('rumik mint failed', up.status, 'upstream',
        up.buffer.toString('utf8').slice(0, 300));
    }
    let data;
    try { data = JSON.parse(up.buffer.toString('utf8')); } catch { data = {}; }
    return data; // { ws_url, token }
  },
};

/* ==========================================================================
   LLM LAYER. Speech recognition intentionally remains Deepgram only.
   ========================================================================== */

const DEFAULT_SYSTEM = 'You are RapidX, a warm, concise voice assistant. Reply in 1 to 3 short spoken sentences. No markdown, no lists, no emojis. This will be read aloud.';

const sttDeepgram = {
  id: 'deepgram',
  label: 'Deepgram Nova-3',
  layer: 'stt',
  needs: ['DEEPGRAM_API_KEY'],
  implemented: true,
  get live() { return hasEnv(this.needs); },
  get model() { return process.env.DEEPGRAM_MODEL || 'nova-3'; },

  async mintToken() {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) throw notConfigured(this.label, this.needs);
    const body = Buffer.from(JSON.stringify({ ttl_seconds: 60 }));
    const up = await httpsPost(DEEPGRAM_HOST, '/v1/auth/grant', {
      'Authorization': `Token ${key}`,
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    }, body);
    let data = {}; try { data = JSON.parse(up.buffer.toString('utf8')); } catch {}
    if (up.status !== 200 || !data.access_token) {
      throw new ProviderError('deepgram token grant failed', up.status, 'upstream',
        (data.err_msg || data.error || up.buffer.toString('utf8')).slice(0, 300));
    }
    return { access_token: data.access_token, expires_in: data.expires_in || 60, model: this.model };
  },

  async transcribe(opts) {
    const key = process.env.DEEPGRAM_API_KEY;
    if (!key) throw notConfigured(this.label, this.needs);
    const audio = Buffer.from(String(opts.audio || ''), 'base64');
    if (audio.length < 200) throw new ProviderError('no audio', 422, 'no_audio');
    const mime = String(opts.mime || 'audio/webm').split(';')[0];
    const started = Date.now();
    const path = `/v1/listen?model=${encodeURIComponent(this.model)}&language=multi&smart_format=true&punctuate=true&utterances=false`;
    const up = await httpsPost(DEEPGRAM_HOST, path, {
      'Authorization': `Token ${key}`,
      'Content-Type': mime,
      'Content-Length': audio.length,
    }, audio);
    let data = {}; try { data = JSON.parse(up.buffer.toString('utf8')); } catch {}
    if (up.status !== 200) {
      throw new ProviderError('deepgram transcription failed', up.status, 'upstream',
        (data.err_msg || data.error || up.buffer.toString('utf8')).slice(0, 300));
    }
    const alt = (((data.results || {}).channels || [])[0] || {}).alternatives || [];
    return {
      text: String((alt[0] || {}).transcript || '').trim(),
      provider: 'deepgram',
      model: this.model,
      latency_ms: Date.now() - started,
    };
  },
};

const llmGroq = {
  id: 'groq',
  label: 'Groq Llama 3.3 70B',
  layer: 'llm',
  needs: ['GROQ_API_KEY'],
  implemented: true,
  modelAllowlistEnv: 'GROQ_ALLOWED_MODELS',
  get live() { return hasEnv(this.needs); },
  get model() { return process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'; },

  async chat(opts) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw notConfigured(this.label, this.needs);
    const history = Array.isArray(opts.messages) ? opts.messages.slice(-16) : [];
    const messages = [{ role: 'system', content: String(opts.system || DEFAULT_SYSTEM).slice(0, 3000) }]
      .concat(history.filter((m) => m && m.text).map((m) => ({
        role: (m.role === 'assistant' || m.role === 'model') ? 'assistant' : 'user',
        content: String(m.text).slice(0, 4000),
      })));
    if (messages.length < 2) throw new ProviderError('no messages', 422, 'no_messages');
    const model = selectedModel(this, opts.model);
    const payload = Buffer.from(JSON.stringify({
      model,
      messages,
      temperature: 0.7,
      max_completion_tokens: 400,
      stream: false,
    }));
    const started = Date.now();
    const up = await httpsPost(GROQ_HOST, '/openai/v1/chat/completions', {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Content-Length': payload.length,
    }, payload);
    let data = {}; try { data = JSON.parse(up.buffer.toString('utf8')); } catch {}
    if (up.status !== 200) {
      throw new ProviderError('groq response failed', up.status, 'upstream',
        (((data.error || {}).message) || up.buffer.toString('utf8')).slice(0, 300));
    }
    const choice = (data.choices || [])[0] || {};
    return {
      text: String(((choice.message || {}).content) || '').trim() || 'Sorry, I did not catch that.',
      finish: choice.finish_reason || null,
      provider: 'groq',
      model,
      latency_ms: Date.now() - started,
    };
  },
};

const llmGemini = {
  id: 'gemini',
  label: 'Google Gemini',
  layer: 'llm',
  needs: ['GEMINI_API_KEY'],
  implemented: true,
  modelAllowlistEnv: 'GEMINI_ALLOWED_MODELS',
  get live() { return hasEnv(this.needs); },
  get model() { return process.env.GEMINI_MODEL || 'gemini-flash-latest'; },

  // The conversation brain. Reuses the verified generateContent call with
  // thinkingConfig.thinkingBudget 0 for low voice-loop latency.
  // Returns { text, finish }.
  async chat(opts) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw notConfigured(this.label, this.needs);

    const model = selectedModel(this, opts.model);
    const history = Array.isArray(opts.messages) ? opts.messages.slice(-16) : [];
    const system = String(opts.system || DEFAULT_SYSTEM).slice(0, 2000);
    const contents = history
      .filter((m) => m && m.text)
      .map((m) => ({
        role: (m.role === 'assistant' || m.role === 'model') ? 'model' : 'user',
        parts: [{ text: String(m.text).slice(0, 4000) }],
      }));
    if (!contents.length) throw new ProviderError('no messages', 422, 'no_messages');

    const payload = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: {
        maxOutputTokens: 400,
        temperature: 0.8,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    const started = Date.now();
    let buf = Buffer.from(JSON.stringify(payload));
    let up = await httpsPost(GEMINI_HOST,
      `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${key}`,
      { 'Content-Type': 'application/json', 'Content-Length': buf.length }, buf);

    let data; try { data = JSON.parse(up.buffer.toString('utf8')); } catch { data = {}; }
    // Some Gemini aliases reject thinkingConfig even though the same models
    // accept the rest of the request. Retry once without that optional field.
    if (up.status === 400 && /invalid argument/i.test((data.error && data.error.message) || '')) {
      delete payload.generationConfig.thinkingConfig;
      buf = Buffer.from(JSON.stringify(payload));
      up = await httpsPost(GEMINI_HOST,
        `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${key}`,
        { 'Content-Type': 'application/json', 'Content-Length': buf.length }, buf);
      try { data = JSON.parse(up.buffer.toString('utf8')); } catch { data = {}; }
    }
    if (up.status !== 200) {
      throw new ProviderError('gemini error', up.status, 'upstream',
        (data.error && data.error.message) || '');
    }
    const cand = (data.candidates || [])[0] || {};
    const parts = (cand.content && cand.content.parts) || [];
    const text = parts.map((p) => p.text || '').join('').trim();
    return {
      text: text || 'Sorry, I did not catch that.',
      finish: cand.finishReason || null,
      provider: this.id,
      model,
      latency_ms: Date.now() - started,
    };
  },
};

/* ==========================================================================
   TELEPHONY LAYER. VoBiz through Dograh.
   ========================================================================== */

function dograhConnection() {
  const raw = String(process.env.DOGRAH_BASE_URL || '').trim();
  let parsed;
  try { parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch {
    throw new ProviderError('DOGRAH_BASE_URL is invalid', 503, 'not_configured');
  }
  if (parsed.protocol !== 'https:') {
    throw new ProviderError('DOGRAH_BASE_URL must use HTTPS', 503, 'not_configured');
  }
  return {
    host: parsed.host,
    prefix: parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, ''),
    dashboard: parsed.origin + '/',
  };
}

function positiveIntEnv(name) {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProviderError(`${name} must be a positive integer`, 503, 'not_configured');
  }
  return value;
}

function parseJsonResponse(up) {
  try { return JSON.parse(up.buffer.toString('utf8') || '{}'); } catch { return {}; }
}

function upstreamMessage(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;
  if (typeof data.detail === 'string') return data.detail;
  if (typeof data.message === 'string') return data.message;
  if (typeof data.error === 'string') return data.error;
  return fallback;
}

function upstreamStatus(status) {
  // An invalid Dograh service credential is not an expired RapidX user session.
  // Never forward 401/403, because the browser correctly treats those as a
  // reason to sign the current RapidX user out.
  if (status === 401 || status === 403) return 502;
  return status || 502;
}

const telVobiz = {
  id: 'vobiz',
  label: 'VoBiz via Dograh',
  layer: 'telephony',
  needs: [
    'DOGRAH_BASE_URL', 'DOGRAH_API_KEY', 'DOGRAH_WORKFLOW_ID',
    'DOGRAH_TELEPHONY_CONFIG_ID', 'DOGRAH_PHONE_NUMBER_ID',
  ],
  implemented: true,
  get live() { return hasEnv(this.needs); },
  get did() { return String(process.env.VOBIZ_NUMBER || '').replace(/[^0-9+]/g, ''); },
  get dashboard() { return dograhConnection().dashboard; },

  async request(method, pathname, payload) {
    if (!hasEnv(this.needs)) throw notConfigured(this.label, this.needs);
    const connection = dograhConnection();
    const headers = { 'X-API-Key': process.env.DOGRAH_API_KEY };
    let up;
    if (method === 'POST') {
      const buf = Buffer.from(JSON.stringify(payload || {}));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = buf.length;
      up = await httpsPost(connection.host, connection.prefix + pathname, headers, buf);
    } else {
      up = await httpsGet(connection.host, connection.prefix + pathname, headers);
    }
    return { up, data: parseJsonResponse(up) };
  },

  // Report the VoBiz configuration and numbers as Dograh sees them. Reading
  // status through Dograh verifies the same control plane used for live calls.
  async status() {
    const configId = positiveIntEnv('DOGRAH_TELEPHONY_CONFIG_ID');
    const phoneNumberId = positiveIntEnv('DOGRAH_PHONE_NUMBER_ID');
    const configsResult = await this.request('GET', '/api/v1/organizations/telephony-configs');
    if (configsResult.up.status < 200 || configsResult.up.status >= 300) {
      throw new ProviderError('Could not read VoBiz status from Dograh', upstreamStatus(configsResult.up.status),
        'upstream', upstreamMessage(configsResult.data, 'Dograh telephony status failed.'));
    }
    const configs = Array.isArray(configsResult.data.configurations)
      ? configsResult.data.configurations : [];
    const config = configs.find((row) => Number(row.id) === configId);
    if (!config || String(config.provider || '').toLowerCase() !== 'vobiz') {
      throw new ProviderError('VoBiz is not configured in Dograh', 503, 'not_configured',
        `Expected Dograh telephony configuration ${configId} with provider vobiz.`);
    }

    const numbersResult = await this.request('GET',
      `/api/v1/organizations/telephony-configs/${configId}/phone-numbers`);
    if (numbersResult.up.status < 200 || numbersResult.up.status >= 300) {
      throw new ProviderError('Could not read VoBiz numbers from Dograh', upstreamStatus(numbersResult.up.status),
        'upstream', upstreamMessage(numbersResult.data, 'Dograh phone-number status failed.'));
    }
    const numbers = Array.isArray(numbersResult.data.phone_numbers)
      ? numbersResult.data.phone_numbers : [];
    const selectedNumber = numbers.find((row) => Number(row.id) === phoneNumberId);
    if (!selectedNumber || selectedNumber.is_active === false) {
      throw new ProviderError('The VoBiz caller ID is not active in Dograh', 503, 'not_configured',
        `Expected active Dograh phone number ${phoneNumberId}.`);
    }
    const dids = numbers.map((row) => ({
      id: row.id,
      number: row.address || row.address_normalized,
      status: row.is_active === false ? 'inactive' : 'active',
      label: row.label || '',
      isDefaultCallerId: !!row.is_default_caller_id,
      inboundWorkflowId: row.inbound_workflow_id,
      inboundWorkflowName: row.inbound_workflow_name || '',
    }));
    return {
      connected: true,
      provider: 'vobiz',
      orchestrator: 'dograh',
      configuration: {
        id: config.id,
        name: config.name,
        isDefaultOutbound: !!config.is_default_outbound,
      },
      dids,
      did: selectedNumber.address || selectedNumber.address_normalized || this.did,
      workflowId: positiveIntEnv('DOGRAH_WORKFLOW_ID'),
      dashboard: this.dashboard,
    };
  },

  // Place one real paid call through Dograh. The HTTP route above this adapter
  // is the sole confirm guard, and this method makes exactly one initiate call.
  async dial(rawNumber, options = {}) {
    if (!hasEnv(this.needs)) throw notConfigured(this.label, this.needs);
    let clean = String(rawNumber || '').trim();
    let num;
    if (clean.startsWith('+')) {
      // E.164 format supplied: keep leading +, strip whitespace and formatting characters
      const digits = clean.slice(1).replace(/[^0-9]/g, '');
      if (digits.length < 7 || digits.length > 15) {
        throw new ProviderError('invalid E.164 number (must be 7-15 digits after +)', 422, 'bad_number');
      }
      num = '+' + digits;
    } else {
      // National / bare format: assume India (+91)
      const digits = clean.replace(/[^0-9]/g, '');
      let stripped = digits;
      if (stripped.length === 12 && stripped.startsWith('91')) stripped = stripped.slice(2);
      else if (stripped.length === 11 && stripped.startsWith('0')) stripped = stripped.slice(1);
      if (stripped.length !== 10) {
        throw new ProviderError('supply a 10-digit Indian number or E.164 format (e.g. +14155552671)', 422, 'bad_number');
      }
      num = '+91' + stripped;
    }
    const result = await this.request('POST', '/api/v1/telephony/initiate-call', {
      workflow_id: Number.isInteger(options.workflowId) && options.workflowId > 0 ? options.workflowId : positiveIntEnv('DOGRAH_WORKFLOW_ID'),
      telephony_configuration_id: positiveIntEnv('DOGRAH_TELEPHONY_CONFIG_ID'),
      from_phone_number_id: Number.isInteger(options.fromPhoneNumberId) && options.fromPhoneNumberId > 0 ? options.fromPhoneNumberId : positiveIntEnv('DOGRAH_PHONE_NUMBER_ID'),
      phone_number: num,
    });
    if (result.up.status < 200 || result.up.status >= 300) {
      throw new ProviderError('Dograh could not initiate the VoBiz call', upstreamStatus(result.up.status),
        'upstream', upstreamMessage(result.data, 'The call was not placed.'));
    }
    return { status: result.up.status, data: result.data };
  },
};

/* ==========================================================================
   Registries + lookups + describeProviders for GET /api/providers
   ========================================================================== */

const registries = { stt: {}, tts: {}, llm: {}, telephony: {} };
const requiredMethods = {
  stt: ['transcribe', 'mintToken'],
  tts: ['synthesize', 'wsConnect'],
  llm: ['chat'],
  telephony: ['status', 'dial'],
};

function registerProvider(layer, adapter, options = {}) {
  if (!PROVIDER_LAYERS.has(layer)) {
    throw new ProviderError(`Unknown provider layer: ${layer}`, 500, 'invalid_provider_layer');
  }
  if (!adapter || adapter.implemented !== true || adapter.layer !== layer || !PROVIDER_ID_RE.test(String(adapter.id || ''))) {
    throw new ProviderError(`Invalid ${layer} provider adapter`, 500, 'invalid_provider_adapter');
  }
  for (const method of requiredMethods[layer]) {
    if (typeof adapter[method] !== 'function') {
      throw new ProviderError(`${adapter.id} does not implement ${layer}.${method}`, 500, 'invalid_provider_adapter');
    }
  }
  if (registries[layer][adapter.id] && !options.replace) {
    throw new ProviderError(`${layer} provider ${adapter.id} is already registered`, 409, 'duplicate_provider');
  }
  registries[layer][adapter.id] = adapter;
  return adapter;
}

registerProvider('stt', sttDeepgram);
registerProvider('tts', ttsRumik);
registerProvider('llm', llmGroq);
registerProvider('llm', llmGemini);
registerProvider('telephony', telVobiz);

function configuredDefaultId(layer) {
  if (layer === 'stt') return 'deepgram';
  const envName = `${layer.toUpperCase()}_PROVIDER`;
  return String(process.env[envName] || ({ tts: 'rumik', llm: 'groq', telephony: 'vobiz' })[layer] || '').trim().toLowerCase();
}

function get(layer, id) {
  if (!PROVIDER_LAYERS.has(layer)) {
    throw new ProviderError(`Unknown provider layer: ${layer}`, 422, 'invalid_provider_layer');
  }
  const providerId = String(id || configuredDefaultId(layer)).trim().toLowerCase();
  if (layer === 'stt' && providerId !== 'deepgram') {
    throw new ProviderError('Deepgram is the only supported STT provider', 422, 'stt_provider_fixed');
  }
  const adapter = registries[layer][providerId];
  if (!adapter) {
    throw new ProviderError(`Unsupported ${layer} provider: ${providerId}`, 422, 'unsupported_provider');
  }
  return adapter;
}

// Resolve a tenant-safe selection. Only provider and model identifiers are
// accepted. Provider secrets always come from server-side environment values.
function resolveSelection(layer, selection = {}) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    throw new ProviderError('Provider selection must be an object', 422, 'invalid_provider_selection');
  }
  const allowed = new Set(['provider', 'model']);
  const secretLike = Object.keys(selection).find((key) => !allowed.has(key));
  if (secretLike) {
    throw new ProviderError(`Provider selection cannot include ${secretLike}`, 422, 'unsafe_provider_selection');
  }
  const adapter = get(layer, selection.provider);
  const resolved = { provider: adapter.id, adapter };
  if (layer === 'llm' || layer === 'tts' || layer === 'stt') {
    resolved.model = selectedModel(adapter, selection.model);
  }
  return resolved;
}

// Convenience accessors preserve the existing route contract while making the
// LLM and TTS defaults environment-selectable at process start.
const stt = get('stt');
const tts = get('tts');
const llm = get('llm');
const telephony = get('telephony');

// Shape used by GET /api/providers so the UI can render active vs ready-to-wire.
function describeProviders() {
  const out = {};
  for (const [layer, reg] of Object.entries(registries)) {
    out[layer] = Object.values(reg).map((a) => ({
      id: a.id,
      label: a.label,
      implemented: true,
      live: a.live,
      selected: a.id === configuredDefaultId(layer),
      model: (layer === 'llm' || layer === 'tts' || layer === 'stt') ? selectedModel(a) : undefined,
      needs: a.needs,
    }));
  }
  return out;
}

module.exports = {
  ProviderError,
  registries, registerProvider, get, resolveSelection, describeProviders,
  stt, tts, llm, telephony,
  MAX_TEXT, TTS_MODELS, TTS_SPEAKERS,
  BROWSER_UA, MODEL_ID_RE,
};
