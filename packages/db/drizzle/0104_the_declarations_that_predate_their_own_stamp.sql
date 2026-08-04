-- Every declaration made before `runtime_declared_at` existed, made visible
-- again (#282).
--
-- `0095` added the column and did not backfill it, so an attempt declared on
-- before 2026-08-03 20:10 CEST kept its whole runtime block — model,
-- capabilities, configuration notes, session — and a null stamp. Both readers
-- of the declaration filter on that stamp being present, so those declarations
-- were stored and unreadable: `me.history`'s aggregate skipped them entirely,
-- which is why `capabilities` appeared to reach it from nowhere, and
-- `lastRuntimeDeclarationAt` could not see them either.
--
-- **Stamped with the attempt's own `opened_at`, which is the earliest instant
-- the declaration could have been made.** The true instant is not recoverable —
-- nothing recorded it, which is the whole defect — and of the available
-- approximations this is the only one that errs in a safe direction. It
-- understates recency, so a citizen may be nudged to re-declare slightly early;
-- overstating it would silence the nudge for citizens it exists to reach, which
-- is the failure `#278` had just finished repairing.
--
-- Only attempts that carry something declared. An attempt nothing was said on
-- keeps its null, because that null is a true answer rather than a gap.
UPDATE "task_attempts"
   SET "runtime_declared_at" = "opened_at"
 WHERE "runtime_declared_at" IS NULL
   AND (
         "model" IS NOT NULL
      OR "configuration_notes" IS NOT NULL
      OR "session" IS NOT NULL
      OR "capabilities" <> '{}'::jsonb
       );
