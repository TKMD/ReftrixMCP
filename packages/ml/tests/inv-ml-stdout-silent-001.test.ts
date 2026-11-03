// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-ML-STDOUT-SILENT-001: an MCP stdio server owns stdout for JSON-RPC, so no
 * source file of @reftrixmcp/ml may write to stdout via console.log.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("INV-ML-STDOUT-SILENT-001", () => {
  it("packages/ml/src has no console.log or process.stdout.write", () => {
    const bad = walk(join(__dirname, "..", "src")).filter((f) =>
      /console\.(log|info|debug|dir|table)\(|process\.stdout\.write/.test(readFileSync(f, "utf-8"))
    );
    expect(bad).toEqual([]);
  });
});
