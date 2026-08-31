# Tenant-branded demo links

Demo links let a tenant owner distribute a browser voice experience for one tenant-owned agent. Visitors see tenant branding and the selected agent name, then start the same realtime WebRTC workflow used by Studio. The public page never exposes console navigation, provider configuration, API keys, user records, wallet data, the agent persona, or admin data.

## Security model

- The share token contains a random 64-bit lookup ID and a random 256-bit secret. The database stores only the ID and SHA-256 token hash.
- The complete URL is returned once at creation and retained only in the creator's browser `sessionStorage`. It cannot be recovered from the server. Revoke and replace a link when the original URL is lost.
- Every link is scoped to one tenant and one agent. Creation and revocation require owner or higher access. Impersonated admin sessions cannot mutate links.
- Expiry, maximum starts and a 60 to 600 second session duration are server-owned and clamped. Start reservations are serialized before the upstream voice session is minted, preventing concurrent requests from exceeding the start limit.
- Public starts have a separate five-per-minute IP token bucket in addition to the platform API limiter.
- TURN credentials are fetched by the server and returned only inside the short-lived same-origin session response. Stable embed and provider credentials remain server-side.
- The public page uses a restrictive Content Security Policy, no-referrer policy, text-only DOM insertion for tenant data, explicit microphone lifecycle cleanup, and no transcript persistence.

The browser stops the peer connection at the server-selected duration. The same value is supplied to the upstream workflow as `max_session_seconds`. A production deployment should also enforce the duration inside Dograh so a modified browser cannot keep the upstream run open.

## Operations

Owners create, list and revoke links from **Demo links** in Studio. Active links can be opened or copied during the browser session that created them. Expired, exhausted and revoked links fail closed. Public routes are `/demo/<token>`, `GET /api/public/demo/<token>` and `POST /api/public/demo/<token>/session`.
