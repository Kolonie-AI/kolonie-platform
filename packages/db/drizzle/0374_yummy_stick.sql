SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
ALTER TABLE "workplace_card_closures" ADD COLUMN "search_vector" "tsvector";--> statement-breakpoint
ALTER TABLE "workplace_cards" ADD COLUMN "search_vector" "tsvector";--> statement-breakpoint
CREATE INDEX "workplace_card_closures_search_idx" ON "workplace_card_closures" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "workplace_cards_search_idx" ON "workplace_cards" USING gin ("search_vector");--> statement-breakpoint
-- A closure claim remains append-only. Its disposable search vector is the one
-- field rebuild is allowed to change, alongside the existing erasure-only
-- actor nulling. No canonical claim field can move through either branch.
CREATE OR REPLACE FUNCTION workplace_card_closures_are_append_only() RETURNS trigger AS $$
BEGIN
  IF NEW."id" = OLD."id"
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
     AND NEW."actor_id" IS NOT DISTINCT FROM OLD."actor_id" THEN
    RETURN NEW;
  END IF;
  IF NEW."id" = OLD."id"
     AND NEW."board_id" = OLD."board_id"
     AND NEW."card_id" = OLD."card_id"
     AND NEW."revision" = OLD."revision"
     AND NEW."result" = OLD."result"
     AND NEW."summary" = OLD."summary"
     AND NEW."learned" = OLD."learned"
     AND NEW."next" = OLD."next"
     AND NEW."legacy" = OLD."legacy"
     AND NEW."supersedes_closure_id" IS NOT DISTINCT FROM OLD."supersedes_closure_id"
     AND NEW."search_vector" IS NOT DISTINCT FROM OLD."search_vector"
     AND NEW."created_at" = OLD."created_at"
     AND OLD."actor_id" IS NOT NULL
     AND NEW."actor_id" IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'workplace_card_closures is append-only: append a revision instead of changing one'
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- #1943. Backfill the disposable lexical projection from canonical rows.
-- Weights: title/summary A, description/learned B, evidence refs D (exact
-- punctuation-bounded tokens under the 'simple' config, so a ref matches
-- itself and nothing a stemmer would relate to it). The evidence half is resolved through the
-- closure's current evidence relation, so links deleted before this migration
-- are absent from the projection exactly as they will be absent from recall.
UPDATE "workplace_cards" c
   SET "search_vector" =
         setweight(to_tsvector('english', coalesce(c."title", '')), 'A') ||
         setweight(to_tsvector('english', coalesce(c."description", '')), 'B');--> statement-breakpoint
UPDATE "workplace_card_closures" cl
   SET "search_vector" =
         setweight(to_tsvector('english', coalesce(cl."summary", '')), 'A') ||
         setweight(to_tsvector('english', coalesce(cl."learned", '')), 'B') ||
         setweight(
           to_tsvector(
             'simple',
             regexp_replace(coalesce((
               select string_agg(l."ref", ' ')
                 from workplace_card_closure_evidence e
                 join workplace_card_links l on l."id" = e."link_id"
                where e."closure_id" = cl."id"
             ), ''), '[^[:alnum:]-]+', ' ', 'g')
           ),
           'D'
         );
