# STRUCTURE.md

## Key Directories
- `dashboard/`: Contains the entire SaaS Control Plane (GetQualify Studio).
  - `dashboard/server.js`: The main entry point and HTTP server.
  - `dashboard/lib/`: Core backend modules (`core.js` for DB/Auth, `providers.js` for AI integration, `payu.js` for billing).
  - `dashboard/public/`: Frontend assets (Vanilla HTML/CSS/JS). Includes `index.html` and `app.html` (SPA shell).
  - `dashboard/src/`: React source files (e.g., `charts.jsx`) that are compiled to public assets.
  - `dashboard/test/`: Integration tests using the native Node.js test runner.
- `deploy/`: Six bash scripts (`01` to `06`) for the one-shot deployment process, plus a `rumik-overlay/` for Docker.
- `docs/`: Markdown documentation (Pricing, Troubleshooting, Setup).
- `prompts/`: Contains system prompts (`ria-system-prompts.md`).
- `workflows/`: Exported Dograh JSON graphs (e.g., `ria-receptionist.json`).
- `/`: The root contains top-level markdown artifacts (`README.md`, `schema.sql`, `SECURITY-AUDIT.md`, `THREAT-MODEL.md`).
