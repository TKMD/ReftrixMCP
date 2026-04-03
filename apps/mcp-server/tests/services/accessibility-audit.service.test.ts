// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Accessibility Audit Service Unit Tests
 *
 * axe-coreベースのWCAG 2.1 AA準拠監査サービスのテスト
 * Tests for axe-core-based WCAG 2.1 AA compliance audit service
 *
 * @module tests/services/accessibility-audit.service.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  AccessibilityAuditService,
  createAccessibilityAuditService,
  type AccessibilityAuditOptions,
  type AccessibilityAuditResult,
} from "../../src/services/quality/accessibility-audit.service";

describe("AccessibilityAuditService", () => {
  let service: AccessibilityAuditService;

  beforeEach(() => {
    service = new AccessibilityAuditService();
  });

  describe("constructor", () => {
    it("デフォルトオプションで初期化できる", () => {
      const svc = new AccessibilityAuditService();
      expect(svc).toBeDefined();
    });

    it("カスタムオプションで初期化できる", () => {
      const svc = new AccessibilityAuditService({
        wcagLevel: "AAA",
        timeout: 60000,
      });
      expect(svc).toBeDefined();
    });
  });

  describe("audit", () => {
    it("有効なHTMLを解析してスコアを返す", async () => {
      const html = `<!DOCTYPE html>
<html lang="ja">
<head><title>Test Page</title></head>
<body>
  <main>
    <h1>テストページ</h1>
    <p>コンテンツ</p>
    <img src="test.png" alt="テスト画像">
  </main>
</body>
</html>`;
      const result = await service.audit(html);

      expect(result).toBeDefined();
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.level).toBe("AA");
      expect(result.violations).toBeInstanceOf(Array);
      expect(result.summary).toBeDefined();
      expect(result.summary.totalViolations).toBeGreaterThanOrEqual(0);
      expect(result.summary.totalPasses).toBeGreaterThanOrEqual(0);
    });

    it("空のHTMLに対してデフォルト結果を返す", async () => {
      const result = await service.audit("");
      expect(result.score).toBe(100);
      expect(result.violations).toHaveLength(0);
      expect(result.level).toBe("AA");
    });

    it("ホワイトスペースのみのHTMLに対してデフォルト結果を返す", async () => {
      const result = await service.audit("   \n\t  ");
      expect(result.score).toBe(100);
      expect(result.violations).toHaveLength(0);
    });

    it("アクセシビリティ違反があるHTMLは低スコアを返す", async () => {
      const html = `<!DOCTYPE html>
<html>
<head></head>
<body>
  <img src="test.png">
  <button></button>
  <input type="text">
  <div onclick="doSomething()">clickable div</div>
</body>
</html>`;
      const result = await service.audit(html);
      // 違反が検出されるのでスコアは100未満
      expect(result.score).toBeLessThan(100);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    it("違反ごとにimpact分類が正しい", async () => {
      const html = `<!DOCTYPE html>
<html>
<body>
  <img src="test.png">
</body>
</html>`;
      const result = await service.audit(html);

      for (const violation of result.violations) {
        expect(["critical", "serious", "moderate", "minor"]).toContain(violation.impact);
        expect(violation.id).toBeDefined();
        expect(violation.description).toBeDefined();
        expect(violation.help).toBeDefined();
        expect(violation.helpUrl).toBeDefined();
        expect(typeof violation.nodes).toBe("number");
        expect(violation.nodes).toBeGreaterThanOrEqual(0);
        expect(violation.fixSuggestion).toBeDefined();
        expect(typeof violation.fixSuggestion).toBe("string");
      }
    });

    it("スコア計算ロジックが正しい: critical*20, serious*10, moderate*5, minor*1", async () => {
      // テスト用に直接計算を検証
      const scoreCalc = service.calculateScore({
        critical: 1,
        serious: 1,
        moderate: 1,
        minor: 1,
      });
      // 100 - (20 + 10 + 5 + 1) = 64
      expect(scoreCalc).toBe(64);
    });

    it("スコアは最低0になる", () => {
      const scoreCalc = service.calculateScore({
        critical: 5,
        serious: 0,
        moderate: 0,
        minor: 0,
      });
      // 100 - (5*20) = 0
      expect(scoreCalc).toBe(0);
    });

    it("重大度が過剰でもスコアは0以下にならない", () => {
      const scoreCalc = service.calculateScore({
        critical: 10,
        serious: 10,
        moderate: 10,
        minor: 10,
      });
      expect(scoreCalc).toBe(0);
    });
  });

  describe("WCAGレベルフィルタリング", () => {
    it("レベルAで監査できる", async () => {
      const svc = new AccessibilityAuditService({ wcagLevel: "A" });
      const html = `<!DOCTYPE html><html lang="ja"><head><title>Test</title></head><body><h1>Test</h1></body></html>`;
      const result = await svc.audit(html);
      expect(result.level).toBe("A");
    });

    it("レベルAAAで監査できる", async () => {
      const svc = new AccessibilityAuditService({ wcagLevel: "AAA" });
      const html = `<!DOCTYPE html><html lang="ja"><head><title>Test</title></head><body><h1>Test</h1></body></html>`;
      const result = await svc.audit(html);
      expect(result.level).toBe("AAA");
    });
  });

  describe("include_passes オプション", () => {
    it("include_passes=true でpassesの詳細が含まれる", async () => {
      const html = `<!DOCTYPE html><html lang="ja"><head><title>Test</title></head><body><h1>Test</h1></body></html>`;
      const result = await service.audit(html, { includePasses: true });
      expect(result.passes).toBeDefined();
      expect(result.passes).toBeInstanceOf(Array);
    });

    it("include_passes=false でpassesが空配列", async () => {
      const html = `<!DOCTYPE html><html lang="ja"><head><title>Test</title></head><body><h1>Test</h1></body></html>`;
      const result = await service.audit(html, { includePasses: false });
      expect(result.passes).toEqual([]);
    });
  });

  describe("summary フィールド", () => {
    it("summary に重大度ごとの件数が含まれる", async () => {
      const html = `<!DOCTYPE html><html><body><img src="test.png"></body></html>`;
      const result = await service.audit(html);

      expect(result.summary).toBeDefined();
      expect(typeof result.summary.totalViolations).toBe("number");
      expect(typeof result.summary.totalPasses).toBe("number");
      expect(typeof result.summary.critical).toBe("number");
      expect(typeof result.summary.serious).toBe("number");
      expect(typeof result.summary.moderate).toBe("number");
      expect(typeof result.summary.minor).toBe("number");
    });
  });

  describe("ファクトリ関数", () => {
    it("createAccessibilityAuditService でインスタンスを作成できる", () => {
      const svc = createAccessibilityAuditService();
      expect(svc).toBeInstanceOf(AccessibilityAuditService);
    });

    it("オプション付きでインスタンスを作成できる", () => {
      const svc = createAccessibilityAuditService({ wcagLevel: "AAA" });
      expect(svc).toBeInstanceOf(AccessibilityAuditService);
    });
  });

  describe("修正提案テキスト生成", () => {
    it("違反IDに対する修正提案を生成する", () => {
      const suggestion = service.generateFixSuggestion(
        "image-alt",
        "Images must have alternate text"
      );
      expect(suggestion).toBeDefined();
      expect(typeof suggestion).toBe("string");
      expect(suggestion.length).toBeGreaterThan(0);
    });

    it("未知の違反IDにはhelpテキストをフォールバックとして返す", () => {
      const suggestion = service.generateFixSuggestion("unknown-rule-id-xyz", "Some help text");
      expect(suggestion).toBeDefined();
      expect(typeof suggestion).toBe("string");
    });
  });
});
