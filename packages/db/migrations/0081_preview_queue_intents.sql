-- SPDX-License-Identifier: AGPL-3.0-only
CREATE TABLE IF NOT EXISTS preview_queue_jobs (
  id text PRIMARY KEY, app_id text NOT NULL, pr_number integer NOT NULL CHECK (pr_number > 0),
  action text NOT NULL CHECK (action IN ('deploy', 'teardown')), head_sha text,
  requested_by_user_id text, source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
--> statement-breakpoint
ALTER TABLE preview_deployments ADD COLUMN IF NOT EXISTS queue_job_id text;
