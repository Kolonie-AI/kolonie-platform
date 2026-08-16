--> Which scrubber reached a walk's verdict (`#1108`). Both verdicts are stamped
--> from here on, an approval as well as a refusal, and the runner re-queues the
--> refusals stamped below `WALK_PROSE_SCRUBBER_VERSION`.
-->
--> Nothing is backfilled, and that is the point rather than an omission: null
--> means *judged before the stamp existed*, which is true of every row this
--> migration touches and is exactly what makes the thirteen historical refusals
--> re-read once on the first run after this ships. A backfill to the current
--> version would claim a scrubber read them when none of them did.
ALTER TABLE "account_walks" ADD COLUMN "prose_scrubber_version" integer;
