# GetQualify Domain & URL Architecture Restructuring Plan

> **Status:** Planning Only — Awaiting User Approval  
> **Target Version:** Phase 1 (Immediate / Today), Phase 2 (Subdomain Cleanliness & Dograh Relocation), Phase 3 (Decoupled CDN)  
> **Date:** September 7, 2026  

---

## Executive Summary

GetQualify currently operates five subdomains on a single Ubuntu 24.04 VPS (`45.76.105.201`). During recent testing and audits, three structural inconsistencies were identified in the public routing and domain layout:

1. **Cross-Bleeding of Dashboard onto the Apex Domain (`getqualify.in/app.html`):**
   The marketing site (`getqualify.in`) and the customer portal (`dashboard.getqualify.in`) are both reverse-proxied by Nginx to the same Node.js dashboard process (`port 8787`). Because `server.js` resolves static files purely by file path without inspecting the incoming `Host` header, and because `dashboard/public/index.html` has relative CTA links (`href="/app.html"`), visitors clicking "Sign in" or "Launch console" remain on `getqualify.in/app.html` rather than transitioning to the dedicated application subdomain.
2. **Session Partitioning & UX Confusion:**
   Because session cookies (`rxv_sess`) are set without an explicit `Domain` attribute (RFC 6265 host-only cookies), a user logging in on `getqualify.in/app.html` receives a session scoped solely to `getqualify.in`. If that user subsequently navigates to `dashboard.getqualify.in`, the browser does not transmit the cookie, presenting a confusing "logged-out" screen and requiring a second login.
3. **Internal Engine Exposure & Brand Leak (`app.getqualify.in`):**
   `app.getqualify.in` currently points directly to Dograh's visual workflow builder (`dograh-ui-1` on port 3010). Dograh is GetQualify's internal telephony and orchestration engine, not the customer-facing product. Exposing Dograh on `app.getqualify.in` (standard convention for customer SaaS portals) risks customer confusion and exposes internal architecture.
4. **Legacy URL Formats (`.html` extensions):**
   Exposing raw filenames such as `/app.html` and `/console.html` diminishes brand polish and search credibility.

This document outlines a phased, production-grade restructuring plan to isolate the marketing site, clean up customer routing, eliminate session splitting, and re-home internal infrastructure without disrupting active telephony or web widget sessions.

---

## Implementation Phases

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Phase 1 (Immediate - Today)                                                 │
│ • Fix relative CTAs in marketing landing page (index.html) -> dashboard      │
│ • Add 301 permanent redirects in Nginx on getqualify.in for /app.html       │
│ • Keep session cookies host-only (analyzed & confirmed safe)                │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼───────────────────────────────────────┐
│ Phase 2 (Clean URLs & Dograh Relocation)                                     │
│ • Strip .html from dashboard URLs using Nginx internal rewrites              │
│ • Provision DNS & Let's Encrypt SSL for studio.getqualify.in                │
│ • Relocate Dograh UI from app.getqualify.in -> studio.getqualify.in          │
│ • Update FRONTEND_API_URL and embed token allowed_domains in database       │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │
┌──────────────────────────────────────▼───────────────────────────────────────┐
│ Phase 3 (Infrastructure Decoupling - Future)                                 │
│ • Move static marketing site to CDN (Cloudflare Pages / Vercel)              │
│ • VPS handles only dashboard, studio, and real-time voice runtime            │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

### Phase 1: Immediate Overlap & Routing Fix (Low Risk / High Impact)

**Objective:** Ensure visitors on `getqualify.in` who click any login or console CTA are routed to `dashboard.getqualify.in`, and prevent the dashboard SPA from rendering on the apex domain.

---

#### Step 1.1: Update Marketing Landing Page CTA Links

* **What Changes:** [`dashboard/public/index.html`](file:///c:/Users/Sachin/OneDrive/Desktop/rapidx-voice-agent-stack-main/getqualify-voice-agent-stack-main/dashboard/public/index.html)
* **Rationale:** Replace all 10 relative `href="/app.html"` links with absolute `https://dashboard.getqualify.in/app.html` (or `https://dashboard.getqualify.in/`) so that all clicks cleanly navigate to the dashboard subdomain.
* **Exact Before / After:**

```diff
--- a/dashboard/public/index.html
+++ b/dashboard/public/index.html
@@ -46,8 +46,8 @@
       </nav>
       <div class="nav-cta">
-        <a class="btn btn-quiet btn-sm nav-login" href="/app.html">Sign in</a>
-        <a class="btn btn-primary btn-sm magnetic" href="/app.html">Launch console</a>
+        <a class="btn btn-quiet btn-sm nav-login" href="https://dashboard.getqualify.in/app.html">Sign in</a>
+        <a class="btn btn-primary btn-sm magnetic" href="https://dashboard.getqualify.in/app.html">Launch console</a>
       </div>
       <button class="nav-burger" id="navBurger" aria-label="Open menu" aria-expanded="false">
@@ -59,3 +59,3 @@
       <a href="#faq">FAQ</a>
-      <a class="btn btn-primary" href="/app.html">Launch console</a>
+      <a class="btn btn-primary" href="https://dashboard.getqualify.in/app.html">Launch console</a>
     </div>
@@ -84,3 +84,3 @@
           <div class="hero-actions reveal" data-d="3">
-            <a class="btn btn-primary btn-lg magnetic" href="/app.html">
+            <a class="btn btn-primary btn-lg magnetic" href="https://dashboard.getqualify.in/app.html">
               Launch console
@@ -282,3 +282,3 @@
           </ul>
-          <a class="btn btn-ghost magnetic reveal" data-d="3" href="/app.html">Open the console</a>
+          <a class="btn btn-ghost magnetic reveal" data-d="3" href="https://dashboard.getqualify.in/app.html">Open the console</a>
         </div>
@@ -376,3 +376,3 @@
           <div class="closing-actions">
-            <a class="btn btn-primary btn-lg magnetic" href="/app.html">Launch console</a>
+            <a class="btn btn-primary btn-lg magnetic" href="https://dashboard.getqualify.in/app.html">Launch console</a>
             <a class="btn btn-ghost btn-lg magnetic" href="#faq">Read the FAQ</a>
@@ -450,3 +450,3 @@
           <p class="footer-tag soft">AI voice agents from ₹1/min for the promotional AI layer. Telephony is separate.</p>
-          <a class="btn btn-primary btn-sm magnetic" href="/app.html">Launch console</a>
+          <a class="btn btn-primary btn-sm magnetic" href="https://dashboard.getqualify.in/app.html">Launch console</a>
         </div>
@@ -462,5 +462,5 @@
           <div class="footer-col">
             <span class="footer-h">Product</span>
-            <a href="/app.html">Console</a>
-            <a href="/app.html">Voice Studio</a>
-            <a href="/app.html">Telephony</a>
+            <a href="https://dashboard.getqualify.in/app.html">Console</a>
+            <a href="https://dashboard.getqualify.in/app.html">Voice Studio</a>
+            <a href="https://dashboard.getqualify.in/app.html">Telephony</a>
             <a href="#faq">FAQ</a>
```

* **Workflow / Pipeline:**
  1. Commit change on local branch:
     ```bash
     git checkout feature/payal-receptionist-phase1-deepgram
     git add dashboard/public/index.html
     git commit -m "fix(marketing): point nav and footer CTAs to dashboard.getqualify.in"
     git push origin feature/payal-receptionist-phase1-deepgram
     ```
  2. Merge PR to `main`.
  3. Deploy via GitHub Actions (approve production deployment in GitHub UI).
* **Verification:**
  ```bash
  curl -s https://getqualify.in/ | grep -E 'href="https://dashboard.getqualify.in'
  ```
  Expected: Confirms all 10 CTA buttons output absolute URLs targeting `dashboard.getqualify.in`.
* **Rollback:** Revert commit and push to branch.
* **Risk Level:** **Very Low** (Pure HTML markup update).

---

#### Step 1.2: Add 301 Redirects in Nginx for Apex Domain

* **What Changes:** Remote VPS Nginx configuration at `/etc/nginx/sites-available/getqualify.conf` (or `/etc/nginx/sites-enabled/getqualify.conf`).
* **Rationale:** Even with updated HTML links, existing bookmarks, browser histories, or search engine links may request `https://getqualify.in/app.html` or `https://getqualify.in/console.html`. Nginx should immediately return an HTTP 301 permanent redirect to `https://dashboard.getqualify.in/app.html`.
* **Exact Before / After:**

```diff
--- /etc/nginx/sites-available/getqualify.conf (server block for getqualify.in / www.getqualify.in)
+++ /etc/nginx/sites-available/getqualify.conf
@@ -29,6 +29,15 @@
     ssl_certificate_key /etc/letsencrypt/live/app.getqualify.in/privkey.pem; # managed by Certbot
 
+    # Permanent redirects for legacy / accidental app URLs on marketing root
+    location = /app.html {
+        return 301 https://dashboard.getqualify.in/app.html;
+    }
+
+    location = /console.html {
+        return 301 https://dashboard.getqualify.in/app.html;
+    }
+
     location / {
         proxy_pass http://127.0.0.1:8787;
         proxy_http_version 1.1;
```

* **Commands to Run (Directly on VPS):**
  ```bash
  # 1. Edit or insert the redirect rules inside the 443 server block for getqualify.in
  ssh -i ~/.ssh/id_ed25519 root@45.76.105.201 "nginx -t"
  
  # 2. Reload Nginx safely without downtime
  ssh -i ~/.ssh/id_ed25519 root@45.76.105.201 "systemctl reload nginx"
  ```
* **Verification:**
  ```bash
  curl -sI https://getqualify.in/app.html | grep -E 'HTTP/|Location:'
  curl -sI https://getqualify.in/console.html | grep -E 'HTTP/|Location:'
  ```
  Expected output:
  ```http
  HTTP/1.1 301 Moved Permanently
  Location: https://dashboard.getqualify.in/app.html
  ```
* **Rollback:**
  Remove the two `location = ...` blocks and run `systemctl reload nginx`.
* **Risk Level:** **Low** (Isolated to `/app.html` and `/console.html` routes on the marketing apex).

---

#### Step 1.3: Architectural Decision: Cookie `Domain` Attribute Scope

* **Core Question:** Should `dashboard/lib/core.js` be modified in Phase 1 to set `Domain=.getqualify.in;` on session and CSRF cookies, or remain host-only?
* **Analysis:**
  1. *Current Behavior:* In `dashboard/lib/core.js` (line 382):
     ```javascript
     return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
     ```
     Because no `Domain` is specified, browsers apply RFC 6265 **host-only** rules. A cookie set on `dashboard.getqualify.in` is transmitted *only* to `dashboard.getqualify.in`.
  2. *Impact with Steps 1.1 & 1.2 Implemented:*
     Because all users are strictly directed to and authenticated on `dashboard.getqualify.in`, users will never initiate or hold an active session on `getqualify.in`. The session isolation problem is completely eliminated by keeping users on the designated subdomain.
  3. *Security & Isolation Risks of Setting `Domain=.getqualify.in`:*
     - **Broadened Attack Surface:** If the cookie is scoped to `.getqualify.in`, it will be transmitted to *every* subdomain, including `getqualify.in`, `app.getqualify.in`, `dograh.getqualify.in`, and any future subdomains.
     - **Marketing Site Script Exposure:** When marketing analytics (Google Analytics, Meta Pixel, Hotjar) are added to `getqualify.in`, any client-side vulnerability on the marketing site could expose non-HttpOnly cookies (such as CSRF tokens).
     - **Cookie Shadowing Bugs:** If a user currently possesses an old host-only cookie for `dashboard.getqualify.in` and receives a new wildcard `.getqualify.in` cookie, RFC 6265 dictates both are sent. Web servers frequently parse duplicate cookies unpredictably, causing intermittent authentication failures.
  4. *Recommendation:*
     > [!IMPORTANT]
     > **DO NOT modify the cookie domain in Phase 1.** Keep cookies host-only.
     > With Step 1.1 and 1.2 in place, 100% of customer dashboard interactions occur on `dashboard.getqualify.in`. Host-only scoping follows the principle of least privilege (identical to Stripe, Linear, and Vercel architectures).

---

### Phase 2: Modern URL Cleanliness & Internal Engine Relocation (Medium Risk)

**Objective:** Eliminate raw `.html` filenames from customer URLs, and relocate the internal Dograh voice canvas from `app.getqualify.in` to `studio.getqualify.in` so customer-facing domain naming remains clean.

---

#### Step 2.1: Remove `.html` from User-Facing URLs (Nginx Internal Rewrite)

* **What Changes:** `/etc/nginx/sites-available/getqualify.conf` on VPS under `server_name dashboard.getqualify.in`.
* **Rationale:** Modern web applications do not show `.html` extensions. The browser URL bar should display `https://dashboard.getqualify.in/` or clean paths like `/login` or `/agents`.
* **Exact Configuration:**

```nginx
# Under server block for dashboard.getqualify.in
server {
    server_name dashboard.getqualify.in;
    listen 443 ssl http2;
    ...

    # 1. Direct hit to /app.html gets permanently redirected to /
    location = /app.html {
        return 301 https://dashboard.getqualify.in/;
    }

    # 2. Direct hit to root internally proxies /app.html to Node backend
    location = / {
        proxy_pass http://127.0.0.1:8787/app.html;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 3. All other paths (/api/*, /assets/*, etc.) proxy normally
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
    }
}
```

* **Client Navigation Compatibility:**
  The dashboard uses hash routing (`location.hash`), e.g., `dashboard.getqualify.in/#agents`, `dashboard.getqualify.in/#presets`. Hash routing works identically regardless of whether the base URL is `/` or `/app.html`.
* **Verification:**
  ```bash
  curl -sI https://dashboard.getqualify.in/ | grep "HTTP/1.1 200"
  curl -sI https://dashboard.getqualify.in/app.html | grep "Location: https://dashboard.getqualify.in/"
  ```
* **Risk Level:** **Low**.

---

#### Step 2.2: Audit of All `app.getqualify.in` References in Codebase & VPS

Before relocating Dograh, an exhaustive audit was performed across all configs, databases, and code to find every dependency on `app.getqualify.in`:

| Location | Key / Setting | Current Value | Required Update for `studio.getqualify.in` |
| :--- | :--- | :--- | :--- |
| **VPS:** `/etc/nginx/sites-available/getqualify.conf` | `server_name` (line 95, 104) | `app.getqualify.in` | Change to `studio.getqualify.in` |
| **VPS:** `/etc/nginx/sites-available/default` | `server_name` (line 89) | `app.getqualify.in` | Change or remove legacy block |
| **VPS:** `/opt/dograh/.env` | `FRONTEND_API_URL` (line 24) | `https://app.getqualify.in` | Update to `https://studio.getqualify.in` |
| **Dograh DB:** `embed_tokens` table | `allowed_domains` column | `["dashboard.getqualify.in", "getqualify.in", "app.getqualify.in", "www.getqualify.in"]` | Append `"studio.getqualify.in"` so test widgets continue working in studio |
| **Let's Encrypt:** Certbot certificates | Certificate lineage | Exists for `app.getqualify.in` | Must issue new certificate for `studio.getqualify.in` |
| **DNS Registrar / Cloudflare:** | DNS A Record | `app.getqualify.in` -> `45.76.105.201` | Add `studio.getqualify.in` -> `45.76.105.201` |
| **Dashboard:** `dashboard/.env` | `DOGRAH_BASE_URL` | `https://dograh.getqualify.in` | **NO CHANGE** (API is on `dograh.getqualify.in`, not `app`) |
| **Telephony Webhook:** VoBiz answer URL | VoBiz Application callback | Points to `https://dograh.getqualify.in/...` | **NO CHANGE** (Telephony routes to API backend, unaffected by studio UI) |

---

#### Step 2.3: Relocate Dograh UI from `app.getqualify.in` to `studio.getqualify.in`

* **Sequential Execution Steps:**
  1. **DNS Creation (Prerequisite):**
     Create DNS `A` record at DNS provider:
     `studio.getqualify.in` -> `45.76.105.201` (TTL 300s).
     Verify propagation: `dig +short studio.getqualify.in` must return `45.76.105.201`.
  2. **SSL Certificate Issuance:**
     ```bash
     ssh -i ~/.ssh/id_ed25519 root@45.76.105.201 "certbot certonly --nginx -d studio.getqualify.in"
     ```
  3. **Update Dograh Environment:**
     In `/opt/dograh/.env`:
     ```bash
     sed -i 's/FRONTEND_API_URL=https:\/\/app.getqualify.in/FRONTEND_API_URL=https:\/\/studio.getqualify.in/' /opt/dograh/.env
     ```
     Restart Dograh UI container:
     ```bash
     cd /opt/dograh && docker compose restart ui
     ```
  4. **Update Embed Token Allowed Domains in Database:**
     ```bash
     docker exec dograh-postgres-1 psql -U postgres -d postgres -c \
       "UPDATE embed_tokens SET allowed_domains = '[\"dashboard.getqualify.in\", \"getqualify.in\", \"studio.getqualify.in\", \"app.getqualify.in\", \"www.getqualify.in\"]' WHERE id = 1;"
     ```
  5. **Update Nginx Configuration:**
     Change the server block handling port 3010 from `app.getqualify.in` to `studio.getqualify.in`, referencing the new SSL certificates:
     ```nginx
     server {
         listen 443 ssl http2;
         server_name studio.getqualify.in;
         ssl_certificate /etc/letsencrypt/live/studio.getqualify.in/fullchain.pem;
         ssl_certificate_key /etc/letsencrypt/live/studio.getqualify.in/privkey.pem;

         location / {
             proxy_pass http://127.0.0.1:3010;
             proxy_http_version 1.1;
             proxy_set_header Upgrade $http_upgrade;
             proxy_set_header Connection "upgrade";
             proxy_set_header Host $host;
             proxy_set_header X-Real-IP $remote_addr;
             proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
             proxy_set_header X-Forwarded-Proto $scheme;
         }
     }
     ```
     Add a temporary 302 redirect on `app.getqualify.in` forwarding team members to `studio.getqualify.in`:
     ```nginx
     server {
         listen 443 ssl http2;
         server_name app.getqualify.in;
         ssl_certificate /etc/letsencrypt/live/app.getqualify.in/fullchain.pem;
         ssl_certificate_key /etc/letsencrypt/live/app.getqualify.in/privkey.pem;
         return 302 https://studio.getqualify.in$request_uri;
     }
     ```
     Test and reload:
     ```bash
     nginx -t && systemctl reload nginx
     ```
* **Rollback:**
  Revert `/opt/dograh/.env` back to `FRONTEND_API_URL=https://app.getqualify.in`, revert Nginx server names, and run `systemctl reload nginx`.
* **Risk Level:** **Medium** (Involves DNS propagation, SSL issuance, and container env restart).

---

### Phase 3: Infrastructure Decoupling (High Level / Long Term)

**Objective:** Decouple public marketing traffic from application and telephony operations.

* **Target Architecture:**
  - `getqualify.in`: Hosted on a globally distributed Edge CDN (Cloudflare Pages, Vercel, or Netlify).
  - VPS (`45.76.105.201`): Dedicated exclusively to `dashboard.getqualify.in` (Agency OS), `studio.getqualify.in` (Dograh Canvas), `dograh.getqualify.in` (FastAPI backend), and telephony WebSockets.
* **Benefits:**
  - **Zero Impact from Traffic Spikes:** Marketing viral traffic or DDoS attempts will never consume CPU/RAM on the voice VPS or cause audio packet drops during active phone calls.
  - **High Availability:** Marketing landing page remains online even during VPS maintenance, Docker container restarts, or kernel updates.
* **Key Decisions Needed Closer to Execution:**
  1. Static Site Generator selection (keep vanilla HTML/CSS or adopt Astro/Next.js for a future marketing blog).
  2. DNS delegation (Cloudflare DNS proxy vs apex ALIAS records).
  3. API routing for public demo links: whether `/api/public/demo/*` routes remain on `dashboard.getqualify.in` or proxy via Cloudflare route rules.

---

## Testing Checklist (End-to-End)

After completing Phase 1, run the following verification checks in sequence to confirm zero regression:

### 1. Marketing Site Navigation & CTAs
- [ ] Visit `https://getqualify.in/` in an incognito window.
- [ ] Inspect header "Sign in" and "Launch console" buttons: verify link target is `https://dashboard.getqualify.in/app.html`.
- [ ] Click "Sign in": confirm browser navigates directly to `https://dashboard.getqualify.in/app.html`.
- [ ] Test mobile navigation menu burger and closing CTA button links.

### 2. Nginx Redirect Guard
- [ ] Test curl directly:
  ```bash
  curl -sI https://getqualify.in/app.html
  ```
  Verify HTTP response is `301 Moved Permanently` with `Location: https://dashboard.getqualify.in/app.html`.
- [ ] Test curl for console redirect:
  ```bash
  curl -sI https://getqualify.in/console.html
  ```
  Verify HTTP response is `301 Moved Permanently` with `Location: https://dashboard.getqualify.in/app.html`.

### 3. Dashboard Authentication & Tenant Isolation
- [ ] Sign in on `https://dashboard.getqualify.in/app.html` using credentials (`hello@getqualify.in`).
- [ ] Verify `rxv_sess` cookie is issued under host `dashboard.getqualify.in`.
- [ ] Verify Agency OS loads all overview metrics, agents, and presets.
- [ ] Visit `https://getqualify.in/` in the same browser: confirm marketing page loads cleanly without displaying broken logged-in widgets.

### 4. Telephony & Live Voice Regressions (Zero Impact Check)
- [ ] **Talk-to-it Browser Audio:** In the dashboard under Agent -> Talk to it, verify the WebSocket audio session connects cleanly using the embed token (`DOGRAH_EMBED_TOKEN`).
- [ ] **Inbound Telephony:** Place a test phone call to the VoBiz number (`+918065354620`). Verify the call answers promptly and streams synthesized audio without lag.
- [ ] **Outbound Telephony:** Place a test call from the dashboard telephony tab. Verify the call is placed and dispatches normally through Dograh.

---

## Open Questions for User Approval

Before proceeding with Phase 1 execution, please confirm:

1. **Phase 1 Approval:** Are you ready to proceed with executing Phase 1 (updating `dashboard/public/index.html` via PR/deploy and applying the Nginx 301 redirects on the VPS)?
2. **Cookie Scoping Alignment:** Do you approve keeping the session cookie host-only to `dashboard.getqualify.in` as recommended in Section 1.3?
3. **Phase 2 DNS Access:** When we proceed to Phase 2, do you have access to your DNS registrar (e.g. Cloudflare or Namecheap) to add the `A` record for `studio.getqualify.in`?
