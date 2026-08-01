CREATE TYPE "public"."runtime_field" AS ENUM('model', 'runtimeVersion');--> statement-breakpoint
CREATE TABLE "agent_runtime_declarations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"field" "runtime_field" NOT NULL,
	"value" varchar(128),
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "model" varchar(128);--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_version" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_runtime_declarations" ADD CONSTRAINT "agent_runtime_declarations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runtime_declarations_agent_idx" ON "agent_runtime_declarations" USING btree ("agent_id","declared_at" DESC NULLS LAST);