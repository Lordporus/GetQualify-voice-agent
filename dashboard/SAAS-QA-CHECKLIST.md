# GetQualify SaaS Acceptance Checklist

## Safety and deployment

- [x] Existing browser conversation and real call plane remain healthy.
- [x] Production data is backed up before deployment.
- [x] No call-critical Docker container, volume, or provider configuration is removed.
- [x] SaaS control-plane resource use fits the existing 2 GB droplet.
- [x] Port 8787 is reachable only through the HTTPS reverse proxy.

## Authentication and authorization

- [x] New account signup creates one isolated tenant and owner.
- [x] Every new tenant receives exactly INR 10.00 of trial wallet credit once.
- [x] Passwords require at least 12 characters and remain scrypt hashed.
- [x] Session cookies are secure, HTTP-only, same-site, expiring, and revoked on logout.
- [x] Roles cover super admin, tenant owner, tenant admin, and member.
- [x] Every tenant route rejects cross-tenant object identifiers.
- [x] Admin routes reject tenant users.
- [x] Suspended users and tenants cannot create sessions or use paid features.
- [x] Destructive actions require explicit confirmation and create an audit event.

## Super admin

- [x] Overview shows tenant, user, agent, ticket, wallet, and usage totals.
- [x] Admin can inspect tenants and users.
- [x] Admin can suspend, reactivate, and terminate accounts.
- [x] Admin can add or deduct wallet credit with a required reason.
- [x] Admin can inspect immutable wallet history.
- [x] Admin can inspect and reply to support tickets.
- [x] Super admin can open a tenant drill-down covering users, agents, BYON numbers, usage, billing ledger, and support.
- [x] Super admin can enter a 30-minute password-reauthenticated user view with a persistent banner and audited exit.
- [x] Impersonated sessions cannot initiate payments or mutate tenant, user, role, or wallet controls.
- [x] Support operators can assign priority and move tickets through open, in progress, waiting, resolved, and closed states.

## Billing and PayU

- [x] Wallet balance derives from immutable ledger entries.
- [x] Recharge amount is selected from server-owned packs.
- [x] PayU transaction IDs and opaque intent tokens are random and unique.
- [x] Browser success redirect never credits a wallet.
- [x] Callback hash is verified and payment status is verified with PayU.
- [x] Duplicate callbacks cannot duplicate credits.
- [x] Failed and cancelled payments do not mint credits.
- [x] Sandbox checkout creation is tested without spending real money.
- [x] Production checkout creation returns the official secure PayU endpoint and never exposes the merchant salt.
- [x] PayU success and failure events can POST to `/api/payu/webhook`, and sanitized webhook outcomes are visible to admins.
- [x] The billing UI posts the signed form to PayU's returned `url` field.
- [ ] Run one low-value PayU sandbox callback end to end against PayU's server.
- [ ] Move payment intents, gateway events, wallets, and ledger entries from the single-process atomic store to PostgreSQL before allowing multiple dashboard replicas.
- [ ] Enable signed refund and chargeback webhooks with PayU support, then test idempotent negative ledger adjustments.
- [ ] Add scheduled PayU reconciliation for pending intents and an admin reconciliation report.
- [ ] Replace the two PayU dashboard webhooks that still point to `api.auto4you.in` with `https://studio.168-144-154-134.sslip.io/api/payu/webhook` after the PayU dashboard finishes loading.

## Agents, presets, and BYON

- [x] Preset library includes Personal Injury, Dental, Real Estate, Restaurant, Appointment Booking, Customer Support, Lead Qualification, and Receptionist.
- [x] Creating from a preset produces a tenant-owned editable agent.
- [x] Personal Injury preset performs consent, conflict-safe intake, basic qualification, emergency redirection, and appointment capture without legal advice.
- [x] Dental preset handles appointment intent, urgency screening, office FAQs, and appointment capture without clinical diagnosis.
- [ ] Connect appointment capture to the chosen external calendar after calendar credentials are supplied.
- [x] New agents have no phone number attached by default.
- [x] BYON accepts only tenant-owned pending-verification connections.
- [x] One tenant cannot view or mutate another tenant's agents or connections.
- [ ] Replace the BYON placeholder with per-tenant Dograh organization and API-key bindings.
- [ ] Verify cross-tenant isolation against two real Dograh organizations before enabling customer BYON writes.
- [ ] Add optional VoiceLink KYC and number marketplace as a separate adapter, without replacing the v1.43 call plane.
- [ ] Complete a sandbox KYC, low-value number purchase, inbound call, and outbound call before exposing number purchase publicly.

## Privacy mode

- [x] Privacy mode is labeled accurately and does not claim automatic HIPAA compliance.
- [x] No-recording mode blocks calls until a verified no-recording upstream workflow is configured.
- [x] Browser conversation transcripts and audio are not persisted by the Studio service.
- [x] Logs omit call audio, transcript text, health details, and secrets.
- [x] UI explains provider BAAs, policies, access controls, and operational safeguards are still required.
- [x] Privacy settings are enforced server-side, not only hidden in the UI.

## Support

- [x] User can open, list, and reply to a tenant-scoped ticket.
- [x] Admin can list, reply, and change status.
- [x] Ticket messages render as text and resist stored XSS.

## Demo links

- [x] Owner or higher can create, list and revoke a tenant-scoped link for one tenant-owned agent.
- [x] Secret URLs are returned once and the database stores only a SHA-256 token hash.
- [x] Public metadata omits provider secrets, agent personas, users, wallet, billing and admin data.
- [x] Revoked, expired and exhausted links fail closed.
- [x] Expiry, start count and duration inputs are server clamped.
- [x] Concurrent session starts reserve capacity through the serialized store before minting upstream sessions.
- [x] Public starts have a separate rate limit and same-origin proxied TURN credentials.
- [x] Public UI covers loading, idle, connecting, listening, thinking, speaking, ended and error states.
- [x] Public page releases media tracks, WebSocket, peer connection and timers on end or page exit.
- [x] Studio and public demo surfaces adapt at 375, 768 and 1280 px widths.
- [ ] Enforce the server-selected maximum duration inside the upstream Dograh workflow, in addition to browser cleanup.
- [x] Production run 31 completed a real visitor WebRTC session with relay ICE, remote audio playback, agent speech, Groq response cycles, transcript generation, and clean resource release. The short-lived demo link was then revoked.
- [ ] Explicitly drive and verify a barge-in interruption on the public demo page with a spoken test phrase.

## QA and production proof

- [x] Automated tests cover schema, role hierarchy, PayU hashing, callback tampering, and browser no-credit behavior.
- [x] API QA covers auth, tenant isolation, wallet idempotency, tickets, presets, privacy mode, and BYON validation.
- [x] A production test tenant and user are created through a one-time controlled bootstrap.
- [x] Test user can log in and sees INR 10.00 trial credit.
- [x] Test user creates Personal Injury and Dental agents from presets.
- [x] Cross-tenant and admin endpoint attacks return 403 or 404.
- [x] Privacy-mode calls fail closed without a verified upstream workflow.
- [x] Desktop and mobile UI paths are checked visually.
- [x] Browser console has no new errors.
- [x] Production health endpoint, login, admin, billing, support, and presets are tested.
- [x] Talk UI uses short-lived Dograh embed sessions and the published phone workflow through SmallWebRTC.
- [x] Talk UI presents a direct voice-call stage and does not render interim or final transcript text.
- [x] Coturn runs on host networking so advertised relay ports match their packet source.
- [ ] Complete one spoken browser greeting and one spoken reply on the production URL. The embedded QA browser does not emit a TURN allocation, so this still requires Brave verification.
- [x] No real paid call or real payment is triggered without separate explicit confirmation.
