CREATE TABLE "workplace_playbook_sources" (
	"playbook_id" uuid NOT NULL,
	"closure_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_playbook_sources_playbook_id_closure_id_pk" PRIMARY KEY("playbook_id","closure_id")
);
--> statement-breakpoint
ALTER TABLE "playbooks" ADD COLUMN "provenance_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "playbooks" ADD COLUMN "provenance_degraded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workplace_playbook_sources" ADD CONSTRAINT "workplace_playbook_sources_playbook_id_playbooks_id_fk" FOREIGN KEY ("playbook_id") REFERENCES "public"."playbooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workplace_playbook_sources" ADD CONSTRAINT "workplace_playbook_sources_closure_id_workplace_card_closures_id_fk" FOREIGN KEY ("closure_id") REFERENCES "public"."workplace_card_closures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workplace_playbook_sources_closure_idx" ON "workplace_playbook_sources" USING btree ("closure_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION workplace_playbook_source_was_deleted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE playbooks
     SET provenance_degraded = true
   WHERE id = OLD.playbook_id;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER workplace_playbook_source_was_deleted
AFTER DELETE ON workplace_playbook_sources
FOR EACH ROW
EXECUTE FUNCTION workplace_playbook_source_was_deleted();