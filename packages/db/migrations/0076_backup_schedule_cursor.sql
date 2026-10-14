ALTER TABLE "backup_configs" ADD COLUMN IF NOT EXISTS "last_scheduled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "volume_backup_configs" ADD COLUMN IF NOT EXISTS "last_scheduled_at" timestamp with time zone;
