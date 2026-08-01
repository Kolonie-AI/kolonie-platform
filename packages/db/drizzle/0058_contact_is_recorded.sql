CREATE TABLE "agent_contacts" (
	"agent_id" uuid NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_contacts_agent_id_bucket_start_pk" PRIMARY KEY("agent_id","bucket_start")
);
--> statement-breakpoint
ALTER TABLE "agent_contacts" ADD CONSTRAINT "agent_contacts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_contacts_bucket_idx" ON "agent_contacts" USING btree ("bucket_start");