-- SPDX-License-Identifier: AGPL-3.0-only
-- Plan v3 Track T4 (PR-V3-T4) — Worker Pre-Return Pause failure-path race
-- closure migration.
--
-- Adds:
--   1. FailedKnownReason enum (6 values; SEC H-01 client sanitised)
--   2. WorkerType enum (mirror of TS SSOT in apps/mcp-server/src/types/worker-type.ts)
--   3. WorkerLifecycleEvent enum (5 values: spawn / release / restart / dispose_start / dispose_end)
--   4. web_pages.failed_with_known_reason column (nullable; populated only on terminal classification)
--   5. worker_job_lifecycle table (FK web_pages with ON DELETE CASCADE; INV-DATA-DELETE-002 cascade)
--
-- All migrations idempotent-safe with IF NOT EXISTS guards where Postgres allows.

-- =====================================================
-- 1. FailedKnownReason enum (6 values)
-- =====================================================
CREATE TYPE "FailedKnownReason" AS ENUM (
  'worker_restart_during_inflight_phase_0',
  'worker_restart_during_inflight_phase_1',
  'worker_restart_during_inflight_phase_2_5',
  'worker_restart_during_inflight_phase_4',
  'worker_restart_during_inflight_phase_5',
  'worker_restart_during_inflight_phase_7_5'
);

-- =====================================================
-- 2. WorkerType enum (2 values, mirrors TS SSOT)
-- =====================================================
CREATE TYPE "WorkerType" AS ENUM (
  'page',
  'embedding-backfill'
);

-- =====================================================
-- 3. WorkerLifecycleEvent enum (5 values)
-- =====================================================
CREATE TYPE "WorkerLifecycleEvent" AS ENUM (
  'spawn',
  'release',
  'restart',
  'dispose_start',
  'dispose_end'
);

-- =====================================================
-- 4. Add failed_with_known_reason column to web_pages
-- =====================================================
ALTER TABLE "web_pages"
  ADD COLUMN "failed_with_known_reason" "FailedKnownReason";

-- =====================================================
-- 5. worker_job_lifecycle table (FK web_pages CASCADE)
-- =====================================================
CREATE TABLE "worker_job_lifecycle" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "web_page_id" UUID NOT NULL,
  "worker_pid" INTEGER NOT NULL,
  "worker_spawn_time" TIMESTAMPTZ NOT NULL,
  "worker_type" "WorkerType" NOT NULL,
  "event_type" "WorkerLifecycleEvent" NOT NULL,
  "event_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "nonce" UUID NOT NULL,

  CONSTRAINT "worker_job_lifecycle_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "worker_job_lifecycle_web_page_id_fkey"
    FOREIGN KEY ("web_page_id")
    REFERENCES "web_pages"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE
);

-- 3 indexes per design §5.1 schema specification
CREATE INDEX "worker_job_lifecycle_web_page_id_idx"
  ON "worker_job_lifecycle"("web_page_id");

CREATE INDEX "worker_job_lifecycle_worker_pid_worker_spawn_time_idx"
  ON "worker_job_lifecycle"("worker_pid", "worker_spawn_time");

CREATE INDEX "worker_job_lifecycle_event_at_idx"
  ON "worker_job_lifecycle"("event_at");
