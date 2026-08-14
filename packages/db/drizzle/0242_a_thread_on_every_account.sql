-- The conversation that hangs off an account (`#929`).
--
-- Four tables and four rules the database holds rather than the application:
-- every account has a thread, one thread has at most one `acquisition` episode
-- ever, a `failed` outcome carries a wall, and a closed episode rests at
-- `nobody`. Each of them is here rather than in a call site because what it
-- prevents would otherwise be silent — argued column by column in
-- `packages/db/src/schema/account-threads.ts`, and as a design in
-- `kolonie-docs/state/decisions/the-account-is-the-permanent-object.md`.
--
-- No cryptography is introduced. A secret slot carries a value the caller has
-- already sealed with the mechanism its direction already uses.
CREATE TYPE "public"."episode_kind" AS ENUM('acquisition', 'maintenance');--> statement-breakpoint
CREATE TYPE "public"."episode_outcome" AS ENUM('taken-over', 'created', 'repaired', 'failed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."episode_turn" AS ENUM('agent', 'operator', 'nobody');--> statement-breakpoint
CREATE TYPE "public"."slot_filler" AS ENUM('agent', 'operator');--> statement-breakpoint
CREATE TYPE "public"."thread_party" AS ENUM('agent', 'operator', 'colony');--> statement-breakpoint
CREATE TABLE "account_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"author" "thread_party" NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_entries_body_fits" CHECK (length("account_entries"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "account_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"opened_by" "thread_party" NOT NULL,
	"kind" "episode_kind" NOT NULL,
	"turn" "episode_turn" DEFAULT 'nobody' NOT NULL,
	"title" text NOT NULL,
	"outcome" "episode_outcome",
	"wall" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "account_episodes_failed_has_a_wall" CHECK ("account_episodes"."outcome" is distinct from 'failed' or "account_episodes"."wall" is not null),
	CONSTRAINT "account_episodes_wall_belongs_to_a_failure" CHECK ("account_episodes"."wall" is null or "account_episodes"."outcome" = 'failed'),
	CONSTRAINT "account_episodes_closed_rests" CHECK ("account_episodes"."outcome" is null or "account_episodes"."turn" = 'nobody'),
	CONSTRAINT "account_episodes_closed_has_a_date" CHECK (("account_episodes"."outcome" is null) = ("account_episodes"."closed_at" is null)),
	CONSTRAINT "account_episodes_title_fits" CHECK (length("account_episodes"."title") between 1 and 200),
	CONSTRAINT "account_episodes_wall_fits" CHECK ("account_episodes"."wall" is null or length("account_episodes"."wall") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "account_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"episode_id" uuid NOT NULL,
	"label" text NOT NULL,
	"secret" boolean DEFAULT false NOT NULL,
	"filled_by" "slot_filler",
	"filled_at" timestamp with time zone,
	"value" text,
	CONSTRAINT "account_slots_filled_together" CHECK (("account_slots"."filled_by" is null and "account_slots"."filled_at" is null and "account_slots"."value" is null)
          or ("account_slots"."filled_by" is not null and "account_slots"."filled_at" is not null and "account_slots"."value" is not null)),
	CONSTRAINT "account_slots_label_fits" CHECK (length("account_slots"."label") between 1 and 120),
	CONSTRAINT "account_slots_value_fits" CHECK ("account_slots"."value" is null or length("account_slots"."value") <= 8192)
);
--> statement-breakpoint
CREATE TABLE "account_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_threads_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_episode_id_account_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."account_episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_episodes" ADD CONSTRAINT "account_episodes_thread_id_account_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."account_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_slots" ADD CONSTRAINT "account_slots_episode_id_account_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."account_episodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_threads" ADD CONSTRAINT "account_threads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_entries_episode_idx" ON "account_entries" USING btree ("episode_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "account_episodes_one_acquisition" ON "account_episodes" USING btree ("thread_id") WHERE "account_episodes"."kind" = 'acquisition';--> statement-breakpoint
CREATE INDEX "account_episodes_thread_idx" ON "account_episodes" USING btree ("thread_id","opened_at");--> statement-breakpoint
CREATE INDEX "account_episodes_open_idx" ON "account_episodes" USING btree ("turn") WHERE "account_episodes"."outcome" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "account_slots_label_unique" ON "account_slots" USING btree ("episode_id","label");--> statement-breakpoint
CREATE INDEX "account_slots_episode_idx" ON "account_slots" USING btree ("episode_id");--> statement-breakpoint
-- Every account that already exists gets its thread, before the trigger below
-- makes that true of every account created afterwards (`#929`).
--
-- **Backfilled rather than created lazily on first read.** A thread minted by
-- whichever query happened to look first would mean *this account has no thread*
-- is a state the rest of the code has to handle forever, and handling it is
-- indistinguishable from handling *this account has had nothing happen to it*.
-- One statement here, and the case never exists.
INSERT INTO "account_threads" ("account_id")
SELECT "id" FROM "accounts"
ON CONFLICT ("account_id") DO NOTHING;--> statement-breakpoint
-- An account with no thread cannot exist.
--
-- A trigger rather than a line in `createAccount`, for the reason `0105` gives
-- about `tasks_stamp_retirement`: two code paths already insert accounts and a
-- third will, each one that had to remember is a chance to forget, and the
-- failure is silent — an account whose thread is missing looks exactly like an
-- account nothing has ever happened to. A trigger makes the next writer correct
-- without knowing this table is here.
--
-- `ON CONFLICT DO NOTHING` because the statement above may already have run for
-- this row, and because a caller that inserts its own thread should not be
-- punished for it.
CREATE OR REPLACE FUNCTION accounts_open_thread() RETURNS trigger AS $$
BEGIN
  INSERT INTO "account_threads" ("account_id") VALUES (NEW."id")
  ON CONFLICT ("account_id") DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER accounts_open_thread
  AFTER INSERT ON "accounts"
  FOR EACH ROW EXECUTE FUNCTION accounts_open_thread();--> statement-breakpoint
-- Closing an episode is one act, so it writes all three columns.
--
-- The date and the resting turn are facts about the outcome rather than things a
-- caller supplies alongside it: a `closed_at` passed in can disagree with the
-- state beside it, and a `turn` left where it was would leave a finished episode
-- reading as *waiting on the operator* in the one surface that matters.
--
-- Only the transition stamps. Writing the same outcome a second time leaves the
-- original date alone, which is what makes closing idempotent at this level as
-- well as in storage.
CREATE OR REPLACE FUNCTION account_episodes_stamp_close() RETURNS trigger AS $$
BEGIN
  IF NEW."outcome" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."outcome" IS NULL) THEN
    NEW."closed_at" := now();
    NEW."turn" := 'nobody';
  ELSIF NEW."outcome" IS NULL THEN
    -- Cleared on the way back. Nothing reopens an episode today; if something
    -- ever does, it must not carry the old closing date with it.
    NEW."closed_at" := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER account_episodes_stamp_close
  BEFORE INSERT OR UPDATE OF "outcome" ON "account_episodes"
  FOR EACH ROW EXECUTE FUNCTION account_episodes_stamp_close();--> statement-breakpoint
-- An entry cannot be changed after it is written, by anybody, including its
-- author.
--
-- **`UPDATE` only, and `DELETE` deliberately left alone.** Erasure takes
-- everything a citizen ever wrote — that is what erasure means — and it reaches
-- these rows by cascade from the agent. A trigger that refused deletes would
-- refuse erasure, which is a worse failure than the one it prevents. So
-- append-only is held two ways instead: the database refuses to change a body,
-- and the storage surface exposes no path that removes one.
--
-- What replaces editing is writing again. The correction is a second entry, and
-- the sequence shows that somebody changed their mind, which is usually the part
-- worth knowing.
CREATE OR REPLACE FUNCTION account_entries_are_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'account_entries is append-only: write a further entry instead of changing one'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER account_entries_are_append_only
  BEFORE UPDATE ON "account_entries"
  FOR EACH ROW EXECUTE FUNCTION account_entries_are_append_only();
