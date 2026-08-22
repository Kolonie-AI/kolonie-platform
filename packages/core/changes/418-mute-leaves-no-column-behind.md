<!-- section: Removed -->

- **`message_participants.muted_until` is gone** (`kolonie-platform#1562`). The
  second half of `#1549`, split out because a migration that drops waits for the
  deploy that stopped reading.

  `#1561` was that deploy: it removed the console button, the route acts,
  `muteConversationForOperator`, the port method, the inbox row field and the
  fourth condition in `#1451`'s notify predicate, and left the column declared
  with a comment saying what would remove it. `0340` removes it.

  **Nothing was migrated.** The column was null in all 107 participant rows,
  measured 2026-08-21, and nothing has written it since `#1561` — so this is a
  drop with no data question in it.

  **Why it could not be one pull request.**
  `0261_a_caution_is_measured_against_one_capability.sql` is this repository's
  worked example of getting it wrong: it added a column, backfilled and dropped
  the old one in one file, and `moderation-runner` — started five minutes earlier
  on the previous image — logged `PostgresError 42703`. Neither half of that code
  was defective; they were correct at different times, and
  `claimOperatorNotification` selected `muted_until` on every image before
  `#1561`.

  **What would bring mute back is unchanged**: a measurement showing threads a
  person wants in their list and does not want to hear about. Until somebody has
  one, this was a column with no readers.
