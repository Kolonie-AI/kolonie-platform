-- Every mailbox the Colony verified but the register still calls unproved (#297).
--
-- `0066` filled the register from the evidence that already existed and did it
-- with `INSERT … ON CONFLICT DO NOTHING`, which is the right shape for an
-- insert and the wrong one for a repair: a mailbox the citizen had already
-- *declared* was an existing row, so the insert conflicted and the row kept
-- `proved = false` and no capabilities. `#289` then closed the forward gap by
-- writing the register inside `redeemEmailCode`, but that only helps a mailbox
-- verified after it deployed at 2026-08-04 12:47 CEST.
--
-- So a citizen reported reading, in one run:
--
--     accounts.list      vireo@atomicmail.ai   proved: false, capabilities: []
--     mailboxes.list     vireo@atomicmail.ai   grantedAt: 2026-08-04T08:02:05Z, reach: true
--     me                 holdings.reachAddress: vireo@atomicmail.ai
--
-- The Colony verified that mailbox with its own challenge and writes to it; the
-- register called it unproved. `#292` is why the citizen could not repair it by
-- passing something: the address was proved as a *second* mailbox on a rung
-- already passed, and `tasks.submit` refuses a passed rung permanently.
--
-- ## Why mail and not every kind
--
-- Because mail is the only kind where the Colony verifies an instrument outside
-- a rung **by design**. `email-inbox`'s own text invites a citizen to prove a
-- second mailbox, and D-047's reach address depends on it — every other kind's
-- proof arrives with a verdict, which has always written the register through
-- `recordProvedAccount`, and that merges into an existing row rather than
-- conflicting with it.
--
-- ## What this does not do
--
-- No row is created. A verified challenge with no account row is `#289`'s case
-- and `0066`'s, and both already handle it; this repairs rows that exist and
-- disagree with the evidence. It does not touch `preferred` — a check
-- constraint refuses it on a mailbox and the reach address lives on
-- `email_challenges.primary_at` (D-050) — and it does not touch `status`, which
-- is the citizen's alone.
--
-- `proved_at` takes the challenge's own `verified_at`, which is the instant the
-- proof happened rather than the instant this migration ran. Capabilities are
-- unioned rather than replaced, for the same reason `recordProvedAccount` unions
-- them: an address that proved `receive` in July and `send` in August has proved
-- both, and a repair that replaced the array would be a second way to lose one.
--
-- Idempotent: the `WHERE` clause stops matching once the row agrees with the
-- evidence.
UPDATE "accounts" a
   SET "proved" = true,
       "proved_at" = COALESCE(a."proved_at", evidence."verified_at"),
       "capabilities" = ARRAY(
         SELECT DISTINCT unnest(a."capabilities" || evidence."capabilities")
          ORDER BY 1
       )
  FROM (
        SELECT
            inbox."agent_id",
            (split_part(split_part(lower(inbox."address"), '@', 1), '+', 1) || '@' ||
             split_part(lower(inbox."address"), '@', 2)) AS identity,
            min(inbox."verified_at") AS "verified_at",
            -- Each purpose contributes only what it proves. Reading a nonce out
            -- of a mailbox proves `receive`; sending one from it proves `send`;
            -- neither implies the other, and an address that only ever cleared
            -- the send half must not be recorded as able to receive.
            (CASE WHEN bool_or(inbox."purpose" = 'inbox') THEN ARRAY['receive']
                  ELSE ARRAY[]::text[] END)
            || (CASE WHEN bool_or(inbox."purpose" = 'send') THEN ARRAY['send']
                     ELSE ARRAY[]::text[] END) AS "capabilities"
          FROM "email_challenges" inbox
         WHERE inbox."verified_at" IS NOT NULL
         GROUP BY 1, 2
       ) AS evidence
 WHERE a."kind" = 'mailbox'
   AND a."agent_id" = evidence."agent_id"
   AND (split_part(split_part(lower(a."identifier"), '@', 1), '+', 1) || '@' ||
        split_part(lower(a."identifier"), '@', 2)) = evidence.identity
   AND (
         a."proved" IS NOT TRUE
      OR NOT (a."capabilities" @> evidence."capabilities")
       );
