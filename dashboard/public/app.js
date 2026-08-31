'use strict';
/* RapidX Voice Studio , front-end. Talks only to our own /api/* (keys stay server-side). */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const RATE = { muga: { disc: 0.99, perm: 5 }, mulberry: { disc: 0.50, perm: 2.5 } }; // ₹ / 1000 chars

/* ---------- tabs ---------- */
$$('.tab').forEach((t) => t.onclick = () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  $$('.panel').forEach((x) => x.classList.remove('active'));
  t.classList.add('active');
  $('#tab-' + t.dataset.tab).classList.add('active');
});

/* ---------- health ---------- */
fetch('/api/health').then((r) => r.json()).then((h) => {
  const el = $('#health');
  if (h.ok && h.rumik && h.gemini) { el.textContent = 'rumik ✓  brain ✓'; el.className = 'pill ok'; }
  else { el.textContent = 'keys: rumik ' + (h.rumik ? '✓' : '✗') + ' brain ' + (h.gemini ? '✓' : '✗'); el.className = 'pill err'; }
  $('#footHealth').textContent = 'brain: ' + (h.model || '');
}).catch(() => { $('#health').textContent = 'server offline'; $('#health').className = 'pill err'; });

/* =========================================================
   STUDIO
   ========================================================= */
let studioModel = 'muga', tone = 'happy';

function refreshStudioUI() {
  $('#mugaCtl').hidden = studioModel !== 'muga';
  $('#mulCtl').hidden = studioModel !== 'mulberry';
  $('#ccModel').textContent = studioModel;
  updateCost();
}
$$('#studioModel button').forEach((b) => b.onclick = () => {
  $$('#studioModel button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active'); studioModel = b.dataset.m; refreshStudioUI();
});
$$('#toneChips .chip').forEach((c) => c.onclick = () => {
  $$('#toneChips .chip').forEach((x) => x.classList.remove('active'));
  c.classList.add('active'); tone = c.dataset.tone;
});
$('#studioPitch').oninput = (e) => $('#pitchVal').textContent = e.target.value;
$('#studioText').oninput = updateCost;

function studioCharCount() {
  let t = $('#studioText').value;
  if (studioModel === 'muga') t = `[${tone}] ` + t;
  return t.length;
}
function updateCost() {
  const n = studioCharCount();
  $('#ccChars').textContent = n.toLocaleString();
  $('#ccDisc').textContent = '₹' + (n / 1000 * RATE[studioModel].disc).toFixed(3);
  $('#ccPerm').textContent = '₹' + (n / 1000 * RATE[studioModel].perm).toFixed(3);
}

$('#genBtn').onclick = async () => {
  const btn = $('#genBtn'); btn.disabled = true;
  const st = $('#genStatus'); st.textContent = 'synthesizing…';
  let text = $('#studioText').value.trim();
  if (!text) { st.textContent = 'enter some text first'; btn.disabled = false; return; }
  const payload = { model: studioModel, text };
  if (studioModel === 'muga') payload.text = `[${tone}] ` + text;
  if (studioModel === 'mulberry') {
    const sp = $('#studioSpeaker').value;
    if (sp) payload.speaker = sp; else payload.description = $('#studioDesc').value;
    if (sp) payload.description = $('#studioDesc').value; // description still steers prosody
    payload.f0_up_key = parseInt($('#studioPitch').value, 10) || 0;
  }
  const t0 = performance.now();
  try {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) { const e = await r.json().catch(() => ({})); st.textContent = 'error: ' + (e.detail || e.error || r.status); btn.disabled = false; return; }
    const blob = await r.blob();
    const dt = ((performance.now() - t0) / 1000).toFixed(2);
    const url = URL.createObjectURL(blob);
    const a = $('#audio'); a.src = url; $('#dlLink').href = url;
    $('#player').hidden = false;
    // duration once metadata loads
    a.onloadedmetadata = () => { $('#pmDur').textContent = a.duration.toFixed(1) + 's audio'; };
    $('#pmLatency').textContent = dt + 's gen';
    const chars = parseInt(r.headers.get('X-Chars') || payload.text.length, 10);
    $('#pmCost').textContent = '₹' + (chars / 1000 * RATE[studioModel].disc).toFixed(3) + ' (now)';
    a.play().catch(() => {});
    st.textContent = 'done · ' + chars + ' chars';
  } catch (e) { st.textContent = 'failed: ' + e.message; }
  btn.disabled = false;
};

/* sample A/B player */
const SAMPLES = [
  ['muga · excited', 'muga_excited.wav', 'tone tag [excited]'],
  ['muga · whisper', 'muga_whisper.wav', 'tone tag [whisper]'],
  ['mulberry · speaker_1', 'mul_spk1.wav', 'preset studio voice'],
  ['mulberry · deep male', 'mul_spk3_deep.wav', 'speaker_3 + description'],
  ['mulberry · pitch +2', 'mul_spk1_pitch.wav', 'f0_up_key = 2'],
  ['mulberry · streamed', 'stream_mulberry.wav', 'live WS path'],
];
(function renderSamples() {
  const box = $('#samples'); let cur = null;
  SAMPLES.forEach(([label, file, sub]) => {
    const row = document.createElement('div'); row.className = 'sample-row';
    row.innerHTML = `<button class="splay">▶</button><div><div class="slabel">${label}</div><div class="ssub">${sub}</div></div>`;
    const btn = row.querySelector('.splay');
    const au = new Audio('/samples/' + file);
    btn.onclick = () => {
      if (cur && cur !== au) { cur.pause(); cur.currentTime = 0; }
      if (au.paused) { au.play(); btn.textContent = '⏸'; cur = au; } else { au.pause(); btn.textContent = '▶'; }
    };
    au.onended = () => btn.textContent = '▶';
    box.appendChild(row);
  });
})();

/* =========================================================
   ECONOMICS
   ========================================================= */
(function renderEcon() {
  const data = [
    ['Rumik mulberry · promo', 5.9, true],
    ['OpenAI tts-1', 15, false],
    ['Deepgram Aura-2', 15, false],
    ['Rumik mulberry · list', 29, false],
    ['Cartesia Sonic', 35, false],
    ['Rumik muga · list', 59, false],
    ['ElevenLabs (PAYG)', 99, false],
  ];
  const max = 99, ul = $('#econBars');
  data.forEach(([label, val, hl]) => {
    const li = document.createElement('li'); if (hl) li.className = 'hl';
    li.innerHTML = `<span>${label}</span><div><div class="bar" style="width:${Math.max(6, val / max * 100)}%"></div></div><span class="bnum">$${val}/1M</span>`;
    ul.appendChild(li);
  });
  $('#verdictText').innerHTML =
    "Real, but read the fine print. <b>The capability is genuinely modern</b> , description-steered expressive TTS, four preset speakers, pitch control, tone tags, and a streaming WS path that returns first audio in ~1.3s. " +
    "<b>The pricing is the headline.</b> At the launch promo, mulberry at ₹0.50/1k (~$5.9/1M) is cheaper than OpenAI and Deepgram and a fraction of ElevenLabs , and your meter is reading 0 credits used so far. " +
    "At the <b>permanent</b> rate (₹2.5/1k for mulberry, ₹5/1k for muga) it's no longer a giveaway: mulberry lands near Cartesia and under ElevenLabs, but OpenAI/Deepgram undercut it. " +
    "So the move is: <b>build on it now while it's cheap, but design the stack so the TTS engine is swappable</b>, and judge the voice by ear vs ElevenLabs before betting a client product on permanent pricing. For INR-billed Indian voice agents, native rupee pricing + expressiveness is a real edge.";
})();

/* =========================================================
   LIVE , mic → brain → Rumik streaming TTS
   ========================================================= */
let liveModel = 'mulberry';
$$('#liveModel button').forEach((b) => b.onclick = () => {
  $$('#liveModel button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active'); liveModel = b.dataset.v;
  $('#liveSpeakerWrap').style.opacity = liveModel === 'muga' ? .4 : 1;
  $('#latVoice').textContent = liveModel + (liveModel === 'mulberry' ? ' · ' + $('#liveSpeaker').value : '');
});

const orb = $('#orb'), orbLabel = $('#orbLabel');
function setOrb(state, label) { orb.className = 'voice-orb ' + state; if (label) orbLabel.textContent = label; }

let audioCtx = null;
function ctx() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 }); return audioCtx; }

let conversation = [];
function addBubble(role, text) {
  const tr = $('#transcript'); const empty = tr.querySelector('.t-empty'); if (empty) empty.remove();
  const b = document.createElement('div'); b.className = 'bubble ' + (role === 'user' ? 'user' : 'bot');
  b.innerHTML = `<span class="who">${role === 'user' ? 'you' : 'getqualify'}</span>${text}`;
  tr.appendChild(b); tr.scrollTop = tr.scrollHeight;
}

/* speak text through Rumik streaming WS; resolves when done. */
function speak(text) {
  return new Promise(async (resolve) => {
    let frameText = text, model = liveModel;
    const frame = { text: frameText };
    if (model === 'mulberry') {
      const desc = $('#liveDesc').value.trim();
      if (desc) frame.description = desc; else frame.speaker = $('#liveSpeaker').value;
      frame.f0_up_key = 0;
    }
    let mint;
    try {
      mint = await (await fetch('/api/ws-connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, text: frameText }) })).json();
    } catch (e) { resolve(); return; }
    if (!mint.ws_url) { resolve(); return; }
    const c = ctx(); if (c.state === 'suspended') c.resume();
    let playAt = c.currentTime + 0.05, t0 = performance.now(), gotFirst = false;
    const ws = new WebSocket(mint.ws_url + '?token=' + encodeURIComponent(mint.token));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify(frame));
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        if (!gotFirst) { gotFirst = true; $('#latTtfa').textContent = ((performance.now() - t0) / 1000).toFixed(2) + 's'; setOrb('speaking', 'speaking…'); }
        const pcm = new Int16Array(e.data);
        const buf = c.createBuffer(1, pcm.length, 24000);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
        const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination);
        playAt = Math.max(playAt, c.currentTime);
        src.start(playAt); playAt += buf.duration;
        speak._lastEnd = playAt;
      } else {
        let m = {}; try { m = JSON.parse(e.data); } catch (_) {}
        if (m.type === 'done' || m.error) { ws.close(); }
      }
    };
    ws.onclose = () => {
      const wait = Math.max(0, (speak._lastEnd || c.currentTime) - c.currentTime) * 1000 + 150;
      setTimeout(resolve, wait);
    };
    ws.onerror = () => resolve();
  });
}

/* brain */
async function think() {
  const t0 = performance.now();
  const r = await fetch('/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ system: $('#persona').value, messages: conversation }),
  });
  const d = await r.json().catch(() => ({}));
  $('#latBrain').textContent = ((performance.now() - t0) / 1000).toFixed(2) + 's';
  return d.text || "Sorry, I had trouble there.";
}

/* STT via real mic capture -> Gemini (works in Brave + every browser, no Web Speech API) */
let running = false, speaking = false;
let micStream = null, recCtx = null, recNode = null, recBuf = [], recording = false;

async function armMic() {
  if (micStream) return true;
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
  catch (e) { return false; }
  recCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = recCtx.createMediaStreamSource(micStream);
  recNode = recCtx.createScriptProcessor(4096, 1, 1);
  src.connect(recNode); recNode.connect(recCtx.destination);
  recNode.onaudioprocess = (e) => { if (recording) recBuf.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  return true;
}
function encodeWavB64(chunks, sr) {
  let len = 0; chunks.forEach((c) => len += c.length);
  const data = new Float32Array(len); let o = 0; chunks.forEach((c) => { data.set(c, o); o += c.length; });
  const target = 16000, ratio = sr / target, outLen = Math.floor(len / ratio), out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) { const s = data[Math.floor(i * ratio)] || 0; out[i] = Math.max(-1, Math.min(1, s)) * 0x7fff; }
  const buf = new ArrayBuffer(44 + out.length * 2), dv = new DataView(buf);
  const ws = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + out.length * 2, true); ws(8, 'WAVE'); ws(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, target, true); dv.setUint32(28, target * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); ws(36, 'data'); dv.setUint32(40, out.length * 2, true);
  for (let i = 0; i < out.length; i++) dv.setInt16(44 + i * 2, out[i], true);
  let bin = ''; const bytes = new Uint8Array(buf); for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
async function sttFromWav(b64) {
  const r = await fetch('/api/stt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio: b64, mime: 'audio/wav' }) });
  const d = await r.json().catch(() => ({})); return (d.text || '').trim();
}

async function handleUtterance(text) {
  if (!text.trim()) { setOrb('idle', 'Hold the orb to talk'); return; }
  addBubble('user', text); conversation.push({ role: 'user', text });
  setOrb('thinking', 'thinking…');
  const reply = await think();
  addBubble('bot', reply); conversation.push({ role: 'model', text: reply });
  speaking = true; await speak(reply); speaking = false;
  setOrb('idle', running ? 'Hold the orb to talk' : 'Tap Start');
}

async function startConversation() {
  conversation = []; $('#latencyRow').hidden = false; $('#transcript').innerHTML = '';
  const ok = await armMic();
  running = true; $('#micBtn').disabled = true; $('#stopBtn').disabled = false;
  if (!ok) { setOrb('idle', 'mic blocked, type below'); addBubble('bot', 'I could not open your mic. Type to me below instead.'); return; }
  setOrb('idle', 'Hold the orb to talk'); addBubble('bot', 'Hold the orb and speak. Release to send.');
}
function stopConversation() {
  running = false; speaking = false; recording = false;
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  $('#micBtn').disabled = false; $('#stopBtn').disabled = true;
  setOrb('idle', 'Tap Start');
}
function orbDown() { if (!running || speaking || recording) return; ctx().resume(); recBuf = []; recording = true; setOrb('listening', 'recording… release to send'); }
async function orbUp() {
  if (!recording) return; recording = false; setOrb('thinking', 'transcribing…');
  const b64 = encodeWavB64(recBuf, recCtx ? recCtx.sampleRate : 48000);
  const txt = await sttFromWav(b64);
  if (!txt) { setOrb('idle', 'Hold the orb to talk'); addBubble('bot', '(did not catch that, hold and try again)'); return; }
  await handleUtterance(txt);
}
orb.addEventListener('pointerdown', orbDown);
orb.addEventListener('pointerup', orbUp);
orb.addEventListener('pointerleave', () => { if (recording) orbUp(); });
$('#micBtn').onclick = startConversation;
$('#stopBtn').onclick = stopConversation;

/* type box is always available as an alternative */
$('#typeFallback').hidden = false;
async function sendTyped() {
  const inp = $('#typeInput'); const txt = inp.value.trim(); if (!txt) return;
  inp.value = '';
  if (!running) { running = true; $('#latencyRow').hidden = false; if (!conversation.length) $('#transcript').innerHTML = ''; }
  ctx().resume();
  addBubble('user', txt); conversation.push({ role: 'user', text: txt });
  setOrb('thinking', 'thinking…');
  const reply = await think(); addBubble('bot', reply); conversation.push({ role: 'model', text: reply });
  speaking = true; await speak(reply); speaking = false;
  setOrb('idle', running ? 'Hold the orb to talk' : 'Tap Start');
}
$('#typeSend').onclick = sendTyped;
$('#typeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTyped(); });
$('#liveSpeaker').onchange = () => $('#latVoice').textContent = liveModel + ' · ' + $('#liveSpeaker').value;

refreshStudioUI();

/* ===== RapidXAI promo popup + owner off-switch ===== */
(function promos() {
  const promo = $('#promo'), gear = $('#gear'), settings = $('#settings'), promoOff = $('#promoOff');
  if (!promo) return;
  const isOff = () => localStorage.getItem('rxai_promo_off') === '1';
  promoOff.checked = isOff();
  gear.onclick = () => { settings.hidden = !settings.hidden; };
  promoOff.onchange = () => { localStorage.setItem('rxai_promo_off', promoOff.checked ? '1' : '0'); if (promoOff.checked) promo.hidden = true; };
  $('#promoX').onclick = () => { promo.hidden = true; };
  let hideT = null;
  function flash() {
    if (isOff()) { promo.hidden = true; return; }
    promo.hidden = false;
    clearTimeout(hideT); hideT = setTimeout(() => { promo.hidden = true; }, 10000);
  }
  setTimeout(flash, 15000);
  setInterval(flash, 30000);
})();
