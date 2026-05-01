// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Fork Common Helper Tests (v0.4.0 PR7e-β4 PR1)
 *
 * shared/fork-common.ts の API 単体テスト。
 *   A. buildChildEnv() — env 変数生成
 *   B. appendConnectionLimit() — DATABASE_URL 結合の edge case
 *   C. buildChildExecArgv() — execArgv 生成
 *   D. resolveChildScriptPath() — dist/src 両対応のパス解決
 *
 * runChildProcess() の lifecycle テストは fork() を実際に起動する必要があり
 * 重い (Phase 5 既存テスト同様、ソース文字列 grep にとどめる)。本テストでは
 * runChildProcess の export 存在と型シグネチャの基本健全性のみを確認する。
 *
 * Unit tests for the shared/fork-common.ts helper APIs. The runChildProcess()
 * lifecycle requires actually spawning fork() which is heavy; following the
 * Phase 5 convention, we limit ourselves to source-string grep + existence
 * checks for that function.
 *
 * @module tests/workers/phases/shared/fork-common
 */

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const FORK_COMMON_SRC = path.resolve(
  __dirname,
  "../../../../src/workers/phases/shared/fork-common.ts"
);

describe("shared/fork-common: buildChildEnv (A) / 子プロセス env 生成", () => {
  it("EMBEDDING_WORKER_THREAD=false / DINOV2_WORKER_THREAD=false を設定する", async () => {
    const { buildChildEnv } = await import("../../../../src/workers/phases/shared/fork-common");
    const env = buildChildEnv({ phaseLabel: "test" });
    expect(env.EMBEDDING_WORKER_THREAD).toBe("false");
    expect(env.DINOV2_WORKER_THREAD).toBe("false");
  });

  it("ONNX_EXECUTION_PROVIDER=cpu を強制する (β2-P1)", async () => {
    const { buildChildEnv } = await import("../../../../src/workers/phases/shared/fork-common");
    const env = buildChildEnv({ phaseLabel: "test" });
    expect(env.ONNX_EXECUTION_PROVIDER).toBe("cpu");
  });

  it("MALLOC_ARENA_MAX が未設定なら 2 を設定する (OOM-1)", async () => {
    const original = process.env.MALLOC_ARENA_MAX;
    delete process.env.MALLOC_ARENA_MAX;
    try {
      const { buildChildEnv } = await import("../../../../src/workers/phases/shared/fork-common");
      const env = buildChildEnv({ phaseLabel: "test" });
      expect(env.MALLOC_ARENA_MAX).toBe("2");
    } finally {
      if (original !== undefined) process.env.MALLOC_ARENA_MAX = original;
    }
  });

  it("MALLOC_ARENA_MAX が既に設定済みなら上書きしない", async () => {
    const original = process.env.MALLOC_ARENA_MAX;
    process.env.MALLOC_ARENA_MAX = "4";
    try {
      const { buildChildEnv } = await import("../../../../src/workers/phases/shared/fork-common");
      const env = buildChildEnv({ phaseLabel: "test" });
      expect(env.MALLOC_ARENA_MAX).toBe("4");
    } finally {
      if (original === undefined) {
        delete process.env.MALLOC_ARENA_MAX;
      } else {
        process.env.MALLOC_ARENA_MAX = original;
      }
    }
  });

  it("WORKER_MAX_OLD_SPACE_MB を memory profile から設定する", async () => {
    const { buildChildEnv } = await import("../../../../src/workers/phases/shared/fork-common");
    const env = buildChildEnv({ phaseLabel: "test" });
    expect(env.WORKER_MAX_OLD_SPACE_MB).toBeDefined();
    const n = Number.parseInt(env.WORKER_MAX_OLD_SPACE_MB!, 10);
    expect(Number.isFinite(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });

  it("DATABASE_URL に connection_limit を append する (default 3)", async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:26432/reftrix";
    try {
      const { buildChildEnv } = await import("../../../../src/workers/phases/shared/fork-common");
      const env = buildChildEnv({ phaseLabel: "test" });
      expect(env.DATABASE_URL).toContain("connection_limit=3");
    } finally {
      if (original === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = original;
      }
    }
  });

  it("DATABASE_URL の connection_limit を override 可能 (custom limit)", async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://user:pass@localhost:26432/reftrix";
    try {
      const { buildChildEnv } = await import("../../../../src/workers/phases/shared/fork-common");
      const env = buildChildEnv({ phaseLabel: "test", connectionLimit: 5 });
      expect(env.DATABASE_URL).toContain("connection_limit=5");
    } finally {
      if (original === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = original;
      }
    }
  });

  it("DATABASE_URL が未設定なら append しない (no-op)", async () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const { buildChildEnv } = await import("../../../../src/workers/phases/shared/fork-common");
      const env = buildChildEnv({ phaseLabel: "test" });
      expect(env.DATABASE_URL).toBeUndefined();
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
    }
  });
});

describe("shared/fork-common: appendConnectionLimit (B) / DATABASE_URL 結合 edge cases", () => {
  it("クエリなし URL に ? で append", async () => {
    const { appendConnectionLimit } =
      await import("../../../../src/workers/phases/shared/fork-common");
    expect(appendConnectionLimit("postgresql://localhost/db", 3)).toBe(
      "postgresql://localhost/db?connection_limit=3"
    );
  });

  it("既存クエリ付き URL に & で append", async () => {
    const { appendConnectionLimit } =
      await import("../../../../src/workers/phases/shared/fork-common");
    expect(appendConnectionLimit("postgresql://localhost/db?sslmode=require", 5)).toBe(
      "postgresql://localhost/db?sslmode=require&connection_limit=5"
    );
  });

  it("複数クエリ付き URL でも & で append (重複に注意せず単純結合)", async () => {
    const { appendConnectionLimit } =
      await import("../../../../src/workers/phases/shared/fork-common");
    expect(appendConnectionLimit("postgresql://localhost/db?a=1&b=2", 7)).toBe(
      "postgresql://localhost/db?a=1&b=2&connection_limit=7"
    );
  });

  it("limit=1 の最小値も正常に append", async () => {
    const { appendConnectionLimit } =
      await import("../../../../src/workers/phases/shared/fork-common");
    expect(appendConnectionLimit("postgresql://localhost/db", 1)).toBe(
      "postgresql://localhost/db?connection_limit=1"
    );
  });
});

describe("shared/fork-common: buildChildExecArgv (C) / Node.js execArgv 生成", () => {
  it("--max-old-space-size と --expose-gc の 2 要素を返す", async () => {
    const { buildChildExecArgv } =
      await import("../../../../src/workers/phases/shared/fork-common");
    const argv = buildChildExecArgv();
    expect(argv).toHaveLength(2);
    expect(argv[0]).toMatch(/^--max-old-space-size=\d+$/);
    expect(argv[1]).toBe("--expose-gc");
  });

  it("デフォルト max-old-space-size がプロファイル上限と 4096MB の min", async () => {
    const { buildChildExecArgv } =
      await import("../../../../src/workers/phases/shared/fork-common");
    const argv = buildChildExecArgv();
    const match = argv[0].match(/^--max-old-space-size=(\d+)$/);
    expect(match).not.toBeNull();
    const cap = Number.parseInt(match![1], 10);
    // Default cap is 4096; profile may be smaller on low-memory hosts.
    expect(cap).toBeLessThanOrEqual(4096);
    expect(cap).toBeGreaterThan(0);
  });

  it("maxOldSpaceMb override が適用される", async () => {
    const { buildChildExecArgv } =
      await import("../../../../src/workers/phases/shared/fork-common");
    const argv = buildChildExecArgv({ maxOldSpaceMb: 1024 });
    const match = argv[0].match(/^--max-old-space-size=(\d+)$/);
    expect(match).not.toBeNull();
    const cap = Number.parseInt(match![1], 10);
    expect(cap).toBeLessThanOrEqual(1024);
  });
});

describe("shared/fork-common: resolveChildScriptPath (D) / パス解決", () => {
  it("絶対パスはそのまま返す", async () => {
    const { resolveChildScriptPath } =
      await import("../../../../src/workers/phases/shared/fork-common");
    const abs = "/tmp/child-script.js";
    expect(resolveChildScriptPath(abs)).toBe(abs);
  });

  it("相対パスを baseDir から解決する", async () => {
    const { resolveChildScriptPath } =
      await import("../../../../src/workers/phases/shared/fork-common");
    const baseDir = "/opt/app";
    expect(resolveChildScriptPath("worker.js", baseDir)).toBe("/opt/app/worker.js");
  });

  it("baseDir 未指定なら __dirname の親 (workers/phases) で解決する", async () => {
    const { resolveChildScriptPath } =
      await import("../../../../src/workers/phases/shared/fork-common");
    const resolved = resolveChildScriptPath("phase-5-text-embedding-child.js");
    // The resolved path must be absolute and end with the requested filename.
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith("phase-5-text-embedding-child.js")).toBe(true);
  });
});

describe("shared/fork-common: source-level guarantees / ソースレベル保証", () => {
  let src: string;

  beforeEach(() => {
    src = fs.readFileSync(FORK_COMMON_SRC, "utf-8");
  });

  it("SPDX ヘッダーが先頭 2 行に含まれる", () => {
    const head = src.split("\n").slice(0, 2).join("\n");
    expect(head).toContain("SPDX-FileCopyrightText");
    expect(head).toContain("SPDX-License-Identifier: AGPL-3.0-only");
  });

  it("runChildProcess を export する (lifecycle runner の export 存在確認)", () => {
    expect(src).toMatch(/export\s+async\s+function\s+runChildProcess/);
  });

  it("runChildProcess が child_process.fork を使用する", () => {
    expect(src).toMatch(/import\s*\{\s*fork[\s\S]*?\}\s*from\s*["']node:child_process["']/);
    expect(src).toMatch(/fork\s*\(/);
  });

  it("runChildProcess が setImmediate で IPC race condition を回避する (Phase 5 と同じ defense)", () => {
    expect(src).toContain("setImmediate");
    expect(src).toContain("drain");
  });

  it("buildChildEnv / buildChildExecArgv / resolveChildScriptPath / appendConnectionLimit / runChildProcess の 5 API を全て export する", () => {
    expect(src).toMatch(/export\s+function\s+buildChildEnv\b/);
    expect(src).toMatch(/export\s+function\s+buildChildExecArgv\b/);
    expect(src).toMatch(/export\s+function\s+resolveChildScriptPath\b/);
    expect(src).toMatch(/export\s+function\s+appendConnectionLimit\b/);
    expect(src).toMatch(/export\s+async\s+function\s+runChildProcess\b/);
  });
});
