// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5 Config Tests
 *
 * `loadPhase5Config()` の境界値・異常値・デフォルト値処理を検証する。
 * Zod スキーマのレンジ（512 MB 〜 131,072 MB）と NaN / Infinity / 負値の
 * fallback 動作を確認する。
 *
 * PR-V3-T1a §3.4.2 / FIND-V3-IO-M-07 absorbed-as-tail per IO Plan Decision V1
 * (anchor 019dfab3-607d): DEFAULT_PARENT_RSS_MAX_MB raised 7168 → 8192 in
 * commit dcc754ee. T1a #38 NOT re-opened (CC-3 Phase 3 docs traceability via
 * FIND-V3-IO-M-07 disposition update + 3-CHANGELOG cross-reference).
 *
 * PR-V3-T1a (2026-05-06):
 * - DEFAULT_PARENT_RSS_MAX_MB を 7168 → 8192 に再緩和（dcc754ee で実装、
 *   本 test は Phase 2 cleanup-pre-existing-baseline で同期）
 *
 * PR7e-β2 (2026-04-17):
 * - DEFAULT_PARENT_RSS_MAX_MB を 4096 → 7168 にさらに段階緩和
 *   (reftrix.io: RSS=5528MB, Stripe: RSS=5027MB の実測値で β1 4096 でも
 *    early skip が発動していたため、観測最大値+10% マージンで 7168 に引上げ)
 *
 * PR7e-β1 (2026-04-16):
 * - DEFAULT_PARENT_RSS_MAX_MB を 3072 → 4096 に段階緩和
 * - DEFAULT_MAX_SECTIONS_INPUT (=50) + PHASE5_MAX_SECTIONS_INPUT env を新設
 *
 * Verifies `loadPhase5Config()` behaviour on boundary / invalid / default inputs.
 *
 * PR-V3-T1a (2026-05-06):
 * - DEFAULT_PARENT_RSS_MAX_MB raised 7168 → 8192 (committed in dcc754ee;
 *   this test re-aligned in Phase 2 cleanup-pre-existing-baseline)
 *
 * PR7e-β2 (2026-04-17):
 * - DEFAULT_PARENT_RSS_MAX_MB raised 4096 → 7168 (further tier relaxation
 *   based on measured Phase 5 entry RSS: reftrix.io=5528MB, Stripe=5027MB
 *   still hitting β1 4096 ceiling; raised to observed max + ~10% headroom)
 *
 * PR7e-β1 (2026-04-16):
 * - DEFAULT_PARENT_RSS_MAX_MB raised from 3072 → 4096 (tier relaxation)
 * - New DEFAULT_MAX_SECTIONS_INPUT (=50) + PHASE5_MAX_SECTIONS_INPUT env
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { loadPhase5Config, Phase5ConfigSchema } from "../../src/config/phase5-config";

describe("Phase 5 Config — parentRssMaxMb", () => {
  const originalRss = process.env["PHASE5_PARENT_RSS_MAX_MB"];
  const originalSections = process.env["PHASE5_MAX_SECTIONS_INPUT"];

  beforeEach(() => {
    delete process.env["PHASE5_PARENT_RSS_MAX_MB"];
    delete process.env["PHASE5_MAX_SECTIONS_INPUT"];
  });

  afterEach(() => {
    if (originalRss === undefined) {
      delete process.env["PHASE5_PARENT_RSS_MAX_MB"];
    } else {
      process.env["PHASE5_PARENT_RSS_MAX_MB"] = originalRss;
    }
    if (originalSections === undefined) {
      delete process.env["PHASE5_MAX_SECTIONS_INPUT"];
    } else {
      process.env["PHASE5_MAX_SECTIONS_INPUT"] = originalSections;
    }
  });

  it("should return default (8192 MB) when env var is unset (PR-V3-T1a tier relaxation)", () => {
    const config = loadPhase5Config();
    expect(config.parentRssMaxMb).toBe(8192);
  });

  it("should accept a valid integer in-range", () => {
    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "8192";
    const config = loadPhase5Config();
    expect(config.parentRssMaxMb).toBe(8192);
  });

  it("should accept lower and upper boundaries (512 and 131072)", () => {
    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "512";
    expect(loadPhase5Config().parentRssMaxMb).toBe(512);

    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "131072";
    expect(loadPhase5Config().parentRssMaxMb).toBe(131072);
  });

  it("should fall back to default (8192) on out-of-range values", () => {
    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "100";
    expect(loadPhase5Config().parentRssMaxMb).toBe(8192);

    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "999999";
    expect(loadPhase5Config().parentRssMaxMb).toBe(8192);
  });

  it("should fall back to default (8192) on NaN / Infinity / negative / non-integer", () => {
    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "not-a-number";
    expect(loadPhase5Config().parentRssMaxMb).toBe(8192);

    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "Infinity";
    expect(loadPhase5Config().parentRssMaxMb).toBe(8192);

    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "-1024";
    expect(loadPhase5Config().parentRssMaxMb).toBe(8192);

    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "1024.5";
    expect(loadPhase5Config().parentRssMaxMb).toBe(8192);
  });

  it("should have a matching Zod schema default", () => {
    const result = Phase5ConfigSchema.parse({});
    expect(result.parentRssMaxMb).toBe(8192);
    expect(result.maxSectionsInput).toBe(50);
  });
});

describe("Phase 5 Config — maxSectionsInput (PR7e-β1)", () => {
  const originalRss = process.env["PHASE5_PARENT_RSS_MAX_MB"];
  const originalSections = process.env["PHASE5_MAX_SECTIONS_INPUT"];

  beforeEach(() => {
    delete process.env["PHASE5_PARENT_RSS_MAX_MB"];
    delete process.env["PHASE5_MAX_SECTIONS_INPUT"];
  });

  afterEach(() => {
    if (originalRss === undefined) {
      delete process.env["PHASE5_PARENT_RSS_MAX_MB"];
    } else {
      process.env["PHASE5_PARENT_RSS_MAX_MB"] = originalRss;
    }
    if (originalSections === undefined) {
      delete process.env["PHASE5_MAX_SECTIONS_INPUT"];
    } else {
      process.env["PHASE5_MAX_SECTIONS_INPUT"] = originalSections;
    }
  });

  it("should return default (50) when env var is unset", () => {
    expect(loadPhase5Config().maxSectionsInput).toBe(50);
  });

  it("should accept valid values in-range", () => {
    process.env["PHASE5_MAX_SECTIONS_INPUT"] = "100";
    expect(loadPhase5Config().maxSectionsInput).toBe(100);

    process.env["PHASE5_MAX_SECTIONS_INPUT"] = "10";
    expect(loadPhase5Config().maxSectionsInput).toBe(10);
  });

  it("should accept boundaries (1 and 500)", () => {
    process.env["PHASE5_MAX_SECTIONS_INPUT"] = "1";
    expect(loadPhase5Config().maxSectionsInput).toBe(1);

    process.env["PHASE5_MAX_SECTIONS_INPUT"] = "500";
    expect(loadPhase5Config().maxSectionsInput).toBe(500);
  });

  it("should fall back to default (50) on below-min (0) / above-max (1000)", () => {
    process.env["PHASE5_MAX_SECTIONS_INPUT"] = "0";
    expect(loadPhase5Config().maxSectionsInput).toBe(50);

    process.env["PHASE5_MAX_SECTIONS_INPUT"] = "1000";
    expect(loadPhase5Config().maxSectionsInput).toBe(50);
  });

  it("should fall back to default (50) on NaN / Infinity / negative / non-integer", () => {
    process.env["PHASE5_MAX_SECTIONS_INPUT"] = "bad";
    expect(loadPhase5Config().maxSectionsInput).toBe(50);

    process.env["PHASE5_MAX_SECTIONS_INPUT"] = "Infinity";
    expect(loadPhase5Config().maxSectionsInput).toBe(50);

    process.env["PHASE5_MAX_SECTIONS_INPUT"] = "-5";
    expect(loadPhase5Config().maxSectionsInput).toBe(50);

    process.env["PHASE5_MAX_SECTIONS_INPUT"] = "50.5";
    expect(loadPhase5Config().maxSectionsInput).toBe(50);
  });

  it("should independently load both env vars", () => {
    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "7168";
    process.env["PHASE5_MAX_SECTIONS_INPUT"] = "100";
    const config = loadPhase5Config();
    expect(config.parentRssMaxMb).toBe(7168);
    expect(config.maxSectionsInput).toBe(100);
  });

  it("should fall back ONLY affected field when one env is invalid and the other is valid", () => {
    // rss invalid, sections valid
    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "Infinity";
    process.env["PHASE5_MAX_SECTIONS_INPUT"] = "100";
    let config = loadPhase5Config();
    expect(config.parentRssMaxMb).toBe(8192); // fallback (PR-V3-T1a)
    expect(config.maxSectionsInput).toBe(100); // preserved

    // rss valid, sections invalid
    process.env["PHASE5_PARENT_RSS_MAX_MB"] = "8192";
    process.env["PHASE5_MAX_SECTIONS_INPUT"] = "NaN";
    config = loadPhase5Config();
    expect(config.parentRssMaxMb).toBe(8192); // preserved
    expect(config.maxSectionsInput).toBe(50); // fallback
  });
});
