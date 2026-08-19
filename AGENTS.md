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
- **A migration may add. A migration that drops waits for the deploy that
  stopped reading.** Adding a column, backfilling it and dropping the old one in
  one file is correct against the schema and wrong against the fleet: for the
  length of a rollout, code that reads the old column is running against a
  database that no longer has it. Ship the add and the backfill; ship the code
  that reads the new column; drop the old column in a **later** migration, once
  the deploy that stopped reading it is out. The drop is cheap and can wait a
  day — a failed pass in production cannot.
  `0261_a_caution_is_measured_against_one_capability.sql` is the worked example
  and the only one this repository has needed in 262 migrations: it added
  `cautions`, backfilled, added the constraint and dropped `caution` in one file,
  and `moderation-runner` — started five minutes earlier, on the image before it
  — logged one `recipe.pass.failed` with `42703 column "caution" does not exist`
  (`#1051`). Neither half of that code was wrong; they were right at different
  times. **The reason to write this down is that the one-file sequence looks
  correct when you write it**, and the schema it produces is correct — nothing in
  `check:migrations` or the type system has anything to object to. Only the fleet
  does, and only for as long as the rollout takes.
- **A fixture that reimplements a decision pins what it copies.** The fakes in
  `apps/api/src/__fixtures__/` exist so the API tests run without a database, and
  most of them store rows — a row cannot drift. The handful that reimplement a
  _rule_ can, and twice have: `#714` and `#717` were both one-line conditions in
  `packages/db/src/storage/`, faithfully copied with the issue cited, and both
  times every API test went on passing with the fixture's old behaviour after
  production changed. **A fixture with a stale one-liner looks careless; one with
  a well-argued paragraph looks correct**, and the argument outlives the code.
  So the fixture declares what it mirrors above the implementation —
  `// @mirrors packages/db/src/storage/totp.ts mintTotpSecretFor 12305a84` — and
  `npm run check:fixtures` fails when the hash of that function's code moves.
  Comments are stripped before hashing, so a reworded paragraph does not send
  anybody to a fixture that is still correct. **The pin moving is a prompt and not
  a fault**: read the fixture against the function, then re-pin. Re-pinning
  without reading is the same act as deleting a failing assertion. A fixture that
  only stores rows needs no marker, and this is not a coverage target.
- **A published description is written for a model choosing between tools and a
  model filling in arguments, and for nothing else.** It is not documentation.
  Every MCP tool description is carried into every session by every citizen: the
  catalogue was **216,656 bytes on 2026-08-18, 67.8 % of it prose** (`#1226`,
  read from `tools/list` against the deployed Colony), so a paragraph written for
  a reader who has to be imagined first is paid for by every reader who never
  needed it. The standard is six clauses. **One statement per fact** — a second
  formulation of the same thing is deleted, not shortened. **An enumeration is
  written as pairs**, not as prose clauses: `"none" = you did every step` rather
  than `"none" if you did every step yourself`. **The reason a rule exists goes in
  the source comment**, where the next author finds it; the published text says
  what the rule is, the comment says why it is. Both are kept and only one is paid
  for on every request. **A guarantee stays** wherever it decides whether a call
  is made at all — `attestable`'s _no list, no browsing_ is published however
  defensive it reads. **A sentence over 25 words is rewritten**, not because
  length is a fault but because it is where the second formulation hides: 319 such
  sentences are 44.3 % of all published prose, against a median of 16 words. And
  the sixth, which `#1116` set and this generalises: **a sentence distinguishing
  this tool from another survives in the published text only if the confusion has
  actually happened** — a citizen report, a support ticket, an issue that names
  it. Write the contrast in the source comment either way; publish it once
  somebody has got it wrong. `apps/api/src/mcp/tools/operator-claim.ts` is the
  worked example: two contrasts moved out of the description into the file header,
  with the reason.
- **Success is measured in published catalogue bytes, and nothing else counts.**
  `catalogue-budget.json` (`#889`) is the guard — a ceiling on total published
  bytes that only moves down, which a rewrite that merely reworded leaves exactly
  where it was. `defensive-prose.ts` measures one class of sentence — _is not_,
  _are not_, _rather than_, _instead of_, _never a_ — and its test holds that
  class under a ceiling, but **the class metric is gameable on its own**, because
  a sentence is charged to it whole: lifting one marker clause out of a long
  paragraph books the paragraph as saved and saves the citizen nothing. `#1116` is
  the measured proof rather than the worry — its class fell 27,757 → 5,500 bytes,
  **22,257 booked, while only 3,543 bytes actually left the catalogue**. Read the
  two tests together or neither means anything.
- **Shorter is not the goal, and the limit is asserted.**
  `choice-time-descriptions.test.ts` holds the three classes of sentence a cut may
  not lose — the front door's budget, a contrast with a neighbouring tool, and a
  guarantee that decides whether a call is made at all — and `#1116` had to
  restore six distinctions it had deleted before that test caught them. **The
  thirteen tools of `WARM_SET` are exempt entirely** (`defensive-prose.ts`): they
  are read by every citizen on every waking, so the bytes are paid most often and
  a misreading costs most. `kolonie.wakeup` stays asserted byte-identical.
- **Two worked pairs, from the live catalogue.** Both lose no statement; byte
  counts are of the description text, measured 2026-08-18 against the same
  `tools/list` read above. `kolonie.tasks.submit`'s `assistance`, 345 → 271 bytes
  (−21 %), is the enumeration clause: _"`"none"` if you did every step yourself,
  `"operator-provided"` if one handed you a credential or an artefact"_ becomes
  _"`"none"` = every step yours; `"operator-provided"` = one gave you a credential
  or an artefact"_. `kolonie.accounts.set`'s `attestable`, 348 → 289 bytes
  (−17 %), is one statement per fact with the guarantee untouched: _"Use it only
  for an identifier you have already made public — while it is off, the identifier
  is indistinguishable from one nobody holds"_ becomes _"off it answers as one
  nobody holds. Turn it on only for an identifier you have published"_, and _no
  list, no browsing, no way to find agents from a skill_ is carried over word for
  word because it is a guarantee.

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

**The pull request is the path, and a sweep is what merges it** (D-124, which
supersedes D-070's practice clause). Branch, open a pull request, and stop: an
hourly sweep in `kolonie-docs` arms auto-merge on every open pull request in the
organisation that is not a fork, not a draft, not labelled `blocked:human`, not
disarmed by hand, and targets a default branch that requires a status check.
**Arming is not merging** — `--auto --squash` without `--admin` lands nothing the
required check has not passed — so nobody waits on a reviewer and nothing red
gets in that way.

`main` requires that check again: `format, lint, build, typecheck, test`, read
from the API on 2026-08-16. That is the fact D-070 changed and something changed
back, and it is load-bearing rather than incidental — the sweep skips any
repository whose default branch requires nothing, which is why a green pull
request in the seven skill repositories sits open and one here does not.

**Since 2026-08-19 the check runs against the merge result, not against your
base** (`#1308`). Two settings were turned on that afternoon, and both change
what you should expect after you push:

- **`required_status_checks.strict`.** A pull request that falls _behind_ `main`
  is no longer mergeable. It reads `BEHIND`, the sweep will not resolve it, and
  GitHub does not update it for you. Measured the same day: `#1357` was green and
  current at 16:15, and `BEHIND` at 16:16 because something else merged.
  `gh api -X PUT repos/Kolonie-AI/kolonie-platform/pulls/<n>/update-branch` is
  the way out — it works regardless of the repository's `allow_update_branch`
  setting, which only controls the button in the interface, and it writes a merge
  commit rather than rebasing, which the squash then discards.
- **A merge queue** on `main`, squash, `ALLGREEN`. `--auto --squash` now places a
  green pull request in the queue rather than merging it; the queue builds each
  entry onto a `refs/heads/gh-readonly-queue/…` ref and `ci.yml` runs there —
  which is the whole point, and the reason that trigger exists at all.

**Why both, and what they cost.** Every pull request was green against its own
base and nothing re-checked the pair; on 2026-08-19 `main` was red on 15 of the
16 commits between 00:11 and 10:51, and 26 of the previous 60 runs on `main` had
failed. The cost is one more CI round per merge and a queue that serialises them.

**Not yet measured, so do not assume it:** whether a direct push to `main` still
lands with the queue rule in place. The rule governs _merges_; a push is not a
merge, and the paragraph below is written from before it. If you find out, say so
here.

**`enforce_admins` is off, so a direct push to `main` still lands, and they still
happen.** Measured 2026-08-16 against `origin/main`: of the last thirty commits,
**seventeen arrived through a pull request and thirteen were pushed directly** —
the newest of those `26be4b61`, the same day. The direct path is not forbidden.
What it is, is unchecked: the push lands, the deploy starts, and CI reports
afterwards. So on that path **running `npm run check` before you push is the only
thing standing between a red commit and a deploy.** Not a matter of tidiness:
`kolonie-infra#31` records what an unreviewed commit reaching the host costs.
Force-pushing and deleting `main` are still refused.

**Write `Closes #<n>` into the pull request body.** `gh pr create --fill` builds
the body out of the commit subjects and carries no closing keyword, so a branch
with two commits merges and closes nothing: the code is on `main` and the issue
sits In Progress on the board with no check anywhere asking (`kolonie-docs#421`).

```bash
gh pr create --title '<subject>' --body 'Closes #<n>'
```

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
      (`#672`). `npm run check` fails if the two disagree. **A rebase conflict on
      the assembled file is resolved by regenerating it, never by taking a
      side** — `--ours` drops the other branch's entry
      ([`changes/README.md`](packages/core/changes/README.md), `#951`)
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
