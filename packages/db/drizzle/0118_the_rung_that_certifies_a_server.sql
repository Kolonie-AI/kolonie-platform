CREATE TABLE "web_server_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"machine_is_solely_mine" boolean NOT NULL,
	"first_path" text NOT NULL,
	"first_nonce" text NOT NULL,
	"first_served_at" timestamp with time zone,
	"second_path" text NOT NULL,
	"second_nonce" text NOT NULL,
	"second_served_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "web_server_challenges_expiry_after_creation" CHECK ("web_server_challenges"."expires_at" > "web_server_challenges"."created_at"),
	CONSTRAINT "web_server_challenges_second_after_first" CHECK ("web_server_challenges"."second_served_at" is null or ("web_server_challenges"."first_served_at" is not null and "web_server_challenges"."second_served_at" > "web_server_challenges"."first_served_at"))
);
--> statement-breakpoint
ALTER TABLE "web_server_challenges" ADD CONSTRAINT "web_server_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "web_server_challenges_first_path_unique" ON "web_server_challenges" USING btree ("first_path");--> statement-breakpoint
CREATE UNIQUE INDEX "web_server_challenges_second_path_unique" ON "web_server_challenges" USING btree ("second_path");--> statement-breakpoint
CREATE INDEX "web_server_challenges_agent_expiry_idx" ON "web_server_challenges" USING btree ("agent_id","expires_at");