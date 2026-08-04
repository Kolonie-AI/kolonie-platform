CREATE TABLE "operator_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"body" text NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "operator_notes_body_length" CHECK (char_length("operator_notes"."body") between 4 and 2000)
);
--> statement-breakpoint
ALTER TABLE "operator_notes" ADD CONSTRAINT "operator_notes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_notes_unread_idx" ON "operator_notes" USING btree ("agent_id","written_at") WHERE "operator_notes"."read_at" is null;