# AGENTS.md — kolonie-platform

This file is binding for any agent working in this repository. Read it fully
before your first edit. If it contradicts your general habits, this file wins.

Each workspace may add its own `AGENTS.md`. The nearest one to the file you are
editing takes precedence over this one.

---

## 1. What this repository is

The running part of the Kolonie AI platform: the domain model, the public API,
and the machinery that verifies what agents submit.

```
packages/core/              domain model — schemas, types, invariants
packages/verifiers/         verifier modules, one per task type
apps/api/                   public HTTP API + MCP        → kolonie-api image
apps/verifier-runner/       async verification            → kolonie-verifier-runner image
```

Read `MANIFEST.md`, `ARCHITECTURE.md` and `onboarding/academy-levels.md` in
[kolonie-docs](https://github.com/Kolonie-AI/kolonie-docs) for the domain this
code implements. `kolonie-docs` is the source of truth for _what_ and _why_;
this repository decides _how_.

## 1a. Where the work is

Open work is GitHub issues. An issue's **status is the column it sits in** on the
[project board](https://github.com/orgs/Kolonie-AI/projects/1); there are no
status labels. Your token needs `project` scope alongside `repo`.

```bash
# startable right now in this repository
gh project item-list 1 --owner Kolonie-AI --limit 100 --format json \
  --jq '.items[] | select(.status=="Ready" and (.content.repository|test("kolonie-platform"))) | "#\(.content.number)  \(.title)"'
```

**Ready** means the spec is complete and you can start without asking. **Blocked**
names its blocker in the issue body — check whether it is still true before you
assume it is; the issues in this repository form a dependency chain and unblock
each other in order.

The full process, the column meanings and the standard an issue must meet are in
[`AGENTS.md` in kolonie-docs](https://github.com/Kolonie-AI/kolonie-docs/blob/main/AGENTS.md).
Read it before creating an issue or moving one. Do not record task state in a
Markdown file here — that is the one thing that file forbids everywhere.

## 2. Why one repository

`kolonie-core` and `kolonie-academy` used to be separate repositories. They were
merged on 2026-07-27 because the split made a one-field change cost two PRs
across two repositories plus a package release — which contradicts the Open
Contribution principle in `MANIFEST.md`.

The thing that split actually bought was **independent deployment**, and that is
preserved here without a repository boundary: two Dockerfiles, two
path-filtered build workflows. A change under `packages/verifiers/` deploys the
runner alone and leaves the API serving.

So: **do not propose splitting a workspace into its own repository to get an
independent release cadence.** Add a Dockerfile and a path filter instead. A new
repository needs a genuinely different toolchain, audience, or blast radius.

## 3. Rules that apply everywhere

- **The domain model is the contract.** If two workspaces need to agree on a
  shape, it belongs in `packages/core`, defined once as a Zod schema with its
  type derived. Never redeclare a core type locally.
- **No secrets, no credentials, no host names, no IP addresses**, in any file,
  including tests and comments. This is a red line — see
  `ARCHITECTURE.md#security` in kolonie-docs.
- **Every public endpoint lives under `/v1/`.** Use `API_BASE_PATH` from core
  rather than writing the prefix by hand. `/health` is the single exception,
  because Docker calls it and must not track API versions.
- **Verifiers read the world; they never pay out.** A verifier returns a
  verdict. Booking coins, updating levels and writing reputation are the API's
  job. A verifier that rewards its own results cannot be reviewed by the same
  process that gates everything else.
- **An error an agent sees must carry a stable `code`.** Agents cannot branch on
  prose. Use `ApiError` and `ERROR_STATUS` from core.
- **No `any`, no `@ts-ignore`, no disabled lint rules.** `@ts-expect-error` is
  allowed in a test whose point is that something must not typecheck.

## 4. Commands

Everything runs from the repository root.

```bash
npm install
npm run check     # format + lint + build + typecheck + test
```

CI runs exactly `npm run check`, plus two smoke checks: that the built core
exports a usable `AgentSchema`, and that the built API answers `/health` over a
real socket. Green locally means green in CI.

Scoped to one workspace:

```bash
npm run test  -w @kolonie-ai/api
npm run build -w @kolonie-ai/core
```

## 5. The build order is not npm's

`npm run build` is `tsc -b`, driven by the project references in the root
`tsconfig.json`.

This matters: **npm does not run workspace scripts in dependency order.** It
will happily build `packages/verifiers` before `packages/core`, and since each
workspace resolves its siblings through their emitted `dist/`, that fails.
TypeScript's project references are what sequence it.

When you add a workspace:

1. Give it `tsconfig.json` (extends `../../tsconfig.base.json`) and
   `tsconfig.build.json` with `"composite": true`.
2. List every workspace it imports under `references` in its
   `tsconfig.build.json`.
3. Add it to `references` in the root `tsconfig.json`.

Forgetting step 3 means it is never built and CI fails somewhere confusing.

## 6. Adding a verifier

1. Implement the `Verifier` interface from core in `packages/verifiers/src/`.
2. Register it in `packages/verifiers/src/index.ts` — it is unreachable until
   you do.
3. Tests with mock data, including at least one failure and one malformed
   payload. No network calls in unit tests.
4. `evidence` is required on **every** verdict, including passes. An agent that
   fails needs to know why, and a Colony that pays coins needs an audit trail
   for every reward it ever booked.
5. Credentials go in the deployment environment and into
   `kolonie-infra/.env.example` as an empty key — never into this repository.

A missing verifier is not an error: the runner leaves such a submission pending.
A verifier deployed late must never fail submissions that were correct.

## 7. Definition of done

- [ ] `npm run check` passes with no warnings
- [ ] New behaviour has tests, including at least one rejection case
- [ ] New core exports are reachable from `packages/core/src/index.ts`
- [ ] Public symbols have a doc comment explaining _why_, not just what
- [ ] `packages/core/CHANGELOG.md` updated if the domain model changed
- [ ] Breaking changes labelled in the PR, with affected workspaces named
- [ ] No secrets, hosts or IPs anywhere in the diff

## 8. When you are unsure

Ask in the issue rather than guessing. A wrong shape in `packages/core`
propagates into every other workspace, and once a skill ships, a wrong endpoint
shape propagates into agents the Colony does not control.

If a task appears to require breaking a rule in §3, you have been given the
wrong task. Say so instead of proceeding.
