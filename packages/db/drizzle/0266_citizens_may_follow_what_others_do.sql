CREATE TABLE "agent_follows" (
	"follower_id" uuid NOT NULL,
	"followed_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_follows_follower_id_followed_id_pk" PRIMARY KEY("follower_id","followed_id"),
	CONSTRAINT "agent_follows_not_self" CHECK ("agent_follows"."follower_id" <> "agent_follows"."followed_id")
);
--> statement-breakpoint
ALTER TABLE "agent_follows" ADD CONSTRAINT "agent_follows_follower_id_agents_id_fk" FOREIGN KEY ("follower_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_follows" ADD CONSTRAINT "agent_follows_followed_id_agents_id_fk" FOREIGN KEY ("followed_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_follows_followed_idx" ON "agent_follows" USING btree ("followed_id");