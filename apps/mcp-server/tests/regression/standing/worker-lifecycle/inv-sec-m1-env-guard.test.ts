// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — worker-lifecycle domain
 *
 * SEC-M1 (ADR-0016 § Test-only Env Var Guard, deadline 2026-05-15) wiring 検証:
 *
 * - **SEC-M1-01**: `apps/mcp-server/src/workers/phases/shared/fork-common.ts`
 *   の `buildChildEnv()` が `filterTestOnlyEnvForChild()` 経由で env を構築し、
 *   production runtime に万一 `EMBEDDING_MODEL_MOCK=true` がリークしても child
 *   env に伝搬しない。
 *
 * - **SEC-M1-02**: 3 production entry point (`src/index.ts` main(),
 *   `src/server.ts` start(), `src/scripts/start-workers.ts` main()) の起動
 *   シーケンス冒頭で `assertNoTestOnlyEnvLeak()` が呼ばれる (defense in depth)。
 *
 * SEC-M1 wiring verification: SEC-M1-01 ensures `buildChildEnv()` strips
 * test-only env vars before fork; SEC-M1-02 ensures all 3 production entry
 * points call `assertNoTestOnlyEnvLeak()` at boot (defense in depth).
 *
 * 検証方式 / Strategy:
 *   - SEC-M1-01: source-code 静的検証 + `buildChildEnv()` 単体実行で
 *     test-only env が strip されることを assert (実際の fork は行わない)
 *   - SEC-M1-02: source-code 静的検証 + `assertNoTestOnlyEnvLeak()` 単体動作
 *     検証 (production NODE_ENV = throw / test NODE_ENV = no-op)
 *
 * SEC-M1-01: source-code static check + `buildChildEnv()` unit invocation.
 * SEC-M1-02: source-code static check + `assertNoTestOnlyEnvLeak()` unit
 * behaviour verification.
 *
 * @see ADR-0016 § Test-only Env Var Guard (SEC-Plan-01) Amendment for SEC-M1
 * @see decision 019da55d (IO M1 Sanity Check Decision: CONDITIONAL documentation-only)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { assertInvName } from "../_setup/inv-assert";
import {
  assertNoTestOnlyEnvLeak,
  filterTestOnlyEnvForChild,
} from "../../../../src/config/test-env-guard";

const REPO_ROOT_RELATIVE_FROM_TEST = "../../../..";
const SRC_INDEX = path.resolve(__dirname, REPO_ROOT_RELATIVE_FROM_TEST, "src/index.ts");
const SRC_SERVER = path.resolve(__dirname, REPO_ROOT_RELATIVE_FROM_TEST, "src/server.ts");
const SRC_START_WORKERS = path.resolve(
  __dirname,
  REPO_ROOT_RELATIVE_FROM_TEST,
  "src/scripts/start-workers.ts"
);
const SRC_FORK_COMMON = path.resolve(
  __dirname,
  REPO_ROOT_RELATIVE_FROM_TEST,
  "src/workers/phases/shared/fork-common.ts"
);

function readSource(absPath: string): string {
  return fs.readFileSync(absPath, "utf-8");
}

describe("INV-SEC-M1-01: filterTestOnlyEnvForChild() is wired into fork-common.buildChildEnv()", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SEC-M1-01");
  });

  it("INV-SEC-M1-01: fork-common.ts は test-env-guard から filterTestOnlyEnvForChild を import している / fork-common.ts imports filterTestOnlyEnvForChild from test-env-guard", () => {
    const src = readSource(SRC_FORK_COMMON);
    expect(src).toMatch(
      /import\s*\{[^}]*filterTestOnlyEnvForChild[^}]*\}\s*from\s*["']\.\.\/\.\.\/\.\.\/config\/test-env-guard["']/
    );
  });

  it("INV-SEC-M1-01: buildChildEnv() は filterTestOnlyEnvForChild(process.env) を baseEnv の起点に使う / buildChildEnv() seeds baseEnv via filterTestOnlyEnvForChild(process.env)", () => {
    const src = readSource(SRC_FORK_COMMON);
    // baseEnv の構築起点が filterTestOnlyEnvForChild であることを assert。
    // 旧実装の `{ ...process.env }` 直接展開が再発した場合、本テストが fail する。
    // The baseEnv must originate from filterTestOnlyEnvForChild — if the legacy
    // `{ ...process.env }` shallow-copy regresses, this test will fail.
    expect(src).toMatch(/baseEnv\s*=\s*filterTestOnlyEnvForChild\(process\.env\)/);
    expect(src).not.toMatch(/baseEnv\s*=\s*\{\s*\.\.\.process\.env\s*\}/);
  });

  it("INV-SEC-M1-01: production runtime (NODE_ENV=production) で EMBEDDING_MODEL_MOCK が strip される / production strip semantics for EMBEDDING_MODEL_MOCK", () => {
    const filtered = filterTestOnlyEnvForChild({
      NODE_ENV: "production",
      EMBEDDING_MODEL_MOCK: "true",
      DATABASE_URL: "postgres://example/db",
    });
    expect(filtered.EMBEDDING_MODEL_MOCK).toBeUndefined();
    expect(filtered.DATABASE_URL).toBe("postgres://example/db");
    expect(filtered.NODE_ENV).toBe("production");
  });

  it("INV-SEC-M1-01: NODE_ENV=test では filterTestOnlyEnvForChild が test-only var を保持する (テスト経路の正当性) / NODE_ENV=test preserves test-only vars (legitimate test path)", () => {
    const filtered = filterTestOnlyEnvForChild({
      NODE_ENV: "test",
      EMBEDDING_MODEL_MOCK: "true",
    });
    expect(filtered.EMBEDDING_MODEL_MOCK).toBe("true");
  });

  it("INV-SEC-M1-01: development runtime でも EMBEDDING_MODEL_MOCK=true は strip される (本番同様の防御) / development runtime strips EMBEDDING_MODEL_MOCK same as production", () => {
    const filtered = filterTestOnlyEnvForChild({
      NODE_ENV: "development",
      EMBEDDING_MODEL_MOCK: "true",
    });
    expect(filtered.EMBEDDING_MODEL_MOCK).toBeUndefined();
  });
});

describe("INV-SEC-M1-02: assertNoTestOnlyEnvLeak() is invoked at all 3 production entry points", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-SEC-M1-02");
  });

  it("INV-SEC-M1-02: src/index.ts は assertNoTestOnlyEnvLeak を import + main() で呼び出す / src/index.ts imports and calls assertNoTestOnlyEnvLeak in main()", () => {
    const src = readSource(SRC_INDEX);
    expect(src).toMatch(
      /import\s*\{\s*assertNoTestOnlyEnvLeak\s*\}\s*from\s*["']\.\/config\/test-env-guard["']/
    );
    expect(src).toMatch(/assertNoTestOnlyEnvLeak\(\)/);
  });

  it("INV-SEC-M1-02: src/server.ts は assertNoTestOnlyEnvLeak を import + start() で呼び出す / src/server.ts imports and calls assertNoTestOnlyEnvLeak in start()", () => {
    const src = readSource(SRC_SERVER);
    expect(src).toMatch(
      /import\s*\{\s*assertNoTestOnlyEnvLeak\s*\}\s*from\s*["']\.\/config\/test-env-guard["']/
    );
    expect(src).toMatch(/assertNoTestOnlyEnvLeak\(\)/);
  });

  it("INV-SEC-M1-02: src/scripts/start-workers.ts は assertNoTestOnlyEnvLeak を import + main() で呼び出す / start-workers.ts imports and calls assertNoTestOnlyEnvLeak in main()", () => {
    const src = readSource(SRC_START_WORKERS);
    expect(src).toMatch(
      /import\s*\{\s*assertNoTestOnlyEnvLeak\s*\}\s*from\s*["']\.\.\/config\/test-env-guard["']/
    );
    expect(src).toMatch(/assertNoTestOnlyEnvLeak\(\)/);
  });

  describe("INV-SEC-M1-02: assertNoTestOnlyEnvLeak() runtime semantics", () => {
    let originalNodeEnv: string | undefined;
    let originalMock: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
      originalMock = process.env.EMBEDDING_MODEL_MOCK;
    });

    afterEach(() => {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
      if (originalMock === undefined) {
        delete process.env.EMBEDDING_MODEL_MOCK;
      } else {
        process.env.EMBEDDING_MODEL_MOCK = originalMock;
      }
    });

    it("INV-SEC-M1-02: production env で EMBEDDING_MODEL_MOCK=true は throw する / throws in production when EMBEDDING_MODEL_MOCK=true", () => {
      expect(() =>
        assertNoTestOnlyEnvLeak({
          NODE_ENV: "production",
          EMBEDDING_MODEL_MOCK: "true",
        })
      ).toThrow(/EMBEDDING_MODEL_MOCK/);
    });

    it("INV-SEC-M1-02: development env でも EMBEDDING_MODEL_MOCK=true は throw する (本番同等防御) / throws in development too (matches production guard)", () => {
      expect(() =>
        assertNoTestOnlyEnvLeak({
          NODE_ENV: "development",
          EMBEDDING_MODEL_MOCK: "true",
        })
      ).toThrow(/EMBEDDING_MODEL_MOCK/);
    });

    it("INV-SEC-M1-02: NODE_ENV=test では mock var が許可されて throw しない (legitimate test path) / NODE_ENV=test allows mock vars without throwing", () => {
      expect(() =>
        assertNoTestOnlyEnvLeak({
          NODE_ENV: "test",
          EMBEDDING_MODEL_MOCK: "true",
        })
      ).not.toThrow();
    });

    it("INV-SEC-M1-02: production env でも EMBEDDING_MODEL_MOCK 未設定なら throw しない / no throw in production when EMBEDDING_MODEL_MOCK is unset", () => {
      expect(() =>
        assertNoTestOnlyEnvLeak({
          NODE_ENV: "production",
        })
      ).not.toThrow();
    });

    it("INV-SEC-M1-02: production env で EMBEDDING_MODEL_MOCK=false / 0 / 空文字は throw しない / falsy values do not trigger throw in production", () => {
      expect(() =>
        assertNoTestOnlyEnvLeak({
          NODE_ENV: "production",
          EMBEDDING_MODEL_MOCK: "false",
        })
      ).not.toThrow();
      expect(() =>
        assertNoTestOnlyEnvLeak({
          NODE_ENV: "production",
          EMBEDDING_MODEL_MOCK: "0",
        })
      ).not.toThrow();
      expect(() =>
        assertNoTestOnlyEnvLeak({
          NODE_ENV: "production",
          EMBEDDING_MODEL_MOCK: "",
        })
      ).not.toThrow();
    });
  });
});
