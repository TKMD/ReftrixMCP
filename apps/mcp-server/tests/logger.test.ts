// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ロガー テスト
 * src/utils/logger.ts の実装をテスト
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Logger, createLogger, isDevelopment, type ILogger } from "../src/utils/logger";

describe("Logger", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    // Logger uses console.error for all levels
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Enable logging by setting development mode
    process.env.NODE_ENV = "development";
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.clearAllMocks();
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
  });

  describe("ログレベル", () => {
    it.each([
      { level: "debug" as const, expectedPrefix: "[DEBUG]" },
      { level: "info" as const, expectedPrefix: "[INFO]" },
      { level: "warn" as const, expectedPrefix: "[WARN]" },
      { level: "error" as const, expectedPrefix: "[ERROR]" },
    ])("$levelレベルのログが出力できること", ({ level, expectedPrefix }) => {
      const logger = createLogger("Test");
      logger[level]("Test message");
      expect(consoleSpy).toHaveBeenCalled();
      const logCall = consoleSpy.mock.calls[0][0] as string;
      expect(logCall).toContain(expectedPrefix);
      expect(logCall).toContain("Test message");
    });

    it("errorレベルのログがErrorオブジェクトを構造化すること", () => {
      const logger = createLogger("Test");
      logger.error("Error message", new Error("Test error"));
      expect(consoleSpy).toHaveBeenCalled();
      const logCall = consoleSpy.mock.calls[0][0] as string;
      expect(logCall).toContain("[ERROR]");
      expect(logCall).toContain("Test error");
      expect(logCall).toContain("stack");
    });
  });

  describe("開発環境でのログ出力", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "development";
    });

    it("開発環境ではすべてのログレベルが出力されること", () => {
      const logger = createLogger("Test");
      logger.debug("Debug in dev");
      logger.info("Info in dev");
      logger.warn("Warn in dev");
      logger.error("Error in dev");

      expect(consoleSpy).toHaveBeenCalledTimes(4);
    });

    it("開発環境では構造化ログが出力されること", () => {
      const logger = createLogger("Test");
      const structuredData = { requestId: "abc123", userId: "user456", action: "search" };
      logger.info("User action", structuredData);
      expect(consoleSpy).toHaveBeenCalled();
      const logCall = consoleSpy.mock.calls[0][0] as string;
      expect(logCall).toContain("User action");
      expect(logCall).toContain("abc123");
    });
  });

  describe("本番環境でのログ抑制", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "production";
    });

    it.each([{ level: "debug" as const }, { level: "info" as const }])(
      "$levelログが抑制されること",
      ({ level }) => {
        const logger = createLogger("Test");
        logger[level]("Should be suppressed");
        expect(consoleSpy).not.toHaveBeenCalled();
      }
    );

    it.each([
      { level: "warn" as const, prefix: "[WARN]" },
      { level: "error" as const, prefix: "[ERROR]" },
    ])("$levelログは出力されること", ({ level, prefix }) => {
      const logger = createLogger("Test");
      logger[level]("Should be output");
      expect(consoleSpy).toHaveBeenCalled();
      const logCall = consoleSpy.mock.calls[0][0] as string;
      expect(logCall).toContain(prefix);
    });
  });

  describe("構造化ログ形式", () => {
    it("タイムスタンプが含まれること", () => {
      const logger = createLogger("Test");
      logger.info("Test message");
      expect(consoleSpy).toHaveBeenCalled();
      const logCall = consoleSpy.mock.calls[0][0] as string;
      expect(logCall).toMatch(/\[\d{4}-\d{2}-\d{2}T/);
    });

    it("ログレベルが含まれること", () => {
      const logger = createLogger("Test");
      logger.error("Error message");
      expect(consoleSpy).toHaveBeenCalled();
      const logCall = consoleSpy.mock.calls[0][0] as string;
      expect(logCall).toContain("[ERROR]");
    });

    it("追加データが出力されること", () => {
      const logger = createLogger("Test");
      const data = { userId: "user123", action: "search" };
      logger.info("User action", data);
      const logCall = consoleSpy.mock.calls[0][0] as string;
      expect(logCall).toContain("user123");
    });
  });

  describe("エラー特定とデバッグ支援", () => {
    it("スタックトレースが含まれること", () => {
      const logger = createLogger("Test");
      const error = new Error("Test error");
      logger.error("An error occurred", error);
      const logCall = consoleSpy.mock.calls[0][0] as string;
      expect(logCall).toContain("stack");
    });

    it("モジュール名が含まれること", () => {
      const logger = createLogger("MCP");
      logger.info("Server started");
      const logCall = consoleSpy.mock.calls[0][0] as string;
      expect(logCall).toContain("[MCP]");
    });

    it("コンテキスト情報が含まれること", () => {
      const logger = createLogger("Test");
      const context = { tool: "svg.search", query: "test", requestId: "req-123" };
      logger.info("Tool executed", context);
      const logCall = consoleSpy.mock.calls[0][0] as string;
      expect(logCall).toContain("req-123");
    });
  });

  describe("createLogger ファクトリ", () => {
    it("ILoggerインターフェースを満たすインスタンスを返すこと", () => {
      const logger: ILogger = createLogger("TestModule");
      expect(typeof logger.debug).toBe("function");
      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
    });

    it("Loggerクラスのインスタンスを返すこと", () => {
      const logger = createLogger("TestModule");
      expect(logger).toBeInstanceOf(Logger);
    });
  });

  describe("パフォーマンス", () => {
    it("大量のログ出力でも性能が劣化しないこと", () => {
      const logger = createLogger("Perf");
      const iterations = 1000;
      const startTime = Date.now();

      for (let i = 0; i < iterations; i++) {
        logger.info(`Log message ${i}`, { index: i });
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000);
      expect(consoleSpy).toHaveBeenCalledTimes(iterations);
    });
  });
});
