CREATE TABLE "agent_avatars" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"format" varchar(8) NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"source_url" varchar(2048) NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_avatars" ADD CONSTRAINT "agent_avatars_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;