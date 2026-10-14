CREATE TABLE IF NOT EXISTS "host_disk_samples" (
  "host_key" text NOT NULL,
  "bucket_at" timestamp with time zone NOT NULL,
  "measured_at" timestamp with time zone NOT NULL,
  "used_bytes" bigint NOT NULL CHECK ("used_bytes" >= 0),
  "total_bytes" bigint NOT NULL CHECK ("total_bytes" > 0),
  CONSTRAINT "host_disk_samples_pkey" PRIMARY KEY ("host_key", "bucket_at")
);
