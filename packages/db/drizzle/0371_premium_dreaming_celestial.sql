ALTER TABLE "workplace_commitments" ADD COLUMN "focus_card_id" uuid;--> statement-breakpoint
ALTER TABLE "workplace_commitments" ADD COLUMN "focus_lost" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workplace_commitments" ADD CONSTRAINT "workplace_commitments_focus_card_id_workplace_cards_id_fk" FOREIGN KEY ("focus_card_id") REFERENCES "public"."workplace_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION workplace_commitment_focus_was_deleted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE workplace_commitments
     SET focus_card_id = NULL,
         focus_lost = true,
         version = version + 1,
         updated_at = now()
   WHERE focus_card_id = OLD.id;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER workplace_commitments_focus_was_deleted
BEFORE DELETE ON workplace_cards
FOR EACH ROW
EXECUTE FUNCTION workplace_commitment_focus_was_deleted();