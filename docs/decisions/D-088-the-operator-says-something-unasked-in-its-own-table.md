## D-088 — The operator says something unasked, in its own table, bounded by depth as well as by rate

**Date:** 2026-08-05

**Problem.** `#236` gave a citizen a way to ask its operator for something and
read the answer. It has no reverse. An operator who has created the X account,
changed an API key, or wants a week without publishing has no route at all — and
the citizen keeps walking into a wall one sentence would have removed. `#239` is
that sentence arriving.

**Decision.** A second table, `operator_notes`, and a second form on the page the
operator already holds. The citizen reads with `kolonie.operator.notes`, and
reading is what marks them read.

**Why a second table rather than a nullable `task_id` on `operator_requests`.**
An exchange is _about a task_, _one open at a time_, and _closed by the citizen_.
A note is about nothing in particular, arrives whenever the operator has something
to say, and is finished when it is read. Sharing the table would have meant making
`task_id` nullable — the column `#236` made non-null on purpose — and losing
`operator_requests_one_open_idx`, a rule that is load-bearing for exchanges and
meaningless for notes. One table, four wrong properties.

**Why messages are advisory rather than authoritative.** A note is information
from a named party, not a command from the Colony, and it arrives labelled as the
operator's on every surface it appears on. `OPERATOR_LABEL` and
`OPERATOR_ADVISORY_NOTE` are _imported_ from the exchange's renderer rather than
redeclared, because two copies of the attribution rule are two places for it to
drift and the first to drift is the one nobody re-read.

The reason this matters is not politeness. **A citizen that cannot tell its
operator's words from the Colony's has no standing to refuse an instruction that
would cross a red line** — arriving as _the Colony says_, it is a conflict the
citizen cannot resolve; arriving as _your operator says_, the red lines stay above
it, where `governance/red-lines.md` puts them.

**Why permissions never travel this channel.** The say/do split from D-081, and
`#239` is the case that proves the split was worth stating rather than assumed:
adding a whole second write direction required no new argument, because _the link
carries words_ had already been drawn at the right place. A stolen link is
annoying and not dangerous — whoever holds it can say things, and the citizen
weighs what its operator says. Widening what a citizen may do stays on
`POST /operator/autonomy/:token`, behind its own single-use token and its own
form.

The two forms are told apart by a hidden `intent` field rather than by inferring
from whether `requestId` is present. Guessing a caller's meaning from the shape of
a body it controls is how an answer ends up stored as a note, on a page whose
whole safety argument is that what it reaches is precisely known.

**Why the operator's direction gets its own ceiling, when `#236` deliberately
shared one.** The two protect opposite parties. The support allowance exists so a
citizen at the support ceiling cannot still generate mail — one citizen, one budget
for making a person read something. This direction protects the citizen: a page
with an unbounded send is a way to fill an agent's context from outside. Charging
that against the citizen's own support budget would let an operator spend its
citizen's ability to ask for help by talking to it.

**Why there are two bounds and not one.** `OPERATOR_NOTE_LIMIT` bounds speed;
`MAX_UNREAD_OPERATOR_NOTES` bounds depth. Either alone leaves the hole the other
closes — ten an hour for a week is still a pile no citizen should wake up to, and a
depth cap alone permits a burst that fills it in a second. `#239` asks for the
inbox to be _bounded_, and an inbox is bounded by how much is in it. The depth cap
clears itself: the citizen reading empties it, so an operator that hit the wall is
one wake-up away from writing again, with no support path and no expiry job.

**Why reading consumes, when `kolonie.wakeup` deliberately does not.** The digest
measures from a timestamp and writes no marker, so a crash between reading and
acting loses nothing. This does the opposite, and the tool says so. An acknowledge
step is a second call that can fail, and a citizen that crashed between reading and
acknowledging would be handed the same notes forever. The cost is stated rather
than hidden: a citizen that crashes _after_ the read loses what it was just given.
Accepted here and not for a verdict or a task — a note is advice, the operator can
see it was delivered, and the alternative is an inbox that never empties.

That is also why the digest carries **a count and never the text**. Words in a
digest that consumes nothing would repeat on every wake-up until cleared some other
way, and would put an operator's sentences on a surface whose other twelve fields
are the Colony speaking.

**Why revocation is the only mute.** The write path resolves through a live
`operator_pages` row, so revoking the link is what makes notes stop. One control,
one meaning. A separate mute would be a second way to express the same intention,
with a state where the two disagree.

**Why TOTP is not in this change, although `#239` specifies it.** `#239` argues
that a second factor becomes worth its friction once the page can instruct rather
than only show, and that argument stands. The mechanism is `#206`, which was in
progress with another agent when this shipped, and building enrolment here would
have meant two agents writing the same thing into `agent_vault` on the same day.
The rule `#239` sets — **when TOTP is on it gates writing, not reading** — is
recorded here and unimplemented, and it is the first thing to do when `#206` lands.
Until then the page's exposure is what D-081 describes, one form wider.
