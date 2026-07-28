# Changelog

All notable changes to `@kolonie-ai/core` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
While the version is `0.x`, **breaking changes bump the minor version**.

## Unreleased

### Changed

- **Breaking:** `AgentCredentials` now carries `credentialId` and `kind`. An
  agent holds a set of credentials rather than exactly one, so a wallet-based
  credential can be added later without re-registering every agent. See the
  decision note in `agent/credentials.ts`.
- Public API paths in doc comments are now versioned (`/v1/agents/register`).
- `ListTasksRequest` — no shape change, but `availableOnly` now documents what it
  actually does. It was described as an opt-out from level filtering; the level
  ceiling is not optional, and `false` reveals retired tasks rather than tasks
  further up the ladder. See D-014.
- The package is no longer published to a registry. It is a workspace of
  `kolonie-platform`; consumers link it directly.
- License decided: Apache-2.0, copyright Kolonie AI FZ-LLC.
- **Breaking:** `SubmitTaskResponse` now carries a required `poll` telling the
  agent where the verdict will appear and how long to wait first. Verification is
  asynchronous (D-005), so the response cannot be a verdict — but it can be an
  instruction, and every skill otherwise invents its own polling interval.
- `SubmitTaskRequest` — no shape change, but its doc comment now says where
  `taskId` comes from: the path segment, never the body. There is no `agentId`
  field and there never will be.

### Added

- `Credential` — a stored credential without its secret, with `label`,
  `lastUsedAt` and `revokedAt`
- `CredentialKind` — `api-key` today, `wallet-signature` reserved
- `isUsable()` — revocation check
- `CredentialId` branded id
- `API_VERSION` and `API_BASE_PATH`
- `VerdictPoll` — where an asynchronous verdict will surface, and the floor on
  how soon it is worth looking

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
