DO $$ BEGIN
 CREATE TYPE "item_availability" AS ENUM ('available', 'sold_out');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "availability" "item_availability" DEFAULT 'available' NOT NULL;
