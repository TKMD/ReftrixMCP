// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PR-D-9 Wave 4 (C-06 / FIND-PLAN-SEC-02): BBOX_RESOLVE_RELOAD env-var parser
 * unit tests.
 *
 * Verifies the strict semantics of `parseBboxReloadIntEnv` and
 * `resolveBboxReloadBudget` per Plan v1.1 §4.3.2 / §6.4 / §6.6 (C-14 branch
 * coverage). Exercises:
 *   - Default values (env var unset)
 *   - Strict integer parsing (rejects "0" / negatives / floats / non-numeric)
 *   - Absolute cap clamping
 *   - `BBOX_RESOLVE_RELOAD_ENABLED` strict `=== "true"` semantics
 *     (FIND-PLAN-SEC-04 silent-enable risk mitigation, CWE-1188)
 *
 * @see Plan v1.1 §4.3.2 / §6.4 (C-06 safety budget)
 * @see Finding Registry FIND-PLAN-SEC-02 / FIND-PLAN-SEC-04
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parseBboxReloadIntEnv,
  resolveBboxReloadBudget,
} from "../../../src/services/part/part-bbox-playwright.service";

describe("parseBboxReloadIntEnv (PR-D-9 Wave 4 / C-06)", () => {
  it("returns default when raw is undefined", () => {
    expect(parseBboxReloadIntEnv(undefined, 5, 100, "TEST_VAR")).toBe(5);
  });

  it("returns default when raw is empty string", () => {
    expect(parseBboxReloadIntEnv("", 5, 100, "TEST_VAR")).toBe(5);
  });

  it("returns default and warns when raw is non-numeric", () => {
    expect(parseBboxReloadIntEnv("abc", 5, 100, "TEST_VAR")).toBe(5);
  });

  it("returns default and warns when raw is zero (not positive)", () => {
    expect(parseBboxReloadIntEnv("0", 5, 100, "TEST_VAR")).toBe(5);
  });

  it("returns default and warns when raw is negative", () => {
    expect(parseBboxReloadIntEnv("-1", 5, 100, "TEST_VAR")).toBe(5);
  });

  it("clamps to absoluteCap when raw exceeds cap", () => {
    expect(parseBboxReloadIntEnv("1000", 5, 100, "TEST_VAR")).toBe(100);
  });

  it("returns parsed value when within range", () => {
    expect(parseBboxReloadIntEnv("42", 5, 100, "TEST_VAR")).toBe(42);
  });

  it("returns absoluteCap exactly when raw equals cap", () => {
    expect(parseBboxReloadIntEnv("100", 5, 100, "TEST_VAR")).toBe(100);
  });
});

describe("resolveBboxReloadBudget (PR-D-9 Wave 4 / C-06 + FIND-PLAN-SEC-04)", () => {
  let originalEnabled: string | undefined;
  let originalMaxReloads: string | undefined;
  let originalTimeout: string | undefined;

  beforeEach(() => {
    originalEnabled = process.env["BBOX_RESOLVE_RELOAD_ENABLED"];
    originalMaxReloads = process.env["BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE"];
    originalTimeout = process.env["BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS"];
    delete process.env["BBOX_RESOLVE_RELOAD_ENABLED"];
    delete process.env["BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE"];
    delete process.env["BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS"];
  });

  afterEach(() => {
    if (originalEnabled === undefined) {
      delete process.env["BBOX_RESOLVE_RELOAD_ENABLED"];
    } else {
      process.env["BBOX_RESOLVE_RELOAD_ENABLED"] = originalEnabled;
    }
    if (originalMaxReloads === undefined) {
      delete process.env["BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE"];
    } else {
      process.env["BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE"] = originalMaxReloads;
    }
    if (originalTimeout === undefined) {
      delete process.env["BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS"];
    } else {
      process.env["BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS"] = originalTimeout;
    }
    vi.restoreAllMocks();
  });

  it("default budget when all env vars unset (enabled=false, maxReloads=5, timeoutMs=60000)", () => {
    const budget = resolveBboxReloadBudget();
    expect(budget.enabled).toBe(false);
    expect(budget.maxReloadsPerPage).toBe(5);
    expect(budget.totalTimeoutMs).toBe(60_000);
  });

  it('enabled=true ONLY when BBOX_RESOLVE_RELOAD_ENABLED === "true" (strict semantics)', () => {
    process.env["BBOX_RESOLVE_RELOAD_ENABLED"] = "true";
    expect(resolveBboxReloadBudget().enabled).toBe(true);
  });

  it("enabled=false on canonical 'false' value", () => {
    process.env["BBOX_RESOLVE_RELOAD_ENABLED"] = "false";
    expect(resolveBboxReloadBudget().enabled).toBe(false);
  });

  it('FIND-PLAN-SEC-04: silent-enable risk — "1" is rejected (defaults to false + warn)', () => {
    process.env["BBOX_RESOLVE_RELOAD_ENABLED"] = "1";
    expect(resolveBboxReloadBudget().enabled).toBe(false);
  });

  it('FIND-PLAN-SEC-04: silent-enable risk — "yes" is rejected (defaults to false + warn)', () => {
    process.env["BBOX_RESOLVE_RELOAD_ENABLED"] = "yes";
    expect(resolveBboxReloadBudget().enabled).toBe(false);
  });

  it('FIND-PLAN-SEC-04: silent-enable risk — "True" (capital T) is rejected', () => {
    process.env["BBOX_RESOLVE_RELOAD_ENABLED"] = "True";
    expect(resolveBboxReloadBudget().enabled).toBe(false);
  });

  it("respects custom maxReloadsPerPage when set", () => {
    process.env["BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE"] = "10";
    expect(resolveBboxReloadBudget().maxReloadsPerPage).toBe(10);
  });

  it("clamps maxReloadsPerPage to absolute cap (100)", () => {
    process.env["BBOX_RESOLVE_RELOAD_ENABLED_MAX_RELOADS_PER_PAGE"] = "500";
    expect(resolveBboxReloadBudget().maxReloadsPerPage).toBe(100);
  });

  it("respects custom totalTimeoutMs when set", () => {
    process.env["BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS"] = "30000";
    expect(resolveBboxReloadBudget().totalTimeoutMs).toBe(30_000);
  });

  it("clamps totalTimeoutMs to absolute cap (600000ms = 10min)", () => {
    process.env["BBOX_RESOLVE_RELOAD_TOTAL_TIMEOUT_MS"] = "9999999";
    expect(resolveBboxReloadBudget().totalTimeoutMs).toBe(600_000);
  });
});
