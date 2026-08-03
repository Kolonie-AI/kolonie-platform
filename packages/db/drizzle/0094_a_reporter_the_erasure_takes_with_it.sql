CREATE SEQUENCE "public"."support_reporter_ordinal_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "reporter_ordinal" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_reporter_ordinal_unique" ON "agents" USING btree ("reporter_ordinal") WHERE "agents"."reporter_ordinal" is not null;