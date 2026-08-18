CREATE TABLE "playbook_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playbook_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"steps" jsonb NOT NULL,
	"proposal_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"cut_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playbook_revisions_revision_is_positive" CHECK ("playbook_revisions"."revision" >= 1),
	CONSTRAINT "playbook_revisions_steps_within_bounds" CHECK (jsonb_array_length("playbook_revisions"."steps") between 1 and 20)
);
--> statement-breakpoint
ALTER TABLE "playbook_step_proposals" ADD COLUMN "folded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "playbook_step_proposals" ADD COLUMN "fold_refusal_reason" text;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "playbook_revision" integer;--> statement-breakpoint
ALTER TABLE "playbook_revisions" ADD CONSTRAINT "playbook_revisions_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "playbook_revisions_playbook_revision_key" ON "playbook_revisions" USING btree ("playbook_id","revision");--> statement-breakpoint
CREATE INDEX "playbook_revisions_playbook_cut_at_idx" ON "playbook_revisions" USING btree ("playbook_id","cut_at");--> statement-breakpoint
ALTER TABLE "playbook_step_proposals" ADD CONSTRAINT "playbook_step_proposals_folded_is_accepted" CHECK ("playbook_step_proposals"."folded_at" is null or "playbook_step_proposals"."status" = 'accepted');--> statement-breakpoint
ALTER TABLE "playbook_step_proposals" ADD CONSTRAINT "playbook_step_proposals_fold_refusal_is_pending" CHECK ("playbook_step_proposals"."fold_refusal_reason" is null or "playbook_step_proposals"."status" = 'pending');--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_revision_is_positive" CHECK ("playbook_runs"."playbook_revision" is null or "playbook_runs"."playbook_revision" >= 1);--> statement-breakpoint
-- Backfill: one cut per existing playbook at its live version. Empty proposal_ids —
-- nothing was folded; the steps are as they stood when revisions shipped (#1255).
INSERT INTO "playbook_revisions" ("playbook_id", "revision", "steps", "proposal_ids", "cut_at")
SELECT "id", "version", "steps", '{}'::uuid[], "updated_at" FROM "playbooks";