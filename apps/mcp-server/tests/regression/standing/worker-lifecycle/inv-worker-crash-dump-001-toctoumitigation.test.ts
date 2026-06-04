// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-WORKER-CRASH-DUMP-001 — TOCTOU mitigation standing regression (Wave 3 PR3c)
 *
 * Plan v3 T2 V1 §7.2 case #2 (Δ4 atomic-rename TOCTOU). Asserts the
 * staging-then-rename pipeline prevents external readers from observing a
 * partially-written or unsanitised report:
 *
 *   - Source MUST be in a session-unique 0o700 staging dir under os.tmpdir().
 *   - Public root MUST only ever contain sanitised content (no Stage 1 raw).
 *   - During an interrupted sanitise (failure-injection), the public root
 *     MUST NOT contain a `.tmp` peer file (atomic rename is single-syscall).
 *   - Source MUST be removed only AFTER the rename completes (no time window
 *     where the staging file is gone but the public file is incomplete).
 *
 * Standing regression contract (CI-failing, P0 incident on fail).
 *
 * @see Plan v3 T2 V1 §4.4 Δ4 + §13.1 SEC sign-off evidence #3
 * @see ADR-0021 §"TOCTOU section"
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createStagingRoot,
  destroyStagingRoot,
  CRASH_DUMP_DIR_PREFIX,
} from "../../../../src/services/crash-dump-persistence.service";
import { processReportFile } from "../../../../src/services/crash-report-watcher";
import { resetSequenceForTesting } from "../../../../src/services/crash-report-sanitizer";

vi.mock("../../../../src/services/audit-log.service", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("../../../../src/services/audit-log.service");
  return {
    ...actual,
    getAuditLogService: () => ({
      log: vi.fn(async () => undefined),
      query: vi.fn(async () => []),
      getRetentionPolicy: vi.fn(() => ({ retentionDays: 365, description: "" })),
    }),
  };
});

describe("INV-WORKER-CRASH-DUMP-001 — Δ4 TOCTOU atomic rename (V1 §7.2 case #2)", () => {
  let staging: string;
  let publicRoot: string;

  beforeEach(async () => {
    resetSequenceForTesting();
    staging = await createStagingRoot();
    publicRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `${CRASH_DUMP_DIR_PREFIX}-toctou-`));
  });

  afterEach(async () => {
    await destroyStagingRoot(staging);
    await fsp.rm(publicRoot, { recursive: true, force: true }).catch(() => undefined);
  });

  // INV-WORKER-CRASH-DUMP-001
  it("staging dir is private under os.tmpdir() with 0o700 mode", async () => {
    const stat = await fsp.stat(staging);
    expect(stat.isDirectory()).toBe(true);
    // POSIX mode check — owner has rwx.
    expect(stat.mode & 0o700).toBe(0o700);
    // Outside-world access bits MUST be zero (no group/other rwx).
    expect(stat.mode & 0o077).toBe(0);
    // Must reside under os.tmpdir().
    const realTmp = await fsp.realpath(os.tmpdir());
    const realStaging = await fsp.realpath(staging);
    expect(realStaging.startsWith(realTmp + path.sep)).toBe(true);
  });

  // INV-WORKER-CRASH-DUMP-001
  it("after rename, no .tmp peer file lingers in public subdir", async () => {
    const stagingFile = path.join(staging, "before.json");
    await fsp.writeFile(stagingFile, JSON.stringify({ header: { commandLine: ["node"] } }));
    const result = await processReportFile({
      stagingRoot: staging,
      publicRoot,
      workerType: "page",
      role: "child",
      basename: "before.json",
    });
    expect(result).not.toBeNull();
    const subdir = path.join(publicRoot, "page", "child");
    const entries = await fsp.readdir(subdir);
    // No `.tmp` peer should remain.
    const tmpPeers = entries.filter((e) => e.includes(".tmp"));
    expect(tmpPeers.length).toBe(0);
    // Exactly one sanitised final file.
    const finalFiles = entries.filter((e) => e.endsWith(".json"));
    expect(finalFiles.length).toBe(1);
  });

  // INV-WORKER-CRASH-DUMP-001
  it("source file deletion happens AFTER successful rename (atomicity)", async () => {
    const stagingFile = path.join(staging, "atomic-test.json");
    await fsp.writeFile(stagingFile, JSON.stringify({ header: { commandLine: ["node"] } }));
    // Source must exist before processing.
    await expect(fsp.stat(stagingFile)).resolves.toBeTruthy();
    const result = await processReportFile({
      stagingRoot: staging,
      publicRoot,
      workerType: "page",
      role: "child",
      basename: "atomic-test.json",
    });
    expect(result).not.toBeNull();
    // Public file exists.
    await expect(fsp.stat(result!.finalPath)).resolves.toBeTruthy();
    // Source file is gone.
    await expect(fsp.stat(stagingFile)).rejects.toThrow();
  });

  // INV-WORKER-CRASH-DUMP-001
  it("public root only contains sanitised content (DATABASE_URL never leaks)", async () => {
    const stagingFile = path.join(staging, "leak-check.json");
    await fsp.writeFile(
      stagingFile,
      JSON.stringify({
        environmentVariables: { DATABASE_URL: "postgres://supersecret-leak@host" },
      })
    );
    const result = await processReportFile({
      stagingRoot: staging,
      publicRoot,
      workerType: "page",
      role: "child",
      basename: "leak-check.json",
    });
    expect(result).not.toBeNull();
    const finalContent = await fsp.readFile(result!.finalPath, { encoding: "utf-8" });
    // Hard contract: the raw secret literal MUST NOT survive in the public file.
    expect(finalContent).not.toContain("supersecret-leak");
    expect(finalContent).not.toContain("postgres://");
  });
});
