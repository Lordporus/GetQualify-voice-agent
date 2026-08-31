'use strict';

const byId = (id) => document.getElementById(id);
const token = decodeURIComponent(location.pathname.replace(/^\/demo\//, '').split('/')[0] || '');
const stage = byId('voiceStage');
const callButton = byId('callButton');
const remoteAudio = byId('remoteAudio');
let metadata = null;
let running = false;
let pc = null;
let ws = null;
let stream = null;
let startedAt = 0;
let endTimer = null;
let clockTimer = null;

function initials(name) {
  return String(name || 'V').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'V';
}
function setStatus(state, title, detail) {
  stage.dataset.state = state;
  byId('statusText').textContent = title;
  byId('statusDetail').textContent = detail;
}
function showError(title, copy, retry) {
  byId('loadingState').hidden = true;
  byId('demoContent').hidden = true;
  byId('errorState').hidden = false;
  byId('errorTitle').textContent = title;
  byId('errorCopy').textContent = copy;
  byId('retryButton').hidden = !retry;
  byId('demoCard').setAttribute('aria-busy', 'false');
}
async function jsonFetch(path, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try { response = await fetch(path, { ...(options || {}), credentials: 'omit', headers: { 'Content-Type': 'application/json' }, signal: controller.signal }); }
  catch (error) { clearTimeout(timeout); throw new Error(error.name === 'AbortError' ? 'The voice service timed out.' : 'The voice service could not be reached.'); }
  clearTimeout(timeout);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'The voice service could not start.');
  return data;
}
async function loadDemo() {
  byId('loadingState').hidden = false; byId('errorState').hidden = true; byId('demoContent').hidden = true;
  try {
    metadata = await jsonFetch('/api/public/demo/' + encodeURIComponent(token));
    document.documentElement.style.setProperty('--brand', metadata.brand.color);
    document.title = metadata.agent.name + ' voice demo';
    byId('brandName').textContent = metadata.brand.name;
    byId('brandAvatar').textContent = initials(metadata.brand.name);
    byId('agentName').textContent = metadata.agent.name;
    byId('agentGreeting').textContent = metadata.agent.greeting || 'Start the call, then speak naturally.';
    byId('loadingState').hidden = true; byId('demoContent').hidden = false; byId('demoCard').setAttribute('aria-busy', 'false');
    if (metadata.demo.status !== 'active') {
      callButton.disabled = true;
      setStatus('error', 'Demo ' + metadata.demo.status, 'Ask the sender for a fresh demo link.');
    }
  } catch (error) { showError('This demo is unavailable', error.message || 'Ask the sender for a new link.', true); }
}
function securePeerId() {
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  return 'PC-' + Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function setButton(active) {
  running = active;
  callButton.textContent = active ? 'End voice call' : 'Start voice call';
  callButton.classList.toggle('active', active);
  callButton.setAttribute('aria-label', active ? 'End voice call' : 'Start voice call');
}
function updateClock(maxSeconds) {
  const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const remaining = Math.max(0, maxSeconds - elapsed);
  byId('demoTimer').textContent = Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0') + ' remaining';
}
function stopCall(label) {
  clearTimeout(endTimer); clearInterval(clockTimer); endTimer = null; clockTimer = null;
  if (ws && ws.readyState < 2) { try { ws.close(); } catch (_) {} } ws = null;
  if (pc) { try { pc.getSenders().forEach((sender) => sender.track && sender.track.stop()); pc.close(); } catch (_) {} } pc = null;
  if (stream) stream.getTracks().forEach((track) => track.stop()); stream = null;
  remoteAudio.srcObject = null; startedAt = 0; byId('demoTimer').textContent = '';
  setButton(false); callButton.disabled = metadata && metadata.demo.status !== 'active';
  setStatus('idle', label || 'Ready to talk', 'Your microphone is used only while this demo is active.');
}
async function handleSignal(message) {
  if (!pc) return;
  if (message.type === 'answer') return pc.setRemoteDescription({ type: 'answer', sdp: message.payload.sdp });
  if (message.type === 'ice-candidate') {
    const candidate = message.payload && message.payload.candidate;
    if (candidate) await pc.addIceCandidate(candidate).catch(() => {});
    return;
  }
  if (message.type === 'call-ended') return stopCall('Call ended');
  if (message.type === 'error' || message.type === 'rtf-pipeline-error') return setStatus('error', 'Voice error', 'End the call, then try once more.');
  if (message.type === 'rtf-user-transcription') return setStatus('thinking', 'Agent is thinking', 'Your agent is preparing a response.');
  if (message.type === 'rtf-bot-started-speaking') return setStatus('speaking', 'Agent is speaking', 'You can interrupt naturally at any time.');
  if (message.type === 'rtf-bot-stopped-speaking') return setStatus('listening', 'Listening', 'Speak naturally when you are ready.');
}
async function startCall() {
  if (running || !metadata || metadata.demo.status !== 'active') return;
  setButton(true); callButton.disabled = true; setStatus('connecting', 'Connecting', 'Allow microphone access when your browser asks.');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const session = await jsonFetch('/api/public/demo/' + encodeURIComponent(token) + '/session', { method: 'POST', body: '{}' });
    const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
    if (session.turnCredentials && session.turnCredentials.uris && session.turnCredentials.uris.length) {
      iceServers.push({ urls: session.turnCredentials.uris, username: session.turnCredentials.username, credential: session.turnCredentials.password });
    }
    pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: session.turnCredentials ? 'relay' : 'all' });
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    pc.ontrack = (event) => { if (event.track.kind === 'audio') { remoteAudio.srcObject = event.streams[0]; remoteAudio.play().catch(() => {}); } };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') {
        startedAt = Date.now(); callButton.disabled = false; setStatus('listening', 'Listening', 'Speak naturally when you are ready.');
        const maximum = Number(session.maxSessionSeconds || metadata.demo.maxSessionSeconds || 300);
        updateClock(maximum); clockTimer = setInterval(() => updateClock(maximum), 1000);
        endTimer = setTimeout(() => stopCall('Demo time completed'), maximum * 1000);
      }
      if (pc.connectionState === 'failed') { stopCall('Connection failed'); setStatus('error', 'Connection failed', 'Check your network, then try again.'); }
    };
    const peerId = securePeerId();
    ws = new WebSocket(session.signalingUrl);
    ws.onmessage = async (event) => { try { await handleSignal(JSON.parse(event.data)); } catch (_) { setStatus('error', 'Signaling error', 'End the call, then try again.'); } };
    ws.onclose = () => { if (running) stopCall('Call ended'); };
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('The realtime connection could not open.')); });
    pc.onicecandidate = (event) => {
      if (!event.candidate || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'ice-candidate', payload: { candidate: { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex }, pc_id: peerId } }));
    };
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'offer', payload: { sdp: offer.sdp, type: 'offer', pc_id: peerId, workflow_id: session.workflowId, workflow_run_id: session.workflowRunId } }));
  } catch (error) {
    stopCall('Ready to retry'); setStatus('error', 'Could not start', error.message || 'Allow microphone access and try again.'); callButton.disabled = false;
  }
}

callButton.addEventListener('click', () => running ? stopCall('Ready to talk') : startCall());
byId('retryButton').addEventListener('click', loadDemo);
window.addEventListener('pagehide', () => stopCall('Call ended'));
loadDemo();
