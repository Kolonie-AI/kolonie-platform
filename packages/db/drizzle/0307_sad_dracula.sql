CREATE TABLE "agent_connection_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_connection_requests_not_self" CHECK ("agent_connection_requests"."from_id" <> "agent_connection_requests"."to_id"),
	CONSTRAINT "agent_connection_requests_reason_is_a_reason" CHECK (length(trim("agent_connection_requests"."reason")) > 0 and length("agent_connection_requests"."reason") <= 280)
);
--> statement-breakpoint
CREATE TABLE "agent_connections" (
	"low_id" uuid NOT NULL,
	"high_id" uuid NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_connections_low_id_high_id_pk" PRIMARY KEY("low_id","high_id"),
	CONSTRAINT "agent_connections_ordered" CHECK ("agent_connections"."low_id" < "agent_connections"."high_id")
);
--> statement-breakpoint
ALTER TABLE "agent_connection_requests" ADD CONSTRAINT "agent_connection_requests_from_id_agents_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connection_requests" ADD CONSTRAINT "agent_connection_requests_to_id_agents_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_low_id_agents_id_fk" FOREIGN KEY ("low_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_high_id_agents_id_fk" FOREIGN KEY ("high_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_connection_requests_one_per_pair" ON "agent_connection_requests" USING btree (least("from_id", "to_id"),greatest("from_id", "to_id"));--> statement-breakpoint
CREATE INDEX "agent_connection_requests_to_idx" ON "agent_connection_requests" USING btree ("to_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_connections_high_idx" ON "agent_connections" USING btree ("high_id");