// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests — `apps/mcp-server/src/utils/env-validators.ts`
 *
 * Plan v3 T5 V1 §1.1 (U-T5-1) + §1.7 U-CC-3:
 *   - `validatePartBboxEnv()` SSOT (5 NEW env vars upper bound enforcement)
 *   - `parseBoundedIntEnv()` shared helper (cross-cohort SSOT)
 *   - `parseBoolEnv()` shared helper (CWE-1188 silent-enable mitigation)
 *
 * Fault injection cases (CWE-770 attack vectors):
 *   - `BBOX_STALE_DETECTION_TOLERANCE_PX=10000` → throws (silent-degrade attack)
 *   - `BBOX_PREEMPTIVE_SCROLL_MAX_ITERATIONS=100` → throws (Phase 0 SSOT cap exceed)
 *   - `BBOX_LAYERED_TOTAL_TIMEOUT_MS=120000` → throws (DoS budget breach)
 *   - Boundary: `=2000` valid / `=2001` throws
 *   - NaN / non-numeric / float / leading-plus → throws
 *   - All env unset → defaults applied
 *
 * @see Plan v3 T5 V1 §1.1 / §3.5 / §6.1
 * @module tests/utils/env-validators
 */

import { describe, it, expect } from "vitest";
import {
  validatePartBboxEnv,
  parseBoundedIntEnv,
  parseBoolEnv,
  validateMallocArenaMaxEnv,
} from "../../src/utils/env-validators";

describe("env-validators (Plan v3 T5 V1 §1.1 SSOT)", () => {
  // ==========================================================================
  // validatePartBboxEnv — defaults applied when env unset
  // ==========================================================================
  describe("validatePartBboxEnv: defaults", () => {
    it("returns canonical defaults when no env var is set", () => {
      const cfg = validatePartBboxEnv({});
      expect(cfg.preEmptiveScrollEnabled).toBe(true);
      expect(cfg.preEmptiveScrollMaxIterations).toBe(30);
      expect(cfg.targetedRequeryEnabled).toBe(true);
      expect(cfg.staleDetectionEnabled).toBe(true);
      expect(cfg.staleDetectionTolerancePx).toBe(500);
      expect(cfg.layeredTotalTimeoutMs).toBe(30_000);
    });
  });

  // ==========================================================================
  // validatePartBboxEnv — fault injection (CWE-770 attack vectors)
  // ==========================================================================
  describe("validatePartBboxEnv: CWE-770 fault injection", () => {
    it("throws on BBOX_STALE_DETECTION_TOLERANCE_PX=10000 (silent-degrade attack vector)", () => {
      expect(() => validatePartBboxEnv({ BBOX_STALE_DETECTION_TOLERANCE_PX: "10000" })).toThrow(
        /BBOX_STALE_DETECTION_TOLERANCE_PX.*1\.\.2000/
      );
    });

    it("throws on BBOX_PREEMPTIVE_SCROLL_MAX_ITERATIONS=100 (exceeds Phase 0 SSOT cap)", () => {
      expect(() => validatePartBboxEnv({ BBOX_PREEMPTIVE_SCROLL_MAX_ITERATIONS: "100" })).toThrow(
        /BBOX_PREEMPTIVE_SCROLL_MAX_ITERATIONS.*1\.\.50/
      );
    });

    it("throws on BBOX_LAYERED_TOTAL_TIMEOUT_MS=120000 (DoS budget breach)", () => {
      expect(() => validatePartBboxEnv({ BBOX_LAYERED_TOTAL_TIMEOUT_MS: "120000" })).toThrow(
        /BBOX_LAYERED_TOTAL_TIMEOUT_MS.*5000\.\.60000/
      );
    });

    it("accepts boundary upper value BBOX_STALE_DETECTION_TOLERANCE_PX=2000", () => {
      const cfg = validatePartBboxEnv({ BBOX_STALE_DETECTION_TOLERANCE_PX: "2000" });
      expect(cfg.staleDetectionTolerancePx).toBe(2000);
    });

    it("throws on boundary-overshoot BBOX_STALE_DETECTION_TOLERANCE_PX=2001", () => {
      expect(() => validatePartBboxEnv({ BBOX_STALE_DETECTION_TOLERANCE_PX: "2001" })).toThrow();
    });

    it("throws on non-numeric BBOX_STALE_DETECTION_TOLERANCE_PX=abc", () => {
      expect(() => validatePartBboxEnv({ BBOX_STALE_DETECTION_TOLERANCE_PX: "abc" })).toThrow(
        /decimal integer/
      );
    });

    it("throws on float BBOX_LAYERED_TOTAL_TIMEOUT_MS=30000.5", () => {
      expect(() => validatePartBboxEnv({ BBOX_LAYERED_TOTAL_TIMEOUT_MS: "30000.5" })).toThrow(
        /decimal integer/
      );
    });

    it("throws on leading-plus BBOX_PREEMPTIVE_SCROLL_MAX_ITERATIONS=+30", () => {
      expect(() => validatePartBboxEnv({ BBOX_PREEMPTIVE_SCROLL_MAX_ITERATIONS: "+30" })).toThrow(
        /decimal integer/
      );
    });

    it("throws on hex BBOX_STALE_DETECTION_TOLERANCE_PX=0x1f4", () => {
      expect(() => validatePartBboxEnv({ BBOX_STALE_DETECTION_TOLERANCE_PX: "0x1f4" })).toThrow(
        /decimal integer/
      );
    });
  });

  // ==========================================================================
  // validatePartBboxEnv — bool env CWE-1188 silent-enable mitigation
  // ==========================================================================
  describe("validatePartBboxEnv: bool CWE-1188 silent-enable mitigation", () => {
    it("throws on non-canonical 'True' (case-sensitive)", () => {
      expect(() => validatePartBboxEnv({ BBOX_PREEMPTIVE_SCROLL_ENABLED: "True" })).toThrow(
        /'true' or 'false'/
      );
    });

    it("throws on non-canonical '1'", () => {
      expect(() => validatePartBboxEnv({ BBOX_PREEMPTIVE_SCROLL_ENABLED: "1" })).toThrow(
        /'true' or 'false'/
      );
    });

    it("throws on non-canonical 'yes'", () => {
      expect(() => validatePartBboxEnv({ BBOX_TARGETED_REQUERY_ENABLED: "yes" })).toThrow(
        /'true' or 'false'/
      );
    });

    it("accepts canonical 'true' and 'false' for all bool envs", () => {
      const cfg = validatePartBboxEnv({
        BBOX_PREEMPTIVE_SCROLL_ENABLED: "false",
        BBOX_TARGETED_REQUERY_ENABLED: "false",
        BBOX_STALE_DETECTION_ENABLED: "false",
      });
      expect(cfg.preEmptiveScrollEnabled).toBe(false);
      expect(cfg.targetedRequeryEnabled).toBe(false);
      expect(cfg.staleDetectionEnabled).toBe(false);
    });
  });

  // ==========================================================================
  // parseBoundedIntEnv — cross-cohort shared helper (U-CC-3 SSOT)
  // ==========================================================================
  describe("parseBoundedIntEnv: cross-cohort SSOT helper", () => {
    it("returns default on undefined / empty", () => {
      expect(parseBoundedIntEnv(undefined, 42, 1, 100, "X")).toBe(42);
      expect(parseBoundedIntEnv("", 42, 1, 100, "X")).toBe(42);
    });

    it("accepts valid in-range integer", () => {
      expect(parseBoundedIntEnv("50", 42, 1, 100, "X")).toBe(50);
      expect(parseBoundedIntEnv("1", 42, 1, 100, "X")).toBe(1);
      expect(parseBoundedIntEnv("100", 42, 1, 100, "X")).toBe(100);
    });

    it("throws on out-of-range", () => {
      expect(() => parseBoundedIntEnv("0", 42, 1, 100, "X")).toThrow();
      expect(() => parseBoundedIntEnv("101", 42, 1, 100, "X")).toThrow();
    });

    it("throws on non-integer / NaN / float", () => {
      expect(() => parseBoundedIntEnv("abc", 42, 1, 100, "X")).toThrow();
      expect(() => parseBoundedIntEnv("1.5", 42, 1, 100, "X")).toThrow();
      expect(() => parseBoundedIntEnv("NaN", 42, 1, 100, "X")).toThrow();
    });

    it("error message includes varName for PII-safe identification", () => {
      expect(() => parseBoundedIntEnv("0", 42, 1, 100, "MY_VAR")).toThrow(/MY_VAR/);
    });
  });

  // ==========================================================================
  // parseBoolEnv — strict CWE-1188 mitigation
  // ==========================================================================
  describe("parseBoolEnv: strict CWE-1188 mitigation", () => {
    it("returns default on undefined / empty", () => {
      expect(parseBoolEnv(undefined, true)).toBe(true);
      expect(parseBoolEnv(undefined, false)).toBe(false);
      expect(parseBoolEnv("", true)).toBe(true);
    });

    it("accepts canonical 'true' / 'false'", () => {
      expect(parseBoolEnv("true", false)).toBe(true);
      expect(parseBoolEnv("false", true)).toBe(false);
    });

    it("throws on case variants ('True', 'TRUE', 'False')", () => {
      expect(() => parseBoolEnv("True", false)).toThrow();
      expect(() => parseBoolEnv("TRUE", false)).toThrow();
      expect(() => parseBoolEnv("False", true)).toThrow();
    });

    it("throws on alternate truthy values ('1', 'yes', 'on')", () => {
      expect(() => parseBoolEnv("1", false)).toThrow();
      expect(() => parseBoolEnv("yes", false)).toThrow();
      expect(() => parseBoolEnv("on", false)).toThrow();
    });
  });

  // ==========================================================================
  // T1ev V1 sanity: validateMallocArenaMaxEnv co-existence
  // ==========================================================================
  describe("validateMallocArenaMaxEnv: T1ev co-existence (no regression)", () => {
    it("returns ok when unset", () => {
      const result = validateMallocArenaMaxEnv(undefined);
      expect(result.level).toBe("ok");
      expect(result.parsed).toBe(0);
    });

    it("returns ok when in recommended bound", () => {
      const result = validateMallocArenaMaxEnv("8");
      expect(result.level).toBe("ok");
      expect(result.parsed).toBe(8);
    });

    it("returns warn when over recommended bound", () => {
      const result = validateMallocArenaMaxEnv("24");
      expect(result.level).toBe("warn");
      expect(result.parsed).toBe(24);
    });

    it("returns fail when over hard bound", () => {
      const result = validateMallocArenaMaxEnv("64");
      expect(result.level).toBe("fail");
      expect(result.parsed).toBe(64);
    });
  });
});
