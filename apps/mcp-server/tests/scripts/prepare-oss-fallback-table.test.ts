// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The license-checker fallback table in scripts/prepare-oss.sh lists the minor of the
 * @modelcontextprotocol/sdk range that apps/mcp-server declares (it still said 1.26.x).
 *
 * @module tests/scripts/prepare-oss-fallback-table.test
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");

describe("prepare-oss.sh fallback license table", () => {
  it("lists the declared minor of @modelcontextprotocol/sdk in every table copy", () => {
    const pkg = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps/mcp-server/package.json"), "utf-8")
    ) as {
      dependencies: Record<string, string>;
    };
    const declared = pkg.dependencies["@modelcontextprotocol/sdk"]?.match(/(\d+)\.(\d+)\.\d+/);
    expect(declared).not.toBeNull();
    const rows = readFileSync(join(REPO_ROOT, "scripts/prepare-oss.sh"), "utf-8")
      .split("\n")
      .filter((l) => l.startsWith("| @modelcontextprotocol/sdk |"));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) expect(row).toContain(`| ${declared?.[1]}.${declared?.[2]}.x |`);
  });
});
