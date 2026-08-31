# Security policy

## Supported version

Security fixes target the current `main` branch.

## Reporting

Do not open a public issue containing credentials, customer data, call recordings, transcripts, or an exploitable vulnerability. Contact GetQualify privately through the contact route on [GetQualify.com](https://GetQualify.com).

## Deployment rules

- Keep every provider key in an ignored `.env` file or a managed secret store.
- Use a dedicated Dograh organization API key for each production tenant.
- Keep PayU in test mode until the unchecked financial controls in `dashboard/SAAS-QA-CHECKLIST.md` are complete.
- Treat the included JSON persistence layer as single-process evaluation storage, not a production financial ledger.
- Rotate any secret that has appeared in chat, screenshots, shell history, logs, or committed Git history.
