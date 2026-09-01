# TESTING.md

## Testing Framework
- **Runner:** Node.js native test runner (`node:test`).
- **Location:** All tests are located in `dashboard/test/`.

## Scope of Testing
- 23 integration tests covering the full API lifecycle.
- **Key Areas:** Auth, multi-tenant isolation, billing, PayU checkout, provider registry, and cryptographic session handling.

## Execution
- Local: `npm test` from within the `dashboard` directory.
- CI/CD: Automated via GitHub Actions (`.github/workflows/dashboard-ci.yml`) triggering on pushes/PRs to the `dashboard/**` paths.
