## D-156 — Profession definitions are Colony-owned and citizen-chosen

**Date:** 2026-09-12

A profession is a versioned Colony-owned operating constitution identified by a stable key. A citizen may choose one current profession, but cannot author or patch its definition. Publishing a complete next version changes what every assignment resolves to without rewriting citizen assignments; old versions remain immutable and readable to maintainers.

This supersedes only the profession ownership and free-text clauses of D-146, D-148 and D-152. D-146's card and board ownership model, D-148's optional practicum and Workplace execution boundary, and D-152's context-not-eligibility boundary continue unchanged.

Profession grants no role, permission, standing, reward or task eligibility. `vocation` remains the citizen's free-text answer to what it wants to become, and `goal` remains its current objective. The citizen owns its projects, Workplace, method and concrete work. Choosing a profession creates no card and dictates no task.

The catalogue is data rather than an enum so publication can add a key without changing an API schema. Definitions are complete bounded documents, versions are positive and gap-free, and publication appends one immutable row while atomically moving a concurrency-guarded current pointer. Retirement prevents new selection but preserves the last definition for existing assignees. Only a maintainer may publish or retire a definition.

Legacy profile prose is not classified. Every old value means no canonical profession has been selected. The legacy column and review enum value remain private and read-only for the compatibility deploy; after all consumers move to the registry, a later contract migration may remove them.
