// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — large-page domain
 *
 * **INV-RSS-BUDGET-001** (NEW per Plan v3 T1ev V1 §5.1, IO Decision §8.2)
 *
 * internal anchors:
 *   - V1 amendment checkpoint: `019e124f-e666-7463-a5a4-4618fc7e0569`
 *   - C-2 contract decision (γ winning): `019e1251-93b4-7530-b07e-9d60263942c9`
 *   - Phase 2 Wave 1 impl start: `019e129f-45e2-723d-9ec1-27b3271333ad`
 *
 * ## Contract / 不変条件
 *
 * Worker process tree must inject `MALLOC_ARENA_MAX="2"` (production target,
 * Cell-2) at all three sites — Site A (parent / Node.js main process), Site B
 * (WorkerSupervisor child via fork), Site C (Phase 5 fork orchestrator child)
 * — and the bounded-range invariant `MALLOC_ARENA_MAX ≤ 32` (CWE-770 budget
 * overflow guard) MUST hold at each site.
 *
 * Worker プロセスツリーは 3 site (Site A parent / Site B WorkerSupervisor child /
 * Site C Phase 5 fork orchestrator child) で `MALLOC_ARENA_MAX="2"` を注入し、
 * 範囲 invariant `MALLOC_ARENA_MAX ≤ 32` (CWE-770) を満たさなければならない。
 *
 * ## Why a standing regression / なぜ常設 regression か
 *
 * glibc は `__libc_init_first` で `MALLOC_ARENA_MAX` を 1 度だけ読み、Node.js
 * プロセス起動後に `process.env.MALLOC_ARENA_MAX = "2"` と書いても **構造的に
 * 効果ゼロ** (β fake-success trap)。Site A / B / C すべてで fork-time injection
 * (`package.json` shell wrapper / fork env) を維持し続ける必要がある。
 * 1 site でも injection 経路が drift すれば silent RSS regression が発生する
 * (CI で fail しない)。本 standing test は drift を CI-failing 化することで
 * Plan v2 OOM-1 baseline と Plan v3 T1ev V1 winning contract を保護する。
 *
 * glibc reads `MALLOC_ARENA_MAX` once at `__libc_init_first`; runtime writes
 * to `process.env.MALLOC_ARENA_MAX` after Node.js starts have **zero effect**
 * (β fake-success trap). All three sites must keep fork-time injection
 * (`package.json` shell wrapper or fork env). If even one drifts, a silent
 * RSS regression occurs that would never fail CI. This standing test makes
 * such drift CI-failing.
 *
 * ## Scope (per V1 §6.1) / スコープ
 *
 * | Cell | Mode      | What it pins                                                                                          |
 * | ---- | --------- | ------------------------------------------------------------------------------------------------------ |
 * | 1    | AST scan  | Site A: `package.json` `worker:start` script contains `MALLOC_ARENA_MAX=...` prefix (γ winning)        |
 * | 2    | AST scan  | Site B + Site C: 3 fork-env injection sites preserve `MALLOC_ARENA_MAX = "2"` fallback                 |
 * | 6    | AST scan  | β fake-success guard: zero hits on `process.env.MALLOC_ARENA_MAX = ...` runtime assignment in src/     |
 * | 7    | Runtime   | `validateMallocArenaMaxEnv("33")` → level: "fail" (CWE-770 upper bound)                                |
 * | 8    | Runtime   | `validateMallocArenaMaxEnv("17")` → level: "warn" (above recommended bound)                            |
 * | 9    | Runtime   | `validateMallocArenaMaxEnv("2")` → level: "ok" (production target)                                     |
 * | 9b   | Runtime   | `validateMallocArenaMaxEnv(undefined)` → level: "ok" (glibc default fallback)                          |
 * | 9c   | Runtime   | `validateMallocArenaMaxEnv("abc")` → level: "fail" (operator misconfiguration)                         |
 *
 * **Cell-3 (A3 sensitivity = "4") is dropped from this Wave 1 implementation**
 * per IO Decision V0 §2.4 U-T1EV-2 — operator-provisioned only, no env var
 * injection point. Cell-4 / Cell-5 (Site B / C "4" sensitivity) are explicitly
 * **dropped** (not deferred) per V1 §4.2.
 *
 * ## Why under large-page domain / なぜ large-page ドメインか
 *
 * Phase 5 fork orchestrator (Site C) は INV-PAGE-QUEUE-001 (large-page >100
 * parts) の embedding backfill 経路で実行される。RSS budget contract は同経路の
 * memory-pressure ガード (parent SIGKILL) と直接結合する。drift すると INV-
 * PAGE-QUEUE-001-B (skipped_memory_pressure 終端遷移) の発火頻度が変動するため、
 * cross-binding INV として large-page domain に landing する (V1 §0 metadata)。
 *
 * Phase 5 fork orchestrator runs on the embedding backfill path triggered by
 * INV-PAGE-QUEUE-001 (>100 parts pages). The RSS budget contract directly
 * couples with parent SIGKILL guard, so drift would change the firing rate of
 * INV-PAGE-QUEUE-001-B (`skipped_memory_pressure` terminal transition).
 * This cross-binding justifies landing under the large-page domain.
 *
 * @see Plan v3 T1ev V1 §4.2 (γ winning contract)
 * @see Plan v3 T1ev V1 §5.1 (INV-RSS-BUDGET-001 statement)
 * @see Plan v3 T1ev V1 §6.1 (mandatory cell list)
 * @see Plan v3 T1ev V1 §6.4 (validateMallocArenaMaxEnv SSOT)
 * @see ADR-0026 (LoC variance feat-only methodology)
 * @see ADR-0030 (Plan v3 Dependency Upgrade Gate; will host §"glibc env-at-init constraint")
 * @see `apps/mcp-server/src/utils/env-validators.ts` (validator SSOT)
 * @see `apps/mcp-server/src/services/worker-supervisor.service.ts` line 781-783 (Site B)
 * @see `apps/mcp-server/src/workers/phases/phase-5-fork-orchestrator.ts` line 176-178 (Site C #1)
 * @see `apps/mcp-server/src/workers/phases/shared/fork-common.ts` line 318-320 (Site C #2)
 * @see `apps/mcp-server/package.json` `scripts.worker:start` (Site A, γ shell wrapper)
 *
 * @module tests/regression/standing/large-page/inv-rss-budget-001-malloc-arena-max-3-site
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import {
  validateMallocArenaMaxEnv,
  MALLOC_ARENA_MAX_WARN_THRESHOLD,
  MALLOC_ARENA_MAX_FAIL_THRESHOLD,
} from "../../../../src/utils/env-validators";

// ============================================================================
// Constants / 定数
// ============================================================================

/**
 * Repository roots discovered relative to this test file.
 *
 * このテストファイルから相対計算したリポジトリ root の各 path。
 */
const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../..");
const SRC_ROOT = path.resolve(MCP_SERVER_ROOT, "src");
const PACKAGE_JSON_PATH = path.resolve(MCP_SERVER_ROOT, "package.json");

/**
 * Site A: package.json `worker:start` scripts that must carry the γ shell
 * wrapper prefix `MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"`.
 *
 * Site A: `package.json` の `worker:start` script (γ shell wrapper prefix)。
 */
const SITE_A_SCRIPT_KEYS = ["worker:start", "worker:start:page"] as const;

/**
 * Site B + Site C source files that must preserve the
 * `if (!env.MALLOC_ARENA_MAX) { env.MALLOC_ARENA_MAX = "2"; }` fork-time
 * injection contract. Path is relative to `apps/mcp-server/src/`.
 *
 * Site B + Site C の fork-time injection を持つ source file。
 */
const FORK_INJECTION_SITES: ReadonlyArray<{
  readonly relPath: string;
  readonly siteLabel: string;
}> = [
  {
    // Note: Post-merge with main (PR #25 / CO-26), the MALLOC_ARENA_MAX injection
    // for the WorkerSupervisor child fork path was relocated from
    // `worker-supervisor.service.ts` to the dedicated
    // `worker-supervisor-lifecycle.service.ts` module during the multi-track
    // recovery. The injection contract is preserved at the new path.
    relPath: "services/worker-supervisor-lifecycle.service.ts",
    siteLabel: "Site B (WorkerSupervisor child fork)",
  },
  {
    relPath: "workers/phases/phase-5-fork-orchestrator.ts",
    siteLabel: "Site C #1 (Phase 5 fork orchestrator)",
  },
  {
    relPath: "workers/phases/shared/fork-common.ts",
    siteLabel: "Site C #2 (Phase 5 shared fork-common)",
  },
];

/**
 * Files where `process.env.MALLOC_ARENA_MAX = ...` is **legitimately allowed**.
 *
 * - Tests under `tests/` exercise validator behaviour and may freely mutate
 *   `process.env` within a test scope.
 * - The validator SSOT module reads (never writes) the env var.
 *
 * Cell-6 β fake-success guard scans `src/` only and excludes none — production
 * code MUST have zero assignments.
 *
 * Cell-6 β fake-success guard は src/ のみ scan、production コード内 0 件を
 * 強制する。テストは scan 対象外。
 */
const SCAN_EXCLUDED_REL_PATHS: ReadonlyArray<string> = [];

/**
 * Walk a directory recursively and yield every `.ts` file path (relative to
 * the directory root). Skips `node_modules`, `dist`, hidden directories, and
 * `*.d.ts` declaration files.
 *
 * ディレクトリを再帰的に walk して `.ts` ファイル相対 path を返す。
 */
function collectTsFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
          continue;
        }
        stack.push(abs);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        out.push(abs);
      }
    }
  }
  return out;
}

// ============================================================================
// Tests / テスト
// ============================================================================

describe("INV-RSS-BUDGET-001: MALLOC_ARENA_MAX 3-site control arm (Plan v3 T1ev V1)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-RSS-BUDGET-001");
  });

  // ==========================================================================
  // Cell-1: Site A — package.json γ shell wrapper prefix
  // ==========================================================================
  describe("Cell-1: Site A package.json γ shell wrapper", () => {
    let pkgJson: { scripts?: Record<string, string> };

    beforeAll(() => {
      const raw = fs.readFileSync(PACKAGE_JSON_PATH, "utf8");
      pkgJson = JSON.parse(raw) as { scripts?: Record<string, string> };
    });

    for (const scriptKey of SITE_A_SCRIPT_KEYS) {
      it(`INV-RSS-BUDGET-001 Cell-1: package.json scripts["${scriptKey}"] starts with γ MALLOC_ARENA_MAX prefix`, () => {
        const scripts = pkgJson.scripts;
        expect(scripts, "package.json must declare a scripts object").toBeDefined();
        const script = scripts?.[scriptKey];
        expect(
          script,
          `scripts["${scriptKey}"] must exist for Plan v3 T1ev V1 γ winning contract`
        ).toBeTypeOf("string");
        // γ shell wrapper contract: prefix must read env-or-default-2.
        // Use a permissive regex so cosmetic quoting changes (single vs double
        // quotes, optional surrounding whitespace) don't false-fail the test.
        // γ shell wrapper の prefix: 環境変数 or デフォルト 2 を読み込む形式。
        const gammaPattern = /^MALLOC_ARENA_MAX=["']?\$\{MALLOC_ARENA_MAX:-2\}["']?\s/;
        expect(
          gammaPattern.test(script ?? ""),
          `scripts["${scriptKey}"] must begin with γ shell wrapper "MALLOC_ARENA_MAX=\${MALLOC_ARENA_MAX:-2}". ` +
            `Actual: ${JSON.stringify(script)}`
        ).toBe(true);
      });
    }
  });

  // ==========================================================================
  // Cell-2: Site B + Site C — fork-time injection preserved across 3 sites
  // ==========================================================================
  describe("Cell-2: Site B + Site C fork-time injection", () => {
    for (const site of FORK_INJECTION_SITES) {
      it(`INV-RSS-BUDGET-001 Cell-2: ${site.siteLabel} preserves MALLOC_ARENA_MAX="2" fork-env injection`, () => {
        const abs = path.resolve(SRC_ROOT, site.relPath);
        expect(fs.existsSync(abs), `Site source file must exist: ${site.relPath}`).toBe(true);
        const source = fs.readFileSync(abs, "utf8");
        // Pattern matches both worker-supervisor (`env.MALLOC_ARENA_MAX = "2"`)
        // and phase-5/fork-common (`baseEnv.MALLOC_ARENA_MAX = "2"`) idioms.
        // worker-supervisor の `env.MALLOC_ARENA_MAX` と phase-5 / fork-common
        // の `baseEnv.MALLOC_ARENA_MAX` を両方検出。
        const injectionPattern = /(?:^|\b)\w+\.MALLOC_ARENA_MAX\s*=\s*["']2["']/m;
        expect(
          injectionPattern.test(source),
          `${site.siteLabel} (${site.relPath}) must contain fork-time injection ` +
            `\`<env>.MALLOC_ARENA_MAX = "2"\` for OOM-1 baseline preservation. ` +
            `Plan v3 T1ev V1 §4.2 (γ winning) requires all 3 sites kept aligned.`
        ).toBe(true);
        // Conditional guard pattern: injection must be wrapped in
        // `if (!<env>.MALLOC_ARENA_MAX)` so operator override (Cell-3) is
        // honoured. Without this guard, override would silently fail.
        // 条件 guard pattern: operator override を尊重するため
        // `if (!<env>.MALLOC_ARENA_MAX)` でガードされている必要がある。
        const guardPattern = /if\s*\(\s*!\s*\w+\.MALLOC_ARENA_MAX\s*\)/;
        expect(
          guardPattern.test(source),
          `${site.siteLabel} must guard injection with \`if (!<env>.MALLOC_ARENA_MAX)\` ` +
            `so operator override is preserved (deployment-time switching path).`
        ).toBe(true);
      });
    }
  });

  // ==========================================================================
  // Cell-6: β fake-success guard — zero runtime process.env writes in src/
  // ==========================================================================
  describe("Cell-6: β fake-success guard (zero process.env runtime writes)", () => {
    it("INV-RSS-BUDGET-001 Cell-6: no production source assigns to process.env.MALLOC_ARENA_MAX", () => {
      // glibc reads MALLOC_ARENA_MAX at __libc_init_first; runtime writes are
      // structurally ineffective. Any such assignment in src/ is a fake-success
      // pattern that must be eliminated.
      // glibc は __libc_init_first で読むため runtime 書き込みは無効。
      const tsFiles = collectTsFiles(SRC_ROOT);
      // Match `process.env.MALLOC_ARENA_MAX =` (assignment), but not `===`
      // / `!==` comparisons. The negative lookahead protects against false
      // positives from equality checks.
      // 代入式 (`=`) のみを検出、比較演算子 (`===` / `!==`) は除外。
      const assignmentPattern = /process\.env\.MALLOC_ARENA_MAX\s*=(?!=)/;
      const offenders: string[] = [];
      for (const file of tsFiles) {
        const rel = path.relative(MCP_SERVER_ROOT, file);
        if (SCAN_EXCLUDED_REL_PATHS.includes(rel)) {
          continue;
        }
        const rawSource = fs.readFileSync(file, "utf8");
        // Strip block comments (/* ... */) and line comments (// ...) so
        // documentation that describes the β trap (e.g. JSDoc explaining what
        // runtime assignment looks like) is not flagged as an actual offender.
        // Block comments: replace with a single space to preserve regex offsets
        // for surrounding code; line comments: terminate at end-of-line.
        // ブロックコメント / 行コメントは β trap の説明用に文字列を保持する
        // ことがあるため、scan 対象から除外する。
        const stripped = rawSource
          .replace(/\/\*[\s\S]*?\*\//g, " ")
          .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
        if (assignmentPattern.test(stripped)) {
          offenders.push(rel);
        }
      }
      expect(
        offenders,
        "Production source code MUST NOT assign to process.env.MALLOC_ARENA_MAX " +
          "(β fake-success trap; glibc env-at-init makes runtime writes a no-op). " +
          "Plan v3 T1ev V1 §4.2 winning contract = (γ) shell wrapper + fork-time env only. " +
          `Offending files: ${JSON.stringify(offenders)}`
      ).toEqual([]);
    });
  });

  // ==========================================================================
  // Cell-7 / Cell-8 / Cell-9 — validateMallocArenaMaxEnv() SSOT
  // ==========================================================================
  describe("Cell-7/8/9: validateMallocArenaMaxEnv() SSOT (V1 §6.4)", () => {
    it(`INV-RSS-BUDGET-001 Cell-7: validateMallocArenaMaxEnv("33") returns level: "fail" (above CWE-770 upper bound ${MALLOC_ARENA_MAX_FAIL_THRESHOLD})`, () => {
      const result = validateMallocArenaMaxEnv("33");
      expect(result.parsed).toBe(33);
      expect(result.level).toBe("fail");
      expect(result.message).toContain(`exceeds upper bound ${MALLOC_ARENA_MAX_FAIL_THRESHOLD}`);
      expect(result.message).toContain("CWE-770");
    });

    it(`INV-RSS-BUDGET-001 Cell-8: validateMallocArenaMaxEnv("17") returns level: "warn" (above recommended bound ${MALLOC_ARENA_MAX_WARN_THRESHOLD})`, () => {
      const result = validateMallocArenaMaxEnv("17");
      expect(result.parsed).toBe(17);
      expect(result.level).toBe("warn");
      expect(result.message).toContain(
        `exceeds recommended bound ${MALLOC_ARENA_MAX_WARN_THRESHOLD}`
      );
    });

    it('INV-RSS-BUDGET-001 Cell-9: validateMallocArenaMaxEnv("2") returns level: "ok" (production target)', () => {
      const result = validateMallocArenaMaxEnv("2");
      expect(result.parsed).toBe(2);
      expect(result.level).toBe("ok");
      expect(result.message).toContain("MALLOC_ARENA_MAX=2");
    });

    it('INV-RSS-BUDGET-001 Cell-9b: validateMallocArenaMaxEnv(undefined) returns level: "ok" (glibc default fallback)', () => {
      const result = validateMallocArenaMaxEnv(undefined);
      expect(result.parsed).toBe(0);
      expect(result.level).toBe("ok");
      expect(result.message).toContain("unset");
    });

    it('INV-RSS-BUDGET-001 Cell-9c: validateMallocArenaMaxEnv("abc") returns level: "fail" (operator misconfiguration)', () => {
      const result = validateMallocArenaMaxEnv("abc");
      expect(result.parsed).toBe(0);
      expect(result.level).toBe("fail");
      expect(result.message).toContain("not a positive integer");
    });

    it("INV-RSS-BUDGET-001 Cell-9d: validateMallocArenaMaxEnv boundary values — exactly at threshold", () => {
      // 16 (warn threshold) → ok
      const at16 = validateMallocArenaMaxEnv(String(MALLOC_ARENA_MAX_WARN_THRESHOLD));
      expect(at16.level).toBe("ok");
      // 17 (warn threshold + 1) → warn
      const at17 = validateMallocArenaMaxEnv(String(MALLOC_ARENA_MAX_WARN_THRESHOLD + 1));
      expect(at17.level).toBe("warn");
      // 32 (fail threshold) → warn (still within the warn band, since fail is > 32 not >= 32)
      const at32 = validateMallocArenaMaxEnv(String(MALLOC_ARENA_MAX_FAIL_THRESHOLD));
      expect(at32.level).toBe("warn");
      // 33 (fail threshold + 1) → fail
      const at33 = validateMallocArenaMaxEnv(String(MALLOC_ARENA_MAX_FAIL_THRESHOLD + 1));
      expect(at33.level).toBe("fail");
    });
  });
});
