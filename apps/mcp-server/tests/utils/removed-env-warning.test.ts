// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  REMOVED_INTERNAL_API_ENV,
  warnIfRemovedInternalApiEnv,
} from "../../src/utils/removed-env-warning";

describe("warnIfRemovedInternalApiEnv", () => {
  it("emits exactly one [DEPRECATION] warning when the removed variable is set", () => {
    const warn = vi.fn();
    const emitted = warnIfRemovedInternalApiEnv({ WEBUI_INTERNAL_API_ENABLED: "true" }, { warn });
    expect(emitted).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain("[DEPRECATION]");
    expect(message).toContain(REMOVED_INTERNAL_API_ENV);
  });

  it("warns for any non-empty value, including the old opt-out value", () => {
    const warn = vi.fn();
    expect(warnIfRemovedInternalApiEnv({ WEBUI_INTERNAL_API_ENABLED: "false" }, { warn })).toBe(
      true
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("never puts the configured value into the warning message", () => {
    const marker = "SECRET-MARKER-9f3a7c";
    const warn = vi.fn();
    warnIfRemovedInternalApiEnv({ WEBUI_INTERNAL_API_ENABLED: marker }, { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(marker);
  });

  it("is silent when the variable is unset or empty", () => {
    const warn = vi.fn();
    expect(warnIfRemovedInternalApiEnv({}, { warn })).toBe(false);
    expect(warnIfRemovedInternalApiEnv({ WEBUI_INTERNAL_API_ENABLED: "" }, { warn })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("is wired into the server entry point and no internal API server is started", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/index.ts"), "utf8");
    expect(src).toContain("warnIfRemovedInternalApiEnv()");
    expect(src).not.toMatch(/startInternalApi|api\/internal/);
  });
});
