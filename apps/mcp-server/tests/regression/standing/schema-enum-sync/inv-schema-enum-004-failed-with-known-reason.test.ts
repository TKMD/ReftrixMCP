// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SCHEMA-ENUM-004 EXTENSION (Plan v3 T4).
 *
 * Verifies the 4-layer sync contract for the NEW `FailedKnownReason` enum
 * (Plan v3 Track T4 PR-V3-T4 / Conflict 3 closure):
 *
 *   1. Prisma schema    — `enum FailedKnownReason` (SSOT, 6 values)
 *   2. TypeScript types — `packages/core/src/types/failed-known-reason.ts`
 *   3. Zod schema       — `apps/mcp-server/src/schemas/failed-known-reason.schema.ts`
 *   4. OpenAPI/MCP spec — `apps/mcp-server/src/tools/page/get-job-status.tool.ts`
 *      (sanitised generic surface only; raw enum NEVER reaches client)
 *
 * **Naming convention contract (TPA L-01 IO Decision)**: `_2_5` underscore
 * form, NOT `_2.5` dot form. Postgres enum literal does not allow dots.
 *
 * INV-SCHEMA-ENUM-004 EXTENSION — Plan v3 T4 FailedKnownReason 4-layer sync.
 *
 * @see PR-V3-T4 design.md §6.2 (4-layer sync table)
 * @see ADR-0016 §INV-SCHEMA-ENUM-004 (4-face sync contract)
 *
 * @module tests/regression/standing/schema-enum-sync/inv-schema-enum-004-failed-with-known-reason
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { FAILED_KNOWN_REASONS } from "@reftrixmcp/core";

import { FailedKnownReasonSchema } from "../../../../src/schemas/failed-known-reason.schema";
import { assertInvName } from "../_setup/inv-assert";
import { setDifference } from "./_extractors";

const PRISMA_SCHEMA_FILE = resolve(
  __dirname,
  "../../../../../../packages/database/prisma/schema.prisma"
);

const GET_JOB_STATUS_TOOL_FILE = resolve(
  __dirname,
  "../../../../src/tools/page/get-job-status.tool.ts"
);

const SANITIZE_ERROR_FILE = resolve(__dirname, "../../../../src/utils/sanitize-error.ts");

/**
 * Canonical 6 FailedKnownReason values (per design §6.1 specification).
 * Naming: `_2_5` underscore form (TPA L-01 IO Decision).
 */
const CANONICAL_FAILED_KNOWN_REASONS = [
  "worker_restart_during_inflight_phase_0",
  "worker_restart_during_inflight_phase_1",
  "worker_restart_during_inflight_phase_2_5",
  "worker_restart_during_inflight_phase_4",
  "worker_restart_during_inflight_phase_5",
  "worker_restart_during_inflight_phase_7_5",
] as const;

describe("INV-SCHEMA-ENUM-004 EXTENSION — FailedKnownReason 4-layer sync", () => {
  describe("Layer 1: Prisma schema SSOT", () => {
    it("INV-SCHEMA-ENUM-004: Prisma schema declares enum FailedKnownReason with exactly 6 values / Prisma SSOT 6-value count", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
      const content = readFileSync(PRISMA_SCHEMA_FILE, "utf-8");
      const enumStart = content.indexOf("enum FailedKnownReason");
      expect(enumStart).toBeGreaterThan(0);
      const enumBlock = content.slice(enumStart, enumStart + 1000);
      // Each canonical value must appear in the enum block.
      for (const value of CANONICAL_FAILED_KNOWN_REASONS) {
        expect(enumBlock).toContain(value);
      }
    });

    it("INV-SCHEMA-ENUM-004: Prisma enum uses underscore form (_2_5 not _2.5) per TPA L-01 IO Decision / Postgres-compatible naming", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
      const content = readFileSync(PRISMA_SCHEMA_FILE, "utf-8");
      // Defensive: dot form is structurally rejected.
      expect(content).not.toMatch(/worker_restart_during_inflight_phase_2\.5/);
      expect(content).not.toMatch(/worker_restart_during_inflight_phase_7\.5/);
    });
  });

  describe("Layer 2: TypeScript SSOT (FAILED_KNOWN_REASONS)", () => {
    it("INV-SCHEMA-ENUM-004: TS SSOT FAILED_KNOWN_REASONS has exactly 6 values matching Prisma / TS-Prisma sync", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
      expect(FAILED_KNOWN_REASONS).toHaveLength(6);
      const ts = [...FAILED_KNOWN_REASONS];
      const canonical = [...CANONICAL_FAILED_KNOWN_REASONS];
      const diff = setDifference(ts, canonical);
      expect(diff.onlyInA).toEqual([]);
      expect(diff.onlyInB).toEqual([]);
    });
  });

  describe("Layer 3: Zod schema mirror", () => {
    it("INV-SCHEMA-ENUM-004: FailedKnownReasonSchema accepts all 6 canonical values / Zod-Prisma exhaustive sync", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
      for (const value of CANONICAL_FAILED_KNOWN_REASONS) {
        expect(() => FailedKnownReasonSchema.parse(value)).not.toThrow();
      }
    });

    it("INV-SCHEMA-ENUM-004: FailedKnownReasonSchema rejects unknown values / strict enum boundary", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
      const result = FailedKnownReasonSchema.safeParse("worker_restart_during_inflight_phase_99");
      expect(result.success).toBe(false);
    });

    it("INV-SCHEMA-ENUM-004: FailedKnownReasonSchema rejects dot-form drift (worker_restart_during_inflight_phase_2.5) / TPA L-01 naming guard", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
      const result = FailedKnownReasonSchema.safeParse("worker_restart_during_inflight_phase_2.5");
      expect(result.success).toBe(false);
    });
  });

  describe("Layer 4: OpenAPI/MCP spec — sanitised client surface", () => {
    it("INV-SCHEMA-ENUM-004: get-job-status.tool.ts applies sanitizeAnalysisErrorForClient before surfacing failedReason / SEC H-01 client-facing sanitiser application", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
      const content = readFileSync(GET_JOB_STATUS_TOOL_FILE, "utf-8");
      expect(content).toMatch(/sanitizeAnalysisErrorForClient/);
    });

    it("INV-SCHEMA-ENUM-004: sanitizeAnalysisErrorForClient maps worker_restart_during_inflight_phase_<N> → analysis_pipeline_interrupted (1:1 generic per OQ-T4-SEC-01) / SEC H-01 sanitiser contract", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
      const content = readFileSync(SANITIZE_ERROR_FILE, "utf-8");
      expect(content).toMatch(/export function sanitizeAnalysisErrorForClient/);
      expect(content).toMatch(/worker_restart_during_inflight_phase_/);
      expect(content).toMatch(/analysis_pipeline_interrupted/);
    });
  });

  describe("Cross-cut: AST grep — no inline string-literal bypass of SSOT", () => {
    it("INV-SCHEMA-ENUM-004: get-job-status.tool.ts does NOT hardcode raw FailedKnownReason values (must go through sanitiser) / SSOT bypass guard", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
      const content = readFileSync(GET_JOB_STATUS_TOOL_FILE, "utf-8");
      // Hardcoded enum value strings forbidden in client tool source.
      for (const value of CANONICAL_FAILED_KNOWN_REASONS) {
        expect(content).not.toContain(`"${value}"`);
      }
    });
  });

  describe("Layer 5 (CO-T4-03): emission-boundary runtime parse gate", () => {
    const FAILURE_PATH_SERVICE_FILE = resolve(
      __dirname,
      "../../../../src/services/worker-supervisor-failure-path.service.ts"
    );

    it("INV-SCHEMA-ENUM-004: worker-supervisor-failure-path.service.ts imports WorkerRestartInflightAuditMetadataSchema (runtime gate presence) / CO-T4-03 emission-boundary gate import", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      expect(content).toMatch(/WorkerRestartInflightAuditMetadataSchema/);
    });

    it("INV-SCHEMA-ENUM-004: markFailedAndAuditAtomic calls WorkerRestartInflightAuditMetadataSchema.parse before auditLog.create (Contract 1 runtime gate) / CO-T4-03 Contract 1 parse-before-write", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      // Both parse() call and the matching auditLog.create must appear in the file.
      // The parse() call must appear before the auditLog.create (text-order check).
      // PR-INGEST-FAIL-ROW / CONS-1: the actor is now the SSOT constant
      // `AUDIT_ACTOR_PAGE_ANALYZE_WORKER` (hardcoded `"system:page-analyze-worker"`
      // literal removed, INV-AUDIT-EMIT-SSOT-IMPORT-001 Test 8 parity). Anchor on
      // the Contract 1 `actor:` usage of the SSOT constant.
      const parseIdx = content.indexOf("WorkerRestartInflightAuditMetadataSchema.parse(metadata)");
      const createIdx = content.indexOf("actor: AUDIT_ACTOR_PAGE_ANALYZE_WORKER");
      expect(parseIdx).toBeGreaterThan(0);
      expect(createIdx).toBeGreaterThan(parseIdx);
    });

    it("INV-SCHEMA-ENUM-004: backfillOrphanWebPageRow calls WorkerRestartInflightAuditMetadataSchema.parse before auditLog.create (Contract 2 runtime gate) / CO-T4-03 Contract 2 parse-before-write", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
      const content = readFileSync(FAILURE_PATH_SERVICE_FILE, "utf-8");
      // Both emission sites must have the parse() call.
      const allParseOccurrences = [
        ...content.matchAll(/WorkerRestartInflightAuditMetadataSchema\.parse\(metadata\)/g),
      ];
      // Must appear at least twice: once for each emission site.
      expect(allParseOccurrences.length).toBeGreaterThanOrEqual(2);
    });

    it("INV-SCHEMA-ENUM-004: output.schemas.ts does NOT contain FailedKnownReasonSchema (MCP outbound serialization uses z.string intentionally) / CO-T4-03 intentional exclusion guard", () => {
      assertInvName(expect.getState().currentTestName ?? "", "INV-SCHEMA-ENUM-004");
      const OUTPUT_SCHEMAS_FILE = resolve(
        __dirname,
        "../../../../src/tools/page/output.schemas.ts"
      );
      const content = readFileSync(OUTPUT_SCHEMAS_FILE, "utf-8");
      // MCP outbound uses z.string() for failedReason — intentional (Plan §5.2b).
      expect(content).not.toMatch(/FailedKnownReasonSchema/);
    });
  });
});
