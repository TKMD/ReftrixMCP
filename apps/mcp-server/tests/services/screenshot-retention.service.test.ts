// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the screenshot retention policy primitives (inactive: nothing calls them yet).
 * スクリーンショット保持期限の方針部品のユニットテスト (非活性: まだ呼ぶものはない)
 *
 * env の解析、終端の分類、分類から生成した適格条件、監査 SSOT 定数を固定する。
 * Pins env parsing, the terminal classification, the eligibility predicate generated from
 * it, and the audit SSOT constants.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EmbeddingBackfillStatus, type PrismaClient } from "@prisma/client";

import {
  AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED,
  AUDIT_ACTOR_SCREENSHOT_RETENTION_CRON,
} from "../../src/audit/audit-actions";
import {
  RETENTION_BATCH_SIZE,
  RETENTION_MAX_BATCHES,
  RETENTION_MAX_ROWS_PER_RUN,
  RETENTION_MAX_SCAN_BATCHES,
  RETENTION_SCAN_BATCH_MULTIPLIER,
  RETENTION_MS_PER_DAY,
  RETENTION_ROW_TX_MAX_WAIT_MS,
  RETENTION_ROW_TX_TIMEOUT_MS,
  RETENTION_TERMINAL_ANALYSIS_STATUSES,
  RETENTION_TERMINAL_BACKFILL_STATUSES,
  SCREENSHOT_RETENTION_DAYS_ENV,
  ScreenshotRetentionConfigError,
  SCREENSHOT_RETENTION_DEFAULT_DAYS,
  SCREENSHOT_RETENTION_MAX_DAYS,
  buildNonCanonicalPathPredicate,
  buildRetentionEligibilityPredicate,
  checkPhase5Dir,
  classifyBackfillStatusForRetention,
  getScreenshotRetentionDays,
  removeScreenshotFile,
  resolveScreenshotRetentionDays,
  type RetentionPrismaClient,
} from "../../src/services/screenshot-retention.service";
import { logger } from "../../src/utils/logger";

const NOW = new Date("2026-10-27T00:00:00.000Z");

// =====================================================
// env: retention days
// =====================================================

describe("resolveScreenshotRetentionDays / getScreenshotRetentionDays", () => {
  it("accepts decimal integers in 1..30 as given (positive control)", () => {
    for (const [raw, days] of [
      ["1", 1],
      ["7", 7],
      ["14", 14],
      ["30", 30],
      ["007", 7],
    ] as const) {
      expect(resolveScreenshotRetentionDays(raw)).toEqual({ days, status: "ok" });
    }
  });

  it("uses the default silently when unset or empty", () => {
    const expected = { days: SCREENSHOT_RETENTION_DEFAULT_DAYS, status: "default" };
    expect(resolveScreenshotRetentionDays(undefined)).toEqual(expected);
    expect(resolveScreenshotRetentionDays("")).toEqual(expected);
  });

  it("clamps a value above the maximum to the maximum (never to the shorter default)", () => {
    for (const raw of ["31", "365", "9999999999999999999999999999"]) {
      expect(resolveScreenshotRetentionDays(raw), `raw=${raw}`).toEqual({
        days: SCREENSHOT_RETENTION_MAX_DAYS,
        status: "clamped",
      });
    }
  });

  it("marks 0, negatives, non-integers and prefix matches invalid, with no days", () => {
    for (const raw of [
      "0",
      "-3",
      "7abc",
      "abc",
      "1.5",
      " 7",
      "7 ",
      "1e1",
      "0x10",
      "+7",
      "Infinity",
    ]) {
      expect(resolveScreenshotRetentionDays(raw), `raw=${raw}`).toEqual({
        days: null,
        status: "invalid",
      });
    }
  });

  it("getScreenshotRetentionDays: warns only on a clamp, throws on an invalid value", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(getScreenshotRetentionDays({ [SCREENSHOT_RETENTION_DAYS_ENV]: "14" })).toBe(14);
    expect(getScreenshotRetentionDays({})).toBe(SCREENSHOT_RETENTION_DEFAULT_DAYS);
    expect(warn).not.toHaveBeenCalled();
    expect(getScreenshotRetentionDays({ [SCREENSHOT_RETENTION_DAYS_ENV]: "365" })).toBe(
      SCREENSHOT_RETENTION_MAX_DAYS
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => getScreenshotRetentionDays({ [SCREENSHOT_RETENTION_DAYS_ENV]: "7abc" })).toThrow(
      ScreenshotRetentionConfigError
    );
    // the message names the env var but never echoes the raw value
    try {
      getScreenshotRetentionDays({ [SCREENSHOT_RETENTION_DAYS_ENV]: "secret-7abc" });
    } catch (error) {
      expect((error as Error).message).toContain(SCREENSHOT_RETENTION_DAYS_ENV);
      expect((error as Error).message).not.toContain("secret");
    }
  });

  it("uses the documented env var name", () => {
    expect(SCREENSHOT_RETENTION_DAYS_ENV).toBe("REFTRIX_SCREENSHOT_RETENTION_DAYS");
  });
});

// =====================================================
// Terminal classification and generated predicate
// =====================================================

describe("terminal classification", () => {
  it("classifies every EmbeddingBackfillStatus value", () => {
    for (const status of Object.values(EmbeddingBackfillStatus)) {
      expect(["terminal", "non_terminal"]).toContain(classifyBackfillStatusForRetention(status));
    }
  });

  it("terminal = not_required / completed / failed / skipped_screenshot_missing", () => {
    expect([...RETENTION_TERMINAL_BACKFILL_STATUSES].sort()).toEqual(
      ["completed", "failed", "not_required", "skipped_screenshot_missing"].sort()
    );
  });

  it("the five rows a backfill reader still uses are non-terminal", () => {
    for (const status of [
      "queued",
      "in_progress",
      "skipped_fork_error",
      "skipped_memory_pressure",
      "failed_with_known_reason",
    ] as const) {
      expect(classifyBackfillStatusForRetention(status)).toBe("non_terminal");
      expect(RETENTION_TERMINAL_BACKFILL_STATUSES).not.toContain(status);
    }
  });

  it("the predicate binds exactly the generated lists, cutoff, the phase5 prefix and no hand-written status", () => {
    const cutoff = new Date(
      NOW.getTime() - SCREENSHOT_RETENTION_DEFAULT_DAYS * RETENTION_MS_PER_DAY
    );
    const prefix = "/data/phase5/";
    const predicate = buildRetentionEligibilityPredicate(cutoff, prefix);
    expect(predicate.values).toEqual([
      ...RETENTION_TERMINAL_BACKFILL_STATUSES,
      ...RETENTION_TERMINAL_ANALYSIS_STATUSES,
      cutoff,
      prefix,
    ]);
    expect(predicate.sql).toContain("screenshot_storage_path IS NOT NULL");
    expect(predicate.sql).toContain("updated_at <");
    expect(predicate.sql).toContain("screenshot_storage_path = ?");
    expect(predicate.sql).toContain("id::text");
    for (const literal of Object.values(EmbeddingBackfillStatus)) {
      expect(predicate.sql).not.toContain(`'${literal}'`);
    }
  });

  it("the non-canonical predicate is the terminal part AND NOT the canonical match (same bindings)", () => {
    const cutoff = new Date(NOW.getTime() - RETENTION_MS_PER_DAY);
    const prefix = "/data/phase5/";
    const eligible = buildRetentionEligibilityPredicate(cutoff, prefix);
    const other = buildNonCanonicalPathPredicate(cutoff, prefix);
    expect(other.values).toEqual(eligible.values);
    expect(other.sql).toContain("NOT (");
  });
});

describe("audit SSOT constants", () => {
  it("uses the system: actor and a snake_case action (no ttl-cron literal)", () => {
    expect(AUDIT_ACTOR_SCREENSHOT_RETENTION_CRON).toBe("system:screenshot-retention-cron");
    expect(AUDIT_ACTION_SCREENSHOT_RETENTION_EXPIRED).toBe("screenshot_retention_expired");
  });
});

describe("removeScreenshotFile (deleted | absent | failed)", () => {
  let sandbox: string;
  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "fua1a-remove-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const ID = "0192f3a0-0000-7000-8000-000000000001";

  it("deleted: removes an existing file", async () => {
    const file = path.join(sandbox, `${ID}.png`);
    await fs.writeFile(file, "x");
    await expect(removeScreenshotFile(file, ID)).resolves.toBe("deleted");
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("absent: a missing file is not an error and is not logged as a failure", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await expect(removeScreenshotFile(path.join(sandbox, `${ID}.png`), ID)).resolves.toBe("absent");
    expect(warn).not.toHaveBeenCalled();
  });

  it("failed: any other error keeps the file, warns, and never throws (a directory cannot be unlinked)", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const dir = path.join(sandbox, `${ID}.png`);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, "inner"), "x");
    await expect(removeScreenshotFile(dir, ID)).resolves.toBe("failed");
    await expect(fs.lstat(dir)).resolves.toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    // PII-truncated id only in the log
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain(ID);
  });
});

describe("checkPhase5Dir (fail-closed)", () => {
  let sandbox: string;
  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "fua1a-phase5-"));
  });
  afterEach(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("null for a real directory (positive control)", async () => {
    await expect(checkPhase5Dir(sandbox)).resolves.toBeNull();
  });

  it("phase5_dir_missing when it does not exist", async () => {
    await expect(checkPhase5Dir(path.join(sandbox, "nope"))).resolves.toBe("phase5_dir_missing");
  });

  it("phase5_dir_unsafe for a symlink to a real directory", async () => {
    const real = path.join(sandbox, "real");
    const link = path.join(sandbox, "link");
    await fs.mkdir(real);
    await fs.symlink(real, link);
    await expect(checkPhase5Dir(link)).resolves.toBe("phase5_dir_unsafe");
  });

  it("phase5_dir_unsafe for a regular file", async () => {
    const file = path.join(sandbox, "file");
    await fs.writeFile(file, "x");
    await expect(checkPhase5Dir(file)).resolves.toBe("phase5_dir_unsafe");
  });
});

describe("cycle limits (CWE-770) and types", () => {
  it("one run is bounded to 200 rows x 10 batches, and the cap is derived from them", () => {
    expect(RETENTION_BATCH_SIZE).toBe(200);
    expect(RETENTION_MAX_BATCHES).toBe(10);
    expect(RETENTION_MAX_ROWS_PER_RUN).toBe(RETENTION_BATCH_SIZE * RETENTION_MAX_BATCHES);
    expect(RETENTION_MAX_ROWS_PER_RUN).toBe(2000);
  });

  it("the scan budget is a multiple of the cleared budget and derived from it", () => {
    expect(RETENTION_MAX_SCAN_BATCHES).toBe(
      RETENTION_MAX_BATCHES * RETENTION_SCAN_BATCH_MULTIPLIER
    );
    expect(RETENTION_MAX_SCAN_BATCHES).toBeGreaterThan(RETENTION_MAX_BATCHES);
  });

  it("the per-row tx timeout is derived from its lock wait (x3), and a day is 86 400 000 ms", () => {
    expect(RETENTION_ROW_TX_TIMEOUT_MS).toBe(RETENTION_ROW_TX_MAX_WAIT_MS * 3);
    expect(RETENTION_ROW_TX_TIMEOUT_MS).toBeGreaterThan(RETENTION_ROW_TX_MAX_WAIT_MS);
    expect(RETENTION_MS_PER_DAY).toBe(24 * 60 * 60 * 1000);
    expect(RETENTION_MS_PER_DAY).toBe(86_400_000);
  });

  it("the real PrismaClient satisfies the injected surface (compile-time check)", () => {
    const accept = (_client: RetentionPrismaClient): void => undefined;
    const assertCompiles = (client: PrismaClient): void => accept(client);
    expect(typeof assertCompiles).toBe("function");
  });
});
