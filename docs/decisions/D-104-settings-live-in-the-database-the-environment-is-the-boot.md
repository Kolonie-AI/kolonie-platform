## D-104 — Settings live in the database, the environment is the boot default, and no secret ever crosses

**Date:** 2026-08-07 — `kolonie-platform#488`.

Every configurable value in the platform is an environment variable. Changing one
— a poll interval, a model name, a threshold — means editing the deploy host and
restarting a container. There is no settings table anywhere in
`packages/db/src/schema/`.

Some of those values are genuinely deploy contract and belong exactly where they
are. Others are things the maintainer wants to turn while watching what happens,
and for those a restart is the wrong unit of change. This decides which is which
and how a running process learns that one moved. It does **not** build the table;
`#489` is the surface, and the table arrives with it.

### What may live in the database

| Group          | Values today                                                                                | Why they move                                                   |
| -------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Runner cadence | `POLL_INTERVAL_MS`, `BRIEFING_INTERVAL_MS`, `ATTRIBUTION_INTERVAL_MS`, `REFUND_INTERVAL_MS` | Tuned against observed load, not decided at release             |
| Models         | `OPENROUTER_MODEL`, `TRIAGE_MODEL`, `SCENE_VISION_MODEL`, `OPENROUTER_EMBEDDING_MODEL`      | A model change is an operating decision and often an urgent one |
| Thresholds     | platform fee percent, the quest-audit disagreement threshold, `PERMISSION_AGGREGATE_FLOOR`  | Set by observation, adjusted after it                           |
| Switches       | whether registration is open, whether the quest audit is enforcing                          | Have to take effect now, not after a deploy                     |

### What may never, and this half is not negotiable

- **Every credential and token.** `CLOUDFLARE_EMAIL_SEND_TOKEN`,
  `TWILIO_API_KEY_SECRET`, `HCAPTCHA_SECRET`, `EMAIL_INBOUND_SECRET`,
  `DEPOSIT_WEBHOOK_SECRET`, `DATABASE_URL`. A secret readable through a web page
  is a secret with a new and much larger blast radius.
- **Anything `preflight_env()` checks.** `kolonie-infra#42` refuses a deploy whose
  host cannot supply a declared name, _before any container is recreated_, and the
  images declare those names in `ai.kolonie.required-env`. A value the deploy
  checks for and the process then reads from somewhere else makes that check a
  formality.
- **`PORT`, `HEALTH_PORT`.** Read before the process can reach a database.

**The exclusion is a property of the code, not a rule on a page.** A settings
table whose safety depends on nobody adding the wrong row is not safe. Only names
in an explicit allow-list are readable or writable through the settings path, and
a name absent from it is not "not yet supported" — it is refused. That inverts the
usual direction deliberately: forgetting to _add_ a tunable is a minor
inconvenience discovered immediately, and forgetting to _exclude_ a secret is
discovered by somebody else.

### 1. Precedence — the database wins, the environment is the boot default

A row that does not exist means the variable's value, so a deployment that has
never written a setting behaves exactly as it does today, and the first write is
what starts overriding.

**The page must show, per value, which of the two is in effect.** Without that
line the commonest failure is a maintainer editing a setting that a variable is
quietly winning against — except that under this rule the variable never wins,
which is precisely why the line is still required: a maintainer needs to see that
a value is _still_ the environment's before concluding their change did nothing.

**Rejected: the environment wins.** It makes the database a suggestion, and a
suggestion is not something anybody can act on during an incident. It also has
the worse failure mode of the two — a change accepted, recorded, audited, and
inert.

### 2. Audit — every write is an `authority_events` row

On the argument that table already makes: _"a permission is not [derivable] — a
steward granting another steward leaves nothing behind but the changed array"_. A
setting is the same shape: the value says what it is now and nothing about who
decided that or when. `#485` added `subject_human_id`, which is what a
maintainer's write needs.

**A write that could not be recorded is a write that does not happen** — the two
commit together, as `recordAuthorityEvent` requires.

### 3. Reaching a running process — read per use, with one bounded cache

The genuinely hard part. A runner that read its interval once at startup does not
learn that a row changed.

**The rule: a setting is read at the point of use, through a cache with a stated
maximum staleness of 30 seconds.** Not _eventually_, which is not a property
anybody can rely on during an incident — a number, so a maintainer flipping a
switch knows what they are waiting for and when to conclude something is wrong.

**Rejected: read at startup.** It is what exists today and is the thing being
fixed.

**Rejected: uncached per-use reads.** A poll loop reading its own interval from
Postgres every iteration adds a query to the hottest path in the system to serve
a value that changes a few times a year.

**Rejected: applied at the next loop.** For an interval that is nearly the same
thing; for a _switch_ it is unbounded, because the next loop of a paused runner
may never come — and a switch is the category with the most urgency in it.

**The cadence values are the one exception and they are read at the top of each
loop rather than through the cache**, because a loop that has already slept for
its old interval cannot un-sleep. The bound there is therefore one interval
rather than 30 seconds, and that is stated on the setting rather than left for
somebody to discover.

### What would reverse this

A second process needing a setting on a path where 30 seconds of staleness is
too much — a payment gate, say. That would argue for a notification channel
(`LISTEN`/`NOTIFY`) rather than for changing the precedence, and it is worth
building when there is such a path rather than in anticipation of one.
