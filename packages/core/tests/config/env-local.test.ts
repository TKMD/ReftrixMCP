// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * loadEnvLocal tests (PR7e-β1)
 *
 * - SEC-β-01: maxDepth 制限 / maxDepth limit
 * - SEC-β-07: verbose=false デフォルトで秘密情報を出力しない / no secret leakage
 * - 既存 env 保護 / preserve existing env
 * - file 存在チェック / file existence handling
 * - 書式バリエーション（export / quoted / whitespace / comment）
 *
 * @module tests/config/env-local
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadEnvLocal } from "../../src/config/env-local";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reftrix-env-local-test-"));
}

function writeEnvFile(dir: string, content: string): string {
  const p = path.join(dir, ".env.local");
  fs.writeFileSync(p, content, "utf8");
  return p;
}

describe("loadEnvLocal", () => {
  const originalEnv = { ...process.env };
  let tempRoot: string;
  let tempSub: string;
  let tempLeaf: string;

  beforeEach(() => {
    tempRoot = makeTempDir();
    tempSub = fs.mkdtempSync(path.join(tempRoot, "sub-"));
    tempLeaf = fs.mkdtempSync(path.join(tempSub, "leaf-"));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* noop */
    }
    vi.restoreAllMocks();
  });

  it(".env.local が見つからなければ loaded=false / returns loaded=false when no file", () => {
    const result = loadEnvLocal({ cwd: tempLeaf });
    expect(result.loaded).toBe(false);
    expect(result.keysLoaded).toBe(0);
    expect(result.path).toBeUndefined();
  });

  it("同ディレクトリの .env.local を読み込む / loads file in the same directory", () => {
    writeEnvFile(tempLeaf, "MY_TEST_KEY_1=hello\n");
    delete process.env["MY_TEST_KEY_1"];
    const result = loadEnvLocal({ cwd: tempLeaf });
    expect(result.loaded).toBe(true);
    expect(result.keysLoaded).toBe(1);
    expect(process.env["MY_TEST_KEY_1"]).toBe("hello");
  });

  it("親ディレクトリを遡って .env.local を探す / walks up to find .env.local", () => {
    writeEnvFile(tempSub, "MY_TEST_KEY_2=parent-value\n");
    delete process.env["MY_TEST_KEY_2"];
    const result = loadEnvLocal({ cwd: tempLeaf });
    expect(result.loaded).toBe(true);
    expect(process.env["MY_TEST_KEY_2"]).toBe("parent-value");
  });

  it("既存 process.env を上書きしない / preserves existing process.env", () => {
    writeEnvFile(tempLeaf, "MY_EXISTING_KEY=from-file\n");
    process.env["MY_EXISTING_KEY"] = "preset-value";
    const result = loadEnvLocal({ cwd: tempLeaf });
    expect(result.loaded).toBe(true);
    expect(result.keysLoaded).toBe(0); // not counted because not written
    expect(process.env["MY_EXISTING_KEY"]).toBe("preset-value");
  });

  it("export KEY=value を正しくパース / parses export KEY=value", () => {
    writeEnvFile(tempLeaf, 'export MY_TEST_KEY_3="quoted val"\n');
    delete process.env["MY_TEST_KEY_3"];
    loadEnvLocal({ cwd: tempLeaf });
    expect(process.env["MY_TEST_KEY_3"]).toBe("quoted val");
  });

  it("single quote もアンラップする / unwraps single-quoted values", () => {
    writeEnvFile(tempLeaf, "MY_TEST_KEY_4='single-value'\n");
    delete process.env["MY_TEST_KEY_4"];
    loadEnvLocal({ cwd: tempLeaf });
    expect(process.env["MY_TEST_KEY_4"]).toBe("single-value");
  });

  it("# コメントと空行は無視 / ignores # comments and blank lines", () => {
    writeEnvFile(
      tempLeaf,
      "# comment line\n\nMY_TEST_KEY_5=val5\n  # indented comment\n\nMY_TEST_KEY_6=val6\n"
    );
    delete process.env["MY_TEST_KEY_5"];
    delete process.env["MY_TEST_KEY_6"];
    const result = loadEnvLocal({ cwd: tempLeaf });
    expect(result.keysLoaded).toBe(2);
    expect(process.env["MY_TEST_KEY_5"]).toBe("val5");
    expect(process.env["MY_TEST_KEY_6"]).toBe("val6");
  });

  it("= を含む値 (DATABASE_URL パスワード等) を正しく保持 / preserves values containing '='", () => {
    writeEnvFile(tempLeaf, "DATABASE_URL=postgres://u:p=assword@host:5432/db?opt=1\n");
    delete process.env["DATABASE_URL"];
    loadEnvLocal({ cwd: tempLeaf });
    expect(process.env["DATABASE_URL"]).toBe("postgres://u:p=assword@host:5432/db?opt=1");
  });

  it("maxDepth=1 で parent を探索しない / maxDepth=1 does not walk to parent", () => {
    writeEnvFile(tempSub, "MY_TEST_KEY_7=parent-val\n");
    delete process.env["MY_TEST_KEY_7"];
    const result = loadEnvLocal({ cwd: tempLeaf, maxDepth: 1 });
    expect(result.loaded).toBe(false);
    expect(process.env["MY_TEST_KEY_7"]).toBeUndefined();
  });

  it("maxDepth=2 で parent (1 レベル上) を探索 / maxDepth=2 walks one level up", () => {
    writeEnvFile(tempSub, "MY_TEST_KEY_8=parent-val\n");
    delete process.env["MY_TEST_KEY_8"];
    const result = loadEnvLocal({ cwd: tempLeaf, maxDepth: 2 });
    expect(result.loaded).toBe(true);
    expect(process.env["MY_TEST_KEY_8"]).toBe("parent-val");
  });

  it("デフォルト maxDepth=5 で親 3 段まで探索 / default maxDepth=5 walks three levels up", () => {
    writeEnvFile(tempRoot, "MY_TEST_KEY_9=root-val\n");
    delete process.env["MY_TEST_KEY_9"];
    const result = loadEnvLocal({ cwd: tempLeaf });
    expect(result.loaded).toBe(true);
    expect(process.env["MY_TEST_KEY_9"]).toBe("root-val");
  });

  it("不正 maxDepth (NaN) はデフォルト 5 にフォールバック / invalid maxDepth falls back to 5", () => {
    writeEnvFile(tempRoot, "MY_TEST_KEY_10=root-val\n");
    delete process.env["MY_TEST_KEY_10"];
    // @ts-expect-error intentional invalid input
    const result = loadEnvLocal({ cwd: tempLeaf, maxDepth: Number.NaN });
    expect(result.loaded).toBe(true);
    expect(process.env["MY_TEST_KEY_10"]).toBe("root-val");
  });

  it("不正 maxDepth (0 / 負値) はデフォルト 5 にフォールバック / maxDepth <= 0 falls back to 5", () => {
    writeEnvFile(tempRoot, "MY_TEST_KEY_11=val\n");
    delete process.env["MY_TEST_KEY_11"];
    const result = loadEnvLocal({ cwd: tempLeaf, maxDepth: 0 });
    expect(result.loaded).toBe(true);
  });

  it("verbose=false (デフォルト) では console.log が呼ばれない / verbose=false suppresses logs", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    writeEnvFile(tempLeaf, "MY_SECRET=shhh\n");
    delete process.env["MY_SECRET"];
    loadEnvLocal({ cwd: tempLeaf });
    expect(spy).not.toHaveBeenCalled();
    // And especially: the value itself must never be logged
    const allCalls = spy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(allCalls).not.toContain("shhh");
  });

  it("verbose=true では path のみ (値を含まない) / verbose=true logs only the path", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    writeEnvFile(tempLeaf, "MY_SECRET_2=supersecret\n");
    delete process.env["MY_SECRET_2"];
    const result = loadEnvLocal({ cwd: tempLeaf, verbose: true });
    expect(spy).toHaveBeenCalled();
    const allCalls = spy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(allCalls).toContain(result.path!);
    expect(allCalls).not.toContain("supersecret");
  });

  it("ファイル read 失敗時は loaded=false を返す / returns loaded=false on read failure", () => {
    // Create a directory with the name `.env.local` so that `existsSync` returns
    // true but `readFileSync` throws EISDIR.
    const weird = path.join(tempLeaf, ".env.local");
    fs.mkdirSync(weird);
    const result = loadEnvLocal({ cwd: tempLeaf });
    expect(result.loaded).toBe(false);
    expect(result.keysLoaded).toBe(0);
  });
});
