## D-125 — The drop and the handover are views onto a slot, and the episode-less slot hangs off an agent rather than off a thread

**Date:** 2026-08-18

**Problem.** A secret passing between an agent and its operator lived in three
tables — `operator_drops` (operator → agent, `#236`), `agent_handovers`
(agent → operator, `#592`) and `account_slots` (both directions, hanging off an
account episode, `#931`). Three tables meant three destruction rules for one kind
of thing, and `#955` recorded that two of the three had already been found
letting a secret outlive its purpose. One rule is a safety property; three are a
surface.

**Decision.** `account_slots` carries all three. A drop is a slot with
`channel = 'drop'` and a handover one with `channel = 'handover'`; the two
storage modules are views onto that table and **every exported signature is
unchanged**. `packages/db` is the only place that knew which table these rows
were in, so nothing above it moved.

**The slot with no episode hangs off `agent_id`, not off a thread.** `#955`
proposed the thread as the owner with `episode_id` nullable. That does not hold:
a thread belongs to an _account_, and a drop is opened against a provider and a
step before any account exists — a handover carries a provider name and nothing
else. Hanging it off a thread would need an account nobody has yet, which is the
same manufactured history the issue rejected one level up when it ruled out
inventing an episode. So `account_slots` gained a nullable `agent_id`, and
`account_slots_owner` makes the two shapes exclusive: a slot has an episode or an
agent, never both and never neither.

**Rejected: a hard cutover.** `operator_drops` and `agent_handovers` stay in
place, unread, for a deploy cycle. Rollback is then a revert rather than a
recovery. Dropping them is a later change with its own entry — a migration that
both moves and destroys has no step you can stop at.

**Rejected: letting the backfill mint new ids.** A sealed value is AES-256-GCM
whose associated data is the agent id and a scope that embeds the row's own id
(`operator-drop:<id>`, `agent-handover:<id>`). A ciphertext that lands on a row
with a different id opens as nothing, and a plain-SQL migration holds no sealing
key with which to re-seal one. So `0295_melted_shaman.sql` inserts each source
row **with its own id**: the id travels with the value or the value is lost.

**Consequence for the proof.** `#955` asks that the existing tests pass
unchanged, and that is what happened to every assertion — but two of the three
files name the old tables directly as instruments, to age a row, burn its
attempt counter, or see what a database dump would yield. Those lines are
repointed at `account_slots` behind a single aliasing helper per file
(`sealed_value` is `value`, `submitted_at` is `filled_at`, `read_at` is
`taken_at`), so the assertions themselves are byte-identical.

**One assertion had to be rewritten, and it is the one worth knowing about.**
`agent_handovers` had no `token_hash` column, and the handover test asserted the
_absence of the column_ to prove no bearer link could reach a handover. The
merged table has one, because the drop is reached by a mailed link. The property
is unchanged — `viewDrop` narrows on `channel = 'drop'` before it looks at a
token, and no handover function takes one — so the test now asserts it directly:
the row's channel is `handover` and its token hash is null. A guarantee that was
being inferred from a table's shape is now stated.

**What would reverse this**: a slot needing to belong to two owners at once, or
the drop and the handover growing destruction rules that genuinely differ — at
which point one table is holding two things again and the merge has bought
nothing.
