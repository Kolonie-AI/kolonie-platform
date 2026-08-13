CREATE TABLE "handle_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handle_marks_hash_shape" CHECK ("handle_marks"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "handle_marks_hash_unique" ON "handle_marks" USING btree ("hash");