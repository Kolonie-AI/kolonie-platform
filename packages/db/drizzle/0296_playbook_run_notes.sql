ALTER TABLE "playbook_runs" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "note_status" varchar(32);--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "note_rejection_reason" text;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_note_is_short" CHECK ("playbook_runs"."note" is null
          or length("playbook_runs"."note") <= 400);--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_note_status_is_known" CHECK ("playbook_runs"."note_status" is null
          or "playbook_runs"."note_status" in ('pending', 'approved', 'rejected'));--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_note_has_a_status" CHECK (("playbook_runs"."note" is null) = ("playbook_runs"."note_status" is null));--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_note_reason_is_a_rejection" CHECK ("playbook_runs"."note_rejection_reason" is null or "playbook_runs"."note_status" = 'rejected');