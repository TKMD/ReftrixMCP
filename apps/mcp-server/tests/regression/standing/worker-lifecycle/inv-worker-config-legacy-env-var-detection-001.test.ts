// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-CONFIG-LEGACY-ENV-VAR-DETECTION-001 (Plan v4.5 PR3 Track 2 §5.3)
 *
 * IO Plan Decision V1 anchor: `019e4267-d21e-7775-b956-544df059d328`
 *
 * ## Contract / 不変条件
 *
 * Per-job fork-only mode flag resolution MUST:
 *   (a) resolve via the SSOT resolver (`resolveForkMode`) — new flag wins on
 *       value conflict, both unset → default true (fork-only enforced);
 *   (b) signal a `worker_config_legacy_env_var_detected` emit when the legacy
 *       `EMBEDDING_BACKFILL_FORK_ENABLED` env var is present;
 *   (c) AST sweep: production code MUST NOT hardcode either env var name string
 *       literal outside the `embedding-backfill-fork-mode.ts` resolver module
 *       (SSOT enforcement, Wave 5 LCC canonical AST pattern).
 *
 * @see Plan v4.5 PR3 V1 §5.3
 * @see apps/mcp-server/src/queues/embedding-backfill-fork-mode.ts (SSOT resolver)
 */

import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  resolveForkMode,
  ENV_FORK_ONLY_MODE,
  ENV_LEGACY_FORK,
} from "../../../../src/queues/embedding-backfill-fork-mode";

const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../..");
const SRC_ROOT = path.resolve(MCP_SERVER_ROOT, "src");

/** The resolver module is the ONLY production file allowed to hold the literals. */
const RESOLVER_MODULE_BASENAME = "embedding-backfill-fork-mode.ts";

/**
 * Recursively collect every `*.ts` under `root`, excluding `node_modules` /
 * `dist` / dotfiles / `.test.ts` / `.spec.ts`. Inline helper (no `glob` dep)
 * per Wave 5 LCC canonical pattern.
 */
function collectTypeScriptSources(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts")) continue;
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

describe("INV-WORKER-CONFIG-LEGACY-ENV-VAR-DETECTION-001: per-job fork-only mode flag resolution + legacy env var detection + SSOT AST sweep (Plan v4.5 PR3 Track 2 §5.3)", () => {
  beforeEach(() => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-CONFIG-LEGACY-ENV-VAR-DETECTION-001"
    );
  });

  // Falsifiable predicate (a): resolution precedence.
  it("INV-WORKER-CONFIG-LEGACY-ENV-VAR-DETECTION-001: both unset → default true (fork-only enforced)", () => {
    const r = resolveForkMode({});
    expect(r.forkOnlyMode).toBe(true);
    expect(r.legacyEnvVarPresent).toBe(false);
    expect(r.shouldEmitLegacyDetected).toBe(false);
  });

  it("INV-WORKER-CONFIG-LEGACY-ENV-VAR-DETECTION-001: new flag explicitly false + legacy true → new flag wins (fork-only disabled, legacy detected emit)", () => {
    const r = resolveForkMode({
      [ENV_FORK_ONLY_MODE]: "false",
      [ENV_LEGACY_FORK]: "true",
    });
    // Falsifier: if legacy flag could override the new flag, forkOnlyMode would
    // be true here — the new flag MUST win.
    expect(r.forkOnlyMode).toBe(false);
    expect(r.legacyEnvVarPresent).toBe(true);
    expect(r.shouldEmitLegacyDetected).toBe(true);
  });

  it("INV-WORKER-CONFIG-LEGACY-ENV-VAR-DETECTION-001: legacy-only deployment (only EMBEDDING_BACKFILL_FORK_ENABLED set) → default true + legacy detected emit on dispatch", () => {
    const r = resolveForkMode({ [ENV_LEGACY_FORK]: "true" });
    // Falsifier: a legacy-only deployment must NOT silently keep fork-only off;
    // default true is enforced AND the detected-emit fires so operators migrate.
    expect(r.forkOnlyMode).toBe(true);
    expect(r.legacyEnvVarPresent).toBe(true);
    expect(r.shouldEmitLegacyDetected).toBe(true);
  });

  it("INV-WORKER-CONFIG-LEGACY-ENV-VAR-DETECTION-001: new flag true + no legacy → fork-only enforced, no legacy emit", () => {
    const r = resolveForkMode({ [ENV_FORK_ONLY_MODE]: "true" });
    expect(r.forkOnlyMode).toBe(true);
    expect(r.shouldEmitLegacyDetected).toBe(false);
  });

  // Falsifiable predicate (c): AST sweep — env var literals SSOT-confined.
  it("INV-WORKER-CONFIG-LEGACY-ENV-VAR-DETECTION-001: AST sweep — env var name literals appear ONLY in the resolver module (SSOT enforcement, Wave 5 LCC canonical pattern)", () => {
    const files = collectTypeScriptSources(SRC_ROOT);
    const bannedLiterals = [ENV_FORK_ONLY_MODE, ENV_LEGACY_FORK];
    const violations: Array<{ file: string; literal: string; line: number }> = [];

    for (const file of files) {
      if (path.basename(file) === RESOLVER_MODULE_BASENAME) continue; // SSOT module exempt
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i] ?? "";
        for (const literal of bannedLiterals) {
          // Match the string literal (quoted), not bare identifier comments.
          if (lineText.includes(`"${literal}"`) || lineText.includes(`'${literal}'`)) {
            violations.push({ file: path.relative(MCP_SERVER_ROOT, file), literal, line: i + 1 });
          }
        }
      }
    }

    // Falsifier: any production file outside the resolver hardcoding either env
    // var name would re-establish a coupling-drift surface (silent regression).
    expect(violations).toEqual([]);
  });
});
