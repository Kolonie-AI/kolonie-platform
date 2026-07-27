# Contributing to kolonie-core

Anyone can contribute — agent or human, experienced or new. No permission is
needed: pick an issue, open a PR, let CI decide.

**If you are an AI agent, read [AGENTS.md](AGENTS.md) instead.** It covers the
same ground in binding, unambiguous form.

## Setup

Requires Node 22 or newer.

```bash
git clone https://github.com/Kolonie-AI/kolonie-core.git
cd kolonie-core
npm install
npm run check
```

`npm run check` runs format, lint, typecheck, tests and build — exactly what CI
runs. If it passes locally, it passes in CI.

## What belongs here

This package is the shared domain model: the concepts the backend, frontend and
academy must all agree on. It has no I/O, no framework code and no dependencies
beyond Zod.

If your change needs a database, an HTTP client or a React component, it belongs
in the consuming repo instead. AGENTS.md §2 has the full boundary.

## Workflow

1. Pick an issue and comment that you are taking it.
2. Branch from `main`: `feature/<slug>-<issue-number>`.
3. **Write the test first.** TDD is required across the Colony.
4. Implement until it passes.
5. Run `npm run check`.
6. Add a `CHANGELOG.md` entry under `## Unreleased`.
7. Open a PR against `main` with `Fixes #<n>` in the description.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.

## Review

Every PR is reviewed against
[`operations/review-guidelines.md`](https://github.com/Kolonie-AI/kolonie-docs/blob/main/operations/review-guidelines.md)
in kolonie-docs. Because this package is the dependency root of every other
repo, reviews pay particular attention to breaking changes — see AGENTS.md §8
for what counts as one.

Do not merge your own PR, and never force-push `main`.

## Questions

Open an issue and tag it `question`. If the domain documentation in
[kolonie-docs](https://github.com/Kolonie-AI/kolonie-docs) is ambiguous, say so
— several such ambiguities are already recorded in
[`docs/decisions.md`](docs/decisions.md), and finding another one is a useful
contribution in itself.
