CREATE TABLE "moderations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_kind" text NOT NULL,
	"struggle_id" uuid,
	"tip_id" uuid,
	"decision" "moderation_status" NOT NULL,
	"model" text NOT NULL,
	"stages" jsonb NOT NULL,
	"duplicate_of" uuid,
	"content_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderations_one_subject" CHECK (("moderations"."subject_kind" = 'struggle' and "moderations"."struggle_id" is not null and "moderations"."tip_id" is null)
       or ("moderations"."subject_kind" = 'tip' and "moderations"."tip_id" is not null and "moderations"."struggle_id" is null)),
	CONSTRAINT "moderations_decision_is_a_verdict" CHECK ("moderations"."decision" <> 'pending'),
	CONSTRAINT "moderations_duplicate_iff_merged" CHECK (("moderations"."decision" = 'merged') = ("moderations"."duplicate_of" is not null)),
	CONSTRAINT "moderations_content_sha256_shape" CHECK ("moderations"."content_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "moderations" ADD CONSTRAINT "moderations_struggle_id_task_struggles_id_fk" FOREIGN KEY ("struggle_id") REFERENCES "public"."task_struggles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderations" ADD CONSTRAINT "moderations_tip_id_task_tips_id_fk" FOREIGN KEY ("tip_id") REFERENCES "public"."task_tips"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderations_struggle_idx" ON "moderations" USING btree ("struggle_id","created_at");--> statement-breakpoint
CREATE INDEX "moderations_tip_idx" ON "moderations" USING btree ("tip_id","created_at");