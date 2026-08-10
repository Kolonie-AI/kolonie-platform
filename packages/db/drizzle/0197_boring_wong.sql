DROP INDEX "operator_requests_one_open_idx";--> statement-breakpoint
ALTER TABLE "operator_requests" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "operator_requests" ADD COLUMN "wish_id" uuid;--> statement-breakpoint
ALTER TABLE "operator_requests" ADD CONSTRAINT "operator_requests_wish_id_account_wishes_id_fk" FOREIGN KEY ("wish_id") REFERENCES "public"."account_wishes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_requests" ADD CONSTRAINT "operator_requests_exactly_one_provenance" CHECK (("operator_requests"."task_id" is null) <> ("operator_requests"."wish_id" is null));