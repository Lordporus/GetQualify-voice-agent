# Threat Model: GetQualify Agency OS

Date: 2026-08-11

## Scope and assets

The change adds platform-wide client operations, invoice state, integration setup requests, a persistent agency prompt, and Recharts analytics. Assets include tenant identity, client records, invoice amounts and status, prompts, sessions, provider credentials, wallet balances, and audit history.

## Data flow

```text
Operator browser
  -> HTTPS reverse proxy
  -> Node API and static app
  -> authenticated session and role checks
  -> atomic single-process JSON store

Node API
  -> server-only voice, telephony, payment, and calendar provider calls
```

Trust changes at the public internet boundary, session boundary, platform-role boundary, tenant boundary, datastore boundary, and each provider boundary.

## STRIDE register

| Threat | Asset | Primary control | Verification |
| --- | --- | --- | --- |
| Spoofing with a stolen or forged session | Client and financial data | Random opaque session token stored as a hash, HttpOnly and Secure production cookie, expiry | Login and cookie tests |
| Tampering with invoice amount, tenant, or status | Revenue reporting | Platform-only writes, integer paise bounds, transition guards, immutable events | API lifecycle, owner-denial, and invalid-input tests |
| Repudiating client or invoice actions | Client delivery history | Actor-linked audit, invoice, activity, and tenant-status events | Persistence assertions in integration test |
| Cross-tenant disclosure | Invoices, prompts, integrations | Server-derived tenant scope and role checks before invoice writes | Two-tenant denial test |
| Cross-origin session abuse | Sessions and paid provider capacity | Exact configured Origin checks on unsafe HTTP and WebSocket requests | Hostile-origin regression tests |
| Stored script execution | Platform session | Text-node rendering and redirect of the unsafe legacy console | Route and frontend review |
| Resource exhaustion | Availability and provider cost | Body caps, timeouts, process-local token bucket | Payload and rate checks, shared limiter remains a production gate |
| Role elevation into client controls | All client workspaces | Server-side `requireRole`, super-admin-only tenant creation and lifecycle controls | Owner denial test |

## Attacker tree

```text
GOAL: change another client's invoice
  OR steal a platform session
  OR become a platform admin
  OR submit another tenant id as an owner
       AND bypass server-derived tenant scope
       AND find or guess an invoice id
```

The implemented regression test closes the cheapest object-reference path. MFA for platform users and a shared limiter remain required before customer production.

