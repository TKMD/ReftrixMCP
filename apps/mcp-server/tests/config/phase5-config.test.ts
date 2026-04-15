// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5 Config Tests (v0.4.0 PR7a-2)
 *
 * `loadPhase5Config()` の境界値・異常値・デフォルト値処理を検証する。
 * Zod スキーマのレンジ（512 MB 〜 131,072 MB）と NaN / Infinity / 負値の
 * fallback 動作を確認する。
 *
 * Verifies `loadPhase5Config()` behaviour on boundary / invalid / default inputs.
 * Confirms the Zod range (512 MB – 131,072 MB) and the fallback behaviour on
 * NaN / Infinity / negative values.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { loadPhase5Config, Phase5ConfigSchema } from "../../src/config/phase5-config";

describe("Phase 5 Config (v0.4.0 PR7a-2)", () => {
  const originalEnv = process.env["PHASE5_PARENT_RSS_MAX_MB"];

  beforeEach(() => {
    delete process.env["PHASE5_PARENT_RSS_MAX_MB"];
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["PHASE5_PARENT_RSS_MAX_MB"];
    } else {
      process.env["PHASE5_PARENT_RSS_MAX_MB"] = originalEnv;
    }
  });

  it("should return default (3072 MB) when env var is unset", () => {
    const config = loadPhase5Config();
    expect(config.parentRssMaxMb).toBe(3072);
  });

  it("should accept a valid integer in-range", () => {
    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "4096";
    const config = loadPhase5Config();
    expect(config.parentRssMaxMb).toBe(4096);
  });

  it("should accept lower and upper boundaries (512 and 131072)", () => {
    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "512";
    expect(loadPhase5Config().parentRssMaxMb).toBe(512);

    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "131072";
    expect(loadPhase5Config().parentRssMaxMb).toBe(131072);
  });

  it("should fall back to default on out-of-range values (below 512 / above 131072)", () => {
    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "100";
    expect(loadPhase5Config().parentRssMaxMb).toBe(3072);

    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "999999";
    expect(loadPhase5Config().parentRssMaxMb).toBe(3072);
  });

  it("should fall back to default on NaN / Infinity / negative values", () => {
    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "not-a-number";
    expect(loadPhase5Config().parentRssMaxMb).toBe(3072);

    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "Infinity";
    expect(loadPhase5Config().parentRssMaxMb).toBe(3072);

    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "-1024";
    expect(loadPhase5Config().parentRssMaxMb).toBe(3072);
  });

  it("should fall back to default on non-integer values", () => {
    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "1024.5";
    expect(loadPhase5Config().parentRssMaxMb).toBe(3072);
  });

  it("should have a matching Zod schema default", () => {
    // Zod default は loadPhase5Config の DEFAULT と一致
    // Zod default matches the loader default
    const result = Phase5ConfigSchema.parse({});
    expect(result.parentRssMaxMb).toBe(3072);
  });
});
