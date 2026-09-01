# INTEGRATIONS.md

## External Services and APIs
- **Telephony:** Vobiz (Indian numbers, Plivo-compatible) or any alternative (Twilio, Telnyx, Vonage).
- **Speech-to-Text (STT):** Deepgram (`nova-3-general`).
- **Large Language Model (LLM):** Groq (`llama-3.3-70b-versatile`) by default, with support for Google Gemini.
- **Text-to-Speech (TTS):** Rumik Silk (`mulberry`), with adapters for others like ElevenLabs or Sarvam.
- **Billing & Payments:** PayU India (Hosted checkout integration).
- **Scheduling:** Cal.com (Mentioned for HVAC desk booking).
- **Orchestrator:** Dograh API (External open-source node-graph agent).
- **SSL / DNS:** sslip.io (used for automatic HTTPS provisioning without DNS setup).
