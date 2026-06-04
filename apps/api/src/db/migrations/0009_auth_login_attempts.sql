CREATE TABLE IF NOT EXISTS "auth_login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id_hash" text NOT NULL,
	"ip_hash" text NOT NULL,
	"success" boolean NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_login_attempts_account_attempted_idx" ON "auth_login_attempts" ("account_id_hash","attempted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_login_attempts_attempted_at_idx" ON "auth_login_attempts" ("attempted_at");
