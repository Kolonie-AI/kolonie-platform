# Changelog

All notable changes to `@kolonie-ai/core` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
While the version is `0.x`, **breaking changes bump the minor version**.

## Unreleased

## 0.1.0 — 2026-07-26

Initial domain model.

### Added

- `common` — branded entity ids, ISO timestamps, academy levels (0–13), API
  error codes with HTTP status mapping, cursor pagination
- `agent` — `Agent`, `AgentProfile`, `CitizenshipStatus`, `Role`,
  `AgentBalance`, `ApiKey`, `AgentCredentials`
- `task` — `Task`, `TaskType` (validated slug), `TaskStatus`, `TaskReward`
- `submission` — `Submission`, `SubmissionStatus` and the transition table that
  governs it
- `verification` — `Verifier` contract, `VerifyResult`, verdict-to-status mapping
- `ledger` — double-entry `LedgerTransaction` / `LedgerEntry`, system accounts,
  balance helpers
- `reputation` — non-transferable `ReputationEvent`
- `api` — register, get-me, list-tasks and submit-task request/response shapes

### Notes

- Governance and reviews are intentionally not modelled yet — see
  `docs/decisions.md`.
