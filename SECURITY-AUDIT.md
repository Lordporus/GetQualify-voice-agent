# Security Findings: GetQualify Agency OS

Date: 2026-08-11
Mode: Harden and verify
Scope: Agency schema v4, invoices, client controls, integrations, agency prompt, analytics bundle, session boundary, and deployment configuration.

## Attack surface and trust boundaries

- Browser to same-origin Node API over the production HTTPS reverse proxy.
- Node API to the single-process JSON store.
- Platform roles to all client workspaces, separated from tenant owner access by server-side role and object checks.
- Node API to voice, telephony, payment, and calendar providers using server-only credentials.
- GitHub Actions to the dashboard build and test pipeline.

Highest-value assets are session tokens, provider credentials, client records, invoice amounts and status, agency prompts, wallet balances, and payment events. The primary abuse cases are cross-tenant invoice access, role escalation into client controls, false financial reporting, stored XSS through client text, credential stuffing, and supply-chain tampering.

## Findings

| ID | Severity | Title | Location | CWE | Evidence | Fix or control | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F-001 | High | Cross-origin authenticated HTTP and WebSocket actions | `dashboard/server.js` | CWE-352, CWE-346 | Unsafe JSON routes and live transcription previously trusted ambient cookies without validating `Origin`; `text/plain` requests bypassed browser preflight. | Require the exact configured production origin, require JSON on application APIs, and validate WebSocket upgrades before session lookup. | Fixed and regression-tested |
| F-002 | High | Tenant owners could assert platform revenue | `dashboard/server.js` | CWE-862, CWE-840 | An owner could create an invoice and mark it paid, and the platform overview included the result. | Invoice writes are platform-admin only. Owners retain tenant-scoped read access. Status changes now follow draft to issued or void, and issued to paid or void. | Fixed and regression-tested |
| F-003 | High | Stored XSS in the legacy voice console | `dashboard/public/console.html`, `dashboard/server.js` | CWE-79 | The legacy console inserted agent and provider fields through `innerHTML`. | The public legacy route now redirects to the text-node-based Agency OS app. | Fixed and regression-tested |
| F-004 | Medium | Internal client notes appeared in tenant overview data | `dashboard/server.js` | CWE-200 | Internal approach, invoice, and lifecycle summaries were included in owner overview activity. | Activities carry an explicit visibility value and non-platform overview reads only tenant-visible records. | Fixed and regression-tested |
| F-005 | Medium | CSP is in report-only rollout | `dashboard/lib/core.js` | CWE-693 | A blocking policy can disrupt Dograh, PayU, audio, or browser voice traffic without production violation telemetry. | Added a scoped `Content-Security-Policy-Report-Only` header. Enforce it after production provider-path validation. | Risk-managed |
| F-006 | Medium | Rate limiting is process-local | `dashboard/lib/core.js`, `dashboard/server.js` | CWE-307, CWE-770 | The token bucket resets on restart and does not coordinate across replicas. | The app accepts the edge client IP only from a private proxy when `TRUST_PROXY=1`, avoiding a shared reverse-proxy bucket. Move limits to a shared store before multi-replica use. | Open, pre-production gate |
| F-007 | Medium | JSON persistence is not a transactional customer-money store | `dashboard/lib/core.js`, `dashboard/README.md` | CWE-362, CWE-922 | Atomic replacement and mode `0600` protect staging writes, but JSON does not provide database transactions, encryption controls, or mature retention. | Keep this deployment in staging. Move invoices, wallets, memberships, prompts, and audit events to transactional PostgreSQL before accepting customer money. | Open, documented boundary |
| F-008 | Medium | Manual paid status is not payment proof | `dashboard/server.js` | CWE-345 | A trusted platform admin can mark an issued invoice paid without a payment reference or provider reconciliation. | Treat paid as an accounting assertion in staging. Require method, reference, and payment-provider verification before customer billing. | Open, documented boundary |
| F-009 | Low | Privileged accounts have password-only authentication | `dashboard/server.js` | CWE-308 | Passwords are salted with scrypt and sessions are opaque, but no passkey or MFA step exists. | Add passkeys or TOTP for platform roles before customer production. | Open, pre-production gate |

No Critical or High findings remain in the changed Agency OS paths.

## Verified controls

- Invoice reads use tenant scope for owners. Invoice creation and status writes require a platform role.
- Cross-tenant and same-tenant owner invoice mutations are denied before object lookup.
- Client creation, approach logging, and tenant status controls are server-role gated.
- Invoice money is integer paise, server validated, and separate from wallet credit.
- Invoice transitions are explicit. Paid and void states are final, and skipped or replayed transitions return conflict.
- Integration requests store setup state only and do not contact Meta or another external service.
- Agency prompts are tenant-scoped, length bounded, versioned, and do not authorize external actions.
- User-provided dashboard text is rendered as text nodes. The limited HTML helper paths contain static or escaped markup.
- The unsafe legacy console is no longer reachable and redirects to the Agency OS app.
- Unsafe HTTP requests and WebSocket upgrades use an exact production-origin allowlist.
- Session cookies are HttpOnly, SameSite=Lax, and Secure when `NODE_ENV=production`.
- Response headers include HSTS, nosniff, referrer policy, frame protection, a scoped permissions policy, and CSP report-only.
- The JSON database file and atomic temporary replacement are mode `0600`.
- Production dependencies are exact-pinned with a lockfile. GitHub Actions are pinned to immutable commit SHAs.
- `gitleaks` scanned 10 commits with no leaks.
- `pnpm audit --prod`, OSV-Scanner, and Semgrep OWASP and secrets rules returned no findings.
- The API lifecycle integration test covers tenant isolation, invalid values, final-state protection, and role denial.

## Verification commands

```sh
pnpm --dir dashboard install --frozen-lockfile
pnpm --dir dashboard build
node --test dashboard/test/*.test.js
pnpm --dir dashboard audit --prod --audit-level high
gitleaks git --redact --no-banner .
osv-scanner scan source -r dashboard
semgrep scan --config p/owasp-top-ten --config p/secrets --no-git-ignore dashboard/server.js dashboard/lib dashboard/src dashboard/public/assets/app.js
```

