#!/usr/bin/env node
// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plan v4.2 SEC M-NEW-1 AST gate: enforce synchronous-only listener body
 * for `worker.once('completed', ...)` in worker files.
 *
 * Plan v4.2 PR-A landing (ADR-0034 Callback-Based Worker Exit Pattern) で
 * BullMQ Worker の callback-based exit responsibility を pre-registered
 * `worker.once('completed', ...)` listener に集約した。Listener body が
 * `async` keyword または `await` expression を含むと、Node.js EventEmitter
 * は Promise の解決を待たずに次の listener / continuation を invoke する
 * ため、`process.exit(0)` の発火タイミングが non-deterministic 化する
 * (BullMQ moveToCompleted Lua transaction commit より前に exit が走る
 * race window が再導入される、Plan v4 PR-C と同根の構造的 race)。
 *
 * 本 AST gate は SEC M-NEW-1 mandate に従い、worker file 内のすべての
 * `worker.once('completed', callback)` callsite について、callback body が
 * synchronous-only であることを CI で機械的に enforce する (TPA-V42-M-03
 * closure)。
 *
 * Plan v4.2 PR-A landing (ADR-0034 Callback-Based Worker Exit Pattern)
 * consolidates BullMQ Worker callback-based exit responsibility into a
 * pre-registered `worker.once('completed', ...)` listener. If the listener
 * body contains an `async` keyword or `await` expression, Node.js
 * EventEmitter does not await Promise resolution before invoking the next
 * listener / continuation, making `process.exit(0)` firing timing
 * non-deterministic (the race window where exit fires before the BullMQ
 * `moveToCompleted` Lua transaction commits is reintroduced — same root
 * cause as Plan v4 PR-C). This AST gate enforces SEC M-NEW-1: every
 * `worker.once('completed', callback)` callsite in worker files MUST have
 * a synchronous-only callback body (TPA-V42-M-03 closure).
 *
 * ## 検査対象 / Targets
 *
 *   - apps/mcp-server/src/workers/page-analyze-worker.ts
 *   - apps/mcp-server/src/workers/embedding-backfill-worker.ts
 *   - apps/mcp-server/src/workers/shared/post-job-lifecycle.ts
 *     (Plan v4.2 PR-L closure, TDA-V42-L-02 helper extraction)
 *
 * ## 検査内容 / Checks
 *
 *   1. `worker.once('completed', callback)` callsite を AST で抽出
 *   2. callback body 内に以下が **0 件** であることを assert:
 *      - `async` function/arrow keyword (callback.async === true)
 *      - `await` expression (AwaitExpression node)
 *   違反検出 → exit 1 (CI fail)
 *
 * ## 実行 / Run
 *
 *   node apps/mcp-server/scripts/verify-completed-listener-sync.mjs
 *
 * ## CI 統合 / CI integration
 *
 *   apps/mcp-server/package.json:
 *     "verify:listener-sync": "node scripts/verify-completed-listener-sync.mjs"
 *
 * Cross-ref: ADR-0034 §Decision 1 Step C, Plan v4.2 §3.2 SEC M-NEW-1,
 * `.claude/rules/security.md` §Canonical CWE-209 PII Protection Pattern.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@typescript-eslint/parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// apps/mcp-server/scripts/ → apps/mcp-server/ → repo root
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const TARGETS = [
  "apps/mcp-server/src/workers/page-analyze-worker.ts",
  "apps/mcp-server/src/workers/embedding-backfill-worker.ts",
  // Plan v4.2 PR-L closure (TDA-V42-L-02): boilerplate を shared helper に集約。
  // Helper 内 `worker.once('completed', ...)` listener body も synchronous-only
  // を enforce する必要があるため TARGETS に追加。
  // Plan v4.2 PR-L (TDA-V42-L-02 helper extraction): added so the helper's
  // `worker.once('completed', ...)` listener body is also synchronous-only.
  "apps/mcp-server/src/workers/shared/post-job-lifecycle.ts",
];

let violations = 0;

for (const relPath of TARGETS) {
  const absPath = resolve(REPO_ROOT, relPath);
  const source = readFileSync(absPath, "utf-8");
  const ast = parse(source, {
    range: true,
    loc: true,
    ecmaVersion: "latest",
    sourceType: "module",
  });

  walk(ast, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      node.callee.property &&
      node.callee.property.name === "once" &&
      node.arguments.length >= 2 &&
      isCompletedLiteral(node.arguments[0])
    ) {
      const callback = node.arguments[1];

      // Check 1: callback must not be declared `async`
      if (callback.async === true) {
        console.error(
          `[verify-listener-sync] ${relPath}:${callback.loc.start.line}: ` +
            `listener is declared async — must be synchronous (SEC M-NEW-1)`
        );
        violations++;
      }

      // Check 2: callback body must not contain any `await` expression
      walk(callback, (inner) => {
        if (inner.type === "AwaitExpression") {
          console.error(
            `[verify-listener-sync] ${relPath}:${inner.loc.start.line}: ` +
              `await expression in listener body — must be synchronous (SEC M-NEW-1)`
          );
          violations++;
        }
      });
    }
  });
}

if (violations > 0) {
  console.error(
    `\n[verify-listener-sync] FAIL: ${violations} violation(s) found across ${TARGETS.length} file(s).\n` +
      `Listener bodies must be synchronous-only per SEC M-NEW-1 (Plan v4.2 PR-A).\n` +
      `Cross-ref: .claude/specs/adr/ADR-0034-callback-based-worker-exit.md`
  );
  process.exit(1);
}

console.log(
  `[verify-listener-sync] PASS: all worker.once('completed', ...) listeners ` +
    `are synchronous across ${TARGETS.length} file(s).`
);

/**
 * Match a literal or template-literal whose value is `"completed"`.
 *
 * @param {object} node AST node for the first argument of `.once()`.
 * @returns {boolean}
 */
function isCompletedLiteral(node) {
  if (!node) return false;
  if (node.type === "Literal" && node.value === "completed") return true;
  if (
    node.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1 &&
    node.quasis[0].value &&
    node.quasis[0].value.raw === "completed"
  ) {
    return true;
  }
  return false;
}

/**
 * Generic AST walker. Skips `parent`, `loc`, `range` keys to avoid cycles.
 *
 * @param {object} node    AST node or wrapper.
 * @param {(node: object) => void} visitor Callback invoked for every visited node.
 */
function walk(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") {
    visitor(node);
  }
  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) walk(c, visitor);
    } else if (child && typeof child === "object" && typeof child.type === "string") {
      walk(child, visitor);
    }
  }
}
