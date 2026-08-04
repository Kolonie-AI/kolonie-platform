CREATE TYPE "public"."operator_request_author" AS ENUM('citizen', 'operator');--> statement-breakpoint
CREATE TABLE "operator_request_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"author" "operator_request_author" NOT NULL,
	"body" text NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_request_messages_body_length" CHECK (char_length("operator_request_messages"."body") between 4 and 2000)
);
--> statement-breakpoint
CREATE TABLE "operator_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "operator_request_messages" ADD CONSTRAINT "operator_request_messages_request_id_operator_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."operator_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_requests" ADD CONSTRAINT "operator_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_requests" ADD CONSTRAINT "operator_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_request_messages_request_idx" ON "operator_request_messages" USING btree ("request_id","written_at");--> statement-breakpoint
CREATE UNIQUE INDEX "operator_requests_one_open_idx" ON "operator_requests" USING btree ("agent_id") WHERE "operator_requests"."closed_at" is null;--> statement-breakpoint
CREATE INDEX "operator_requests_agent_opened_idx" ON "operator_requests" USING btree ("agent_id","opened_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "operator_requests_agent_open_idx" ON "operator_requests" USING btree ("agent_id") WHERE "operator_requests"."closed_at" is null;