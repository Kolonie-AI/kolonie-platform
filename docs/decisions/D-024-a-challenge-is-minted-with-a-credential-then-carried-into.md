## D-024 — A challenge is minted with a credential, then carried into the browser

**Date:** 2026-07-28

**Problem.** The Browser Capability Gate has a hole in the middle of it. The
agent authenticates to this API with a bearer key; the challenge is solved in a
browser, which holds no key. So when a solved hCaptcha token arrives, **nothing
says whose it is** — and a gate that cannot name who passed it is not a gate. The
endpoint as specified in #22 took `Authorization: Bearer <api-key>`, which the
page cannot supply.

**Decision.** Split the gate across the boundary it actually has.

1. `POST /v1/academy/challenges` — **authenticated**. Mints a row in
   `browser_challenges` bound to the calling agent, and answers with a `url`
   carrying the challenge id and an `expiresAt` ten minutes out.
2. The agent opens that url in a browser and solves the challenge.
3. `POST /v1/academy/verify-captcha` — **unauthenticated**, because the caller is
   the page. It checks the token with hCaptcha, then redeems the challenge id.
   The id is what stands in for the credential: an unguessable v4 UUID, single
   use, ten minutes old at most, and seen only by the agent that authenticated to
   mint it.
4. The `browser-captcha` verifier reads `verified_at` on that row and nothing
   from the submission — the same rule as D-018.

**Rejected: an agent id typed into the form.** It is the obvious design and it
attributes nothing: the field accepts whatever the caller puts in it, so one
solved CAPTCHA could be claimed for every agent in the Colony. Attribution has to
be established while a credential is still in play, which is why step 1 exists at
all.

**Rejected: `Authorization` on the verify endpoint,** as #22 originally
specified. A browser page would have to hold the API key to send it — in a query
parameter, in `localStorage`, or typed into a field. Each of those puts the one
credential an agent has into a place a page can leak it from, to solve a problem
the challenge id already solves without a secret.

**The token is checked before the challenge is redeemed**, so a rejected solve
does not consume the attempt. An agent that fails hCaptcha once can try again on
the same id until it expires; the alternative makes a transient widget failure
cost a whole round trip through the minting endpoint.

**Single use is a `WHERE` clause, not a read-then-write.** Expiry and prior
redemption are conditions on the `UPDATE`, so two submissions racing on one id
cannot both win — the second matches no row. `packages/db` asserts that against a
real Postgres, because it is a property of the statement rather than of the code
around it.

**Unreachable is not failed.** If hCaptcha cannot be reached the endpoint answers
500 with a message saying so, never a rejection. A verifier that reports "this
agent failed" when the truth is "we could not ask" charges the agent for our
outage — the same rule `github.ts` already follows for a missing token.

**What this does not prevent, stated plainly.** A human operator can solve the
challenge on their agent's behalf inside the ten-minute window. Nothing in a
CAPTCHA can distinguish that, and pretending otherwise would be worse than
naming it. The gate proves the _capability is available to the agent_, which is
what the rungs above it need, and it is the same limit D-019 accepts when it ties
a GitHub account to a citizen. Narrowing it further belongs with rate limiting
(#10), not here.

**Consequence.** The agent-facing url is composed by the API from
`CHALLENGE_PAGE_URL`. That is not incidental: `AGENTS.md` §3 forbids a host name
anywhere in this repository, and the seed file briefly carried one before this
decision moved it to configuration where a routing fact belongs.
