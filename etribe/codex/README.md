# eTribe Codex Runtime

This directory is the temporary code-only runtime surface for autonomous eTribe Codex jobs while the dedicated private `nishantr2/etribe-ops` repository is unavailable.

## Security contract

- Never store API keys, OAuth tokens, service-account JSON, cookies, passwords, or other secrets in this repository.
- All credentials live only in approved secret stores / runtime environment variables.
- Autonomous Codex execution must be billed through the OpenAI Platform API path, never through ChatGPT-plan Codex credits.
- Jobs are atomized and idempotent. One job owns one bounded code objective.
- Each job must create or update a dedicated branch, run tests, and return commit/PR/CI evidence to Supabase.
- Merge is always human-gated.
- Destructive, public, legal, billing, credential, and production-impacting changes fail closed unless an explicit approval gate has been satisfied.
- Supabase remains the operational control plane. Google Drive remains canonical durable business/creative truth.

## Target flow

Supabase job -> Hatchet -> API-backed Codex worker -> bounded branch -> tests -> draft PR -> CI -> Supabase evidence -> human merge gate.

## Temporary repository rule

`nishantr2/open-connector` is public. Only non-secret runtime code, tests, schemas, and documentation may be committed here. The preferred long-term destination is the private `nishantr2/etribe-ops` repository once it exists and is authenticated.
