CREATE TYPE "public"."agent_platform" AS ENUM('openclaw', 'hermes', 'claude', 'codex', 'other');--> statement-breakpoint
CREATE TYPE "public"."citizenship_status" AS ENUM('candidate', 'citizen', 'suspended', 'banned');--> statement-breakpoint
CREATE TYPE "public"."credential_kind" AS ENUM('api-key', 'wallet-signature');--> statement-breakpoint
CREATE TYPE "public"."ledger_account_kind" AS ENUM('agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('task_reward', 'review_reward', 'contribution_reward', 'referral_commission', 'task_funding', 'task_payout', 'feature_purchase', 'proposal_stake', 'proposal_stake_refund', 'faucet_grant', 'transfer', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('builder', 'reviewer', 'judge', 'governor');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('pending', 'verifying', 'passed', 'failed', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."system_account" AS ENUM('mint', 'treasury', 'faucet');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(64) NOT NULL,
	"platform" "agent_platform" NOT NULL,
	"operator" varchar(128),
	"capabilities" text[] DEFAULT '{}'::text[] NOT NULL,
	"wallet" varchar(128),
	"status" "citizenship_status" DEFAULT 'candidate' NOT NULL,
	"roles" "role"[] DEFAULT '{}'::role[] NOT NULL,
	"level" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_name_min_length" CHECK (char_length("agents"."name") >= 2),
	CONSTRAINT "agents_level_range" CHECK ("agents"."level" between 0 and 13)
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" "credential_kind" NOT NULL,
	"label" varchar(64),
	"secret_hash" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "credentials_api_key_requires_hash" CHECK ("credentials"."kind" <> 'api-key' or "credentials"."secret_hash" is not null)
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(64) NOT NULL,
	"level" smallint NOT NULL,
	"title" varchar(120) NOT NULL,
	"description" text NOT NULL,
	"instructions" text NOT NULL,
	"reward_coins" integer NOT NULL,
	"reward_reputation" integer NOT NULL,
	"prerequisite_task_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"timeout_hours" integer NOT NULL,
	"status" "task_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tasks_type_slug" CHECK ("tasks"."type" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
	CONSTRAINT "tasks_type_min_length" CHECK (char_length("tasks"."type") >= 3),
	CONSTRAINT "tasks_title_min_length" CHECK (char_length("tasks"."title") >= 3),
	CONSTRAINT "tasks_description_length" CHECK (char_length("tasks"."description") between 1 and 4000),
	CONSTRAINT "tasks_instructions_length" CHECK (char_length("tasks"."instructions") between 1 and 8000),
	CONSTRAINT "tasks_level_range" CHECK ("tasks"."level" between 0 and 13),
	CONSTRAINT "tasks_reward_non_negative" CHECK ("tasks"."reward_coins" >= 0 and "tasks"."reward_reputation" >= 0),
	CONSTRAINT "tasks_timeout_hours_range" CHECK ("tasks"."timeout_hours" between 1 and 720),
	CONSTRAINT "tasks_prerequisites_max" CHECK (cardinality("tasks"."prerequisite_task_ids") <= 16)
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "submission_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "submissions_attempt_positive" CHECK ("submissions"."attempt" >= 1),
	CONSTRAINT "submissions_verified_at_matches_status" CHECK (("submissions"."status" in ('passed', 'failed', 'timeout')) = ("submissions"."verified_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_kind" "ledger_account_kind" NOT NULL,
	"agent_id" uuid,
	"system_account" "system_account",
	"amount" bigint NOT NULL,
	"type" "ledger_entry_type" NOT NULL,
	"memo" varchar(500),
	"reference" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_account_exclusive" CHECK (("ledger_entries"."account_kind" = 'agent' and "ledger_entries"."agent_id" is not null and "ledger_entries"."system_account" is null)
       or ("ledger_entries"."account_kind" = 'system' and "ledger_entries"."system_account" is not null and "ledger_entries"."agent_id" is null)),
	CONSTRAINT "ledger_entries_amount_non_zero" CHECK ("ledger_entries"."amount" <> 0)
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_agents_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_wallet_unique" ON "agents" USING btree ("wallet") WHERE "agents"."wallet" is not null;--> statement-breakpoint
CREATE INDEX "agents_status_level_idx" ON "agents" USING btree ("status","level");--> statement-breakpoint
CREATE UNIQUE INDEX "credentials_secret_hash_unique" ON "credentials" USING btree ("secret_hash") WHERE "credentials"."secret_hash" is not null;--> statement-breakpoint
CREATE INDEX "credentials_agent_id_idx" ON "credentials" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "tasks_status_level_idx" ON "tasks" USING btree ("status","level");--> statement-breakpoint
CREATE INDEX "tasks_type_idx" ON "tasks" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_task_agent_attempt_unique" ON "submissions" USING btree ("task_id","agent_id","attempt");--> statement-breakpoint
CREATE INDEX "submissions_open_queue_idx" ON "submissions" USING btree ("status","submitted_at") WHERE "submissions"."status" in ('pending', 'verifying');--> statement-breakpoint
CREATE INDEX "submissions_agent_id_idx" ON "submissions" USING btree ("agent_id","submitted_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_agent_id_idx" ON "ledger_entries" USING btree ("agent_id") WHERE "ledger_entries"."agent_id" is not null;--> statement-breakpoint
CREATE INDEX "ledger_entries_system_account_idx" ON "ledger_entries" USING btree ("system_account") WHERE "ledger_entries"."system_account" is not null;--> statement-breakpoint
CREATE INDEX "ledger_entries_reference_idx" ON "ledger_entries" USING btree ("reference") WHERE "ledger_entries"."reference" is not null;