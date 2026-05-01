// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — testcontainers helper / testcontainers ヘルパー
 *
 * ADR-0016 § Testcontainer Lifecycle (TDA-Plan-09) と § Docker Image License
 * (LCC-Plan-13/14) に従う:
 *
 * - postgres image: `postgres:18-alpine` (PostgreSQL License, AGPL 互換)
 * - pgvector image: `pgvector/pgvector:pg18` (PostgreSQL License)
 * - **redis image: `redis:7.2-alpine` (BSD3) pin — 7.4+ は RSALv2/SSPLv1 で
 *   AGPL-3.0-only 非互換のため絶対不可**
 * - reaper container: testcontainers default Ryuk 有効化 + 3 層 fallback
 * - ephemeral volume: `--rm` 明示、永続化ゼロ
 * - fail-closed: container 起動失敗時 `process.exit(1)`
 * - error log sanitize: 例外を `sanitizeErrorMessage()` で redact
 *
 * Per ADR-0016 § Testcontainer Lifecycle / § Docker Image License:
 *
 * - postgres: `postgres:18-alpine`
 * - pgvector: `pgvector/pgvector:pg18`
 * - **redis: `redis:7.2-alpine` pin — 7.4+ is FORBIDDEN due to RSALv2/SSPLv1
 *   incompatibility with AGPL-3.0-only**
 * - Ryuk reaper enabled with 3-layer fallback
 * - ephemeral volumes (`--rm`)
 * - fail-closed on boot failure
 * - error log redaction via `sanitizeErrorMessage()`
 *
 * @module tests/regression/standing/_setup/testcontainers
 */

import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { sanitizeErrorMessage } from "../../../../src/utils/sanitize-error";

// ============================================================================
// Constants — Image pins (ADR-0016 § Docker Image License)
// ============================================================================

/**
 * pgvector/pgvector:pg18 — PostgreSQL License (AGPL-compatible).
 * `postgres:18-alpine` の代わりに pgvector を直接使用 (HNSW index 用 extension が pre-installed)。
 *
 * Use the pgvector image directly so the `vector` extension is pre-installed
 * for HNSW index tests.
 */
export const POSTGRES_IMAGE = "pgvector/pgvector:pg18" as const;

/**
 * Redis 7.2-alpine — BSD 3-Clause license (AGPL-compatible).
 *
 * **絶対に 7.4+ に上げない / NEVER upgrade to 7.4+**:
 * - Redis 7.4 以降は RSALv2 / SSPLv1 dual license で AGPL-3.0-only 非互換
 * - Redis 8 alternative は AGPLv3 option を明示選択すれば互換だが本 ADR は 7.2 pin
 *
 * Redis 7.4+ uses RSALv2 / SSPLv1 dual license, incompatible with AGPL-3.0-only.
 * Redis 8 has an AGPLv3 option but ADR-0016 pins 7.2-alpine.
 */
export const REDIS_IMAGE = "redis:7.2-alpine" as const;

// PostgreSQL bootstrap parameters (testcontainer-only credentials)
const PG_USER = "reftrix_test" as const;
const PG_PASSWORD = "reftrix_test_password" as const;
const PG_DB = "reftrix_test" as const;
const PG_INTERNAL_PORT = 5432;
const REDIS_INTERNAL_PORT = 6379;

// ============================================================================
// Types
// ============================================================================

/**
 * 起動済み container ハンドル / Started container handles for tear-down.
 */
export interface StandingTestContainers {
  postgres: StartedTestContainer;
  redis: StartedTestContainer;
  /** `postgres://reftrix_test:...@host:mappedPort/reftrix_test` */
  databaseUrl: string;
  /** `redis://host:mappedPort` */
  redisUrl: string;
}

// ============================================================================
// Boot helpers
// ============================================================================

/**
 * pgvector/pgvector:pg18 testcontainer を起動する。
 *
 * `wait_for` は `pg_isready` を 30 秒間 poll し、その後 `vector` extension の
 * 読み出しが成功するまで wait する。
 *
 * Boots the pgvector testcontainer. Waits for `pg_isready` then verifies the
 * `vector` extension is loadable.
 */
export async function startPostgresContainer(): Promise<StartedTestContainer> {
  return await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_USER: PG_USER,
      POSTGRES_PASSWORD: PG_PASSWORD,
      POSTGRES_DB: PG_DB,
    })
    .withExposedPorts(PG_INTERNAL_PORT)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(60_000)
    .start();
}

/**
 * redis:7.2-alpine testcontainer を起動する。
 * Boots the redis:7.2-alpine testcontainer.
 */
export async function startRedisContainer(): Promise<StartedTestContainer> {
  return await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(REDIS_INTERNAL_PORT)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .withStartupTimeout(30_000)
    .start();
}

/**
 * 4 ドメイン standing regression suite 全体で共有する container 群を起動する。
 * fail-closed: いずれか失敗で `process.exit(1)`。
 *
 * Boots the testcontainers shared by the 4-domain standing suite.
 * Fail-closed: any boot failure → `process.exit(1)`.
 *
 * SEC-Plan-08 Amendment: error 出力は `sanitizeErrorMessage()` で redact 済み。
 */
export async function startStandingTestContainers(): Promise<StandingTestContainers> {
  let postgres: StartedTestContainer | undefined;
  let redis: StartedTestContainer | undefined;
  try {
    [postgres, redis] = await Promise.all([startPostgresContainer(), startRedisContainer()]);
    const pgPort = postgres.getMappedPort(PG_INTERNAL_PORT);
    const pgHost = postgres.getHost();
    const redisPort = redis.getMappedPort(REDIS_INTERNAL_PORT);
    const redisHost = redis.getHost();
    const databaseUrl = `postgresql://${PG_USER}:${PG_PASSWORD}@${pgHost}:${pgPort}/${PG_DB}`;
    const redisUrl = `redis://${redisHost}:${redisPort}`;
    return { postgres, redis, databaseUrl, redisUrl };
  } catch (err) {
    // SEC-Plan-08 Amendment: stack trace / connection string を redact してから出力
    // SEC-Plan-08 Amendment: redact stack trace / connection strings before logging.
    console.error("[regression-standing] testcontainer boot failed:", sanitizeErrorMessage(err));
    // 失敗した container は teardown を試みる (Ryuk fail-open fallback layer 1)
    // Best-effort teardown of any containers that did start (Ryuk fallback layer 1).
    await Promise.allSettled([postgres?.stop({ remove: true }), redis?.stop({ remove: true })]);
    process.exit(1);
  }
}

/**
 * container を全て停止し volume を削除する (Ryuk fallback layer 1 — 直接停止)。
 *
 * Stops containers and removes their volumes (Ryuk fallback layer 1 — explicit stop).
 *
 * SEC-Plan-12 Amendment: Ryuk が落ちた場合の first line of defense として、Ryuk に
 * 依存せず明示的に container.stop() を呼ぶ。CI workflow 側の `docker container prune`
 * (always() post-step) が second line of defense。
 *
 * SEC-Plan-12 Amendment: as the first line of defense when Ryuk fails, explicitly
 * call container.stop() without relying on Ryuk. The CI workflow's
 * `docker container prune` (always() post-step) is the second line of defense.
 */
export async function stopStandingTestContainers(
  handles: Pick<StandingTestContainers, "postgres" | "redis">
): Promise<void> {
  const results = await Promise.allSettled([
    handles.postgres.stop({ remove: true }),
    handles.redis.stop({ remove: true }),
  ]);
  for (const r of results) {
    if (r.status === "rejected") {
      console.warn(
        "[regression-standing] container stop failed (Ryuk fallback expected):",
        sanitizeErrorMessage(r.reason)
      );
    }
  }
}
