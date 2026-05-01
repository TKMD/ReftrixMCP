// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * start-workers.ts — dual-run guard source inspection (v0.4.0 PR7d-2)
 *
 * start-workers.ts の main() は副作用 (loadEnvLocal, Prisma init, Redis ping,
 * setTimeout unref 無し) を持ち直接 import すると test runner を汚染するため、
 * 他の start-workers 系テストと同じ pattern でソース静的検査により契約を担保する。
 *
 * Guarded behaviours:
 *   1. NODE_ENV=test → skip
 *   2. REFTRIX_WORKER_IS_CHILD=1 → skip
 *   3. REFTRIX_ALLOW_MANUAL_WORKER=true → warn + continue
 *   4. Redis lock present → process.exit(1)
 *   5. Redis lock absent → acquire + heartbeat
 */

import { beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("start-workers.ts — dual-run guard (v0.4.0 PR7d-2)", () => {
  const startWorkersPath = path.resolve(__dirname, "../../src/scripts/start-workers.ts");
  let source: string;
  let guardSection: string;

  beforeAll(() => {
    source = fs.readFileSync(startWorkersPath, "utf8");
    const start = source.indexOf("async function evaluateDualRunGuard");
    const end = source.indexOf("async function releaseStandaloneLock");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    guardSection = source.slice(start, end);
  });

  describe("Bypass conditions", () => {
    it("skips dual-run check when NODE_ENV=test", () => {
      expect(guardSection).toMatch(/NODE_ENV.*===.*"test"/);
    });

    it("skips dual-run check for fork children (REFTRIX_WORKER_IS_CHILD=1)", () => {
      expect(guardSection).toMatch(/REFTRIX_WORKER_IS_CHILD.*===.*"1"/);
    });

    it("warns and continues when REFTRIX_ALLOW_MANUAL_WORKER=true", () => {
      expect(guardSection).toMatch(/REFTRIX_ALLOW_MANUAL_WORKER.*===.*"true"/);
      expect(guardSection).toMatch(/console\.warn/);
    });
  });

  describe("Redis lock semantics", () => {
    it("uses WorkerActiveLockService for dual-run detection", () => {
      expect(guardSection).toContain("WorkerActiveLockService");
      // v0.4.0 PR7d-3 (SEC M-1): migrated from `checkExistingLock` (boolean/null)
      // to `probeExistingLock` (discriminated union) so Redis-unreachable can
      // be distinguished from "lock absent".
      // v0.4.0 PR7d-3 (SEC M-1): 旧 `checkExistingLock` は両ケースを null に
      // 潰していたため `probeExistingLock` に移行。
      //
      // PR-D-8 Phase 2 MF-06: per-type guard — `probeExistingLock` now takes
      // `workerType` argument resolved from startMode. Test asserts the call
      // pattern (variable arg) rather than a hardcoded "page".
      // PR-D-8 Phase 2 MF-06: per-type guard — `probeExistingLock(workerType)`
      // 呼び出し pattern (引数は変数) を assert する。
      expect(guardSection).toMatch(/probeExistingLock\(workerType\)/);
    });

    it("exits with code 1 when an existing lock is detected", () => {
      expect(guardSection).toContain("DUAL-RUN DETECTED");
      expect(guardSection).toMatch(/process\.exit\(1\)/);
    });

    it("acquires a fresh lock when none is present", () => {
      // v0.4.0 PR7d-3 (SEC M-1): migrated from `acquireLock` to
      // `tryAcquireLock` for discriminated-union fail-open/fail-closed
      // distinction.
      // v0.4.0 PR7d-3 (SEC M-1): fail-open/fail-closed 分岐のため
      // `tryAcquireLock` に移行。
      //
      // PR-D-8 Phase 2 MF-06: per-type acquire — `tryAcquireLock(workerType, token)`
      // (workerType resolved from startMode). Test asserts the call pattern.
      // PR-D-8 Phase 2 MF-06: per-type acquire — `tryAcquireLock(workerType, token)`。
      expect(guardSection).toMatch(/tryAcquireLock\(workerType,\s*token\)/);
      expect(guardSection).toContain("generateBootToken");
    });

    it("fails-open on Redis unavailable vs. fails-closed on race-lost (SEC M-1)", () => {
      // v0.4.0 PR7d-3 (SEC M-1): the guard must inspect
      // `probe.unavailable` / `acquire.reason === "redis_unavailable"`
      // and warn+return; `already_held` must exit(1).
      // v0.4.0 PR7d-3 (SEC M-1): Redis 不可到達は fail-open (warn + return)、
      // 既存 lock / race-lost は fail-closed (exit 1)。
      expect(guardSection).toMatch(/probe\.unavailable/);
      expect(guardSection).toMatch(/redis_unavailable/);
    });

    it("starts a heartbeat to extend TTL", () => {
      expect(guardSection).toMatch(/LOCK_HEARTBEAT_INTERVAL_MS/);
      expect(guardSection).toContain("setInterval");
    });

    it("fails open when Redis is unreachable (non-fatal warning)", () => {
      // fail-open: Redis failure must not block legitimate single-Worker start
      expect(guardSection).toMatch(/non-fatal/i);
    });
  });

  describe("Lifecycle integration", () => {
    it("evaluateDualRunGuard is invoked from main() before heavy init", () => {
      // PR-D-8 Phase 2 MF-06: guard now takes workerType resolved from
      // startMode (`--page` / `--backfill`) before being invoked. Older
      // signature was no-arg `evaluateDualRunGuard()`; the migrated form is
      // `evaluateDualRunGuard(guardWorkerType)`.
      // PR-D-8 Phase 2 MF-06: guard は workerType を受け取る per-type 化済み。
      expect(source).toMatch(/await evaluateDualRunGuard\(guardWorkerType\)/);
      // Ensure the guard runs BEFORE startWorkers (which triggers Prisma/Redis)
      // startWorkers の引数名は `startMode` (StartMode union: "page" |
      // "embedding-backfill" | "all")。guardWorkerType は startMode から導出される。
      const guardCall = source.indexOf("await evaluateDualRunGuard(guardWorkerType)");
      const startCall = source.indexOf("await startWorkers(startMode)");
      expect(guardCall).toBeGreaterThan(-1);
      expect(startCall).toBeGreaterThan(guardCall);
    });

    it("shutdownWorkers calls releaseStandaloneLock before process.exit(0)", () => {
      const shutdownStart = source.indexOf("async function shutdownWorkers");
      const shutdownEnd = source.indexOf("\n}\n", shutdownStart);
      const shutdownBody = source.slice(shutdownStart, shutdownEnd);
      expect(shutdownBody).toContain("releaseStandaloneLock()");
      // releaseStandaloneLock must come before process.exit(0)
      const releaseIdx = shutdownBody.indexOf("releaseStandaloneLock");
      const exitIdx = shutdownBody.indexOf("process.exit(0)");
      expect(releaseIdx).toBeGreaterThan(-1);
      expect(exitIdx).toBeGreaterThan(releaseIdx);
    });
  });
});
