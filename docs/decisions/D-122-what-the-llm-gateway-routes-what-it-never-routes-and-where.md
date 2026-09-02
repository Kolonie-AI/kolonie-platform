## D-122 — What the LLM gateway routes, what it never routes, and where a fallback is forbidden

**2026-08-14 · kolonie-platform#782 · the rules of `#674`, `#693`, `#726`, `#728`**

The gateway wraps a CLI subscription and sits under an injectable `fetch`
(`packages/core/src/llm/gateway.ts`). How it does that is documented there. What
follows is the half a code comment cannot hold: the alternative each rule was
chosen over, so that a later reader can check the choice instead of only finding it.

### 1. Embeddings never route, and that is permanent

**The gateway has no `/embeddings` endpoint — it answers 404.** So
`moderation-runner`'s briefing synthesis reaches OpenRouter directly, and always
will. This is a fact about the product behind the gateway, not a policy of ours,
which is why it is not a flag: `gatewayRequest` routes only
`POST …/chat/completions` and hands everything else to the underlying transport
untouched (`gateway.ts:431`). A path check cannot be switched on by somebody who
has not read this entry.

Measured over the seven days to 2026-08-12: `text-embedding-3-small`, 23 calls,
all on OpenRouter, all correct.

**Written down because the correct state looks exactly like the defect.** Anybody
reading _23 calls a week bypassing the gateway_ sees the same shape as a routing
bug, and the obvious fix — teach `gatewayRequest` about `/embeddings` — turns 23
working calls into 23 404s. The exclusion is only safe while it is legible.

**Rejected: an `LLM_GATEWAY_ROUTE_EMBEDDINGS` flag.** A flag says the answer could
be either. It cannot: there is nothing at the other end.

### 2. The capability tier is per service, not global

`LLM_GATEWAY_MODEL_<SERVICE>` overrides `LLM_GATEWAY_MODEL` for one service, and
is resolved by the same service token that picks the API key (`#726`). Both
variables accept only the closed capability tiers from D-141; an invalid value
is skipped, and the service's `SERVICE_TIERS` assignment is the final default.

**Rejected: letting either variable name a provider model** (`#1810`). It makes
the gateway preset cease to own model selection and sends the same stale slug to
both gateways. Keeping only canonical tier overrides preserves incident steering
without restoring provider-specific deployment configuration.

**Rejected: the single `LLM_GATEWAY_MODEL` that came first.** It was right while
one service used the gateway and wrong the moment two wanted different tiers —
moderation judges quests on the strongest tier the Colony has, because since
`#693` that verdict _is_ the publication, while the verifier reads images and
has different capability and cost needs.

**Rejected: a second list of services for models.** One list, one compile error
when a service is in one place and not the other, instead of a variable nothing
reads.

### 3. One API key per service

Five names in `GATEWAY_API_KEY_VARS`, enumerated in one place because they have
to match what is installed on the deployment.

**Rejected: one key for everything.** A runaway loop in one service would be
billed, capped and revoked together with the rest — so the moderation queue stops
because a verifier misbehaved. Separate keys also make _whose traffic is this_
answerable at the gateway rather than only in our own logs.

**Rejected, specifically, reusing triage's key for the Doctor** (`#840`): a
sentence per new finding across the whole Colony is a different volume and a
different blast radius from a support queue, and the two must not share a cap.

### 4. A decision the Colony cannot take back does not fall back

Quest moderation uses `gatewayOnlyFetch`, which throws where `gatewayRoutedFetch`
replays. The quest stays `pending_review` for the next tick.

**Rejected: the uniform fallback every other stage has** — and this is the rule
most likely to be re-litigated by somebody making fallbacks consistent. Since
`#693` a quest that clears moderation is published by that verdict, and the
fallback model is a flash model, so _when the good model is down, publish paid
work judged by the weaker one_ was what uniformity actually composed into. Being
served late by a weaker model beats not being served at all — true of moderating
an answer, false of publishing paid work.

### 5. The fallback is a property of the `fetch`, not a flag on a call

Two clients, `gatewayRoutedFetch` and `gatewayOnlyFetch`; a caller that wants both
behaviours holds both.

**Rejected: one client with a per-call `fallback: false`.** The routing sits
underneath ten call sites in four services, each with its own error vocabulary
built out of several incidents. A per-call option puts the irreversibility
judgement at the call site, where it is one keyword away from being wrong by
omission; a client makes it a decision taken once, where it is read.

### What would reverse this

Rule 1 falls the day the product behind `LLM_GATEWAY_BASE_URL` serves embeddings
— then it becomes an ordinary routing question and this entry is the record of
why it was not one before. Rule 4 falls if quest publication stops being
implied by the moderation verdict; nothing else in it is about the models.
Rules 2, 3 and 5 are about blast radius and would only move if the set of
services stopped being small enough to enumerate.
