ALTER TABLE "playbook_runs" ADD COLUMN "note_published" text;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_note_published_is_short" CHECK ("playbook_runs"."note_published" is null
          or length("playbook_runs"."note_published") <= 400);--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_note_published_is_approved" CHECK (("playbook_runs"."note_published" is not null) = (coalesce("playbook_runs"."note_status", '') = 'approved'));