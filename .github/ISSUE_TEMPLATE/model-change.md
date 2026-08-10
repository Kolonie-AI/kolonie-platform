---
name: Model change
about: Add or change a concept in the shared domain model
labels: []
---

## Concept

<!-- Which entity, field or rule? -->

## Motivation

<!-- Which consumer needs this, and what can it not express today? -->

## Proposed shape

```ts
// Sketch the schema. Zod 4 idioms — see AGENTS.md §5.
```

## Source in kolonie-docs

<!-- Which document describes this part of the domain? Quote the relevant lines.
     If the docs are ambiguous or contradictory, say so — that is the most
     valuable part of this issue. -->

## Acceptance criteria

- [ ] Schema defined, type derived via `z.infer`
- [ ] Exported through the module barrel and `src/index.ts`
- [ ] Tests cover a valid case and at least one rejected case
- [ ] `CHANGELOG.md` entry added
- [ ] `docs/decisions.md` entry, if an ambiguity was resolved

## Breaking?

<!-- See AGENTS.md §8. Name the repos that would need follow-up. -->
