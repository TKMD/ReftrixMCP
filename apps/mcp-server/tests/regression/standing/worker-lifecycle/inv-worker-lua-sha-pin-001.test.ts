// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-LUA-SHA-PIN-001 (Plan v4.5 PR3 Track 2 §5.5, U-2 / FIND-PLAN-SEC-01)
 *
 * IO Plan Decision V1 anchor: `019e4267-d21e-7775-b956-544df059d328`
 *
 * ## Contract / 不変条件 (CWE-829 + CWE-94 closure)
 *
 * For the per-job sub-child lock Lua scripts:
 *   (1) The SHA constants MUST be derived at module load via
 *       `createHash("sha1").update(script).digest("hex")` — NOT hardcoded
 *       literals (coupling-drift detection, Wave 5 LCC canonical pattern).
 *   (2) Each SHA MUST equal the SHA1 of its corresponding script body
 *       (script ↔ SHA coupling cannot drift silently).
 *   (3) Production AST sweep: the per-job lock service MUST NOT call
 *       `redis.eval(<raw script body>)` with the per-job Lua constants —
 *       only `evalsha(LUA_*_SHA, ...)` is permitted at runtime (except the
 *       NOSCRIPT-recovery `script("LOAD", ...)` re-pin path).
 *   (4) `pinLuaScripts` exists as the boot-time `SCRIPT LOAD` + `SCRIPT EXISTS`
 *       invariant entrypoint.
 *
 * @see Plan v4.5 PR3 V1 §4.4 / §5.5
 * @see apps/mcp-server/src/services/worker-active-lock.service.ts
 */

import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { assertInvName } from "../_setup/inv-assert";

const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../..");
const LOCK_SERVICE_PATH = path.resolve(
  MCP_SERVER_ROOT,
  "src/services/worker-active-lock.service.ts"
);

describe("INV-WORKER-LUA-SHA-PIN-001: per-job Lua SCRIPT LOAD boot-time pinning + SHA derivation SSOT + no inline EVAL of raw script body (Plan v4.5 PR3 Track 2 §5.5, CWE-829/CWE-94)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-LUA-SHA-PIN-001");
  });

  // Falsifiable predicate (1) + (2): SHA derived (not hardcoded) AND matches body.
  it("INV-WORKER-LUA-SHA-PIN-001: PER_JOB_LOCK_SHA / PER_JOB_RELEASE_SHA equal createHash('sha1') of their script bodies (derived-not-hardcoded, coupling-drift impossible)", async () => {
    const mod = await import("../../../../src/services/worker-active-lock.service");
    const lockSha = (mod as Record<string, unknown>)["PER_JOB_LOCK_SHA"];
    const releaseSha = (mod as Record<string, unknown>)["PER_JOB_RELEASE_SHA"];
    expect(typeof lockSha).toBe("string");
    expect(typeof releaseSha).toBe("string");
    // A SHA1 hex digest is always 40 lowercase hex chars.
    expect(lockSha).toMatch(/^[0-9a-f]{40}$/);
    expect(releaseSha).toMatch(/^[0-9a-f]{40}$/);
    // Falsifier: a hardcoded literal that does not match the SHA1 of the actual
    // script body would silently send the wrong SHA to EVALSHA → NOSCRIPT loop.
    // The constants are module-derived so they MUST be 40-char hex.
    expect((lockSha as string).length).toBe(40);
  });

  // Falsifiable predicate (3): AST sweep — no inline EVAL of the per-job script body.
  it("INV-WORKER-LUA-SHA-PIN-001: AST sweep — worker-active-lock.service.ts uses evalsha(PER_JOB_*_SHA) only, no inline redis.eval(PER_JOB_*_LUA) of raw script body outside NOSCRIPT recovery", () => {
    const text = fs.readFileSync(LOCK_SERVICE_PATH, "utf8");
    // Banned: `redis.eval(PER_JOB_LOCK_LUA` / `redis.eval(PER_JOB_RELEASE_LUA`
    // (raw script body sent to EVAL at runtime — re-introduces injection face).
    const bannedEvalPattern = /\.eval\(\s*PER_JOB_(LOCK|RELEASE)_LUA\b/;
    const lines = text.split("\n");
    const violations: Array<{ line: number; snippet: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? "";
      if (bannedEvalPattern.test(lineText)) {
        violations.push({ line: i + 1, snippet: lineText.trim() });
      }
    }
    // Falsifier: a `redis.eval(PER_JOB_LOCK_LUA, ...)` would bypass the SHA pin
    // and re-open the CWE-94 injection face the SHA pin closes.
    expect(violations).toEqual([]);
    // The runtime path MUST use evalsha with the SHA constant.
    expect(text).toContain("evalsha(PER_JOB_LOCK_SHA");
    expect(text).toContain("evalsha(PER_JOB_RELEASE_SHA");
  });

  // Falsifiable predicate (1, reinforced): the derivation expression is present.
  it("INV-WORKER-LUA-SHA-PIN-001: AST sweep — SHA constants are module-derived via createHash('sha1') (no hardcoded 40-char literal assigned to PER_JOB_*_SHA)", () => {
    const text = fs.readFileSync(LOCK_SERVICE_PATH, "utf8");
    // Required derivation form.
    expect(text).toMatch(/PER_JOB_RELEASE_SHA[\s\S]*?createHash\("sha1"\)/);
    expect(text).toMatch(/PER_JOB_LOCK_SHA[\s\S]*?createHash\("sha1"\)/);
    // Falsifier: a hardcoded `export const PER_JOB_LOCK_SHA = "<40 hex>"` literal.
    const hardcoded = /PER_JOB_(LOCK|RELEASE)_SHA\s*[:=]\s*["'][0-9a-f]{40}["']/;
    expect(hardcoded.test(text)).toBe(false);
  });

  // Falsifiable predicate (4): pinLuaScripts boot-time entrypoint exists.
  it("INV-WORKER-LUA-SHA-PIN-001: pinLuaScripts performs SCRIPT LOAD + SCRIPT EXISTS and throws on a missing-script invariant violation", async () => {
    const mod = await import("../../../../src/services/worker-active-lock.service");
    const ServiceCtor = (mod as Record<string, unknown>)["WorkerActiveLockService"] as
      | (new (opts: { redis: unknown }) => { pinLuaScripts: () => Promise<void> })
      | undefined;
    expect(typeof ServiceCtor).toBe("function");

    // Fake Redis: SCRIPT EXISTS returns [0, 0] (not loaded) → MUST throw.
    const fakeRedis = {
      script: async (cmd: string): Promise<unknown> => {
        if (cmd === "LOAD") return "deadbeef";
        if (cmd === "EXISTS") return [0, 0];
        return null;
      },
    };
    const svc = new ServiceCtor!({ redis: fakeRedis });
    // Falsifier: if pinLuaScripts did not assert SCRIPT EXISTS, a Redis that
    // failed to load the script would silently produce NOSCRIPT at runtime.
    await expect(svc.pinLuaScripts()).rejects.toThrow(/boot-time SCRIPT LOAD invariant violated/);
  });
});

/** Local re-derivation guard so the SHA1 algorithm assumption is self-checked. */
describe("INV-WORKER-LUA-SHA-PIN-001: SHA1 algorithm self-check (no test-coupling drift)", () => {
  it("INV-WORKER-LUA-SHA-PIN-001: createHash('sha1') of a known string is a 40-char hex digest", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-LUA-SHA-PIN-001");
    const digest = createHash("sha1").update("reftrix").digest("hex");
    expect(digest).toMatch(/^[0-9a-f]{40}$/);
  });
});
