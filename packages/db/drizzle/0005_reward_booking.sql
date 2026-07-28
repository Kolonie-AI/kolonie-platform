-- Booking a passed submission happens once, and Postgres is what says so.
--
-- Both indexes exist because the writer that would duplicate a reward is not a
-- careless caller but two verdicts landing in the same millisecond. A `select`
-- for a prior booking followed by an `insert` is a race exactly as wide as the
-- transaction, and both sides pass it; only the database sees both inserts.
CREATE UNIQUE INDEX "ledger_entries_task_reward_unique" ON "ledger_entries" USING btree ("reference","account_kind") WHERE "ledger_entries"."type" = 'task_reward';--> statement-breakpoint
CREATE UNIQUE INDEX "reputation_events_task_passed_unique" ON "reputation_events" USING btree ("submission_id") WHERE "reputation_events"."reason" = 'task_passed' and "reputation_events"."submission_id" is not null;