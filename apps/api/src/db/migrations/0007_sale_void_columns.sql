ALTER TABLE "sales" ADD COLUMN "void_business_date" date;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "local_void_id" uuid;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "voided_by_staff_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sales" ADD CONSTRAINT "sales_voided_by_staff_id_staff_id_fk" FOREIGN KEY ("voided_by_staff_id") REFERENCES "staff"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_merchant_local_void_id_uniq" ON "sales" ("merchant_id","local_void_id") WHERE "local_void_id" IS NOT NULL;
