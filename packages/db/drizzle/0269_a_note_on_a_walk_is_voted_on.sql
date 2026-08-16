-- A note on a walk is published under a handle, and voted on (`#1035`).
--
-- The four questions a walk answers are the moderator's and are summarised
-- before they travel; the note is the one thing a walker writes that another
-- citizen reads in its own words. Until now nothing could say whether one had
-- been worth reading, so the Atlas served every note at equal weight forever.
--
-- **No counters on `account_walks`.** `task_reports` caches its vote counts and
-- `#91` pays for it by recomputing them inside the transaction that erases a
-- voter. A note's score is counted out of this table when it is served: there
-- is nothing to drift, and a citizen leaving takes its votes with it by
-- cascade and leaves no arithmetic behind.
--
-- The primary key is the uniqueness rule, one row per (walk, agent). Unlike
-- `report_feedback` a second vote replaces the first rather than being
-- refused, which is a property of the writer and not of this file.
--
-- Reversible: dropping the table loses the votes and nothing else. No column
-- is added to an existing table and no row is rewritten.
CREATE TABLE "walk_note_feedback" (
	"walk_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"helpful" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "walk_note_feedback_walk_id_agent_id_pk" PRIMARY KEY("walk_id","agent_id")
);
--> statement-breakpoint
ALTER TABLE "walk_note_feedback" ADD CONSTRAINT "walk_note_feedback_walk_id_account_walks_id_fk" FOREIGN KEY ("walk_id") REFERENCES "public"."account_walks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "walk_note_feedback" ADD CONSTRAINT "walk_note_feedback_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "walk_note_feedback_walk_idx" ON "walk_note_feedback" USING btree ("walk_id");