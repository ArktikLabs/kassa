CREATE TABLE "bom_components" (
	"bom_id" uuid NOT NULL,
	"component_item_id" uuid NOT NULL,
	"quantity" numeric(18, 6) NOT NULL,
	"uom_id" uuid NOT NULL,
	CONSTRAINT "bom_components_bom_id_component_item_id_pk" PRIMARY KEY("bom_id","component_item_id")
);
--> statement-breakpoint
CREATE TABLE "boms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"api_key_hash" text NOT NULL,
	"fingerprint" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "end_of_day" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outlet_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"closed_by_staff_id" uuid NOT NULL,
	"expected_cash_idr" bigint NOT NULL,
	"counted_cash_idr" bigint NOT NULL,
	"expected_qris_idr" bigint DEFAULT 0 NOT NULL,
	"variance_idr" bigint NOT NULL,
	"variance_reason" text,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrolment_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_device_id" uuid
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"price_idr" bigint NOT NULL,
	"uom_id" uuid NOT NULL,
	"bom_id" uuid,
	"is_stock_tracked" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merchants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Jakarta' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modifiers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"price_delta_idr" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outlets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Jakarta' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"uom_id" uuid NOT NULL,
	"bom_id" uuid,
	"quantity" numeric(18, 6) NOT NULL,
	"unit_price_idr" bigint NOT NULL,
	"line_total_idr" bigint NOT NULL,
	"is_stock_affecting" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid NOT NULL,
	"clerk_id" uuid NOT NULL,
	"local_sale_id" uuid NOT NULL,
	"business_date" date NOT NULL,
	"status" text DEFAULT 'finalised' NOT NULL,
	"subtotal_idr" bigint NOT NULL,
	"discount_idr" bigint DEFAULT 0 NOT NULL,
	"total_idr" bigint NOT NULL,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"pin_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outlet_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"delta" numeric(18, 6) NOT NULL,
	"reason" text NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_snapshots" (
	"outlet_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"on_hand" numeric(18, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_snapshots_outlet_id_item_id_pk" PRIMARY KEY("outlet_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid,
	"request_id" text,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"status_code" integer NOT NULL,
	"duration_ms" integer,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount_idr" bigint NOT NULL,
	"order_ref" text,
	"verified" boolean DEFAULT false NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"outlet_id" uuid,
	"sale_id" uuid,
	"tender_id" uuid,
	"kind" text NOT NULL,
	"amount_idr" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uoms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"merchant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_bom_id_boms_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."boms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_component_item_id_items_id_fk" FOREIGN KEY ("component_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_components" ADD CONSTRAINT "bom_components_uom_id_uoms_id_fk" FOREIGN KEY ("uom_id") REFERENCES "public"."uoms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "end_of_day" ADD CONSTRAINT "end_of_day_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "end_of_day" ADD CONSTRAINT "end_of_day_closed_by_staff_id_staff_id_fk" FOREIGN KEY ("closed_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolment_codes" ADD CONSTRAINT "enrolment_codes_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolment_codes" ADD CONSTRAINT "enrolment_codes_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolment_codes" ADD CONSTRAINT "enrolment_codes_created_by_user_id_staff_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrolment_codes" ADD CONSTRAINT "enrolment_codes_consumed_by_device_id_devices_id_fk" FOREIGN KEY ("consumed_by_device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_uom_id_uoms_id_fk" FOREIGN KEY ("uom_id") REFERENCES "public"."uoms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modifiers" ADD CONSTRAINT "modifiers_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_uom_id_uoms_id_fk" FOREIGN KEY ("uom_id") REFERENCES "public"."uoms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_bom_id_boms_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."boms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_clerk_id_staff_id_fk" FOREIGN KEY ("clerk_id") REFERENCES "public"."staff"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_ledger" ADD CONSTRAINT "stock_ledger_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_snapshots" ADD CONSTRAINT "stock_snapshots_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_snapshots" ADD CONSTRAINT "stock_snapshots_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_events" ADD CONSTRAINT "transaction_events_tender_id_tenders_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uoms" ADD CONSTRAINT "uoms_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bom_components_bom_idx" ON "bom_components" USING btree ("bom_id");--> statement-breakpoint
CREATE INDEX "boms_merchant_updated_at_idx" ON "boms" USING btree ("merchant_id","updated_at");--> statement-breakpoint
CREATE INDEX "boms_merchant_item_idx" ON "boms" USING btree ("merchant_id","item_id");--> statement-breakpoint
CREATE INDEX "devices_merchant_idx" ON "devices" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "devices_outlet_idx" ON "devices" USING btree ("outlet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "end_of_day_outlet_business_date_uniq" ON "end_of_day" USING btree ("outlet_id","business_date");--> statement-breakpoint
CREATE INDEX "end_of_day_business_date_idx" ON "end_of_day" USING btree ("business_date");--> statement-breakpoint
CREATE INDEX "enrolment_codes_outlet_idx" ON "enrolment_codes" USING btree ("outlet_id");--> statement-breakpoint
CREATE INDEX "enrolment_codes_unconsumed_expiry_idx" ON "enrolment_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "items_merchant_code_uniq" ON "items" USING btree ("merchant_id","code");--> statement-breakpoint
CREATE INDEX "items_merchant_updated_at_idx" ON "items" USING btree ("merchant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "modifiers_merchant_code_uniq" ON "modifiers" USING btree ("merchant_id","code");--> statement-breakpoint
CREATE INDEX "modifiers_merchant_updated_at_idx" ON "modifiers" USING btree ("merchant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outlets_merchant_code_uniq" ON "outlets" USING btree ("merchant_id","code");--> statement-breakpoint
CREATE INDEX "outlets_merchant_updated_at_idx" ON "outlets" USING btree ("merchant_id","updated_at");--> statement-breakpoint
CREATE INDEX "sale_items_sale_idx" ON "sale_items" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "sale_items_item_idx" ON "sale_items" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_merchant_local_sale_id_uniq" ON "sales" USING btree ("merchant_id","local_sale_id");--> statement-breakpoint
CREATE INDEX "sales_outlet_business_date_idx" ON "sales" USING btree ("outlet_id","business_date");--> statement-breakpoint
CREATE INDEX "sales_merchant_created_at_idx" ON "sales" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_merchant_email_uniq" ON "staff" USING btree ("merchant_id","email");--> statement-breakpoint
CREATE INDEX "staff_merchant_idx" ON "staff" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "stock_ledger_outlet_item_created_idx" ON "stock_ledger" USING btree ("outlet_id","item_id","created_at");--> statement-breakpoint
CREATE INDEX "stock_ledger_ref_idx" ON "stock_ledger" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "stock_snapshots_outlet_updated_at_idx" ON "stock_snapshots" USING btree ("outlet_id","updated_at");--> statement-breakpoint
CREATE INDEX "sync_log_created_at_idx" ON "sync_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sync_log_device_idx" ON "sync_log" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "tenders_sale_idx" ON "tenders" USING btree ("sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenders_order_ref_uniq" ON "tenders" USING btree ("order_ref") WHERE order_ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transaction_events_merchant_created_at_idx" ON "transaction_events" USING btree ("merchant_id","created_at");--> statement-breakpoint
CREATE INDEX "transaction_events_sale_idx" ON "transaction_events" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "transaction_events_tender_idx" ON "transaction_events" USING btree ("tender_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uoms_merchant_code_uniq" ON "uoms" USING btree ("merchant_id","code");--> statement-breakpoint
CREATE INDEX "uoms_merchant_updated_at_idx" ON "uoms" USING btree ("merchant_id","updated_at");