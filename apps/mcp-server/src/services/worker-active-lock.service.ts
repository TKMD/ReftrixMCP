// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WorkerActiveLockService — Redis-based active-worker detection (v0.4.0 PR7d-2)
 *
 * Prevents two BullMQ Worker processes (MCP-server fork-supervised vs. manual
 * `pnpm worker:start:page`) from concurrently consuming the same page-analyze
 * Queue, which previously caused jobId race and lock-handoff corruption.
 *
 * v0.4.0 PR7d-2: MCP サーバー fork-supervised Worker と手動 `pnpm worker:start:page`
 * が同一 page-analyze Queue を並列消費することで発生していた jobId race / lock 奪取
 * を防止するための Redis ベース active-worker 検出機構。
 *
 * Design:
 *   - Key:   `reftrix:worker:active:<workerType>` (e.g. `reftrix:worker:active:page`)
 *   - Value: UUID nonce (process-unique boot token)
 *   - TTL:   60 seconds (refreshed every 30s via `extendLock()`)
 *   - acquire: `SET key nonce EX 60 NX` (atomic acquire-or-fail)
 *   - release: Lua script — delete only if current value matches our nonce
 *              (prevents accidental deletion of a later owner's lock)
 *
 * 設計:
 *   - キー:   `reftrix:worker:active:<workerType>` (例: `reftrix:worker:active:page`)
 *   - 値:     UUID nonce (プロセス固有の boot token)
 *   - TTL:    60 秒 (30 秒ごとに `extendLock()` で延長)
 *   - acquire: `SET key nonce EX 60 NX` (atomic 取得 or 失敗)
 *   - release: Lua script — 現在値が自 nonce と一致する場合のみ削除
 *              (後続 owner の lock を誤削除しない)
 *
 * NOT a distributed mutex: single-owner detection only. Does not coordinate
 * multi-node BullMQ Workers (BullMQ handles that via Redis lists). This service
 * is strictly for preventing accidental dual-process concurrency on one host.
 *
 * 分散 mutex ではない: 単一 owner 検出のみ。マルチノード BullMQ Worker の調停は
 * BullMQ 本体 (Redis lists) が行う。本サービスは単一ホスト上の偶発的な二重起動
 * 防止に特化する。
 *
 * @module services/worker-active-lock
 */

import { randomUUID } from "node:crypto";
import type Redis from "ioredis";
import { createRedisClient } from "../config/redis";
import { logger } from "../utils/logger";
import { sanitizeErrorMessage } from "../utils/sanitize-error";

// ============================================================================
// Constants
// ============================================================================

/** Known worker types. `page` is the only page-analyze BullMQ Queue consumer. */
export type WorkerType = "page";

/** Redis key prefix for active-worker lock keys. */
const LOCK_KEY_PREFIX = "reftrix:worker:active:";

/** Lock TTL in seconds (refreshed every LOCK_HEARTBEAT_INTERVAL_MS). */
const LOCK_TTL_SECONDS = 60;

/** Heartbeat interval in ms (half of TTL for safety). */
export const LOCK_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Lua script — release lock only if value matches our nonce.
 * Prevents accidentally deleting a lock owned by a later process.
 *
 * 自 nonce と一致する場合のみ lock を削除する Lua スクリプト。
 * 後続プロセスの lock を誤って削除しないように保護する。
 */
const RELEASE_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

// ============================================================================
// Types
// ============================================================================

/**
 * Options for {@link WorkerActiveLockService}.
 *
 * {@link WorkerActiveLockService} のオプション。
 */
export interface WorkerActiveLockServiceOptions {
  /**
   * Redis client. When omitted, a new `client`-purpose client is created.
   *
   * Redis クライアント。未指定時は新規 `client` purpose クライアントを生成する。
   */
  redis?: Redis;
}

/**
 * Result of {@link WorkerActiveLockService.acquireLock} — discriminated union
 * distinguishing race-lost (`already_held`) from Redis-unreachable
 * (`redis_unavailable`). Callers should fail-closed on `already_held` and
 * fail-open on `redis_unavailable` to match ADR-0011's documented intent.
 *
 * {@link WorkerActiveLockService.acquireLock} の結果 — race 敗北
 * (`already_held`) と Redis 到達不能 (`redis_unavailable`) を区別する
 * discriminated union。呼び出し側は `already_held` では fail-closed、
 * `redis_unavailable` では fail-open することで ADR-0011 の設計意図と整合する。
 *
 * v0.4.0 PR7d-3 (SEC M-1): fail-closed vs fail-open 判別を呼び出し側に委ねる
 * ために導入。従来の `boolean` 戻り値では両ケースが共に `false` で区別不能だった。
 */
export type AcquireLockResult =
  | { ok: true }
  | { ok: false; reason: "already_held" }
  | { ok: false; reason: "redis_unavailable"; error: string };

/**
 * Result of {@link WorkerActiveLockService.checkExistingLock} — discriminated
 * union distinguishing "lock absent" (`exists: false`) from
 * "Redis unreachable" (`unavailable: true`).
 *
 * {@link WorkerActiveLockService.checkExistingLock} の結果 — lock 不在
 * (`exists: false`) と Redis 到達不能 (`unavailable: true`) を区別する
 * discriminated union。
 *
 * v0.4.0 PR7d-3 (SEC M-1): 同上。
 */
export type CheckExistingLockResult =
  | { unavailable: false; exists: false }
  | { unavailable: false; exists: true; nonce: string }
  | { unavailable: true; error: string };

// ============================================================================
// Service
// ============================================================================

/**
 * Redis-based worker-active lock manager.
 *
 * Redis ベースの worker-active lock マネージャ。
 */
export class WorkerActiveLockService {
  private readonly redis: Redis;
  private readonly ownedRedis: boolean;

  constructor(options: WorkerActiveLockServiceOptions = {}) {
    if (options.redis) {
      this.redis = options.redis;
      this.ownedRedis = false;
    } else {
      this.redis = createRedisClient({ purpose: "client" });
      this.ownedRedis = true;
    }
  }

  // ==========================================================================
  // Key Derivation
  // ==========================================================================

  /**
   * Compute the Redis key for a given worker type.
   *
   * @internal exposed for tests
   */
  static keyFor(workerType: WorkerType): string {
    return `${LOCK_KEY_PREFIX}${workerType}`;
  }

  // ==========================================================================
  // Lock Operations
  // ==========================================================================

  /**
   * Atomically acquire the active-worker lock for the given worker type.
   *
   * 指定 worker type の active lock を atomic に取得する。
   *
   * **Deprecated戻り値**: 単純な `boolean` は race-lost と Redis 不可到達を
   * 区別できないため、SEC M-1 (PR7d-3) で {@link tryAcquireLock} が追加された。
   * 新規コードは {@link tryAcquireLock} を使うこと。
   *
   * **Legacy return**: simple `boolean` cannot tell race-lost from
   * Redis-unreachable; SEC M-1 (PR7d-3) added {@link tryAcquireLock}. New
   * code should use {@link tryAcquireLock}.
   *
   * @param workerType - Worker type (e.g. `"page"`)
   * @param nonce - Unique boot token for the caller (typically `crypto.randomUUID()`)
   * @returns `true` if acquired, `false` if another owner already holds it OR Redis is unreachable
   */
  async acquireLock(workerType: WorkerType, nonce: string): Promise<boolean> {
    const result = await this.tryAcquireLock(workerType, nonce);
    return result.ok;
  }

  /**
   * Atomically acquire the active-worker lock and return a discriminated union
   * so callers can distinguish race-lost from Redis-unreachable conditions.
   *
   * v0.4.0 PR7d-3 (SEC M-1): ADR-0011 は Redis 到達不能時を fail-open 挙動と
   * 記載していたが、`acquireLock()` が両ケースを共に `false` として返していた
   * ため、呼び出し側が fail-closed 扱いするしかなかった。本メソッドで両者を
   * 明示的に区別する。
   *
   * ADR-0011 documents Redis-unreachable as fail-open, but the legacy
   * `acquireLock()` returned `false` for both race-lost and Redis-unreachable,
   * forcing callers into fail-closed behaviour. This method surfaces the
   * distinction.
   *
   * @param workerType - Worker type (e.g. `"page"`)
   * @param nonce - Unique boot token for the caller
   * @returns Discriminated union (ok / already_held / redis_unavailable)
   */
  async tryAcquireLock(workerType: WorkerType, nonce: string): Promise<AcquireLockResult> {
    if (typeof nonce !== "string" || nonce.length === 0) {
      // Never set an empty-string lock value — would make release impossible.
      // 空文字列を値に入れない（release 不能になる）。
      throw new Error("WorkerActiveLockService.acquireLock: nonce must be a non-empty string");
    }

    const key = WorkerActiveLockService.keyFor(workerType);
    try {
      const result = await this.redis.set(key, nonce, "EX", LOCK_TTL_SECONDS, "NX");
      if (result === "OK") {
        return { ok: true };
      }
      return { ok: false, reason: "already_held" };
    } catch (error) {
      const sanitized = sanitizeErrorMessage(error);
      logger.warn("[WorkerActiveLock] acquireLock failed (redis unavailable)", {
        workerType,
        error: sanitized,
      });
      return { ok: false, reason: "redis_unavailable", error: sanitized };
    }
  }

  /**
   * Refresh the TTL on a lock we own. No-op if the lock no longer exists or
   * is owned by a different nonce.
   *
   * 所有している lock の TTL を延長する。lock が既に消滅している場合、
   * または別 nonce が所有している場合は no-op。
   *
   * @returns `true` if the TTL was refreshed, `false` otherwise
   */
  async extendLock(workerType: WorkerType, nonce: string): Promise<boolean> {
    const key = WorkerActiveLockService.keyFor(workerType);
    try {
      // Check ownership then PEXPIRE in a single round trip via Lua for atomicity.
      // 所有確認 → PEXPIRE を Lua で atomic 実行。
      const script = `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
          return redis.call("PEXPIRE", KEYS[1], ARGV[2])
        else
          return 0
        end
      `;
      const result = await this.redis.eval(script, 1, key, nonce, String(LOCK_TTL_SECONDS * 1000));
      return result === 1;
    } catch (error) {
      logger.warn("[WorkerActiveLock] extendLock failed (non-fatal)", {
        workerType,
        error: sanitizeErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Release the lock we own. If another nonce currently holds the key, the
   * release is refused (we never delete someone else's lock).
   *
   * 所有する lock を解放する。別 nonce が保持している場合は削除を拒否する
   * (他者の lock は絶対に消さない)。
   *
   * @returns `true` if the lock was released, `false` if we did not own it
   */
  async releaseLock(workerType: WorkerType, nonce: string): Promise<boolean> {
    const key = WorkerActiveLockService.keyFor(workerType);
    try {
      const result = await this.redis.eval(RELEASE_LUA, 1, key, nonce);
      return result === 1;
    } catch (error) {
      logger.warn("[WorkerActiveLock] releaseLock failed (non-fatal)", {
        workerType,
        error: sanitizeErrorMessage(error),
      });
      return false;
    }
  }

  /**
   * Inspect whether a lock is currently held (and by which nonce).
   *
   * 現在 lock が保持されているか (およびその nonce) を確認する。
   *
   * **Deprecated戻り値**: 単純な `string | null` は lock 不在と Redis 不可到達を
   * 区別できないため、SEC M-1 (PR7d-3) で {@link probeExistingLock} が追加された。
   * 新規コードは {@link probeExistingLock} を使うこと。
   *
   * **Legacy return**: `string | null` cannot tell lock-absent from
   * Redis-unreachable; SEC M-1 (PR7d-3) added {@link probeExistingLock}.
   *
   * @returns The current owner's nonce, or `null` if no owner OR Redis is unreachable
   */
  async checkExistingLock(workerType: WorkerType): Promise<string | null> {
    const result = await this.probeExistingLock(workerType);
    if (result.unavailable) return null;
    return result.exists ? result.nonce : null;
  }

  /**
   * Inspect the current lock state and return a discriminated union so callers
   * can distinguish "no lock" from "Redis unreachable".
   *
   * v0.4.0 PR7d-3 (SEC M-1): `checkExistingLock()` が両ケースを共に `null` で
   * 返していたため、呼び出し側は Redis 障害時に fail-open できなかった。本
   * メソッドで明示的に区別する。
   *
   * @returns Discriminated union (unavailable / exists / no-exist)
   */
  async probeExistingLock(workerType: WorkerType): Promise<CheckExistingLockResult> {
    const key = WorkerActiveLockService.keyFor(workerType);
    try {
      const value = await this.redis.get(key);
      if (value === null) {
        return { unavailable: false, exists: false };
      }
      return { unavailable: false, exists: true, nonce: value };
    } catch (error) {
      const sanitized = sanitizeErrorMessage(error);
      logger.warn("[WorkerActiveLock] checkExistingLock failed (redis unavailable)", {
        workerType,
        error: sanitized,
      });
      return { unavailable: true, error: sanitized };
    }
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Close the underlying Redis connection (only if this service owns it).
   *
   * 所有する Redis 接続を閉じる (自前生成時のみ)。
   */
  async close(): Promise<void> {
    if (this.ownedRedis) {
      try {
        await this.redis.quit();
      } catch {
        // Best-effort close.
      }
    }
  }
}

// ============================================================================
// Convenience helpers
// ============================================================================

/**
 * Generate a fresh boot-token nonce for lock ownership.
 *
 * Lock 所有用の新しい boot-token nonce を生成する。
 */
export function generateBootToken(): string {
  return randomUUID();
}
