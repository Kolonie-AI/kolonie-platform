CREATE TABLE "payout_obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid,
	"task_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"lamports" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"signature" varchar(120),
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_refusal" text,
	"forfeited_at" timestamp with time zone,
	CONSTRAINT "payout_obligations_lamports_positive" CHECK ("payout_obligations"."lamports" > 0),
	CONSTRAINT "payout_obligations_outstanding_names_its_citizen" CHECK ("payout_obligations"."agent_id" is not null
          or "payout_obligations"."paid_at" is not null
          or "payout_obligations"."forfeited_at" is not null),
	CONSTRAINT "payout_obligations_paid_xor_forfeited" CHECK ("payout_obligations"."paid_at" is null or "payout_obligations"."forfeited_at" is null),
	CONSTRAINT "payout_obligations_signature_iff_paid" CHECK (("payout_obligations"."paid_at" is null) = ("payout_obligations"."signature" is null))
);
--> statement-breakpoint
ALTER TABLE "payout_obligations" ADD CONSTRAINT "payout_obligations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_obligations" ADD CONSTRAINT "payout_obligations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_obligations" ADD CONSTRAINT "payout_obligations_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_obligations_submission_unique" ON "payout_obligations" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "payout_obligations_outstanding_idx" ON "payout_obligations" USING btree ("created_at") WHERE "payout_obligations"."paid_at" is null and "payout_obligations"."forfeited_at" is null;--> statement-breakpoint
CREATE INDEX "payout_obligations_agent_idx" ON "payout_obligations" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "payout_obligations_paid_at_idx" ON "payout_obligations" USING btree ("paid_at");