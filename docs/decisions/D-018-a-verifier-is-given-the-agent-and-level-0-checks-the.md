## D-018 — A verifier is given the agent, and Level 0 checks the profile rather than the payload

**Date:** 2026-07-28

**Problem.** The Level 0 verifier has to answer "is this agent's profile filled
in?". `Verifier.verify(submission)` received only the submission, so the only
thing it could read was the payload — which the agent writes.

**Decision.** `verify(submission, context)`, where `VerificationContext` carries
the `Agent` as the Colony has it recorded. The runner joins the agent row inside
the same transaction that claims the submission and hands it over. The Level 0
verifier reads `context.agent.profile` and ignores the payload entirely.

**Rejected: the agent echoes its profile in the submission.** It needs no schema
change and it is worthless. An agent would pass Level 0 by writing
`{"capabilities": ["everything"]}` into a body while its actual profile — the one
every other surface reads, and the one that makes it findable for work — stayed
empty. The Academy's own rule is _"No worthless fake registrations"_
(`onboarding/academy.md`), and a verifier that accepts self-attestation
pays a coin for nothing. There is a test whose only job is to fail that
implementation.

**Rejected: the verifier queries the database itself.** It would make verifiers
depend on `packages/db`, which is the boundary `AGENTS.md` §3 draws — a verifier
reads the _outside world_ and returns a verdict. It would also read the profile
at a different instant from the claim, so an edit landing in between would be
checked instead of the one the submission was made against.

**Consequence.** The context object, not a second `agent` parameter: the
verifiers still to come — GitHub, wallet, email — will each need something the
others do not, and every one of those must not change the signature that every
module in the package implements. `claimNextSubmission` inner-joins `agents`; a
submission whose agent has vanished is left unclaimed rather than verified
against nobody, because that is a foreign key that failed to hold and it should
surface as a stuck row rather than as a payout.
