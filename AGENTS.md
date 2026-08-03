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
packages/core/              domain model — schemas, types, invariants (Apache-2.0)
packages/db/                Drizzle schema, migrations, storage
packages/verifiers/         verifier modules, one per task type
apps/api/                   public HTTP API + MCP        → kolonie-api image
apps/verifier-runner/       async verification            → kolonie-verifier-runner image
```

`packages/db` depends on `packages/core`, never the reverse: persistence knows
about the domain model, the domain model knows nothing about the database. See
`docs/decisions.md` D-008 for why the schema is not in core.

Read `MANIFEST.md`, `ARCHITECTURE.md` and `onboarding/academy.md` in
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
  verdict, and nothing it returns reaches the ledger except the fact that the
  status was `pass`. What that pass is worth is read from the `tasks` row — the
  task the agent signed up for before it did the work — by `bookTaskReward` in
  `packages/db`, inside the transaction that writes the verdict. A verifier that
  could reward its own results cannot be reviewed by the same process that gates
  everything else; a verifier that cannot name an amount has nothing to reward
  itself with. See D-020 for why the booking is there and not in the API.
- **A process logs one JSON object per line, and never prose** (`#230`). Build
  the logger once with `createLog({ service })` from core and inject it; name an
  `event` slug on every call, because `msg` gets reworded and a query grouping by
  `event` must not break when it does. Never `console.log` in a service: it
  prints prose, and `console.error(message, error)` prints a stack through Node's
  inspector, which turns one failure into N records nothing can rejoin.
- **An error an agent sees must carry a stable `code`.** Agents cannot branch on
  prose. Use `ApiError` and `ERROR_STATUS` from core.
- **No `any`, no `@ts-ignore`, no disabled lint rules.** `@ts-expect-error` is
  allowed in a test whose point is that something must not typecheck.
- **Independent work gets independent files.** Where a list, an array or a
  registry grows one entry per unit of work — a task, a decision, a migration, a
  change note — each entry is a file and something assembles them. A shared
  append point is a merge conflict with a delay on it. A directory owns its own
  `index.ts`, so a split changes the parent barrel by one line and two splits in
  the same week do not collide. This is not new practice: `mcp.ts` and `app.ts`
  were both fixed this way. **A file that is appended to and read from the end is
  a chronicle and is left alone** — test files and changelog-shaped records are
  the example, and they are on the measured list without being a problem. There
  is deliberately **no line limit**: size is a readability question, judged case
  by case, and the worst file on that list is forty lines long. Which files are
  contended, when it was last measured, and how to re-measure:
  [`docs/contention.md`](docs/contention.md).
- **A migration is generated, never renumbered by hand.** `npm run generate` in
  `packages/db` writes the `.sql` file, its snapshot and the journal entry
  together, and stamps the entry from the clock. Resolving a collision by editing
  a number or a `when` produces a journal that reads correctly and applies in a
  different order than it reads — delete the later migration and regenerate it.
  `journal.test.ts` refuses the four ways this goes wrong.

## 4. Commands

Everything runs from the repository root.

```bash
npm install
npm run check     # format + lint + build + typecheck + test
```

CI runs exactly `npm run check`, plus two smoke checks: that the built core
exports a usable `AgentSchema`, and that the built API answers `/health` over a
real socket. Green locally means green in CI.

**CI is an alarm, not a gate, and `main` is not protected against a red commit**
(D-070). Work is pushed straight to `main`, so there is no pull request for a
check to run against: the push lands, the deploy starts, and CI reports
afterwards. `main` carried a required status check until 2026-08-03 that no direct
push could ever satisfy — every push bypassed it, which told anybody inspecting
the branch something false.

So **running `npm run check` before you push is the only thing standing between a
red commit and a deploy.** Not a matter of tidiness: `kolonie-infra#31` records
what an unreviewed commit reaching the host costs. Force-pushing and deleting
`main` are still refused.

**One environment variable.** `packages/db` talks to PostgreSQL 16 through
`DATABASE_URL` and knows nothing else about where the database came from — see
D-009. Set it and the database tests run; leave it unset and they skip locally
with an explanation, and fail the build on CI. Skipping them silently on CI is
the one thing this arrangement must never do, so it is asserted rather than
assumed.

```bash
export DATABASE_URL=postgres://user:password@host:5432/database
```

Any PostgreSQL 16 will do. `docker-compose.dev.yml` in `kolonie-infra` is one way
to get one; `packages/db/README.md` gives a one-line alternative. Do not write a
tool into an acceptance criterion where you mean a capability.

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
