# STACK.md

## Core Technologies
- **Runtime:** Node.js (>= 18)
- **Frontend:** Vanilla HTML/CSS/JS (no heavy build steps required for the main UI). React 19 and Recharts are used specifically for charting, compiled via esbuild.
- **Backend:** Node.js built-in HTTP server (zero-dependency philosophy for the main server, except `ws` for WebSockets).
- **Database:** Primarily a flat JSON store (`data/db.json`) for atomic writes. A PostgreSQL schema (`schema.sql`) and `pg` dependency indicate relational database support (potentially for scale or different deployment tiers).
- **Package Manager:** `pnpm` (based on the presence of `pnpm-lock.yaml` and `pnpm-workspace.yaml`), though `npm` is also referenced in docs.

## Build Tools
- **Bundler:** esbuild (used to compile `src/charts.jsx` to `public/assets/charts.js`).

## AI / Audio
- **Orchestrator:** Dograh (Node-graph agent for VAD and turn detection)
