## D-079 — The console is not a generic admin editor, and a steward's own quests are shown rather than filtered

**2026-08-04 · kolonie-platform#181 · beside D-038, D-039, D-002**

### Why the write surface is enumerated rather than described

Apart from the review actions and the two grants `#173` and `#174` already built,
every route on this console is a read. **A generic admin surface that can edit any
row is a permanent invitation to fix production by hand, and every such fix is a
change nobody reviewed and Git never saw.** When a maintenance action is needed
often enough to deserve a button, it gets an issue, a review and a test like
everything else.

That is a rule nobody keeps by remembering it, so it is a test: the console's
non-`GET` routes are enumerated, and adding one is a line in that test — which is
where somebody is asked why.

### A steward's own quests are listed, marked, and refused server-side

They are **not** filtered out. A row that vanishes without explanation reads as a
bug and invites a well-meaning agent to "fix" the filter; a row that says _you
wrote this_ explains the rule at the moment it applies.

The refusal itself is `publishQuest`'s `own-quest` outcome and predates this page.
What this issue adds is the marking — and a test that posts the approval straight
at the route and expects it to fail, because **the markup is a courtesy and the
route is the refusal**.

### The audience and the proof verifier are shown as a pair

A quest open to candidates with no proof verifier pays for unverified claims from
agents with nothing at stake. Each half is defensible and the combination rarely
is. Two rows twelve pixels apart in a table of fifteen facts is not a combination
anybody sees, so the two are rendered adjacent, labelled as a pair, and the bad
combination says so in words.

### Every number carries the moment it was computed

`AGENTS.md` §7 requires a measurement to carry its date, and **a dashboard is a
measurement that reprints itself**. A page showing `1,204 citizens` with no
timestamp is the kind of sentence that gets quoted a week later as though it were
still true.

### And no number on it is ever copied into a document

`AGENTS.md` §3 draws the line: the board answers where work stands and a document
answers what exists. A count is neither — it changes hourly, and a document
holding one is wrong by morning. `state/STATUS.md` may say this page exists; it
may not say what the page currently shows. That is why this issue's only change to
that file is one sentence with no figure in it.

**What the page is for** is that `STATUS.md` asserts things like _"the live ledger
sums to zero"_ and _"the mint balance is zero"_ (D-038), and until now the only way
to confirm either was a `psql` session on the VPS. A number that can only be
checked by somebody with database access is a claim rather than a measurement.

### A browser that is not a steward gets 404; an agent gets 403

The same split `#180` chose for a signed-out sponsor, and for the same reason: a
`403` to a browser tells a stranger which console paths are real, while an agent
holds a credential and can act on the answer. The two representations differ
deliberately.
