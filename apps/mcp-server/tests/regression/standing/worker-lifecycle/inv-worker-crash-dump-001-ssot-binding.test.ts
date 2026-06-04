// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-WORKER-CRASH-DUMP-001 — SSOT binding AST scan (Wave 3 PR3c)
 *
 * Plan v3 T2 V1 §7.2 case #5 (Δ12 INV-AUDIT-EMIT-SSOT-IMPORT-001 consumer
 * compliance). Asserts the T2 V1 crash dump callsites are bound to the SSOT
 * `audit-log.service.ts` and do NOT contain forbidden patterns:
 *
 *   1. `.slice(0, 8) + "..."` hardcoded literal
 *   2. private re-declaration of `SENSITIVE_KEYS` / `AUDIT_SENSITIVE_KEYS`
 *   3. any non-imported truncation length constant
 *
 * Standing regression contract (CI-failing, P0 incident on fail):
 *   - `crash-report-sanitizer.ts` MUST import `AUDIT_LOG_CONSTANTS`,
 *     `AUDIT_SENSITIVE_KEYS`, and `truncateAuditTargetId` from
 *     `./audit-log.service`.
 *   - The 3 NEW audit_logs action constants MUST be declared in the
 *     SSOT `audit/audit-actions.ts` file (not re-declared elsewhere).
 *   - No forbidden patterns appear in T2 V1 NEW files.
 *
 * @see Plan v3 T2 V1 §4.3 Δ12 + §5.1 INV-AUDIT-EMIT-SSOT-IMPORT-001 + §13.13
 * @see ADR-0032 Wave 5 LCC canonical CWE-209 SSOT pattern
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..", "..");
const MCP_SERVER_SRC = path.join(REPO_ROOT, "apps", "mcp-server", "src");

// T2 V1 NEW production files in scope of the AST scan.
const T2_V1_PRODUCTION_FILES = [
  path.join(MCP_SERVER_SRC, "services", "crash-report-sanitizer.ts"),
  path.join(MCP_SERVER_SRC, "services", "crash-dump-persistence.service.ts"),
  path.join(MCP_SERVER_SRC, "services", "crash-report-watcher.ts"),
  path.join(MCP_SERVER_SRC, "cron", "crash-dump-cleanup-cron.ts"),
];

// Helper: read a file as UTF-8.
function readFile(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

describe("INV-WORKER-CRASH-DUMP-001 — Δ12 SSOT binding (V1 §7.2 case #5)", () => {
  // INV-AUDIT-EMIT-SSOT-IMPORT-001
  it("crash-report-sanitizer.ts imports SSOT symbols from audit-log.service", () => {
    const content = readFile(path.join(MCP_SERVER_SRC, "services", "crash-report-sanitizer.ts"));
    // SSOT import (3 symbols at minimum).
    expect(content).toMatch(
      /import\s*\{[^}]*AUDIT_LOG_CONSTANTS[^}]*\}\s*from\s*['"]\.\/audit-log\.service['"];?/
    );
    expect(content).toMatch(
      /import\s*\{[^}]*AUDIT_SENSITIVE_KEYS[^}]*\}\s*from\s*['"]\.\/audit-log\.service['"];?/
    );
    expect(content).toMatch(
      /import\s*\{[^}]*truncateAuditTargetId[^}]*\}\s*from\s*['"]\.\/audit-log\.service['"];?/
    );
  });

  // INV-AUDIT-EMIT-SSOT-IMPORT-001
  it("crash-report-sanitizer.ts does NOT re-declare SENSITIVE_KEYS or AUDIT_SENSITIVE_KEYS", () => {
    const content = readFile(path.join(MCP_SERVER_SRC, "services", "crash-report-sanitizer.ts"));
    // Forbidden: `const SENSITIVE_KEYS = ...` declaration.
    expect(content).not.toMatch(/^\s*const\s+SENSITIVE_KEYS\s*=/m);
    expect(content).not.toMatch(/^\s*const\s+AUDIT_SENSITIVE_KEYS\s*=/m);
    // The only allowed reference is via import.
    expect(content).toMatch(/import[^;]*AUDIT_SENSITIVE_KEYS/);
  });

  // INV-AUDIT-EMIT-SSOT-IMPORT-001
  it("crash-report-sanitizer.ts does NOT contain hardcoded .slice(0, 8) + '...' literal in executable code", () => {
    const content = readFile(path.join(MCP_SERVER_SRC, "services", "crash-report-sanitizer.ts"));
    // V1 §4.3 forbidden pattern: hardcoded `.slice(0, 8) + "..."` literal.
    // Documentation comments referencing the forbidden pattern (e.g., to
    // warn future implementers) are permitted; only EXECUTABLE code uses
    // are forbidden. We strip block comments and line comments before the
    // regex match so the comment reference in the file header does not
    // trip the assertion.
    const codeOnly = stripComments(content);
    expect(codeOnly).not.toMatch(/\.slice\(\s*0\s*,\s*8\s*\)\s*\+\s*['"]\.\.\.['"]/);
  });

  // INV-AUDIT-EMIT-SSOT-IMPORT-001
  it("crash-report-watcher.ts imports the 3 NEW audit_logs action constants from SSOT", () => {
    const content = readFile(path.join(MCP_SERVER_SRC, "services", "crash-report-watcher.ts"));
    // At minimum, the watcher must import `worker_crash_report_emitted` from
    // the audit-actions SSOT.
    expect(content).toMatch(
      /import\s*\{[^}]*AUDIT_ACTION_WORKER_CRASH_REPORT_EMITTED[^}]*\}\s*from\s*['"]\.\.\/audit\/audit-actions['"];?/
    );
    // No private re-declaration of the action string anywhere.
    expect(content).not.toMatch(/=\s*['"]worker_crash_report_emitted['"]\s*as\s*const/);
  });

  // INV-AUDIT-EMIT-SSOT-IMPORT-001
  it("crash-dump-cleanup-cron.ts imports cleanup + orphan action constants from SSOT", () => {
    const content = readFile(path.join(MCP_SERVER_SRC, "cron", "crash-dump-cleanup-cron.ts"));
    expect(content).toMatch(
      /import\s*\{[^}]*AUDIT_ACTION_WORKER_CRASH_DUMP_CLEANUP[^}]*\}\s*from\s*['"]\.\.\/audit\/audit-actions['"];?/
    );
    expect(content).toMatch(
      /import\s*\{[^}]*AUDIT_ACTION_WORKER_CRASH_REPORT_ORPHANED[^}]*\}\s*from\s*['"]\.\.\/audit\/audit-actions['"];?/
    );
  });

  // INV-AUDIT-EMIT-SSOT-IMPORT-001
  it("audit-actions.ts SSOT declares the 3 NEW T2 V1 action constants", () => {
    const content = readFile(path.join(MCP_SERVER_SRC, "audit", "audit-actions.ts"));
    expect(content).toMatch(
      /AUDIT_ACTION_WORKER_CRASH_REPORT_EMITTED\s*=\s*['"]worker_crash_report_emitted['"]/
    );
    expect(content).toMatch(
      /AUDIT_ACTION_WORKER_CRASH_DUMP_CLEANUP\s*=\s*['"]worker_crash_dump_cleanup['"]/
    );
    expect(content).toMatch(
      /AUDIT_ACTION_WORKER_CRASH_REPORT_ORPHANED\s*=\s*['"]worker_crash_report_orphaned['"]/
    );
  });

  // INV-AUDIT-EMIT-SSOT-IMPORT-001
  it("audit-log.service.ts exports AUDIT_SENSITIVE_KEYS and truncateAuditTargetId", () => {
    const content = readFile(path.join(MCP_SERVER_SRC, "services", "audit-log.service.ts"));
    // Wave 3 PR3a SSOT expansion.
    expect(content).toMatch(/export\s+const\s+AUDIT_SENSITIVE_KEYS\s*=/);
    expect(content).toMatch(/export\s+function\s+truncateAuditTargetId\s*\(/);
    // Existing canonical export.
    expect(content).toMatch(/export\s+const\s+AUDIT_LOG_CONSTANTS\s*=/);
    // Constant remains the canonical value 8.
    expect(content).toMatch(/TARGET_ID_TRUNCATE_LENGTH:\s*8/);
  });

  // INV-AUDIT-EMIT-SSOT-IMPORT-001
  it("no T2 V1 production file contains forbidden hardcoded truncation literal (executable code only)", () => {
    for (const file of T2_V1_PRODUCTION_FILES) {
      const content = readFile(file);
      const codeOnly = stripComments(content);
      expect(codeOnly, `File ${path.basename(file)} contains forbidden literal`).not.toMatch(
        /\.slice\(\s*0\s*,\s*8\s*\)\s*\+\s*['"]\.\.\.['"]/
      );
    }
  });
});

// ============================================================================
// Helper: strip TypeScript comments so AST-style regexes only match code.
// ============================================================================
function stripComments(source: string): string {
  // Remove /* ... */ block comments (non-greedy across lines).
  let result = source.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove // ... line comments to end of line.
  result = result.replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix: string) => prefix);
  return result;
}
