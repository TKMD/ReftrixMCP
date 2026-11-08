// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Source-sweep helpers shared by standing / script invariant tests (scope-limited: callers pass
 * the roots; `node_modules`, `dist` and `*.d.ts` are skipped).
 * source sweep 用の共通 helper (呼び出し側が root を渡す。node_modules / dist / *.d.ts は除外)。
 */

import * as fs from "node:fs";
import * as path from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist"]);

/** Recursively list `*.ts` files under `dir`, skipping `*.d.ts`, `node_modules` and `dist`. */
export function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Files under `root` (relative paths) whose text contains `needle`. */
export function grepTsFiles(root: string, needle: string): string[] {
  return listTsFiles(root)
    .filter((file) => fs.readFileSync(file, "utf8").includes(needle))
    .map((file) => path.relative(root, file));
}
