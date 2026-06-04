// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-PHASE5-PARENT-RSS-TRIM-001 (PR-C3 / 系統B)
 *
 * CPU "true 10/10" integration plan V1.1 §4.3 / ADR-0008 Amendment 1.
 * Root cause (系統B): on heavy CPU sites (e.g. linear.app) parent RSS exceeds
 * `PHASE5_PARENT_RSS_MAX_MB` (default 8192) BEFORE the Phase 5 fork → Phase 5 is
 * skipped entirely (`aps=pending / ptext=0`). The RSS comes from glibc malloc
 * arena residue in the long-lived parent process; `MALLOC_ARENA_MAX=2` does not
 * force-return existing arenas and `--max-old-space-size` only bounds the V8 heap.
 *
 * PR-C3 fix (B3 + bounded B1, plan §3.3):
 *  1. trim (`global.gc()` via `tryGarbageCollect`) + re-measure immediately BEFORE
 *     the ceiling check, so the gate uses the post-GC RSS.
 *  2. graceful degradation when `--expose-gc` is absent (logger.warn in ALL
 *     environments, no `isDevelopment()` guard — SEC L-SEC-3 / FIND-IO-V0-L-05).
 *  3. deterministic ceiling fallback (FIND-IO-V0-H-02): over-ceiling after trim →
 *     PROCEED with the fork (do NOT skip). ADR-0013 ceiling = soft envelope; the
 *     per-chunk RSS budget + fork-kill 4096 backstop remain the hard OOM defences.
 *
 * executable invariant. `.skip()` / `.todo()` forbidden; any failure is a P0
 * incident handled by pipeline-engineer + capture-embedding-engineer.
 *
 * 4 branches (plan §4.3):
 *   (1) trim step source-pin — the worker calls `trimParentRssAndDecide` BEFORE
 *       reading the legacy parent-RSS ceiling; the helper re-measures after GC.
 *   (2) (H-02) `--expose-gc` argv source-pin — production worker launch scripts
 *       (`package.json` `worker:start` / `worker:start:page`) include `--expose-gc`
 *       (coupling-drift defence: a missing flag would make `global.gc()` a no-op).
 *   (3) (L-SEC-3) graceful degradation — `global.gc` unavailable (no-op) →
 *       logger.warn fires in ALL environments + flow proceeds via ceiling fallback.
 *   (4) (H-02) ceiling fallback — post-trim RSS still over ceiling → proceed
 *       (never skip) for both the no-op and the insufficient-trim cases.
 *
 * Mock boundary note (FIND-IO-V0-L-08 / TDA L-03): the GC trigger and RSS
 * measurement are INJECTED into the pure decision helper, so the branch logic is
 * deterministic. The RUNTIME guarantee (real `global.gc()` actually returns enough
 * arena on CPU) is NOT claimed by this test — it is established by the CPU
 * real-machine pass^3 verification (plan §6 / CO-IO-V0-02, Phase 2 Impl gate).
 *
 * @see  §4.3
 * @see apps/mcp-server/src/workers/phases/phase5-parent-rss-trim.ts
 * @see apps/mcp-server/src/workers/page-analyze-worker.ts (parent-RSS ceiling block)
 *
 * @module tests/regression/standing/large-page/inv-phase5-parent-rss-trim-001
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assertInvName } from "../_setup/inv-assert";
import {
  trimParentRssAndDecide,
  type TrimLogger,
} from "../../../../src/workers/phases/phase5-parent-rss-trim";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_SRC = resolve(HERE, "../../../../src");

function makeLogger(): TrimLogger & {
  warnCalls: Array<[string, Record<string, unknown> | undefined]>;
} {
  const warnCalls: Array<[string, Record<string, unknown> | undefined]> = [];
  return {
    warnCalls,
    warn: (message, meta): void => {
      warnCalls.push([message, meta]);
    },
  };
}

describe("INV-PHASE5-PARENT-RSS-TRIM-001: PR-C3 parent-RSS trim + ceiling fallback", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PHASE5-PARENT-RSS-TRIM-001");
  });

  it("INV-PHASE5-PARENT-RSS-TRIM-001 branch 1: trim step runs (GC + re-measure) and decides on the POST-trim RSS", () => {
    // The simulated RSS starts ABOVE the ceiling and GC brings it BACK BELOW.
    // The decision MUST be based on the post-trim value → proceed without fallback.
    const ceilingMb = 8192;
    const rssSeq = [8220, 7800]; // [pre-trim, post-trim]
    let call = 0;
    const measureRssMb = (): number => rssSeq[Math.min(call++, rssSeq.length - 1)];
    const tryGc = vi.fn().mockReturnValue(true);
    const logger = makeLogger();

    const decision = trimParentRssAndDecide(ceilingMb, tryGc, measureRssMb, logger);

    // CI-failing evidence: PRE-FIX the worker read RSS once and skipped at 8220.
    // POST-FIX the trim re-measures (7800) and the ceiling decision uses it.
    expect(tryGc).toHaveBeenCalledTimes(1);
    expect(decision.preTrimRssMb).toBe(8220);
    expect(decision.postTrimRssMb).toBe(7800);
    expect(decision.proceed).toBe(true);
    expect(decision.ceilingFallback).toBe(false);
  });

  it("INV-PHASE5-PARENT-RSS-TRIM-001 branch 2 (H-02): production worker launch scripts include --expose-gc (argv source-pin)", () => {
    // Coupling-drift defence: without `--expose-gc` the production `global.gc()`
    // is a no-op and the PR-C3 primary remedy is dead. Source-pin the package.json
    // scripts so removing the flag fails CI.
    const pkgPath = resolve(REPO_SRC, "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts["worker:start"]).toMatch(/--expose-gc/);
    expect(pkg.scripts["worker:start:page"]).toMatch(/--expose-gc/);
    // Both still carry the existing heap bound (no regression of NODE_OPTIONS).
    expect(pkg.scripts["worker:start"]).toMatch(/--max-old-space-size=4096/);
    expect(pkg.scripts["worker:start:page"]).toMatch(/--max-old-space-size=4096/);
  });

  it("INV-PHASE5-PARENT-RSS-TRIM-001 branch 3 (L-SEC-3): global.gc no-op (--expose-gc absent) → logger.warn in all envs + graceful degradation (no skip)", () => {
    // global.gc unavailable → tryGc returns false. The no-op MUST be surfaced via
    // logger.warn (NOT silently absorbed; no isDevelopment guard), and the flow
    // must still proceed (RSS within ceiling here → normal proceed).
    const ceilingMb = 8192;
    const measureRssMb = (): number => 7000; // within ceiling
    const tryGc = vi.fn().mockReturnValue(false); // --expose-gc absent
    const logger = makeLogger();

    const decision = trimParentRssAndDecide(ceilingMb, tryGc, measureRssMb, logger);

    expect(decision.gcTriggered).toBe(false);
    expect(decision.proceed).toBe(true);
    // logger.warn fired for the no-op (graceful degradation, all envs).
    const noOpWarn = logger.warnCalls.find(([m]) => m.includes("--expose-gc absent"));
    expect(noOpWarn).toBeDefined();
  });

  it("INV-PHASE5-PARENT-RSS-TRIM-001 branch 4 (H-02): post-trim RSS still over ceiling → deterministic ceiling fallback PROCEEDS (never skips), GC-on case", () => {
    // GC ran but did not bring RSS below the ceiling → fallback proceed.
    const ceilingMb = 8192;
    const rssSeq = [9000, 8500]; // GC reclaimed some, still > ceiling
    let call = 0;
    const measureRssMb = (): number => rssSeq[Math.min(call++, rssSeq.length - 1)];
    const tryGc = vi.fn().mockReturnValue(true);
    const logger = makeLogger();

    const decision = trimParentRssAndDecide(ceilingMb, tryGc, measureRssMb, logger);

    // CI-failing evidence: PRE-FIX the worker SKIPPED (memoryAbortEmbedding=true)
    // at 9000 > 8192. POST-FIX it PROCEEDS via the ceiling fallback.
    expect(decision.proceed).toBe(true);
    expect(decision.ceilingFallback).toBe(true);
    expect(decision.postTrimRssMb).toBe(8500);
    const fallbackWarn = logger.warnCalls.find(([m]) =>
      m.includes("deterministic ceiling fallback")
    );
    expect(fallbackWarn).toBeDefined();
  });

  it("INV-PHASE5-PARENT-RSS-TRIM-001 branch 4b (H-02): ceiling fallback also PROCEEDS when GC is a no-op (--expose-gc absent + over ceiling)", () => {
    // The two failure cases (no-op GC AND insufficient GC) both proceed.
    const ceilingMb = 8192;
    const measureRssMb = (): number => 8300; // over ceiling, no GC effect
    const tryGc = vi.fn().mockReturnValue(false);
    const logger = makeLogger();

    const decision = trimParentRssAndDecide(ceilingMb, tryGc, measureRssMb, logger);

    expect(decision.gcTriggered).toBe(false);
    expect(decision.proceed).toBe(true);
    expect(decision.ceilingFallback).toBe(true);
  });

  it("INV-PHASE5-PARENT-RSS-TRIM-001 branch 1b: worker invokes trimParentRssAndDecide before the ceiling decision and NO LONGER skips on the parent-RSS gate (source-pin)", () => {
    // Source-pin the worker wiring: the trim helper is called, and the old
    // "skipping fork" parent-RSS skip path is removed (only the heap-critical
    // checkMemoryPressure abort remains as the hard skip).
    const workerSrc = readFileSync(resolve(REPO_SRC, "workers/page-analyze-worker.ts"), "utf8");

    expect(workerSrc).toMatch(/trimParentRssAndDecide\s*\(/);
    // The legacy parent-RSS "skipping fork" guard log MUST be gone (PR-C3 removed
    // the skip; the ceiling is now a soft envelope handled inside the helper).
    expect(workerSrc).not.toMatch(/Parent RSS exceeds Phase 5 ceiling, skipping fork/);
    // The trim import is wired.
    expect(workerSrc).toMatch(/from\s+"\.\/phases\/phase5-parent-rss-trim"/);
  });

  it("INV-PHASE5-PARENT-RSS-TRIM-001 branch 1c: stale 3072 parent-RSS comment is reconciled to 8192 (M-08, T1 SSOT)", () => {
    // M-08: the worker comment claimed default 3072MB; T1 SSOT is 8192
    // (phase5-config.ts DEFAULT_PARENT_RSS_MAX_MB). The stale literal must be gone.
    const workerSrc = readFileSync(resolve(REPO_SRC, "workers/page-analyze-worker.ts"), "utf8");
    const configSrc = readFileSync(resolve(REPO_SRC, "config/phase5-config.ts"), "utf8");

    expect(configSrc).toMatch(/DEFAULT_PARENT_RSS_MAX_MB\s*=\s*8192/);
    // No stale "3072MB" parent-RSS ceiling comment remains in the guard block.
    expect(workerSrc).not.toMatch(/3072MB/);
  });
});
