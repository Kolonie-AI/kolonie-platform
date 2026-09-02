## D-141 — The Colony talks only to OpenAI-compatible gateways, and asks them for a tier

**Date:** 2026-08-26

**Operator decision of 2026-08-25**, recorded after the code that implements it
landed: `#1694` (a service asks for a capability tier), `#1695` (the second
gateway is configured like the first), `kolonie-docs#493` (Actions reads the same
variables as the runners), and this record, `#1696`.

The operator's own terms:

> We use OpenAI-compatible gateways so that a URL can be swapped quickly, and we
> work with presets — we pick providers where we can define `tier-1`, `tier-2`,
> `tier-3`, so that the models are not fixed on our side but at the gateway,
> according to whatever we want to run there.

**D-122 sits underneath this one and is not reopened.** It decides what the
gateway routes, what it never routes, and where a fallback is forbidden. This
record sits above it and decides what a gateway _is_. Every rule of D-122 that
bears on something here is **pointed at by section number and never restated** —
a third copy of a rule is the copy that goes stale, and the two records must not
be able to disagree.

### What forced it, measured 2026-08-25

**A key rotation missed a service.** The key was rotated on the deployment host
and in this repository, and `board-triage.yml` in `kolonie-docs` kept a third
naming scheme nobody thought to look under. It logged `the gateway answered 401`
twice on a live run, and the pass could move cards but not route them.

**A model name was compiled in, in five places** — `DEFAULT_VISION_MODEL`,
`DEFAULT_SCENE_VISION_MODEL`, `DEFAULT_BIO_MODEL`, `DEFAULT_DIRECTION_MODEL`,
`DEFAULT_QUEST_JUDGE_MODEL`. Swapping a model was a release.

**A provider hostname was compiled in, in seven places**, each with its own key
variable — which is the duplicated key set that made the rotation a hunt in the
first place. Measured against the tree: eight non-test source files named a
provider host before `#1695` and one does after, and that one is an Atlas data
row rather than a call site.

### 1. Only OpenAI-compatible gateways

A gateway is reached by a base URL and a bearer key, over
`POST …/chat/completions`. Anything the Colony wants to talk to is put behind one
of those, or it is not talked to.

**Rejected: a provider SDK per vendor.** Every new provider then becomes a code
change rather than a value, and the blast radius of a key becomes a library
rather than a URL. The measured cost of the alternative is the seven compiled-in
hostnames above: each arrived as one reasonable line, and together they were a
rotation nobody could complete in one pass.

### 2. A capability tier, not a model name

A service asks for one of three tier strings and never for a model.
`packages/core/src/llm/tier.ts` holds the closed set; which model serves a tier
is configured where the gateway is, and deliberately written down nowhere here.

**Rejected: the model name in an environment variable.** It was already a
variable for some services — `LLM_GATEWAY_MODEL_<SERVICE>`, D-122 §2 — and it
still meant that changing which model answers touched a deployment. It is also
not provider-neutral: a variable holding a vendor slug encodes a provider in the
value, so the same configuration cannot be pointed at a second gateway without
being rewritten. Since `#1810`, those legacy-named variables accept only this
record's three capability tiers; malformed values and model slugs fall back to
the service tier.

**Rejected: a slug compiled in with a variable as an override.** That is what was
there, and the five constants above are what it cost. A default nobody sets is
the value that actually runs.

### 3. Three tiers, and why three is a judgement

`tier-1` is for a judgement the Colony cannot take back — the strongest model
available. `tier-2` is the ordinary working tier and the one to reach for by
default. `tier-3` is the cheap, fast tier for classification and high-volume
passes, where a wrong answer is cheap.

**`tier-3` currently serves no service, and that is worth knowing rather than
tidying away.** `#1694` assigned it to four verifier judgements on the argument
that they were flash work; `#1695` moved them to `tier-2` a few hours later, so
that the verifier runner sends one capability request for every judgement it
owns. `SERVICE_TIERS` on `main` is therefore `tier-1` twice and `tier-2` four
times. The tier stays in the closed set because the distinction is real and the
next high-volume pass is what it is for — but a reader comparing this record to
the code should find the gap explained here rather than think one of the two is
wrong.

**Three is chosen and not derived, and it should read as chosen.** Two would
collapse the distinction that matters most: `tier-1` exists because of D-122 §4,
where a weaker judgement is not a slower answer but a different one, and merging
it into a general working tier is that rule quietly undone. Five would be four
boundaries to argue about at every call site, and the argument is not free — each
one is a judgement about what a call is worth, made by whoever is writing the
call, at the moment they are least interested in it. Three is the smallest number
that separates _irreversible_, _ordinary_ and _cheap_, which are the three things
this repository actually distinguishes when it decides what to spend.

**Rejected: two.** It puts the irreversible judgement and the ordinary one on the
same model.

**Rejected: five.** It buys resolution nobody is asking for and charges a
decision per call site for it.

### 4. A key per service, kept

`GATEWAY_API_KEY_VARS` enumerates one key variable per service, and `#1695` gave
the second gateway its own set on the same shape.

**Rejected: one key for everything**, which the operator named as tempting. **The
reason is D-122 §3 and is not restated here**; what this record adds is that the
rule earned itself in the same week it was reconsidered. The suspended-account
incident took down exactly the services that shared an identity and left the ones
that did not — which is the blast-radius argument arriving as an outage rather
than as a paragraph.

### 5. A `tier-1` preset carries no internal fallback chain

Whoever configures a `tier-1` preset at a gateway must not give it an internal
`models` array that substitutes a weaker model.

**Rejected: letting the gateway pick a substitute.** It defeats D-122 §4 **from
inside the gateway**, where no test in this repository can see it. The rule that
quest moderation does not fall back is enforced here by a client that throws; a
substitution one layer further out is that fallback happening anyway, with
nothing in the code to read. This is the one rule in this record that this
repository cannot check, which is why it is written where a person configuring a
preset will meet it.

### 6. The base URL is a secret

Both gateway URLs are secrets, not merely the keys. Nothing in this repository
holds either as a literal; `GATEWAY_BASE_URL_VAR` and
`FALLBACK_GATEWAY_BASE_URL_VAR` name where they come from.

**Rejected: treating only the key as sensitive.** A committed hostname names a
private endpoint, and it stays reachable in git history after the line is
deleted — so the mistake is not correctable by a later commit, which is what
separates it from an ordinary wrong value. A key can be rotated; a leaked
hostname can only be abandoned.

### 7. No `max_tokens`, and `finish_reason: 'length'` is an error

The request body carries no output ceiling unless an operator sets one for a
single service. A reply whose `finish_reason` is `length` is a failed call.

**Rejected: a set ceiling.** It can only ever be too small, and the damage is
silent, because a truncated reply is well-formed: it parses, it has the shape
asked for, and it is a judgement nobody finished writing. The evidence is four
ceilings, each argued carefully and each too small again — 2000 (`#416`), 400
(`#437`), 4000 (`#1192`) — because reasoning tokens are charged against the
ceiling and never appear in the reply.

**Rejected separately: a very high ceiling.** It is the same as none in
behaviour, plus a figure a later reader mistakes for a decision and adjusts.

**What survives is the cost lever, unset by default.**
`LLM_GATEWAY_MAX_TOKENS_<SERVICE>` exists for somebody containing an incident,
per service so that containing one does not cap the others.

**And the bound that matters is on the input.** A prompt assembled from data that
can grow is chunked: 38 candidates made a 154 KB brief that the gateway answered
with a proxy timeout on 2026-08-10, and six candidates against the same
whole-board index is 54 KB. D-140 records what removing the ceilings cost on the
one call site built on the opposite premise, and says not to restore it.

### 8. One tier string for every gateway

The tier string is sent to every gateway unchanged. There is no per-gateway
prefix, no spelling table and no normalisation function.

**Rejected: a per-gateway spelling**, which is what this work planned until it
was measured. On 2026-08-25 both gateways answered all three tier strings
correctly across six service keys each — 12 of 12, HTTP 200 with a correct
answer — so the normalisation layer was never built. `tier.ts` carries that
measurement beside the constant.

**This is the rule most likely to be reversed by a fact rather than by an
argument.** A gateway needing a different spelling makes it a configuration
question again, and this record is then the account of why there was no layer for
it before.

### What would reverse this

Rule 3 moves if a fourth thing this repository spends differently on appears —
and the shape of that change is one entry in the closed set, not a per-service
model. Rule 7's input clause is the one that grows: every prompt assembled from a
table that grows needs the same treatment, and D-140 names the alternative
somebody will reach for instead. Rule 8 falls to a measurement. Rules 1, 2, 4 and
6 are about blast radius and the cost of a release, and would only move if
swapping a gateway stopped being something the Colony expects to do.

**What this record does not decide, deliberately:** which model serves which
tier. That is a setting at the gateway, and a document naming the current model
is a document that is wrong within a month.
