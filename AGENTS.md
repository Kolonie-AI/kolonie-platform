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
  `journal.test.ts` refuses the four ways this goes wrong. **Run
  `npm run check:counts` straight after `npm run generate`** — a new table or enum
  moves four assertions in three files, and this is the eleven-second way to find
  out which (§4).

## 4. Commands

Everything runs from the repository root.

```bash
npm install
npm run check         # format + lint + build + migrations + typecheck + test
npm run check:fast    # the same, minus the tests — and it says so, loudly
npm run check:counts  # only the four assertions that count tables, enums and tools
```

**`npm run check` is the one that decides whether you may push.** The other two
are feedback while you work, and each of them says what it did not cover, because
a partial check whose output looks like a full one is worse than no check.

**`check:counts` exists because four assertions break together and used to be
discovered one full run at a time** (`#312`). Adding a table, an enum or an MCP
tool moves all four — the table count and the enum count in
`packages/db/src/migrate.test.ts`, the table list in `schema.test.ts`, the tool
list in `apps/api/src/mcp/tools/me.test.ts` — and they live in three files nobody
thinks of together. Three of six full runs in one session on 2026-08-04 bought
nothing but those numbers, about five minutes of wall clock. The script runs those
three files and nothing else: **11 s warm against `npm run check`'s 1:31–1:39**,
measured on 2026-08-04.

It **does not** cover formatting, lint, types, migration drift or any other test,
and a green run says nothing about them. It needs `DATABASE_URL` like everything
else and refuses to start without one. Note also that the two counts share a
single test, so a wrong table count masks a wrong enum count until it is fixed —
one run, not always one round.

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
D-009. Set it and the database tests run; leave it unset and they **fail, in
every environment**. They do not skip: a suite that skips silently reports green
while covering nothing, which is the one thing this arrangement must never do, so
it is asserted rather than assumed (`#224`).

```bash
npm run test:db:up      # no server yet: starts one, prints the line to export
npm run test:db:relax   # already have one: makes it fit to test against
```

The second command turns off three durability guarantees a throwaway test
database cannot use, and is worth roughly half this package's wall clock
(`#283`). CI does the same to its own service container.

Any PostgreSQL 16 will do — `docker-compose.dev.yml` in `kolonie-infra` is
another way, and so is a server from `apt`. Do not write a tool into an
acceptance criterion where you mean a capability.

Scoped to one workspace:

```bash
npm run test  -w @kolonie-ai/api
npm run build -w @kolonie-ai/core
```

**A scoped test run does not build first, and the root one does** (`#309`). Every
workspace resolves its siblings through their emitted `dist/`, so a scoped run
against a `dist/` older than the source fails with whatever the missing export
happens to break — `TypeError: … is not a function`, `Cannot read properties of
undefined`, a route answering 500 — and none of it names the build. Four minutes
went into reading somebody else's diff for that on 2026-08-04. `npm test` from the
root now runs the incremental build first, which costs 1.4 s warm and makes the
stale state stop existing; if a **scoped** run fails in that shape, run
`npm run build` before believing it.

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
- [ ] A file in `packages/core/changes/` if the domain model changed, and
      `node scripts/build-changelog.mjs` run — **not an edit to
      `packages/core/CHANGELOG.md`**, which is produced from that directory
      (`#672`). `npm run check` fails if the two disagree
- [ ] Breaking changes labelled in the PR, with affected workspaces named
- [ ] No secrets, hosts or IPs anywhere in the diff

## 8. The check command

```bash
npm run check
```

§4 describes it and §7 requires it; this section exists so that it can be found
without reading either.

**It is machine-read.** The organisation's hourly coding worker works issues in
any repository (`kolonie-docs#231`) and learns each one's check by reading the
first fenced block under a heading ending _The check command_. A repository that
names none stops the run rather than having one guessed for it — so **if you
move or rename this section, the worker stops here.**

A heading rather than a table in the worker, because a table would be a second
record of a fact this repository already states, and the second record goes
stale without anybody editing it.

### The check prerequisite

```bash
npm run test:db:up
```

**`npm run check` cannot pass without a PostgreSQL 16 and a `DATABASE_URL`, and
that is deliberate.** §4 and `kolonie-docs/operations/testing.md` both refuse the
alternative: _"a missing variable is a hard failure, in every environment"_,
because a suite that skips the database tests reports green while covering
nothing. The command above is this repository's own disposable server, and it
finishes by printing the `export DATABASE_URL=…` line that goes with it.

**This heading is machine-read too, and it is the sibling of the one above**
(`kolonie-docs#247`). The hourly worker re-runs this repository's check after its
model has finished — an unattended agent reporting that it ran a check is the
claim that arrangement exists to stop taking on trust — and until 2026-08-09 it
re-ran it with no database at all. Run `31303638874`: the model found this
command in this file, started the server, passed the whole check against it, and
the worker's re-run then failed on the one thing the model had already solved.

So the worker reads the first fenced block under a heading ending _The check
prerequisite_, runs it before the check, and takes the `export NAME=value` lines
it prints. **A repository that needs nothing states nothing** — four of the five
do, and silence there is the ordinary answer rather than a defect. Here it is not
silence, and moving or renaming this section puts the worker back in an
environment this repository's own tests are designed to refuse.

Anything that provides a PostgreSQL 16 will do — §4 fixes the interface at
`DATABASE_URL` and nothing else, so the Compose stack in `kolonie-infra`, an
`apt`-installed server or a hosted throwaway are all equally correct locally.
This section names the one command a machine can run unattended.

## 9. When you are unsure

Ask in the issue rather than guessing. A wrong shape in `packages/core`
propagates into every other workspace, and once a skill ships, a wrong endpoint
shape propagates into agents the Colony does not control.

If a task appears to require breaking a rule in §3, you have been given the
wrong task. Say so instead of proceeding.
