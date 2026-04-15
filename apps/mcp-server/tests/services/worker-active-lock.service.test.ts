// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerActiveLockService unit tests (v0.4.0 PR7d-2)
 *
 * Verifies Redis-based active-worker lock semantics:
 *   - acquireLock is atomic (second acquire fails while first holds)
 *   - extendLock refreshes TTL only for the owning nonce
 *   - releaseLock refuses to delete when the current owner nonce differs
 *   - checkExistingLock reports owner vs. absence correctly
 *
 * 実 Redis を立てずに済むよう、必要最小の Redis API を満たす in-memory stub を
 * 用意する。ioredis-mock を追加依存にしないため。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Redis from "ioredis";
import { WorkerActiveLockService } from "../../src/services/worker-active-lock.service";

// ---------------------------------------------------------------------------
// In-memory Redis stub — implements only: set (with NX+EX), get, eval
// 本テストで必要な API のみをサポートする in-memory Redis stub。
// ---------------------------------------------------------------------------
class InMemoryRedisStub {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  private isExpired(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return true;
    }
    return false;
  }

  async set(key: string, value: string, ...rest: Array<string | number>): Promise<"OK" | null> {
    // ioredis signature we use: set(key, value, "EX", ttl, "NX")
    let ttlSeconds: number | null = null;
    let nx = false;
    for (let i = 0; i < rest.length; i++) {
      const token = rest[i];
      if (token === "EX") {
        ttlSeconds = Number(rest[i + 1]);
        i++;
      } else if (token === "NX") {
        nx = true;
      }
    }
    if (nx) {
      this.isExpired(key); // evict if stale
      if (this.store.has(key)) return null;
    }
    const expiresAt = ttlSeconds !== null ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    if (this.isExpired(key)) return null;
    return this.store.get(key)?.value ?? null;
  }

  async eval(script: string, _numKeys: number, ...args: string[]): Promise<number> {
    const [key, ...rest] = args;
    if (this.isExpired(key)) return 0;
    const current = this.store.get(key)?.value ?? null;
    if (/PEXPIRE/.test(script)) {
      // eval: if GET == ARGV[1] then PEXPIRE ARGV[2]; refresh TTL
      const [nonce, pexpireMs] = rest;
      if (current !== nonce) return 0;
      const expiresAt = Date.now() + Number(pexpireMs);
      this.store.set(key, { value: current, expiresAt });
      return 1;
    }
    if (/DEL/.test(script)) {
      const [nonce] = rest;
      if (current !== nonce) return 0;
      this.store.delete(key);
      return 1;
    }
    return 0;
  }

  async quit(): Promise<"OK"> {
    this.store.clear();
    return "OK";
  }

  async flushall(): Promise<"OK"> {
    this.store.clear();
    return "OK";
  }
}

function createStubRedis(): Redis {
  // Cast to Redis — our stub satisfies the subset used by WorkerActiveLockService.
  return new InMemoryRedisStub() as unknown as Redis;
}

// ---------------------------------------------------------------------------

describe("WorkerActiveLockService (v0.4.0 PR7d-2)", () => {
  let redis: Redis;
  let service: WorkerActiveLockService;

  beforeEach(() => {
    redis = createStubRedis();
    service = new WorkerActiveLockService({ redis });
  });

  afterEach(async () => {
    await service.close();
  });

  describe("acquireLock", () => {
    it("acquires the lock when no owner is present", async () => {
      const acquired = await service.acquireLock("page", "token-1");
      expect(acquired).toBe(true);
    });

    it("refuses a second acquire while another nonce holds the lock", async () => {
      const first = await service.acquireLock("page", "token-1");
      expect(first).toBe(true);

      const second = await service.acquireLock("page", "token-2");
      expect(second).toBe(false);
    });

    it("rejects empty nonces to prevent unreleasable locks", async () => {
      await expect(service.acquireLock("page", "")).rejects.toThrow(/non-empty/);
    });
  });

  describe("checkExistingLock", () => {
    it("returns null when no lock is set", async () => {
      const nonce = await service.checkExistingLock("page");
      expect(nonce).toBeNull();
    });

    it("returns the owner nonce when a lock is set", async () => {
      await service.acquireLock("page", "token-abc");
      const nonce = await service.checkExistingLock("page");
      expect(nonce).toBe("token-abc");
    });
  });

  describe("extendLock", () => {
    it("refreshes the TTL when the nonce matches", async () => {
      await service.acquireLock("page", "token-x");
      const extended = await service.extendLock("page", "token-x");
      expect(extended).toBe(true);
    });

    it("refuses to extend when the nonce does not match", async () => {
      await service.acquireLock("page", "token-x");
      const extended = await service.extendLock("page", "token-y");
      expect(extended).toBe(false);
    });

    it("refuses to extend when the lock does not exist", async () => {
      const extended = await service.extendLock("page", "token-x");
      expect(extended).toBe(false);
    });
  });

  describe("releaseLock (Lua atomic)", () => {
    it("releases the lock when the nonce matches", async () => {
      await service.acquireLock("page", "token-match");
      const released = await service.releaseLock("page", "token-match");
      expect(released).toBe(true);

      // After release, a new acquire must succeed
      const reacquired = await service.acquireLock("page", "token-next");
      expect(reacquired).toBe(true);
    });

    it("refuses to release when the nonce does NOT match", async () => {
      await service.acquireLock("page", "token-owner");
      const released = await service.releaseLock("page", "token-attacker");
      expect(released).toBe(false);

      // Original owner's lock must remain intact
      const nonce = await service.checkExistingLock("page");
      expect(nonce).toBe("token-owner");
    });

    it("returns false when the lock does not exist", async () => {
      const released = await service.releaseLock("page", "any-token");
      expect(released).toBe(false);
    });
  });

  describe("keyFor", () => {
    it("uses the reftrix:worker:active: prefix", () => {
      expect(WorkerActiveLockService.keyFor("page")).toBe("reftrix:worker:active:page");
    });
  });

  // ==========================================================================
  // v0.4.0 PR7d-3 (SEC M-1): discriminated union APIs
  // ==========================================================================

  describe("tryAcquireLock (discriminated union)", () => {
    it("returns { ok: true } on successful acquire", async () => {
      const result = await service.tryAcquireLock("page", "token-1");
      expect(result).toEqual({ ok: true });
    });

    it("returns { ok: false, reason: 'already_held' } when another nonce holds the lock", async () => {
      await service.tryAcquireLock("page", "token-a");
      const result = await service.tryAcquireLock("page", "token-b");
      expect(result).toEqual({ ok: false, reason: "already_held" });
    });

    it("returns { ok: false, reason: 'redis_unavailable', error } on Redis transport failure", async () => {
      // Simulate Redis unavailable by providing a service whose underlying
      // client throws on set().
      const throwingRedis = {
        set: async () => {
          throw new Error("ECONNREFUSED 127.0.0.1:27379");
        },
        get: async () => null,
        eval: async () => 0,
        quit: async () => "OK",
      } as unknown as Redis;
      const failingService = new WorkerActiveLockService({ redis: throwingRedis });
      const result = await failingService.tryAcquireLock("page", "token-x");
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.reason).toBe("redis_unavailable");
        if (result.reason === "redis_unavailable") {
          expect(result.error).toEqual(expect.any(String));
          expect(result.error.length).toBeGreaterThan(0);
        }
      }
      await failingService.close();
    });

    it("rejects empty nonces (same guard as legacy acquireLock)", async () => {
      await expect(service.tryAcquireLock("page", "")).rejects.toThrow(/non-empty/);
    });
  });

  describe("probeExistingLock (discriminated union)", () => {
    it("returns { unavailable: false, exists: false } when no lock is set", async () => {
      const result = await service.probeExistingLock("page");
      expect(result).toEqual({ unavailable: false, exists: false });
    });

    it("returns { unavailable: false, exists: true, nonce } when a lock is set", async () => {
      await service.tryAcquireLock("page", "token-owner");
      const result = await service.probeExistingLock("page");
      expect(result).toEqual({ unavailable: false, exists: true, nonce: "token-owner" });
    });

    it("returns { unavailable: true, error } on Redis transport failure", async () => {
      const throwingRedis = {
        set: async () => "OK",
        get: async () => {
          throw new Error("ETIMEDOUT");
        },
        eval: async () => 0,
        quit: async () => "OK",
      } as unknown as Redis;
      const failingService = new WorkerActiveLockService({ redis: throwingRedis });
      const result = await failingService.probeExistingLock("page");
      expect(result.unavailable).toBe(true);
      if (result.unavailable) {
        expect(result.error).toEqual(expect.any(String));
        expect(result.error.length).toBeGreaterThan(0);
      }
      await failingService.close();
    });
  });

  describe("legacy acquireLock / checkExistingLock preserve boolean / nullable shape", () => {
    it("acquireLock returns true on success and false on Redis failure (legacy compatibility)", async () => {
      const acquired = await service.acquireLock("page", "legacy-token");
      expect(acquired).toBe(true);

      const throwingRedis = {
        set: async () => {
          throw new Error("Redis down");
        },
        get: async () => null,
        eval: async () => 0,
        quit: async () => "OK",
      } as unknown as Redis;
      const failing = new WorkerActiveLockService({ redis: throwingRedis });
      const failAcquire = await failing.acquireLock("page", "legacy-token-2");
      expect(failAcquire).toBe(false);
      await failing.close();
    });

    it("checkExistingLock returns null for both 'no lock' and 'Redis failure' (legacy compatibility)", async () => {
      const none = await service.checkExistingLock("page");
      expect(none).toBeNull();

      const throwingRedis = {
        set: async () => "OK",
        get: async () => {
          throw new Error("Redis down");
        },
        eval: async () => 0,
        quit: async () => "OK",
      } as unknown as Redis;
      const failing = new WorkerActiveLockService({ redis: throwingRedis });
      const failProbe = await failing.checkExistingLock("page");
      expect(failProbe).toBeNull();
      await failing.close();
    });
  });
});
