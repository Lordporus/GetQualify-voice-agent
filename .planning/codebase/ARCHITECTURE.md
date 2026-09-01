# ARCHITECTURE.md

## High-Level System Design
The system is built as a monolithic SaaS control plane (`GetQualify Studio`) paired with an external node-graph voice orchestrator (`Dograh`).

## Components
1. **Dashboard Server (`server.js`):** A zero-dependency HTTP server that handles tenant isolation, billing, auth, and agent configuration.
2. **AI Pipeline Adapters (`lib/providers.js`):** Uniform adapter contracts allowing seamless swapping of STT, LLM, and TTS providers.
3. **Telephony Bridge:** SIP/WebRTC traffic connects to Dograh, which uses the API keys to stream audio through the AI pipeline.

## Data Flow (Voice Call)
`Phone Call (Vobiz) / Browser (WebRTC)` -> `Dograh (VAD/Turn Detection)` -> `STT (Deepgram)` -> `LLM (Groq/Gemini)` -> `TTS (Rumik)` -> `Dograh` -> `Caller`.

## Deployment Model
- **Bare Metal / VPS:** Deployed to a bare Ubuntu 24.04 VPS.
- **Scripted Provisioning:** Six-step shell script pipeline (`deploy/`) that installs dependencies, sets up Dograh with HTTPS, builds a Docker overlay for Rumik, and deploys the dashboard.
