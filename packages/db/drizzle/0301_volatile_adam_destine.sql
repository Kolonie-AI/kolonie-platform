CREATE TABLE "contribution_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"surface" varchar(32) NOT NULL,
	"verdict" varchar(16) NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribution_verdicts_surface_is_known" CHECK ("contribution_verdicts"."surface" in ('walk-report','task-report','playbook-note','step-proposal','quest-report','playbook-draft')),
	CONSTRAINT "contribution_verdicts_verdict_is_known" CHECK ("contribution_verdicts"."verdict" in ('approved','useless','abusive')),
	CONSTRAINT "contribution_verdicts_reason_is_a_refusal" CHECK ("contribution_verdicts"."reason" is null or "contribution_verdicts"."verdict" <> 'approved')
);
--> statement-breakpoint
ALTER TABLE "contribution_verdicts" ADD CONSTRAINT "contribution_verdicts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contribution_verdicts_agent_idx" ON "contribution_verdicts" USING btree ("agent_id","decided_at");--> statement-breakpoint
CREATE INDEX "contribution_verdicts_decided_at_idx" ON "contribution_verdicts" USING btree ("decided_at");