// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Usage Telemetry ユーティリティ テスト
 *
 * MCPツール利用計測のJSONL形式ログ出力テスト。
 * SEC-02: PII/引数除外の厳格な保証
 * SEC-03: パストラバーサル防御
 * TDA: ログローテーション（100MB上限）
 *
 * @module tests/utils/usage-telemetry
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// テスト対象モジュールを動的にインポート（環境変数リセットのため）
let usageTelemetry: typeof import("../../src/utils/usage-telemetry");

// ============================================================================
// テストヘルパー
// ============================================================================

/**
 * 一時ディレクトリにテスト用ログファイルパスを生成
 */
function getTempLogPath(): string {
  const tmpDir = path.join(__dirname, "..", "..", "tmp-test-telemetry");
  return path.join(tmpDir, `test-usage-${Date.now()}.jsonl`);
}

/**
 * テスト用ディレクトリのクリーンアップ
 */
function cleanupTmpDir(): void {
  const tmpDir = path.join(__dirname, "..", "..", "tmp-test-telemetry");
  if (fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================================
// SEC-02: PII除外テスト / PII Exclusion Tests
// ============================================================================

describe("Usage Telemetry", () => {
  beforeEach(async () => {
    cleanupTmpDir();
    // 環境変数をリセット
    delete process.env.TOOL_USAGE_LOG_ENABLED;
    delete process.env.TOOL_USAGE_LOG_PATH;
    // モジュールキャッシュをクリアして再インポート
    vi.resetModules();
    usageTelemetry = await import("../../src/utils/usage-telemetry");
  });

  afterEach(() => {
    cleanupTmpDir();
    delete process.env.TOOL_USAGE_LOG_ENABLED;
    delete process.env.TOOL_USAGE_LOG_PATH;
  });

  // --------------------------------------------------------------------------
  // SEC-02: PII除外テスト / PII Exclusion Tests
  // --------------------------------------------------------------------------

  describe("SEC-02: PII除外 / PII Exclusion", () => {
    it("UsageTelemetryEntry に tool/at/durationMs/success の4フィールドのみ含まれること", () => {
      const entry: usageTelemetry.UsageTelemetryEntry = {
        tool: "layout.search",
        at: new Date().toISOString(),
        durationMs: 150,
        success: true,
      };

      // 4フィールドのみが定義されていること
      const keys = Object.keys(entry);
      expect(keys).toHaveLength(4);
      expect(keys).toContain("tool");
      expect(keys).toContain("at");
      expect(keys).toContain("durationMs");
      expect(keys).toContain("success");
    });

    it("buildTelemetryEntry に args/query/profileId/url/requestId/apiKey/error.message が含まれないこと", () => {
      const entry = usageTelemetry.buildTelemetryEntry("layout.search", 123.456, true);

      // エントリに4フィールドのみ含まれること
      const keys = Object.keys(entry);
      expect(keys).toHaveLength(4);

      // PIIが含まれないことを明示的に検証
      expect(entry).not.toHaveProperty("args");
      expect(entry).not.toHaveProperty("query");
      expect(entry).not.toHaveProperty("profileId");
      expect(entry).not.toHaveProperty("url");
      expect(entry).not.toHaveProperty("requestId");
      expect(entry).not.toHaveProperty("apiKey");
      expect(entry).not.toHaveProperty("error");
      expect(entry).not.toHaveProperty("errorMessage");
    });

    it("ログファイルに書き込まれたJSONにPIIが含まれないこと", async () => {
      const logPath = getTempLogPath();
      const tmpDir = path.dirname(logPath);
      fs.mkdirSync(tmpDir, { recursive: true });

      process.env.TOOL_USAGE_LOG_ENABLED = "true";
      process.env.TOOL_USAGE_LOG_PATH = logPath;

      vi.resetModules();
      usageTelemetry = await import("../../src/utils/usage-telemetry");

      const entry = usageTelemetry.buildTelemetryEntry("preference.hear", 500, true);
      await usageTelemetry.logToolUsage(entry);

      // ファイル書き込みの非同期完了を待つ
      await new Promise((resolve) => setTimeout(resolve, 100));

      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, "utf-8").trim();
        const lines = content.split("\n").filter((l) => l.trim());
        expect(lines.length).toBeGreaterThanOrEqual(1);

        const parsed = JSON.parse(lines[0]!);
        const parsedKeys = Object.keys(parsed);
        expect(parsedKeys).toHaveLength(4);
        expect(parsedKeys.sort()).toEqual(["at", "durationMs", "success", "tool"].sort());
      }
    });
  });

  // --------------------------------------------------------------------------
  // 正常ログテスト / Normal Logging Tests
  // --------------------------------------------------------------------------

  describe("正常ログ記録 / Normal Logging", () => {
    it("tool/at/durationMs/success の4フィールドが正しく記録されること", () => {
      const entry = usageTelemetry.buildTelemetryEntry("page.analyze", 1234.5, true);

      expect(entry.tool).toBe("page.analyze");
      expect(entry.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(entry.durationMs).toBe(1234.5);
      expect(entry.success).toBe(true);
    });

    it("失敗時のエントリが正しく記録されること", () => {
      const entry = usageTelemetry.buildTelemetryEntry("motion.detect", 789, false);

      expect(entry.tool).toBe("motion.detect");
      expect(entry.durationMs).toBe(789);
      expect(entry.success).toBe(false);
    });

    it("ログファイルにJSON lines形式で追記されること", async () => {
      const logPath = getTempLogPath();
      const tmpDir = path.dirname(logPath);
      fs.mkdirSync(tmpDir, { recursive: true });

      process.env.TOOL_USAGE_LOG_ENABLED = "true";
      process.env.TOOL_USAGE_LOG_PATH = logPath;

      vi.resetModules();
      usageTelemetry = await import("../../src/utils/usage-telemetry");

      // 2つのエントリを書き込み
      const entry1 = usageTelemetry.buildTelemetryEntry("layout.search", 100, true);
      const entry2 = usageTelemetry.buildTelemetryEntry("part.search", 200, false);

      await usageTelemetry.logToolUsage(entry1);
      await usageTelemetry.logToolUsage(entry2);

      // 書き込み完了を待つ
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(fs.existsSync(logPath)).toBe(true);
      const content = fs.readFileSync(logPath, "utf-8").trim();
      const lines = content.split("\n").filter((l) => l.trim());
      expect(lines.length).toBe(2);

      const parsed1 = JSON.parse(lines[0]!);
      expect(parsed1.tool).toBe("layout.search");
      expect(parsed1.success).toBe(true);

      const parsed2 = JSON.parse(lines[1]!);
      expect(parsed2.tool).toBe("part.search");
      expect(parsed2.success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // opt-inテスト / Opt-in Tests
  // --------------------------------------------------------------------------

  describe("opt-in制御 / Opt-in Control", () => {
    it("TOOL_USAGE_LOG_ENABLED が未設定の場合、isUsageTelemetryEnabled() が false を返すこと", async () => {
      delete process.env.TOOL_USAGE_LOG_ENABLED;
      vi.resetModules();
      usageTelemetry = await import("../../src/utils/usage-telemetry");

      expect(usageTelemetry.isUsageTelemetryEnabled()).toBe(false);
    });

    it('TOOL_USAGE_LOG_ENABLED が "false" の場合、isUsageTelemetryEnabled() が false を返すこと', async () => {
      process.env.TOOL_USAGE_LOG_ENABLED = "false";
      vi.resetModules();
      usageTelemetry = await import("../../src/utils/usage-telemetry");

      expect(usageTelemetry.isUsageTelemetryEnabled()).toBe(false);
    });

    it('TOOL_USAGE_LOG_ENABLED が "true" の場合、isUsageTelemetryEnabled() が true を返すこと', async () => {
      process.env.TOOL_USAGE_LOG_ENABLED = "true";
      vi.resetModules();
      usageTelemetry = await import("../../src/utils/usage-telemetry");

      expect(usageTelemetry.isUsageTelemetryEnabled()).toBe(true);
    });

    it("無効時にlogToolUsageを呼んでもファイルが作成されないこと", async () => {
      const logPath = getTempLogPath();

      delete process.env.TOOL_USAGE_LOG_ENABLED;
      process.env.TOOL_USAGE_LOG_PATH = logPath;

      vi.resetModules();
      usageTelemetry = await import("../../src/utils/usage-telemetry");

      const entry = usageTelemetry.buildTelemetryEntry("layout.search", 100, true);
      await usageTelemetry.logToolUsage(entry);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(fs.existsSync(logPath)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // SEC-03: パストラバーサルテスト / Path Traversal Tests
  // --------------------------------------------------------------------------

  describe("SEC-03: パストラバーサル防御 / Path Traversal Defense", () => {
    it('"../" を含むパスが拒否されること', () => {
      expect(() => usageTelemetry.validateLogPath("/home/user/../etc/passwd")).toThrow();
    });

    it('"..\\\\\" を含むパスが拒否されること', () => {
      expect(() => usageTelemetry.validateLogPath("C:\\Users\\..\\etc\\passwd")).toThrow();
    });

    it("正規化後に許可ディレクトリ外になるパスが拒否されること", () => {
      // 許可ディレクトリ外への絶対パス
      expect(() => usageTelemetry.validateLogPath("/etc/malicious.jsonl")).toThrow();
    });

    it("正常なパスが受け入れられること", () => {
      // プロジェクトルート配下のログパス
      const projectRoot = path.resolve(__dirname, "../..");
      const validPath = path.join(projectRoot, "logs", "test-usage.jsonl");

      const result = usageTelemetry.validateLogPath(validPath);
      expect(result).toBe(validPath);
    });
  });

  // --------------------------------------------------------------------------
  // ファイルサイズ上限テスト / File Size Limit Tests
  // --------------------------------------------------------------------------

  describe("ファイルサイズローテーション / File Size Rotation", () => {
    it("閾値を超えた場合にローテーションが実行されること", async () => {
      const logPath = getTempLogPath();
      const tmpDir = path.dirname(logPath);
      fs.mkdirSync(tmpDir, { recursive: true });

      process.env.TOOL_USAGE_LOG_ENABLED = "true";
      process.env.TOOL_USAGE_LOG_PATH = logPath;

      vi.resetModules();
      usageTelemetry = await import("../../src/utils/usage-telemetry");

      // テスト用に閾値を非常に小さく設定（50バイト）
      usageTelemetry.setMaxLogFileSizeBytesForTesting(50);

      // 閾値超えのダミーデータを書き込み
      fs.writeFileSync(logPath, "x".repeat(100)); // 100バイト > 50バイト閾値

      const entry = usageTelemetry.buildTelemetryEntry("layout.search", 100, true);
      await usageTelemetry.logToolUsage(entry);

      // ローテーション後に .old ファイルが存在すること
      const oldPath = logPath + ".old";
      expect(fs.existsSync(oldPath)).toBe(true);

      // 新しいログファイルにエントリが書かれていること
      expect(fs.existsSync(logPath)).toBe(true);
      const content = fs.readFileSync(logPath, "utf-8").trim();
      const parsed = JSON.parse(content);
      expect(parsed.tool).toBe("layout.search");

      // クリーンアップ
      usageTelemetry.resetMaxLogFileSizeBytes();
    });

    it("閾値以下の場合はローテーションが実行されないこと", async () => {
      const logPath = getTempLogPath();
      const tmpDir = path.dirname(logPath);
      fs.mkdirSync(tmpDir, { recursive: true });

      process.env.TOOL_USAGE_LOG_ENABLED = "true";
      process.env.TOOL_USAGE_LOG_PATH = logPath;

      vi.resetModules();
      usageTelemetry = await import("../../src/utils/usage-telemetry");

      // テスト用閾値を大きく設定（1MB）
      usageTelemetry.setMaxLogFileSizeBytesForTesting(1024 * 1024);

      // 閾値以下のダミーデータを書き込み
      fs.writeFileSync(logPath, "x".repeat(100)); // 100バイト < 1MB

      const entry = usageTelemetry.buildTelemetryEntry("layout.search", 100, true);
      await usageTelemetry.logToolUsage(entry);

      // .old ファイルが存在しないこと（ローテーション未実行）
      const oldPath = logPath + ".old";
      expect(fs.existsSync(oldPath)).toBe(false);

      // ログファイルにエントリが追記されていること
      const content = fs.readFileSync(logPath, "utf-8");
      // JSONLエントリが含まれていること
      expect(content).toContain('"tool":"layout.search"');

      // クリーンアップ
      usageTelemetry.resetMaxLogFileSizeBytes();
    });

    it("デフォルトの閾値が100MBであること", async () => {
      vi.resetModules();
      usageTelemetry = await import("../../src/utils/usage-telemetry");

      expect(usageTelemetry.getMaxLogFileSizeBytes()).toBe(100 * 1024 * 1024);
    });
  });

  // --------------------------------------------------------------------------
  // fire-and-forgetテスト / Fire-and-Forget Tests
  // --------------------------------------------------------------------------

  describe("fire-and-forget / Fire-and-Forget", () => {
    it("ログ書き込み失敗がツール実行をブロックしないこと", async () => {
      process.env.TOOL_USAGE_LOG_ENABLED = "true";
      // 書き込み不可能なパスを設定
      process.env.TOOL_USAGE_LOG_PATH = "/nonexistent-dir-12345/usage.jsonl";

      vi.resetModules();
      usageTelemetry = await import("../../src/utils/usage-telemetry");

      const entry = usageTelemetry.buildTelemetryEntry("layout.search", 100, true);

      // logToolUsage が例外をスローしないこと
      await expect(usageTelemetry.logToolUsage(entry)).resolves.toBeUndefined();
    });

    it("logToolUsage が Promise<void> を返すこと（非同期 fire-and-forget）", async () => {
      delete process.env.TOOL_USAGE_LOG_ENABLED;
      vi.resetModules();
      usageTelemetry = await import("../../src/utils/usage-telemetry");

      const entry = usageTelemetry.buildTelemetryEntry("layout.search", 100, true);
      const result = usageTelemetry.logToolUsage(entry);

      expect(result).toBeInstanceOf(Promise);
      await expect(result).resolves.toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // NaN/Infinity防御テスト / NaN/Infinity Defense Tests
  // --------------------------------------------------------------------------

  describe("NaN/Infinity防御 / NaN/Infinity Defense", () => {
    it("durationMs が NaN の場合 0 にフォールバックされること", () => {
      const entry = usageTelemetry.buildTelemetryEntry("layout.search", NaN, true);
      expect(entry.durationMs).toBe(0);
    });

    it("durationMs が Infinity の場合 0 にフォールバックされること", () => {
      const entry = usageTelemetry.buildTelemetryEntry("layout.search", Infinity, true);
      expect(entry.durationMs).toBe(0);
    });

    it("durationMs が -Infinity の場合 0 にフォールバックされること", () => {
      const entry = usageTelemetry.buildTelemetryEntry("layout.search", -Infinity, true);
      expect(entry.durationMs).toBe(0);
    });

    it("durationMs が負数の場合 0 にクランプされること", () => {
      const entry = usageTelemetry.buildTelemetryEntry("layout.search", -100, true);
      expect(entry.durationMs).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // デフォルトログパステスト / Default Log Path Tests
  // --------------------------------------------------------------------------

  describe("デフォルトログパス / Default Log Path", () => {
    it("TOOL_USAGE_LOG_PATH 未設定時にデフォルトパスが使用されること", async () => {
      process.env.TOOL_USAGE_LOG_ENABLED = "true";
      delete process.env.TOOL_USAGE_LOG_PATH;

      vi.resetModules();
      usageTelemetry = await import("../../src/utils/usage-telemetry");

      const defaultPath = usageTelemetry.getLogPath();
      expect(defaultPath).toMatch(/logs[/\\]tool-usage\.jsonl$/);
    });
  });
});
