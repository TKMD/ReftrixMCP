// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * docs-verify-extract.mjs テスト
 *
 * ドキュメント-実装整合性検証の構造的パーサー（ts-morph / js-yaml / JSON.parse）が
 * 各コマンド（--tool-count, --ports, --tier-map, --di-factories, --changelog-section）で
 * 正しいJSON出力を返すことを検証する。
 *
 * Tests for docs-verify-extract.mjs structural parser.
 * Verifies each command (--tool-count, --ports, --tier-map, --di-factories,
 * --changelog-section) returns correct JSON output.
 *
 * @module tests/scripts/docs-verify-extract
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT_PATH = resolve(__dirname, "../../../../scripts/docs-verify-extract.mjs");
const PROJECT_ROOT = resolve(__dirname, "../../../..");

/**
 * Run docs-verify-extract.mjs with given args and return parsed JSON.
 * Throws on non-zero exit code.
 */
function runExtract(args: string): unknown {
  const output = execSync(`node ${SCRIPT_PATH} ${args}`, {
    cwd: PROJECT_ROOT,
    encoding: "utf-8",
    timeout: 30_000,
  });
  return JSON.parse(output.trim());
}

describe("docs-verify-extract.mjs", () => {
  // =====================================================
  // スクリプト存在確認 / Script existence check
  // =====================================================

  describe("script file", () => {
    it("should exist at scripts/docs-verify-extract.mjs", () => {
      expect(existsSync(SCRIPT_PATH)).toBe(true);
    });
  });

  // =====================================================
  // --tool-count: allToolDefinitions配列要素数
  // --tool-count: allToolDefinitions array element count
  // =====================================================

  describe("--tool-count", () => {
    let result: Record<string, unknown>;

    beforeAll(() => {
      result = runExtract("--tool-count") as Record<string, unknown>;
    });

    it("should return an object with count property", () => {
      expect(result).toHaveProperty("count");
    });

    it("should return a positive integer count", () => {
      expect(typeof result.count).toBe("number");
      expect(Number.isInteger(result.count)).toBe(true);
      expect(result.count).toBeGreaterThan(0);
    });

    it("should match the expected tool count range (20-100)", () => {
      // Reftrix currently has 35 tools; allow reasonable range for future growth
      // 現在35ツール。将来の増減に対応するため妥当な範囲で検証
      expect(result.count).toBeGreaterThanOrEqual(20);
      expect(result.count).toBeLessThanOrEqual(100);
    });
  });

  // =====================================================
  // --ports: ポート番号抽出
  // --ports: Port number extraction
  // =====================================================

  describe("--ports", () => {
    let result: Record<string, unknown>;

    beforeAll(() => {
      result = runExtract("--ports") as Record<string, unknown>;
    });

    it("should return an object", () => {
      expect(typeof result).toBe("object");
      expect(result).not.toBeNull();
    });

    it("should include postgres port from docker-compose.yml", () => {
      expect(result).toHaveProperty("postgres");
      expect(typeof result.postgres).toBe("number");
      expect(result.postgres).toBeGreaterThan(1024);
    });

    it("should include redis port from docker-compose.yml", () => {
      expect(result).toHaveProperty("redis");
      expect(typeof result.redis).toBe("number");
      expect(result.redis).toBeGreaterThan(1024);
    });

    it("should include bullmq port from bull-board.ts", () => {
      expect(result).toHaveProperty("bullmq");
      expect(typeof result.bullmq).toBe("number");
    });

    it("should include prisma_studio port from constants.ts", () => {
      expect(result).toHaveProperty("prisma_studio");
      expect(typeof result.prisma_studio).toBe("number");
    });

    it("should include reftrix4 port from package.json", () => {
      expect(result).toHaveProperty("reftrix4");
      expect(typeof result.reftrix4).toBe("number");
    });

    it("should return known port values (offset 21000)", () => {
      // All Reftrix ports use offset 21000 from standard ports
      // 全ポートは標準ポート+21000のオフセット
      expect(result.postgres).toBe(26432);
      expect(result.redis).toBe(27379);
    });
  });

  // =====================================================
  // --tier-map: レート制限ティアマップ
  // --tier-map: Rate limit tier map
  // =====================================================

  describe("--tier-map", () => {
    let result: Record<string, string[]>;

    beforeAll(() => {
      result = runExtract("--tier-map") as Record<string, string[]>;
    });

    it("should return analysis and search tier arrays", () => {
      expect(result).toHaveProperty("analysis");
      expect(result).toHaveProperty("search");
      expect(Array.isArray(result.analysis)).toBe(true);
      expect(Array.isArray(result.search)).toBe(true);
    });

    it("should have non-empty tier arrays", () => {
      expect(result.analysis.length).toBeGreaterThan(0);
      expect(result.search.length).toBeGreaterThan(0);
    });

    it("should contain tool names in dotted format (e.g. page.analyze)", () => {
      for (const tool of result.analysis) {
        expect(tool).toMatch(/^[a-z][a-z_]*\.[a-z_]+$/);
      }
      for (const tool of result.search) {
        expect(tool).toMatch(/^[a-z][a-z_]*\.[a-z_]+$/);
      }
    });

    it("should have sorted arrays", () => {
      expect(result.analysis).toEqual([...result.analysis].sort());
      expect(result.search).toEqual([...result.search].sort());
    });

    it("should include known analysis tier tools", () => {
      expect(result.analysis).toContain("page.analyze");
      expect(result.analysis).toContain("layout.ingest");
    });

    it("should include known search tier tools", () => {
      expect(result.search).toContain("layout.search");
      expect(result.search).toContain("search.unified");
    });

    it("should have no overlap between tiers", () => {
      const overlap = result.analysis.filter((t) => result.search.includes(t));
      expect(overlap).toEqual([]);
    });
  });

  // =====================================================
  // --di-factories: DI登録ファクトリ一覧
  // --di-factories: DI registration factory list
  // =====================================================

  describe("--di-factories", () => {
    let result: string[];

    beforeAll(() => {
      result = runExtract("--di-factories") as string[];
    });

    it("should return a sorted array of factory names", () => {
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([...result].sort());
    });

    it("should contain PrismaClient or EmbeddingService factory names", () => {
      for (const name of result) {
        expect(name).toMatch(/^set[A-Za-z]+(PrismaClientFactory|EmbeddingServiceFactory)$/);
      }
    });

    it("should have at least one factory", () => {
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // =====================================================
  // --changelog-section: CHANGELOG最新セクション抽出
  // --changelog-section: Latest CHANGELOG section extraction
  // =====================================================

  describe("--changelog-section", () => {
    it("should return text from CHANGELOG.md", () => {
      const result = runExtract("--changelog-section CHANGELOG.md") as Record<string, string>;
      expect(result).toHaveProperty("text");
      expect(typeof result.text).toBe("string");
    });

    it("should return non-empty text for existing CHANGELOG", () => {
      const result = runExtract("--changelog-section CHANGELOG.md") as Record<string, string>;
      expect(result.text.length).toBeGreaterThan(0);
    });

    it("should start with a version header (## [X.Y.Z])", () => {
      const result = runExtract("--changelog-section CHANGELOG.md") as Record<string, string>;
      expect(result.text).toMatch(/^## \[/);
    });

    it("should return empty text for non-existent file", () => {
      const result = runExtract("--changelog-section /tmp/nonexistent-changelog-test.md") as Record<
        string,
        string
      >;
      expect(result).toEqual({ text: "" });
    });

    it("should extract only the latest version section", () => {
      const result = runExtract("--changelog-section CHANGELOG.md") as Record<string, string>;
      // Should contain at most one "## [" header (the first one)
      // 最新セクションのみ抽出されるため、"## ["ヘッダーは1つだけ
      const versionHeaders = result.text.match(/^## \[/gm) ?? [];
      expect(versionHeaders.length).toBe(1);
    });
  });

  // =====================================================
  // エッジケース / Edge cases
  // =====================================================

  describe("edge cases", () => {
    it("should exit with code 1 for unknown command", () => {
      expect(() =>
        execSync(`node ${SCRIPT_PATH} --unknown-flag`, {
          cwd: PROJECT_ROOT,
          encoding: "utf-8",
          stdio: "pipe",
        })
      ).toThrow();
    });

    it("should exit with code 1 when called without arguments", () => {
      expect(() =>
        execSync(`node ${SCRIPT_PATH}`, {
          cwd: PROJECT_ROOT,
          encoding: "utf-8",
          stdio: "pipe",
        })
      ).toThrow();
    });
  });
});
