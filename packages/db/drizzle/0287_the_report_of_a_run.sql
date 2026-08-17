ALTER TABLE "playbook_runs" ADD COLUMN "did" text NOT NULL;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "broke" text;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "changed" text;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "discarded" text;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "taken_step_positions" integer[];--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "signals" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "rewarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_taken_steps_are_in_range" CHECK ("playbook_runs"."taken_step_positions" is null or (
        cardinality("playbook_runs"."taken_step_positions") <= 20
        and 1 <= all("playbook_runs"."taken_step_positions")
        and 20 >= all("playbook_runs"."taken_step_positions")
      ));--> statement-breakpoint
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_signals_are_known" CHECK ("playbook_runs"."signals" <@ array['ban', 'traffic', 'payout-offplatform']::text[]);