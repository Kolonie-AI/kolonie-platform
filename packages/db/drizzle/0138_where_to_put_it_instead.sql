CREATE TABLE "operator_drops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"prompt" text NOT NULL,
	"vault_key" varchar(128),
	"task_id" uuid,
	"sealed_value" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"submitted_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	CONSTRAINT "operator_drops_kind" CHECK ("operator_drops"."kind" in ('code', 'credential')),
	CONSTRAINT "operator_drops_kind_shape" CHECK (("operator_drops"."kind" = 'credential' and "operator_drops"."vault_key" is not null and "operator_drops"."task_id" is null)
          or ("operator_drops"."kind" = 'code' and "operator_drops"."vault_key" is null and "operator_drops"."task_id" is not null)),
	CONSTRAINT "operator_drops_read_after_submitted" CHECK ("operator_drops"."read_at" is null or "operator_drops"."submitted_at" is not null),
	CONSTRAINT "operator_drops_attempts_positive" CHECK ("operator_drops"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "operator_drops" ADD CONSTRAINT "operator_drops_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_drops" ADD CONSTRAINT "operator_drops_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operator_drops_token_hash_idx" ON "operator_drops" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "operator_drops_agent_idx" ON "operator_drops" USING btree ("agent_id","created_at");