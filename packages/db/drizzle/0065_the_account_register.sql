CREATE TYPE "public"."account_provenance" AS ENUM('self-acquired', 'task');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('in-use', 'retired', 'lost');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"identifier" text NOT NULL,
	"proved" boolean DEFAULT false NOT NULL,
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" "account_status" DEFAULT 'in-use' NOT NULL,
	"preferred" boolean DEFAULT false NOT NULL,
	"note" text,
	"vault_key" text,
	"provenance" "account_provenance" DEFAULT 'self-acquired' NOT NULL,
	"obtained_through_task_id" uuid,
	"proved_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_mail_has_no_preference" CHECK ("accounts"."kind" <> 'mailbox' or "accounts"."preferred" = false),
	CONSTRAINT "accounts_proved_has_a_date" CHECK (("accounts"."proved" = false and "accounts"."proved_at" is null)
          or ("accounts"."proved" = true and "accounts"."proved_at" is not null)),
	CONSTRAINT "accounts_capabilities_need_a_proof" CHECK ("accounts"."proved" = true or cardinality("accounts"."capabilities") = 0),
	CONSTRAINT "accounts_confirmed_implies_proved" CHECK ("accounts"."confirmed_at" is null or "accounts"."proved" = true),
	CONSTRAINT "accounts_task_provenance_is_consistent" CHECK ("accounts"."provenance" = 'task' or "accounts"."obtained_through_task_id" is null),
	CONSTRAINT "accounts_note_length" CHECK ("accounts"."note" is null or char_length("accounts"."note") <= 500)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_obtained_through_task_id_tasks_id_fk" FOREIGN KEY ("obtained_through_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_identifier_per_agent_unique" ON "accounts" USING btree ("agent_id","kind",lower("identifier"));--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_proved_identifier_unique" ON "accounts" USING btree ("kind",lower("identifier")) WHERE "accounts"."proved" = true and "accounts"."kind" <> 'website';--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_preferred_per_kind_unique" ON "accounts" USING btree ("agent_id","kind") WHERE "accounts"."preferred" = true;--> statement-breakpoint
CREATE INDEX "accounts_agent_kind_idx" ON "accounts" USING btree ("agent_id","kind","status");--> statement-breakpoint
CREATE INDEX "accounts_obtained_through_idx" ON "accounts" USING btree ("obtained_through_task_id");