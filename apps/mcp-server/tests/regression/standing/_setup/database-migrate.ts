// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — testcontainer Prisma schema apply helper
 * testcontainer への Prisma schema 適用ヘルパー
 *
 * ADR-0016 § Testcontainer Lifecycle (TDA-Plan-09) で global-setup 起動の
 * testcontainer postgres に `@reftrixmcp/database` schema を適用する。
 *
 * 2026-04-19 (Amendment): `prisma db push` から **`prisma migrate deploy`**
 * に切替。理由:
 *   1. `db push` は migration SQL を replay しないため、production migration
 *      で定義されている **`gen_uuidv7()` 関数** (`pgcrypto` 依存) が作成
 *      されず、schema 内 `@default(dbgenerated("gen_uuidv7()"))` 列で
 *      "function gen_uuidv7() does not exist" でハングアップする。
 *   2. `pgcrypto` / `vector` / `pg_trgm` / `uuid-ossp` 等の extension も
 *      db push は自動 CREATE しない。migration SQL 内で CREATE EXTENSION
 *      される経路が唯一整合性が取れる道。
 *   3. migration deploy の overhead は 10-20s と測定され、M1 SLA (< 15 min)
 *      に問題なく収まる。production と完全一致する点で逆に健全。
 *
 * Per ADR-0016 § Testcontainer Lifecycle. Switched from `db push` to
 * `migrate deploy` on 2026-04-19 because:
 *   1. `db push` skips migration SQL, so Reftrix's custom `gen_uuidv7()`
 *      function (defined in `20251130181932_add_crawler_tables/migration.sql`
 *      with `pgcrypto` dependency) is never created. Schema fields using
 *      `@default(dbgenerated("gen_uuidv7()"))` therefore fail with
 *      "function gen_uuidv7() does not exist".
 *   2. Required extensions (`pgcrypto` / `vector` / `pg_trgm` / `uuid-ossp`)
 *      are only CREATE'd inside migration SQL.
 *   3. `migrate deploy` adds ~10-20s which fits comfortably in the M1 < 15 min
 *      SLA, and yields a testcontainer identical to production.
 *
 * Shared across 4 standing regression domains (large-page / gdpr-delete /
 * worker-lifecycle / schema-enum-sync) per team-lead coordination
 * (2026-04-19): authored by large-page-lead, `migrate deploy` switch by
 * gdpr-delete-lead (LCC) with shared-infra authority.
 *
 * @module tests/regression/standing/_setup/database-migrate
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { sanitizeErrorMessage } from "../../../../src/utils/sanitize-error";

/**
 * Monorepo root からの @reftrixmcp/database package の相対位置
 * Relative location of the @reftrixmcp/database package from the monorepo root.
 */
const DATABASE_PACKAGE_REL_PATH = "packages/database" as const;

/**
 * Prisma schema path within the database package.
 */
const PRISMA_SCHEMA_REL_PATH = "prisma/schema.prisma" as const;

/**
 * migrate deploy のタイムアウト (ms)。testcontainer boot 後に ~10-30s 程度で
 * 完了する想定。migration 件数が増えた場合も十分に余裕がある。
 * Max wait for `prisma migrate deploy` — typically 10-30s after boot.
 */
const MIGRATE_DEPLOY_TIMEOUT_MS = 180_000;

/**
 * monorepo root を解決する (cwd 起点の探索)。
 * apps/mcp-server で pnpm test:regression:standing が起動された場合、
 * cwd は apps/mcp-server。monorepo root は `../..`。
 *
 * Resolve the monorepo root via cwd-based discovery.
 * When `pnpm test:regression:standing` runs from apps/mcp-server, cwd is
 * apps/mcp-server and the monorepo root is `../..`.
 */
function resolveMonorepoRoot(): string {
  // __dirname: apps/mcp-server/tests/regression/standing/_setup
  // monorepo root: ../../../../../..
  return path.resolve(__dirname, "../../../../../..");
}

/**
 * `prisma db push` を testcontainer postgres に対して実行する。
 *
 * Runs `prisma db push` against the testcontainer postgres.
 *
 * ADR-0016 § Fixture Lifecycle / § Isolation Guarantee:
 *   - `DATABASE_URL` は testcontainer 由来に差し替え済み (globalSetup 直後に呼ぶこと)
 *   - production DB には絶対に書込まない (URL prefix validation)
 *   - 失敗時は `process.exit(1)` で fail-closed (stdout/stderr は redact)
 *
 * - `DATABASE_URL` must point to the testcontainer (call after globalSetup).
 * - Never writes to a production DB (URL prefix validation).
 * - Fail-closed on failure with redacted stdout/stderr.
 */
export async function applyPrismaSchemaToTestcontainer(databaseUrl: string): Promise<void> {
  // fail-closed: URL が testcontainer 由来 (`localhost` / `127.0.0.1`) でなければ throw
  // fail-closed: URL must be a testcontainer (localhost / 127.0.0.1)
  if (!/^postgres(?:ql)?:\/\/[^/]*@(?:localhost|127\.0\.0\.1|::1|\[::1\])[:/]/i.test(databaseUrl)) {
    throw new Error(
      "[regression-standing] Refusing to apply schema to non-testcontainer DATABASE_URL " +
        "(must target localhost / 127.0.0.1)"
    );
  }

  const monorepoRoot = resolveMonorepoRoot();
  const databasePackageDir = path.join(monorepoRoot, DATABASE_PACKAGE_REL_PATH);
  const schemaPath = path.join(databasePackageDir, PRISMA_SCHEMA_REL_PATH);

  if (!fs.existsSync(schemaPath)) {
    throw new Error(
      `[regression-standing] Prisma schema not found at ${schemaPath} (monorepo root mis-resolved?)`
    );
  }

  // `prisma migrate deploy` で production migration を testcontainer に適用する。
  // 全 migration を順序通り再生するため CREATE EXTENSION + gen_uuidv7() 関数
  // などの依存も production と同様に作成される。
  //
  // Apply production migrations via `prisma migrate deploy`. Replays every
  // migration in order so extensions and custom functions (gen_uuidv7 etc.)
  // exist exactly as in production.
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "prisma", "migrate", "deploy"], {
      cwd: databasePackageDir,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        // migrate deploy 中の interactive prompt を抑止
        // Suppress interactive prompts during migrate deploy
        CI: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `[regression-standing] prisma migrate deploy timed out after ${MIGRATE_DEPLOY_TIMEOUT_MS}ms (partial stderr: ${sanitizeErrorMessage(stderrBuf.slice(-500))})`
        )
      );
    }, MIGRATE_DEPLOY_TIMEOUT_MS);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `[regression-standing] prisma migrate deploy spawn error: ${sanitizeErrorMessage(err)}`
        )
      );
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        // stdout/stderr は sanitize した snippet のみ log (DATABASE_URL 漏洩防止)
        // Log only a sanitized snippet to prevent DATABASE_URL leakage.
        const lastStderr = stderrBuf.slice(-500);
        const lastStdout = stdoutBuf.slice(-500);
        // 開発者向け詳細エラー (test 環境限定 + REFTRIX_REGRESSION_VERBOSE=1 で有効)。
        // Developer-only verbose output (gated behind NODE_ENV=test + env flag).
        if (process.env.NODE_ENV === "test" && process.env.REFTRIX_REGRESSION_VERBOSE === "1") {
          console.error("[regression-standing][VERBOSE] migrate deploy raw stderr:\n" + stderrBuf);
          console.error("[regression-standing][VERBOSE] migrate deploy raw stdout:\n" + stdoutBuf);
        }
        reject(
          new Error(
            `[regression-standing] prisma migrate deploy failed (exit=${code}): ` +
              `stderr=${sanitizeErrorMessage(lastStderr)} stdout=${sanitizeErrorMessage(lastStdout)}`
          )
        );
      }
    });
  });
}
