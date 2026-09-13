CREATE TABLE "workplace_card_closure_evidence" (
	"closure_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	CONSTRAINT "workplace_card_closure_evidence_closure_id_link_id_pk" PRIMARY KEY("closure_id","link_id")
);
--> statement-breakpoint
CREATE TABLE "workplace_card_closures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"actor_id" uuid,
	"revision" integer NOT NULL,
	"result" varchar(32) NOT NULL,
	"summary" text NOT NULL,
	"learned" text NOT NULL,
	"next" jsonb NOT NULL,
	"legacy" boolean DEFAULT false NOT NULL,
	"supersedes_closure_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_card_closures_id_card" UNIQUE("id","card_id"),
	CONSTRAINT "workplace_card_closures_card_revision" UNIQUE("card_id","revision"),
	CONSTRAINT "workplace_card_closures_supersedes_once" UNIQUE("supersedes_closure_id"),
	CONSTRAINT "workplace_card_closures_revision_supersession_is_whole" CHECK (("workplace_card_closures"."revision" = 1 and "workplace_card_closures"."supersedes_closure_id" is null)
          or ("workplace_card_closures"."revision" > 1 and "workplace_card_closures"."supersedes_closure_id" is not null)),
	CONSTRAINT "workplace_card_closures_result_is_known" CHECK ("workplace_card_closures"."result" in ('shipped', 'failed_experiment', 'abandoned', 'superseded')),
	CONSTRAINT "workplace_card_closures_revision_is_positive" CHECK ("workplace_card_closures"."revision" >= 1),
	CONSTRAINT "workplace_card_closures_prose_is_bounded" CHECK (char_length("workplace_card_closures"."summary") between 1 and 2000
          and char_length("workplace_card_closures"."learned") between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "workplace_cards" DROP CONSTRAINT "workplace_cards_outcome_is_bounded";--> statement-breakpoint
ALTER TABLE "workplace_card_closure_evidence" ADD CONSTRAINT "workplace_card_closure_evidence_closure_id_workplace_card_closures_id_fk" FOREIGN KEY ("closure_id") REFERENCES "public"."workplace_card_closures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_card_closure_evidence" ADD CONSTRAINT "workplace_card_closure_evidence_link_id_workplace_card_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."workplace_card_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_card_closures" ADD CONSTRAINT "workplace_card_closures_board_id_workplace_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."workplace_boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_card_closures" ADD CONSTRAINT "workplace_card_closures_card_id_workplace_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."workplace_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_card_closures" ADD CONSTRAINT "workplace_card_closures_actor_id_agents_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_card_closures" ADD CONSTRAINT "workplace_card_closures_card_board_fk" FOREIGN KEY ("card_id","board_id") REFERENCES "public"."workplace_cards"("id","board_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_card_closures" ADD CONSTRAINT "workplace_card_closures_supersedes_card_fk" FOREIGN KEY ("supersedes_closure_id","card_id") REFERENCES "public"."workplace_card_closures"("id","card_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workplace_card_closures_card_created_idx" ON "workplace_card_closures" USING btree ("card_id","created_at","id");--> statement-breakpoint
ALTER TABLE "workplace_cards" ADD CONSTRAINT "workplace_cards_outcome_is_bounded" CHECK ("workplace_cards"."outcome" is null or char_length("workplace_cards"."outcome") between 1 and 2000);--> statement-breakpoint
CREATE OR REPLACE FUNCTION workplace_card_closures_are_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW."id" = OLD."id"
     AND NEW."board_id" = OLD."board_id"
     AND NEW."card_id" = OLD."card_id"
     AND NEW."revision" = OLD."revision"
     AND NEW."result" = OLD."result"
     AND NEW."summary" = OLD."summary"
     AND NEW."learned" = OLD."learned"
     AND NEW."next" = OLD."next"
     AND NEW."legacy" = OLD."legacy"
     AND NEW."supersedes_closure_id" IS NOT DISTINCT FROM OLD."supersedes_closure_id"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."actor_id" IS NOT NULL
     AND NEW."actor_id" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'workplace_card_closures is append-only: append a revision instead of changing one'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER workplace_card_closures_are_append_only
  BEFORE UPDATE ON "workplace_card_closures"
  FOR EACH ROW EXECUTE FUNCTION workplace_card_closures_are_append_only();--> statement-breakpoint
INSERT INTO "workplace_card_closures" (
  "board_id",
  "card_id",
  "actor_id",
  "revision",
  "result",
  "summary",
  "learned",
  "next",
  "legacy",
  "created_at"
)
SELECT
  "board_id",
  "id",
  NULL,
  1,
  CASE WHEN nullif(btrim("outcome"), '') IS NULL THEN 'abandoned' ELSE 'shipped' END,
  CASE
    WHEN nullif(btrim("outcome"), '') IS NULL THEN 'Legacy completion; no outcome was recorded.'
    ELSE btrim("outcome")
  END,
  'Legacy completion; no learning was recorded.',
  CASE
    WHEN nullif(btrim("outcome"), '') IS NULL
      THEN '{"kind":"sentence","text":"No next decision was recorded."}'::jsonb
    ELSE '{"kind":"none"}'::jsonb
  END,
  true,
  "updated_at"
FROM "workplace_cards"
WHERE "status" = 'done';