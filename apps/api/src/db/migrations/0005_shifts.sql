CREATE TABLE IF NOT EXISTS "shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"cashier_staff_id" uuid NOT NULL,
	"open_shift_id" uuid NOT NULL,
	"close_shift_id" uuid,
	"business_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"opening_float_idr" bigint NOT NULL,
	"closed_at" timestamp with time zone,
	"counted_cash_idr" bigint,
	"expected_cash_idr" bigint,
	"variance_idr" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shifts_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id"),
	CONSTRAINT "shifts_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "outlets"("id"),
	CONSTRAINT "shifts_cashier_staff_id_staff_id_fk" FOREIGN KEY ("cashier_staff_id") REFERENCES "staff"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shifts_merchant_open_shift_id_uniq" ON "shifts" ("merchant_id", "open_shift_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shifts_merchant_close_shift_id_uniq" ON "shifts" ("merchant_id", "close_shift_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shifts_outlet_business_date_idx" ON "shifts" ("outlet_id", "business_date");
