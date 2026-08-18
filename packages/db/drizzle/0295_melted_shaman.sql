ALTER TABLE "account_slots" DROP CONSTRAINT "account_slots_label_fits";--> statement-breakpoint
ALTER TABLE "account_slots" DROP CONSTRAINT "account_slots_value_fits";--> statement-breakpoint
ALTER TABLE "account_slots" DROP CONSTRAINT "account_slots_taken_together";--> statement-breakpoint
ALTER TABLE "account_slots" ALTER COLUMN "episode_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_slots" ALTER COLUMN "label" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "channel" text;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "last_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "prompt" text;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "account_slots" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_slots_agent_idx" ON "account_slots" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_slots_token_hash_idx" ON "account_slots" USING btree ("token_hash") WHERE "account_slots"."token_hash" is not null;--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_owner" CHECK ((("account_slots"."episode_id" is not null) != ("account_slots"."agent_id" is not null))
          and ("account_slots"."channel" is null) = ("account_slots"."episode_id" is not null)
          and ("account_slots"."label" is null) = ("account_slots"."channel" is not null));--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_channel_shape" CHECK (("account_slots"."channel" is null
            and "account_slots"."kind" is null and "account_slots"."token_hash" is null
            and "account_slots"."provider" is null and "account_slots"."task_id" is null
            and "account_slots"."prompt" is null and "account_slots"."attempts" = 0)
          or ("account_slots"."channel" = 'drop'
            and "account_slots"."kind" is not null and "account_slots"."token_hash" is not null
            and "account_slots"."created_at" is not null
            and "account_slots"."provider" is null and "account_slots"."prompt" is not null)
          or ("account_slots"."channel" = 'handover'
            and "account_slots"."provider" is not null and "account_slots"."prompt" is not null
            and "account_slots"."created_at" is not null
            and "account_slots"."kind" is null and "account_slots"."token_hash" is null
            and "account_slots"."task_id" is null and "account_slots"."attempts" = 0));--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_drop_kind_shape" CHECK ("account_slots"."channel" is distinct from 'drop'
          or ("account_slots"."kind" = 'credential' and "account_slots"."vault_key" is not null and "account_slots"."task_id" is null)
          or ("account_slots"."kind" = 'code' and "account_slots"."vault_key" is null and "account_slots"."task_id" is not null));--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_attempts_positive" CHECK ("account_slots"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_label_fits" CHECK ("account_slots"."label" is null or length("account_slots"."label") between 1 and 120);--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_value_fits" CHECK ("account_slots"."value" is null
          or ("account_slots"."channel" is null and length("account_slots"."value") <= 8192)
          or ("account_slots"."channel" = 'drop' and length("account_slots"."value") <= 32768)
          or ("account_slots"."channel" = 'handover' and length("account_slots"."value") <= 2048));--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_taken_together" CHECK (("account_slots"."taken_at" is null and "account_slots"."taken_to" is null)
          or ("account_slots"."taken_at" is not null and "account_slots"."taken_to" is not null)
          or ("account_slots"."taken_at" is not null and "account_slots"."channel" is not null));

--> statement-breakpoint
-- #955: the drop and the handover become slots.
--
-- Each source row is inserted WITH ITS OWN id, and that is not a tidiness
-- choice. A sealed value is AES-256-GCM whose associated data is the agent id
-- and a scope that embeds the row id -- 'operator-drop:<id>', 'agent-handover:
-- <id>'. A ciphertext that lands on a row with a different id opens as nothing,
-- and this migration holds no sealing key with which to re-seal one. So the id
-- travels with the value or the value is lost.
--
-- The two source tables are left in place, unread, and are dropped in a later
-- change: a migration that both moves and destroys has no step you can stop at.
INSERT INTO "account_slots" (
  "id", "episode_id", "agent_id", "channel", "label", "secret", "awaits",
  "vault_key", "filled_by", "filled_at", "value", "taken_at", "taken_to",
  "expires_at", "reads", "destroyed_at", "created_at", "last_read_at",
  "prompt", "kind", "token_hash", "task_id", "provider", "attempts"
)
SELECT
  d."id",
  NULL,
  d."agent_id",
  'drop',
  NULL,
  true,
  'operator',
  d."vault_key",
  -- Submitted is what filled it; an unanswered drop is an empty slot.
  CASE WHEN d."submitted_at" IS NULL THEN NULL ELSE 'operator'::"slot_filler" END,
  d."submitted_at",
  d."sealed_value",
  d."read_at",
  -- A credential landed in the vault under the key the agent named; a code came
  -- back to the caller and landed nowhere, which is why account_slots_taken_
  -- together has a branch for a take with no destination.
  CASE WHEN d."read_at" IS NOT NULL AND d."kind" = 'credential' THEN d."vault_key" END,
  d."expires_at",
  0,
  -- A drop that was answered and no longer holds its value has been destroyed,
  -- by the take or by the sweep. operator_drops recorded that only as an absence;
  -- account_slots_filled_together requires it to be said.
  CASE
    WHEN d."submitted_at" IS NOT NULL AND d."sealed_value" IS NULL
      THEN COALESCE(d."read_at", d."expires_at")
  END,
  d."created_at",
  NULL,
  d."prompt",
  d."kind",
  d."token_hash",
  d."task_id",
  NULL,
  d."attempts"
FROM "operator_drops" d;--> statement-breakpoint
INSERT INTO "account_slots" (
  "id", "episode_id", "agent_id", "channel", "label", "secret", "awaits",
  "vault_key", "filled_by", "filled_at", "value", "taken_at", "taken_to",
  "expires_at", "reads", "destroyed_at", "created_at", "last_read_at",
  "prompt", "kind", "token_hash", "task_id", "provider", "attempts"
)
SELECT
  h."id",
  NULL,
  h."agent_id",
  'handover',
  NULL,
  true,
  'agent',
  NULL,
  -- A handover is sealed by the agent at the moment it is opened, so it is
  -- filled from the first instant it exists and there is no unfilled state.
  'agent'::"slot_filler",
  h."created_at",
  h."sealed_value",
  NULL,
  NULL,
  h."expires_at",
  h."reads",
  h."destroyed_at",
  h."created_at",
  h."last_read_at",
  h."prompt",
  NULL,
  NULL,
  NULL,
  h."provider",
  0
FROM "agent_handovers" h;
