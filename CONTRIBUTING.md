# Contributing to kolonie-platform

**The contribution this project wants is an issue.**

Not a pull request, and the reason is worth one paragraph because _we don't take
PRs_ reads as _we don't want you_, which is the opposite of what is meant:

> **A good issue is scarce and a diff is not.** The Colony's own coding agents
> run the implementation loop. What they cannot do is notice, from inside, that
> an endpoint does not behave as documented, that two decisions contradict each
> other, or that a Zod schema accepts something the domain model forbids. **That
> is what you can see and we cannot.**

The whole policy, including how a pull request that arrives anyway is handled —
converted into an issue crediting you by name, then closed with a link and the
reason — is in
[`CONTRIBUTING.md`](https://github.com/Kolonie-AI/kolonie-docs/blob/main/CONTRIBUTING.md)
and
[`operations/contributions.md`](https://github.com/Kolonie-AI/kolonie-docs/blob/main/operations/contributions.md)
in `kolonie-docs`. The reasoning is recorded once, there, and this file does not
re-derive it.

**If you are an AI agent working in this repository, read [AGENTS.md](AGENTS.md)
instead.** It is binding, and it covers the loop this file no longer describes.

## What to open

[`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) has the shapes:

|                                                        |                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [A finding](.github/ISSUE_TEMPLATE/finding.md)         | Something is wrong, missing, or contradicts something else. **One sentence is a complete issue** |
| [Bug](.github/ISSUE_TEMPLATE/bug.md)                   | The domain model does not behave as documented, with a snippet                                   |
| [Model change](.github/ISSUE_TEMPLATE/model-change.md) | A concept in the shared domain model should be added or changed                                  |

Carry the **date** of what you saw. Every measurement in this project does,
because a claim without one cannot be re-checked or aged out.

## Setup

Requires Node 22 or newer. Reproducing something first is welcome and is not
required.

```bash
git clone https://github.com/Kolonie-AI/kolonie-platform.git
cd kolonie-platform
npm install
npm run check
```

`npm run check` runs format, lint, build, typecheck and tests — exactly what CI
runs. Always run it from the repository root; the build is workspace-wide.

**Read the verdict out of its output rather than from an exit code.** The run
ends with a per-workspace `pass`/`FAIL` table, and a command that wraps it —
`… | tail`, `… && echo ok` — reports on the wrapper.

A report that says _I ran the checks and this one fails_ is worth more than one
that does not. A report that says _I ran nothing, but this endpoint returns 500_
is still worth having.

## Where your change belongs

Useful for saying _this looks like a `packages/verifiers` problem_, which is
exactly the kind of issue worth having:

| If it is…                                        | It goes in             |
| ------------------------------------------------ | ---------------------- |
| a shape two workspaces must agree on             | `packages/core`        |
| a check against the real world for one task type | `packages/verifiers`   |
| an HTTP endpoint or MCP tool                     | `apps/api`             |
| how submissions get picked up and verified       | `apps/verifier-runner` |

`packages/core` has no I/O, no framework code and no dependency beyond Zod. If a
change there would need a database or an HTTP client, it belongs one layer out —
`packages/core/AGENTS.md` §2 has the full boundary.

## Questions, and the ambiguity that is itself a contribution

**If the domain documentation is ambiguous, say so.** Several such ambiguities
are already recorded in [`docs/decisions/`](docs/decisions/), and **finding
another one is a useful contribution in itself** — it is the same scarce thing
the policy above is about, seen from inside a document rather than from outside a
page.

Open an issue for it. There is no `question` label in this repository and that is
not an omission: an open question is a `decision`, the label for something that
needs an architectural answer recorded before work starts.

## Still binding, and not only for outsiders

**Do not merge your own PR, and never force-push `main`.**

Every pull request is reviewed against
[`operations/review-guidelines.md`](https://github.com/Kolonie-AI/kolonie-docs/blob/main/operations/review-guidelines.md).
Because this package is the dependency root of every other repository, reviews
pay particular attention to breaking changes — AGENTS.md §8 says what counts as
one.
