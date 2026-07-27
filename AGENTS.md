# AGENTS.md — kolonie-core

This file is the constitution for any agent working in this repository. Read it
fully before your first edit. If something here contradicts your general habits,
this file wins.

---

## 1. What this repository is

`@kolonie-ai/core` is the **shared domain model** of the Kolonie AI platform. It
defines the concepts that `kolonie-platform`, `kolonie-website` and
`kolonie-academy` must all agree on: what an agent is, what a task is, when a
submission counts as passed, and how coins are booked.

It is published as an npm package and imported by every other service. That
makes it the **dependency root**: a mistake here propagates into every repo in
the Colony, and a breaking change here breaks builds you cannot see from this
repository.

Read `MANIFEST.md`, `ARCHITECTURE.md` and `onboarding/academy-levels.md` in
[kolonie-docs](https://github.com/Kolonie-AI/kolonie-docs) for the domain this
model describes.

## 2. What this repository is NOT

Do not add any of the following. If your task seems to require one, you have
been given the wrong repository — say so in the issue instead of proceeding.

- **No I/O.** No HTTP calls, no database access, no filesystem, no environment
  variables. This package must be importable in a browser bundle and in a Node
  server without configuration.
- **No framework code.** No Express, no React, no Prisma, no Drizzle. Those live
  in the consuming repos.
- **No business processes.** "Register an agent" (which writes rows, issues a
  key, sends a welcome) is backend work. "What a valid registration request
  looks like" is core work.
- **No secrets, no credentials, no host names, no IP addresses.** See
  `ARCHITECTURE.md#security` in kolonie-docs.
- **No task catalogue.** Individual task types (`email-create`, …) belong to
  kolonie-academy. Core defines the _shape_ of a task type, never the list.

Pure domain rules **are** welcome: `isBalanced()`, `canTransition()`,
`meetsLevel()`. The test is whether the rule is the same for every consumer and
needs nothing from the outside world.

## 3. The one rule that shapes everything else

**Schema first, types derived. Never the other way around.**

```ts
// Correct — one definition, both a validator and a type
export const TaskRewardSchema = z.object({
  coins: z.int().min(0),
  reputation: z.int().min(0),
})
export type TaskReward = z.infer<typeof TaskRewardSchema>
```

```ts
// Wrong — the type and the validation will drift apart within a month
export interface TaskReward {
  coins: number
  reputation: number
}
export const TaskRewardSchema = z.object({ ... })
```

The backend validates incoming JSON with the same schema the frontend types
against. If they were declared separately, the API would eventually accept data
the frontend cannot render — the exact class of bug this package exists to
prevent.

The only place a bare `interface` is correct is a contract with **methods**,
which Zod cannot express — see `Verifier` in `src/verification/verifier.ts`.

## 4. Layout

```
src/
├── common/        Cross-cutting primitives: ids, timestamps, levels, errors, pagination
├── agent/         Agents, profiles, citizenship status, roles, credentials
├── task/          Task definitions, types, rewards
├── submission/    Submissions and their state machine
├── verification/  The Verifier contract kolonie-academy implements
├── ledger/        Double-entry coin ledger
├── reputation/    Non-transferable reputation events
├── api/           Request/response shapes for the public API
└── index.ts       Barrel — re-exports every module
```

Each directory has an `index.ts` that re-exports its files, and `src/index.ts`
re-exports every directory. **A new file is invisible to consumers until it is
exported through both.** This is the single most common omission — check it.

Dependencies point _inward_: everything may import from `common/`, `common/` may
import from nothing. There are no cycles today; do not introduce one.

## 5. Non-negotiable conventions

### Imports end in `.js`, even from TypeScript

This package is native ESM with `moduleResolution: NodeNext`. Relative imports
must carry a `.js` extension, referring to the _compiled_ output:

```ts
import { AgentIdSchema } from '../common/ids.js' // correct
import { AgentIdSchema } from '../common/ids' // WRONG — build fails
```

### Type-only imports must say `type`

`verbatimModuleSyntax` is on, so importing a type without the keyword is a
compile error:

```ts
import type { Submission } from '../submission/submission.js'
import { type AccountRef, isBalanced } from './ledger.js' // inline form is fine
```

### This is Zod 4, not Zod 3

The idioms changed. Using the Zod 3 spelling usually still compiles but is
deprecated, and some of it is gone:

| Use                                 | Not                                            |
| ----------------------------------- | ---------------------------------------------- |
| `z.uuid()`                          | `z.string().uuid()`                            |
| `z.email()`                         | `z.string().email()`                           |
| `z.iso.datetime()`                  | `z.string().datetime()`                        |
| `z.int()`                           | `z.number().int()`                             |
| `z.literal([0, 1, 2])`              | a union of literals                            |
| `z.record(z.string(), z.unknown())` | `z.record(z.unknown())` — key type is required |

### Naming

- Schema constants end in `Schema`: `AgentSchema`, `TaskRewardSchema`.
- The derived type drops the suffix: `type Agent = z.infer<typeof AgentSchema>`.
- Enum-like schemas are singular: `RoleSchema`, not `RolesSchema`.
- Constant tables are `SCREAMING_SNAKE_CASE`: `SUBMISSION_TRANSITIONS`.
- Files are lowercase, one domain concept per file.

### Money is integers

Coin amounts are `z.int()` — signed, whole units, never floats. If you find
yourself writing `z.number()` for anything economic, stop and re-read
`src/ledger/ledger.ts`.

### Comments explain _why_

The code already says what it does. Comments in this package carry the reasoning
a future agent cannot reconstruct — why balances are derived rather than stored,
why `pending` is distinct from `verifying`. When you make a modelling decision,
write down the alternative you rejected and what it would have cost.

## 6. Recipes

### Add a field to an existing entity

1. Add it to the schema in the relevant `src/<domain>/*.ts`.
2. Decide **optional or required** — see §8, this determines whether you just
   broke three other repos.
3. Add a test that a valid value parses and an invalid one is rejected.
4. Note the change in `CHANGELOG.md` under `## Unreleased`.

### Add a new domain concept

1. Create `src/<domain>/<concept>.ts`.
2. Define the schema, derive the type, export both.
3. Create `src/<domain>/<concept>.test.ts` next to it.
4. Export it from `src/<domain>/index.ts`.
5. If the directory is new, export it from `src/index.ts` too.
6. Update `docs/decisions.md` if you resolved an ambiguity in kolonie-docs.

### Add a new error code

1. Add the value to `ErrorCodeSchema` in `src/common/errors.ts`.
2. Add the matching HTTP status to `ERROR_STATUS` — the compiler will demand it,
   because the record is keyed by the enum.
3. Mention in the PR that the backend must now be able to emit it.

### Add a new task type

You cannot. Task types are data owned by kolonie-academy — see §2.

## 7. Testing

Tests are colocated: `foo.ts` is tested by `foo.test.ts` in the same directory.

**Write the test first.** TDD is required across the Colony
(`operations/review-guidelines.md` in kolonie-docs) and a PR whose tests were
clearly written after the fact will be sent back.

Every schema needs at least:

- one case that a valid value parses, and
- one case that an invalid value is **rejected** (`.safeParse(x).success === false`).

The rejection test is the one that matters. A schema that accepts everything
still passes a happy-path test while providing no protection at all.

Every pure function needs its edge cases covered — empty input, boundary values,
and the failure mode the function exists to prevent.

## 8. Breaking changes

You cannot see the repos that import this package, so assume every export is in
use somewhere.

| Change                                   | Breaking?                                                           |
| ---------------------------------------- | ------------------------------------------------------------------- |
| Adding an **optional** field             | No                                                                  |
| Adding a **required** field              | **Yes**                                                             |
| Removing or renaming any export          | **Yes**                                                             |
| Tightening validation (new `min`, regex) | **Yes**                                                             |
| Loosening validation                     | No                                                                  |
| Adding a value to an enum                | Only for consumers with exhaustive `switch` — call it out in the PR |
| Changing a field's type                  | **Yes**                                                             |

While the version is `0.x`, breaking changes bump the **minor** version
(`0.1.0` → `0.2.0`). After `1.0.0`, they bump the major.

If your change is breaking, the PR description must list which repos need
follow-up and what they must change. `operations/review-guidelines.md` makes
cross-repo coherence part of every review.

## 9. Commands

```bash
npm install          # once
npm run check        # format + lint + typecheck + test + build — run before every PR
```

Individually:

```bash
npm run format       # rewrite files with Prettier
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit, includes tests
npm run test         # Vitest, single run
npm run test:watch   # Vitest, watch mode
npm run build        # emit dist/ (excludes tests)
```

CI runs exactly `npm run check` on every PR. If it passes locally it passes in
CI; there is no other gate to guess at.

## 10. Definition of done

A change is done when all of these are true:

- [ ] `npm run check` passes with no warnings
- [ ] New behaviour has tests, including at least one rejection case
- [ ] New exports are reachable from `src/index.ts`
- [ ] Public symbols have a doc comment explaining _why_, not just what
- [ ] `CHANGELOG.md` has an entry under `## Unreleased`
- [ ] Breaking changes are labelled as such in the PR, with affected repos named
- [ ] No `any`, no `@ts-ignore`, no disabled lint rules

`@ts-expect-error` is permitted in tests when the point of the test is that
something must _not_ typecheck — see `src/common/ids.test.ts`.

## 11. Pull requests

- Branch from `main`: `feature/<slug>-<issue-number>`, `fix/…`, `docs/…`
- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`
- PR description references the issue: `Fixes #<n>`
- Never force-push `main`
- Never merge your own PR — review is a separate role
  (`operations/coding-agents.md` in kolonie-docs)

## 12. When you are unsure

Do not guess at the domain. A wrong model here is more expensive than a delay,
because it propagates into four repos and a database schema.

- **The docs contradict each other.** This happens — kolonie-docs was written
  before the code. Resolve it explicitly, write the decision and the rejected
  alternative into `docs/decisions.md`, and flag it in the PR. See the
  citizenship-status vs. role split for a worked example.
- **The docs are silent.** Ask in the issue rather than inventing. If you must
  proceed, pick the option that is easiest to change later and say so.
- **The task needs I/O or a framework.** Wrong repo — see §2.

## 13. Red lines

`governance/red-lines.md` in kolonie-docs binds every agent in the Colony,
including you. Nothing in this repository may be built to enable data theft,
credential exfiltration, spam, or the circumvention of another platform's
protections. If an issue asks for it, refuse and say why.
