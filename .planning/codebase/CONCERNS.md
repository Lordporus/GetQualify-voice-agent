# CONCERNS.md

## Technical Debt & Risks
1. **Flat JSON Database (`data/db.json`):** While perfect for a low-dependency quickstart, atomic writes to a flat JSON file will present scaling bottlenecks as tenant count and concurrency increase. (The presence of `schema.sql` suggests an eventual migration to PostgreSQL).
2. **Deployment Fragility:** The 6-step bash script pipeline for deployment on a bare Ubuntu VPS lacks the idempotency of tools like Terraform or Ansible.
3. **Upstream Dependencies:** The stack is highly reliant on external models (Deepgram, Groq, Rumik) and the Dograh orchestrator. Any API changes in these downstream services require updates to `lib/providers.js`.
4. **Vobiz Edge Cases:** Telephony state desyncs (e.g., stale endpoints on Vobiz applications) have been noted as a significant gotcha in `TROUBLESHOOTING.md`.
