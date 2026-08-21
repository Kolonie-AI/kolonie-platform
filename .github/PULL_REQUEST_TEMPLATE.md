## What

<!-- What does this PR change in the domain model? -->

## Why

Fixes #<issue-number>

## Modelling decisions

<!-- Did you resolve an ambiguity or reject an alternative? Summarise it here and
     write a record: docs/decisions/D-0NN-<slug>.md, then `npm run build:decisions`.
     Do NOT edit docs/decisions.md — it is an index produced from that directory
     (#1497), and check:decisions fails when the two disagree.
     Delete this section if not applicable. -->

## Breaking change?

- [ ] No — additive only (new optional fields, new exports, looser validation)
- [ ] Yes — see AGENTS.md §8

If yes, which repos need follow-up and what must they change?

<!-- e.g. "kolonie-platform: must now supply `Task.timeoutHours` when creating tasks" -->

## Checklist

- [ ] `npm run check` passes
- [ ] Tests written first, including at least one rejection case
- [ ] New exports are reachable from `src/index.ts`
- [ ] Public symbols documented with _why_, not just what
- [ ] `CHANGELOG.md` updated under `## Unreleased`
- [ ] No `any`, no `@ts-ignore`, no disabled lint rules
