<!-- section: Removed -->

- **Mute is withdrawn, and this reverses a decision `#1449` shipped**
  (`kolonie-platform#1549`). `message_participants`, production, 2026-08-21: 53
  operator rows and 54 citizen rows, **107 participants, and not one of them had
  ever muted anything**.

  **Why it was specified, and why that was wrong.** `#1447` froze it as decision
  4 — _archive and mute are not the same thing, and folding them would mean a
  person who silenced a chatty thread also lost it from their list_. The
  distinction is logically clean. It is also answering a problem this system does
  not have: the case behind mute is _this thread keeps notifying me and I still
  want to see it_, which presupposes a flood, and `#1451` caps notifications at
  **one per thread per person per day**. There is no flood to silence.

  So the console showed two buttons beside every thread, of which one had never
  solved anything, and two controls where one will do is worse than one.

  Gone: the button on both surfaces, the mute write and the `mutedUntil` field on
  the inbox row, and the fourth condition in `#1451`'s notify predicate — which
  was never once false, so removing it loosens nothing.

  **`muted_until` is still there for one deploy.** AGENTS.md §3: a migration that
  drops waits for the deploy that stopped reading it, and `0261` is the worked
  example of getting that wrong. This is that deploy; the drop is a migration
  behind it, and nothing is migrated because the column is null in all 107 rows.

  **Archive is untouched and is the one that works** — `done_at`, per
  participant, cleared by a message from another party, invisible to the other
  side. All 53 operator rows archived within hours of getting it.

  **What would bring mute back**: a measurement showing threads a person wants in
  their list and does not want to hear about. That is the bar, and it is
  deliberately higher than the anecdote this was built on.
