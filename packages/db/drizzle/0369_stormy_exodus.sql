ALTER TABLE "workplace_cards" ADD COLUMN "kind" varchar(16) DEFAULT 'action' NOT NULL;--> statement-breakpoint
ALTER TABLE "workplace_cards" ADD COLUMN "parent_initiative_id" uuid;--> statement-breakpoint
ALTER TABLE "workplace_cards" ADD CONSTRAINT "workplace_cards_parent_initiative_id_workplace_cards_id_fk" FOREIGN KEY ("parent_initiative_id") REFERENCES "public"."workplace_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION workplace_card_parent_is_live_initiative()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.parent_initiative_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.kind <> 'action' OR NOT EXISTS (
    SELECT 1
      FROM workplace_cards parent
     WHERE parent.id = NEW.parent_initiative_id
       AND parent.board_id = NEW.board_id
       AND parent.kind = 'initiative'
       AND parent.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'workplace parent must be a live Initiative on the same board'
      USING ERRCODE = '23514', CONSTRAINT = 'workplace_cards_parent_is_live_initiative';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER workplace_cards_parent_is_live_initiative
AFTER INSERT OR UPDATE OF kind, parent_initiative_id, board_id, archived_at ON workplace_cards
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION workplace_card_parent_is_live_initiative();--> statement-breakpoint
CREATE INDEX "workplace_cards_parent_idx" ON "workplace_cards" USING btree ("parent_initiative_id");--> statement-breakpoint
ALTER TABLE "workplace_cards" ADD CONSTRAINT "workplace_cards_kind_is_known" CHECK ("workplace_cards"."kind" in ('initiative', 'action'));--> statement-breakpoint
ALTER TABLE "workplace_cards" ADD CONSTRAINT "workplace_cards_initiative_shape" CHECK ("workplace_cards"."kind" = 'action'
        or ("workplace_cards"."parent_initiative_id" is null
            and "workplace_cards"."owner_id" is null
            and "workplace_cards"."status" in ('inbox', 'ready', 'done')));