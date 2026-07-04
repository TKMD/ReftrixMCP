// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Screenshot root SSOT bare-literal 0-occurrence sweep (PR-SS-A / UB-1 / Plan v1 §5.3)
 *
 * production src (`apps/mcp-server/src/**`) のうち SSOT module
 * (`src/services/screenshot-persistence.service.ts`) **以外**に、screenshot root の
 * bare literal が 1 件も存在しないことを assert する sweep test。
 *
 * - 旧 default (`/tmp/reftrix-screenshots`) の直書き → SSOT import への移行漏れ検出
 * - 新 XDG default の文字列直書き (`.local/share/reftrix` / `reftrix/screenshots`)
 *   → 第 4 サイト発生 (coupling drift) を CI で即時 fail に変換
 *
 * Asserts 0 bare-literal occurrences of the screenshot root (the old
 * `/tmp/reftrix-screenshots` default and any spelled-out form of the new XDG
 * default) in production src outside the SSOT module
 * (`src/services/screenshot-persistence.service.ts`). Same rigor as the
 * `INV-AUDIT-EMIT-SSOT-IMPORT-001` sweep / Worker actor naming SSOT: converts a
 * future fourth-site coupling drift into an immediate CI fail.
 *
 * Cross-ref: Plan v1 §3 D-2 (3-site SSOT unification) / Finding Registry
 * FIND-SSPLAN-M-01 (UB-1).
 *
 * @module tests/services/screenshot-root-ssot-sweep.test
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/** apps/mcp-server package root (tests/services/ から 2 階層上 / two levels up) */
const MCP_SERVER_ROOT = path.resolve(__dirname, "../..");
const SRC_DIR = path.join(MCP_SERVER_ROOT, "src");

/**
 * SSOT module（唯一 bare literal / default 構築が許される module）
 * The SSOT module — the only module allowed to construct the default root.
 */
const SSOT_MODULE_RELATIVE = path.join("services", "screenshot-persistence.service.ts");

/**
 * 禁止 bare literal パターン / Forbidden bare-literal patterns
 *
 * - 旧 default: `/tmp/reftrix-screenshots`（D-1 で廃止 — SSOT module 内にも残置禁止だが
 *   sweep scope は plan 通り「SSOT module 外」とする）
 * - 新 XDG default の spelled-out 形: `.local/share/reftrix` / `reftrix/screenshots`
 *   （SSOT module は `path.join(...)` で構築するため contiguous literal を持たない）
 *
 * - The old default `/tmp/reftrix-screenshots`.
 * - Spelled-out forms of the new XDG default (`.local/share/reftrix` /
 *   `reftrix/screenshots`). The SSOT module constructs the default via
 *   `path.join(...)` segments, so it never contains these contiguous literals.
 */
const FORBIDDEN_LITERALS = [
  "/tmp/reftrix-screenshots",
  ".local/share/reftrix",
  "reftrix/screenshots",
] as const;

/**
 * src 配下の .ts production ファイルを再帰収集する（node_modules / dist / dotdir 除外）
 * Recursively collect production .ts files under src (excluding node_modules /
 * dist / dot-directories).
 */
function collectProductionSourceFiles(dir: string): string[] {
  const collected: string[] = [];
  function walk(current: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        collected.push(full);
      }
    }
  }
  walk(dir);
  return collected;
}

describe("screenshot root SSOT bare-literal sweep (PR-SS-A / UB-1)", () => {
  it("production src (SSOT module 外) に screenshot root の bare literal が 0 件 / 0 bare-literal occurrences outside the SSOT module", () => {
    const ssotModuleAbsolute = path.join(SRC_DIR, SSOT_MODULE_RELATIVE);
    const files = collectProductionSourceFiles(SRC_DIR);

    // Sanity: sweep が空振りしていないこと（src が読めている）
    // Sanity: the sweep actually scanned files.
    expect(files.length).toBeGreaterThan(50);
    // Sanity: SSOT module 自体が存在すること（rename 時に sweep が静かに無意味化しない）
    // Sanity: the SSOT module exists (a rename must not silently void the sweep).
    expect(fs.existsSync(ssotModuleAbsolute)).toBe(true);

    const violations: Array<{ file: string; literal: string }> = [];
    for (const file of files) {
      if (file === ssotModuleAbsolute) continue; // SSOT module は対象外 / exempt
      const content = fs.readFileSync(file, "utf-8");
      for (const literal of FORBIDDEN_LITERALS) {
        if (content.includes(literal)) {
          violations.push({ file: path.relative(MCP_SERVER_ROOT, file), literal });
        }
      }
    }

    expect(
      violations,
      `screenshot root bare literal detected outside the SSOT module — ` +
        `import the root resolution from src/services/screenshot-persistence.service.ts instead:\n` +
        violations.map((v) => `  ${v.file}: "${v.literal}"`).join("\n")
    ).toEqual([]);
  });
});
