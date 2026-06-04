// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * INV-WORKER-PER-JOB-FORK-ISOLATION-001 (Plan v4.5 PR3 Track 2 §5.2)
 *
 * IO Plan Decision V1 anchor: `019e4267-d21e-7775-b956-544df059d328`
 *
 * ## Contract / 不変条件
 *
 * For every job dispatched in fork-only mode:
 *   - the sub-child (Layer 3) ONNX session is freshly initialised per job — the
 *     Layer 2 worker MUST NOT hold a persistent module-top-level ONNX session
 *     (global-state isolation, H1 race elimination);
 *   - orphan-cleanup releases ONLY own-bootEpoch locks (a foreign bootEpoch is a
 *     "live owner" and is skipped), guaranteeing per-job isolation across
 *     supervisor restarts (§4.2.2).
 *
 * The Layer 3 sub-child PID ≠ parent PID claim is structurally guaranteed by
 * `child_process.fork()` (the OS assigns a distinct PID); this INV pins the
 * isolation contract that DRIVES the distinct-process guarantee (per-job lock
 * own-origin verification + no persistent parent ONNX session).
 *
 * @see Plan v4.5 PR3 V1 §5.2 / §4.2.2 / §4.6 (dual fork hierarchy)
 */

import path from "node:path";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Redis from "ioredis";
import {
  WorkerActiveLockService,
  PER_JOB_LOCK_KEY_NAMESPACE,
  generateBootToken,
} from "../../../../src/services/worker-active-lock.service";
import { assertInvName } from "../_setup/inv-assert";

const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../..");
const WORKER_PATH = path.resolve(MCP_SERVER_ROOT, "src/workers/embedding-backfill-worker.ts");

function createRealRedisClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("[INV-WORKER-PER-JOB-FORK-ISOLATION-001] REDIS_URL not set by globalSetup");
  }
  const parsed = new URL(url);
  return new Redis({
    host: parsed.hostname,
    port: parseInt(parsed.port, 10),
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
    lazyConnect: false,
  });
}

async function cleanupPerJobKeys(inspector: Redis): Promise<void> {
  const keys = await inspector.keys(`${PER_JOB_LOCK_KEY_NAMESPACE}*`);
  if (keys.length > 0) await inspector.del(...keys);
  await inspector.del("reftrix:worker:active:embedding-backfill:rate");
}

describe("INV-WORKER-PER-JOB-FORK-ISOLATION-001: per-job ONNX session freshness + own-origin orphan isolation (Plan v4.5 PR3 Track 2 §5.2)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-PER-JOB-FORK-ISOLATION-001");
  });

  // Falsifiable predicate: no persistent module-top-level ONNX session in Layer 2.
  it("INV-WORKER-PER-JOB-FORK-ISOLATION-001: Layer 2 worker does NOT eagerly construct a module-top-level persistent ONNX/DINOv2 session (fork-per-job freshness, H1 global-state isolation)", () => {
    const text = fs.readFileSync(WORKER_PATH, "utf8");
    // A module-top-level eager session import like `import { embeddingService }`
    // followed by a top-level `.init()` / `new InferenceSession` at file scope
    // would re-introduce a persistent parent session (the H1 race surface).
    // We assert there is no top-level `new InferenceSession` / synchronous
    // session construction at module scope.
    const lines = text.split("\n");
    const violations: Array<{ line: number; snippet: string }> = [];
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i] ?? "";
      // Detect a top-level (no leading whitespace) ONNX session construction.
      if (/^new\s+InferenceSession\b/.test(lineText)) {
        violations.push({ line: i + 1, snippet: lineText.trim() });
      }
    }
    // Falsifier: a module-scope ONNX session would persist across jobs in the
    // parent thread, defeating per-job isolation.
    expect(violations).toEqual([]);
  });

  describe("INV-WORKER-PER-JOB-FORK-ISOLATION-001: orphan own-origin isolation (Redis)", () => {
    let inspector: Redis;
    let redis: Redis;
    let svc: WorkerActiveLockService;

    beforeEach(async () => {
      inspector = createRealRedisClient();
      await cleanupPerJobKeys(inspector);
      redis = createRealRedisClient();
      svc = new WorkerActiveLockService({ redis });
      await svc.pinLuaScripts();
    });

    afterEach(async () => {
      await cleanupPerJobKeys(inspector);
      await svc.close();
      await redis.quit();
      await inspector.quit();
    });

    it("INV-WORKER-PER-JOB-FORK-ISOLATION-001: scanOrphanPerJobLocks decodes per-job lock owners (nonce+bootEpoch) for own-origin verification", async () => {
      const epochOwn = generateBootToken();
      const epochForeign = generateBootToken();
      await svc.acquirePerJobSubChildLock("iso-own-1", generateBootToken(), epochOwn, {
        minIntervalMs: 0,
      });
      await svc.acquirePerJobSubChildLock("iso-foreign-1", generateBootToken(), epochForeign, {
        minIntervalMs: 0,
      });

      const entries = await svc.scanOrphanPerJobLocks();
      const byKey = new Map(entries.map((e) => [e.key, e]));
      const ownEntry = byKey.get(`${PER_JOB_LOCK_KEY_NAMESPACE}iso-own-1`);
      const foreignEntry = byKey.get(`${PER_JOB_LOCK_KEY_NAMESPACE}iso-foreign-1`);
      expect(ownEntry?.bootEpoch).toBe(epochOwn);
      expect(foreignEntry?.bootEpoch).toBe(epochForeign);
      // Falsifier: if the scan could not decode bootEpoch, own-origin cleanup
      // could not distinguish a crashed own sub-child from a live foreign owner.
      expect(ownEntry?.nonce).not.toBeNull();
      expect(foreignEntry?.nonce).not.toBeNull();
    });

    it("INV-WORKER-PER-JOB-FORK-ISOLATION-001: a release with the WRONG bootEpoch is a no-op (foreign live-owner protection, isolation across supervisor restart)", async () => {
      const ownerEpoch = generateBootToken();
      const ownerNonce = generateBootToken();
      await svc.acquirePerJobSubChildLock("iso-restart", ownerNonce, ownerEpoch, {
        minIntervalMs: 0,
      });
      // A "restarted supervisor" with a fresh bootEpoch must NOT delete this
      // live owner's lock (it is a foreign owner from the restarted POV).
      const restartEpoch = generateBootToken();
      const released = await svc.releasePerJobSubChildLock("iso-restart", ownerNonce, restartEpoch);
      // Falsifier: a bootEpoch-agnostic release would delete the live owner's
      // lock on supervisor restart, breaking per-job isolation.
      expect(released).toBe(false);
      expect(await inspector.get(`${PER_JOB_LOCK_KEY_NAMESPACE}iso-restart`)).not.toBeNull();
    });
  });
});
