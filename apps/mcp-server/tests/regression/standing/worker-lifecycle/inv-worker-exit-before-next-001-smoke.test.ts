// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001 (sub 3/3, integration smoke
 * contract structural verification):
 * 24h pre-merge smoke harness (`tests/smoke/worker-lifecycle-24h-smoke.test.ts`)
 * の **contract structural existence** を standing regression として継続検証
 * する。
 *
 * ## 検証契約 / Verification contracts
 *
 *   1. **Smoke harness file existence**: 24h smoke harness file が
 *      `tests/smoke/worker-lifecycle-24h-smoke.test.ts` に存在する。
 *   2. **4 thresholds contract**: 24h smoke harness が SEC M-NEW-2 / ADR-0030
 *      amendment §Decision N で formalise された 4 thresholds (deadlock /
 *      listener-not-fired / worker-lock p99 / tryAcquireLock race-lost) を
 *      verify する旨を comment / metadata で明示している。
 *   3. **package.json npm script**: `pnpm test:smoke:24h-worker-lifecycle`
 *      相当の manual kickoff script が package.json に登録されている。
 *
 * INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001 (sub 3/3, integration smoke
 * contract structural verification):
 * Continuously verifies the **contract structural existence** of the 24h
 * pre-merge smoke harness in the standing regression suite.
 *
 *   1. **Smoke harness file existence**: 24h smoke harness file exists at
 *      `tests/smoke/worker-lifecycle-24h-smoke.test.ts`.
 *   2. **4 thresholds contract**: smoke harness verifies the 4 thresholds
 *      formalised in SEC M-NEW-2 / ADR-0030 amendment §Decision N (deadlock /
 *      listener-not-fired / worker-lock p99 / tryAcquireLock race-lost) and
 *      declares them in comments / metadata.
 *   3. **package.json npm script**: a manual-kickoff script equivalent to
 *      `pnpm test:smoke:24h-worker-lifecycle` is registered in package.json.
 *
 * ## A-9 Declaration (feedback_no_fake_success A-9)
 *
 * - **A-9.1**: 本 sub 3 は smoke harness の **structural existence verification**
 *   であり、24h smoke run 自体の実行を verify するものではない。Real 24h smoke
 *   run の PASS は ADR-0030 amendment pre-merge gate で別途 enforce される
 *   (T+2d 2026-05-18, ADR-bound external SLA exception)。
 * - **A-9.2**: Standing regression 規約 (`.skip` / `.todo` / `describe.skip`
 *   禁止) と整合させるため、本 sub 3 は file system + package.json check で
 *   structural verification する。Real Redis を必要としない軽量 contract
 *   verification。
 *
 * Structural existence verification; real 24h smoke run is separately enforced
 * via ADR-0030 amendment pre-merge gate (T+2d 2026-05-18).
 *
 * @see Plan v4.2 §3.3 Constraint 5 (NEW INV, sub 3)
 * @see Plan v4.2 §5 (24h Integration Smoke Pre-Merge Gate)
 * @see ADR-0030 amendment §Decision N (24h smoke pre-merge gate, SEC M-NEW-2)
 * @see internal anchor: Plan v4.2 019e2c7e-3b25-701b-a18c-91b8a054a93f
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertInvName } from "../_setup/inv-assert";

// repo paths
const SMOKE_HARNESS_FILE = resolve(
  __dirname,
  "../../../../tests/smoke/worker-lifecycle-24h-smoke.test.ts"
);
const PACKAGE_JSON_FILE = resolve(__dirname, "../../../../package.json");

describe("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001 (sub 3, integration smoke contract): structural existence", () => {
  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: smoke harness file が tests/smoke/worker-lifecycle-24h-smoke.test.ts に存在する / smoke harness file exists", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001"
    );
    expect(existsSync(SMOKE_HARNESS_FILE)).toBe(true);
  });

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: smoke harness が 4 thresholds を comment / code で明示している / smoke harness declares 4 thresholds", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001"
    );
    const fileContent = readFileSync(SMOKE_HARNESS_FILE, "utf-8");
    // 4 thresholds keyword presence (SEC M-NEW-2 / ADR-0030 amendment §Decision N):
    //   1. deadlock
    //   2. listener-not-fired
    //   3. worker-lock p99
    //   4. tryAcquireLock race-lost
    expect(fileContent).toMatch(/deadlock/i);
    expect(fileContent).toMatch(/listener[\s-]?not[\s-]?fired/i);
    expect(fileContent).toMatch(/worker[\s-]?lock|p99/i);
    expect(fileContent).toMatch(/tryAcquireLock|race[\s-]?lost/i);
  });

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: smoke harness が ADR-0030 amendment / SEC M-NEW-2 を cross-reference している / smoke harness cross-references ADR-0030 amendment / SEC M-NEW-2", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001"
    );
    const fileContent = readFileSync(SMOKE_HARNESS_FILE, "utf-8");
    // cross-reference ADR-0030 amendment / SEC M-NEW-2 / Plan v4.2
    expect(fileContent).toMatch(/ADR-0030|SEC M-NEW-2|Plan v4\.2/);
  });

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: smoke harness が 24h continuous run の意図を表明している / smoke harness declares 24h continuous run intent", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001"
    );
    const fileContent = readFileSync(SMOKE_HARNESS_FILE, "utf-8");
    // 24h / 24 hour / 86400 (sec) のいずれか
    expect(fileContent).toMatch(/24\s*h|24\s*hour|86400/i);
  });

  it("INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001: package.json に smoke kickoff script (test:smoke:* または smoke:*) が登録されている / package.json registers smoke kickoff script", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-PROCESS-EXIT-BEFORE-NEXT-JOB-001"
    );
    const pkgJsonContent = readFileSync(PACKAGE_JSON_FILE, "utf-8");
    const pkgJson = JSON.parse(pkgJsonContent) as { scripts?: Record<string, string> };
    const scripts = pkgJson.scripts ?? {};
    const smokeScripts = Object.keys(scripts).filter((name) =>
      /smoke.*(?:24h|worker[-_]?lifecycle)|(?:24h|worker[-_]?lifecycle).*smoke/i.test(name)
    );
    expect(smokeScripts.length).toBeGreaterThanOrEqual(1);
  });
});
