ALTER TABLE "items" ADD COLUMN "tax_rate" integer DEFAULT 11 NOT NULL;--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "tax_inclusive" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "tax_idr" bigint DEFAULT 0 NOT NULL;