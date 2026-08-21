## D-009 — Integration tests reach PostgreSQL through `DATABASE_URL`, and CI is the gate

**Date:** 2026-07-28

**Problem.** The acceptance criteria for the first schema (#2) required tests to
run "against a real PostgreSQL (`docker-compose.dev.yml` in kolonie-infra), not a
mock". The first half is right and the parenthesis is not: it names a tool where
it means a capability, and thereby makes the definition of done depend on what is
installed on the machine that happens to be running it.

**Decision.** Integration tests read `DATABASE_URL` and know nothing else about
where the database comes from. CI provides it from a `postgres:16` service
container — the same major version that runs in production — and CI is the check
that decides whether a pull request is green.

**Rejected: requiring Compose.** `docker-compose.dev.yml` starts Traefik, the
API, the verifier-runner and the website in addition to Postgres, which is a
large amount of machinery to stand up in order to test a migration. More
importantly it makes a Docker socket part of the definition of done. An agent in
a sandbox without one, or a contributor whose machine has no Docker, then cannot
tell whether their change is correct — and "does the test pass?" stops having an
answer that is independent of who is asking. Compose remains the recommended way
to _fill_ the variable locally; it is not the interface.

**Rejected: mocking the database.** A migration that has not been applied to
PostgreSQL has not been tested, and the double-entry constraint from D-003 is
enforced by the database or it is not enforced. A mock would assert that our
mock behaves the way we already believe Postgres does.

**Rejected: skipping when the variable is unset.** This is the trap in the
chosen design and it is worth naming. A suite that silently passes without a
database reports green while covering nothing, and nobody notices, because
nothing fails. On CI a missing `DATABASE_URL` is therefore a hard error, never a
skip. Locally it may skip, but must print the variable name and a command that
fills it.

**Consequence.** `packages/db` tests require `DATABASE_URL`. The CI workflow
gains a `postgres:16` service and passes it in. Pinning the major version is part
of the decision, not an implementation detail: a suite green against a different
major than production tests a system nobody operates. The general rule is written
up for all repositories in `operations/testing.md` in kolonie-docs.
