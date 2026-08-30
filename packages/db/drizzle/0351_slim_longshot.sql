CREATE TABLE "workplace_card_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"ref" text NOT NULL,
	"note" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_card_links_kind_is_known" CHECK ("workplace_card_links"."kind" in ('account', 'provider', 'vault', 'task', 'playbook', 'url')),
	CONSTRAINT "workplace_card_links_ref_is_bounded" CHECK (char_length("workplace_card_links"."ref") between 1 and 2048),
	CONSTRAINT "workplace_card_links_note_is_bounded" CHECK ("workplace_card_links"."note" is null or char_length("workplace_card_links"."note") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "workplace_card_links" ADD CONSTRAINT "workplace_card_links_card_id_workplace_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."workplace_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workplace_card_links_card_kind_ref" ON "workplace_card_links" USING btree ("card_id","kind","ref");--> statement-breakpoint
CREATE INDEX "workplace_card_links_card_idx" ON "workplace_card_links" USING btree ("card_id","created_at");--> statement-breakpoint
CREATE INDEX "workplace_card_links_kind_ref" ON "workplace_card_links" USING btree ("kind","ref");