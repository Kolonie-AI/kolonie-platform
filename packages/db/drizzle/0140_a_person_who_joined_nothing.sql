CREATE TYPE "public"."identity_provider" AS ENUM('github', 'google', 'apple', 'facebook', 'x');--> statement-breakpoint
CREATE TABLE "human_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"human_id" uuid NOT NULL,
	"provider" "identity_provider" NOT NULL,
	"subject" varchar(255) NOT NULL,
	"email" text,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"human_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"browser" varchar(64),
	"location" varchar(64),
	CONSTRAINT "human_sessions_within_ceiling" CHECK (expires_at <= absolute_expires_at)
);
--> statement-breakpoint
CREATE TABLE "humans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "human_identities" ADD CONSTRAINT "human_identities_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_sessions" ADD CONSTRAINT "human_sessions_human_id_humans_id_fk" FOREIGN KEY ("human_id") REFERENCES "public"."humans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "human_identities_provider_subject_unique" ON "human_identities" USING btree ("provider","subject");--> statement-breakpoint
CREATE INDEX "human_identities_human_idx" ON "human_identities" USING btree ("human_id");--> statement-breakpoint
CREATE UNIQUE INDEX "human_sessions_secret_hash_unique" ON "human_sessions" USING btree ("secret_hash");--> statement-breakpoint
CREATE INDEX "human_sessions_human_idx" ON "human_sessions" USING btree ("human_id");