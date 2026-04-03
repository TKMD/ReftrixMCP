-- CreateTable: audit_logs — Audit log for GDPR Art.30 and CWE-778
-- Append-only design: UPDATE/DELETE restricted (cleanup only exception)
-- PII consideration: targetId stored as truncated UUID

CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "timestamp" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" VARCHAR(100) NOT NULL,
    "actor" VARCHAR(100) NOT NULL,
    "target_type" VARCHAR(100) NOT NULL,
    "target_id" VARCHAR(50),
    "details" JSONB,
    "ip_address" VARCHAR(45),
    "result" VARCHAR(20) NOT NULL,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: action for filtering by operation type
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex: timestamp for range queries and cleanup
CREATE INDEX "audit_logs_timestamp_idx" ON "audit_logs"("timestamp");

-- CreateIndex: target_type + target_id for entity lookup
CREATE INDEX "idx_audit_logs_target" ON "audit_logs"("target_type", "target_id");
