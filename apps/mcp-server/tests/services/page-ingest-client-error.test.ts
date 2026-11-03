// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

// 取り込み失敗の client 向け文言 (CWE-209) / Client-facing ingest failure text (CWE-209)

import { describe, it, expect } from "vitest";
import { toClientIngestError } from "../../src/services/page-ingest-adapter";
import { McpError, ErrorCode } from "../../src/utils/errors";

const RAW =
  "page.goto: net::ERR_CONNECTION_REFUSED at http://intranet.corp.example:8080/admin\n" +
  'Call log:\n  - navigating to "http://intranet.corp.example:8080/admin", waiting until "load"';

describe("toClientIngestError", () => {
  it("keeps only the net error code from a Playwright navigation error", () => {
    const out = toClientIngestError(new Error(RAW));
    expect(out).toBe("Navigation failed (net::ERR_CONNECTION_REFUSED)");
    expect(out).not.toContain("intranet");
    expect(out).not.toContain("Call log");
  });

  it("collapses timeouts without the call log", () => {
    const out = toClientIngestError(
      new Error(
        'page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "http://10.0.0.5/"'
      )
    );
    expect(out).toBe("Page load timeout");
  });

  it("returns our own McpError message", () => {
    const e = new McpError(ErrorCode.FORBIDDEN, "Navigation ended at a blocked URL");
    expect(toClientIngestError(e)).toBe("Navigation ended at a blocked URL");
  });

  it("keeps the fixed no-response message", () => {
    expect(toClientIngestError(new Error("No response received from page"))).toBe(
      "No response received from page"
    );
  });

  it("falls back to the generic sanitized message", () => {
    expect(toClientIngestError(new Error("ENOENT: /home/user/.cache/x"))).toBe(
      "An internal error occurred"
    );
    expect(toClientIngestError("weird")).toBe("An internal error occurred");
  });
});
