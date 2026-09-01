# CONVENTIONS.md

## Coding Standards & Patterns
- **Zero-Dependency Philosophy:** The core backend (`dashboard/server.js` and `dashboard/lib/`) uses native Node.js standard libraries (`http`, `crypto`, `fs`) exclusively, except for `ws` (WebSockets).
- **Frontend Simplicity:** The frontend relies heavily on Vanilla HTML/CSS/JS without a complex build pipeline (except for specific React components compiled via esbuild).
- **Provider Adapters:** A uniform adapter contract pattern is used in `lib/providers.js` to allow swapping out STT, LLM, and TTS providers via simple `.env` variable changes.
- **Security & Secrets:** All API keys must be kept in the `.env` file and never shipped to the client. Session management uses `scrypt` hashing and `httpOnly` cookies.
- **Tenancy:** All queries, API responses, and database writes are strictly scoped to `ctx.tenant.id`.
