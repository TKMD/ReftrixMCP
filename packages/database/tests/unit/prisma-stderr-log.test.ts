// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";
import { forwardPrismaLogsToStderr, prismaEventLogConfig } from "../../src/utils/prisma-stderr-log";

// INV-DB-STDOUT-SILENT-001: Prisma must not log to stdout (MCP stdio owns stdout)
describe("prisma stderr log routing", () => {
  it("never configures a stdout log level", () => {
    for (const c of prismaEventLogConfig(["query", "error", "warn"])) expect(c.emit).toBe("event");
  });
  it("forwards events to console.error and not console.log", () => {
    const handlers: Record<string, (e: { message?: string; query?: string }) => void> = {};
    const client = { $on: (l: string, cb: (e: never) => void) => (handlers[l] = cb as never) };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    forwardPrismaLogsToStderr(client, ["query", "error"]);
    handlers.query({ query: "LOAD 'vector'" });
    handlers.error({ message: "boom" });
    expect(err).toHaveBeenCalledTimes(2);
    expect(out).not.toHaveBeenCalled();
    err.mockRestore();
    out.mockRestore();
  });
});
