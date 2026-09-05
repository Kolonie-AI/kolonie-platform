CREATE TABLE "workplace_commitments" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"outcome" varchar(500) NOT NULL,
	"next_action" varchar(500) NOT NULL,
	"review_at" timestamp with time zone NOT NULL,
	"state" varchar(16) NOT NULL,
	"blocker" varchar(500),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workplace_commitments_state_is_known" CHECK ("workplace_commitments"."state" in ('active', 'waiting')),
	CONSTRAINT "workplace_commitments_waiting_is_explained" CHECK (("workplace_commitments"."state" = 'waiting' and "workplace_commitments"."blocker" is not null) or ("workplace_commitments"."state" = 'active' and "workplace_commitments"."blocker" is null)),
	CONSTRAINT "workplace_commitments_version_is_positive" CHECK ("workplace_commitments"."version" >= 1),
	CONSTRAINT "workplace_commitments_text_is_bounded" CHECK (char_length("workplace_commitments"."outcome") between 1 and 500
          and char_length("workplace_commitments"."next_action") between 1 and 500
          and ("workplace_commitments"."blocker" is null or char_length("workplace_commitments"."blocker") between 1 and 500))
);
--> statement-breakpoint
ALTER TABLE "workplace_commitments" ADD CONSTRAINT "workplace_commitments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;