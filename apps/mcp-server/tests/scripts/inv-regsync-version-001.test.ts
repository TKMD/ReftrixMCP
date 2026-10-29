// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-REGSYNC-VERSION-001 (synced leg) — asserts that are true in the private tree and in
 * the OSS output alike: the mcp-server package name maps to server.json
 * `packages[0].identifier` by the deterministic rename (`@reftrixmcp/` -> `@reftrixmcp/`), the
 * four version values are equal, and the tool count in `server.json.description` is
 * fail-closed against `allToolDefinitions`. The `prepare-oss.sh` leg is private-only
 * (inv-regsync-version-001-private-derive.test.ts); mcpName presence is not asserted here.
 *
 * @module tests/scripts/inv-regsync-version-001.test
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { allToolDefinitions } from "../../src/tools";

const REPO_ROOT = resolve(__dirname, "../../../..");
const json = (rel: string): Record<string, any> =>
  JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf-8"));

const rootPkg = json("package.json");
const serverPkg = json("apps/mcp-server/package.json");
const serverJson = json("server.json");

describe("INV-REGSYNC-VERSION-001 (synced leg)", () => {
  it("maps the mcp-server package name to packages[0].identifier by the rename", () => {
    const renamed = String(serverPkg.name).replace(/^@reftrixmcp\//, "@reftrixmcp/");
    expect(serverJson.packages[0].identifier).toBe(renamed);
  });

  it("keeps the four version values equal", () => {
    const versions = [
      rootPkg.version,
      serverPkg.version,
      serverJson.version,
      serverJson.packages[0].version,
    ];
    expect(new Set(versions).size).toBe(1);
  });

  it("states the tool count as 'N MCP tools' and N equals allToolDefinitions (fail-closed)", () => {
    const match = /(\d+) MCP tools/.exec(String(serverJson.description));
    expect(match, "server.json description must contain 'N MCP tools'").not.toBeNull();
    expect(Number(match?.[1])).toBe(allToolDefinitions.length);
  });
});
