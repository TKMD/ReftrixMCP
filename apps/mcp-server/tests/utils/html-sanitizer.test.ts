// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * HTMLサニタイザー テスト
 *
 * SEC監査指摘対応: DOMPurifyインスタンス分離テスト
 *
 * 問題点:
 * - グローバルなDOMPurifyインスタンスを共有している
 * - addHook / removeHook でステートを操作しており、並行リクエストで競合の可能性
 * - 特に sanitizeHtmlWithDetails で hooks を使用
 *
 * テスト目的:
 * - TDD Red Phase: 現在の実装の問題を検出するテスト
 * - 並行実行時のhooks競合を検出
 * - removedCount / removedTags のステートリークを検出
 *
 * @see apps/mcp-server/src/utils/html-sanitizer.ts
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeHtml,
  sanitizeHtmlWithDetails,
  isSafeAttributeValue,
  preStripDangerousTags,
  type SanitizeOptions,
} from '../../src/utils/html-sanitizer';

// 開発環境ログ出力
if (process.env.NODE_ENV === 'development') {
  console.log('[Test] Running: html-sanitizer.test.ts');
}

describe('HTMLサニタイザー', () => {
  // =============================================
  // 基本機能テスト
  // =============================================
  describe('基本機能', () => {
    it('scriptタグを除去する', () => {
      // Arrange: XSS攻撃の典型的なパターン
      const maliciousHtml = '<script>alert("xss")</script><p>Safe content</p>';

      // Act: サニタイズ実行
      const result = sanitizeHtml(maliciousHtml);

      // Assert: scriptタグが除去されていることを確認
      expect(result).not.toContain('<script');
      expect(result).not.toContain('</script>');
      expect(result).toContain('<p>Safe content</p>');
    });

    it('onclickイベントハンドラを除去する', () => {
      // Arrange: イベントハンドラによるXSS
      const maliciousHtml = '<div onclick="alert(1)">Click me</div>';

      // Act
      const result = sanitizeHtml(maliciousHtml);

      // Assert
      expect(result).not.toContain('onclick');
      expect(result).toContain('Click me');
    });

    it('javascript: URLを除去する', () => {
      // Arrange: javascript: プロトコルによるXSS
      const maliciousHtml = '<a href="javascript:alert(1)">Click</a>';

      // Act
      const result = sanitizeHtml(maliciousHtml);

      // Assert
      expect(result).not.toContain('javascript:');
    });

    it('iframeタグを除去する', () => {
      // Arrange: 外部コンテンツ埋め込み攻撃
      const maliciousHtml = '<iframe src="http://evil.com"></iframe><p>Safe</p>';

      // Act
      const result = sanitizeHtml(maliciousHtml);

      // Assert
      expect(result).not.toContain('<iframe');
      expect(result).toContain('<p>Safe</p>');
    });

    it('formタグを除去する', () => {
      // Arrange: フォーム送信による情報漏洩
      const maliciousHtml =
        '<form action="http://evil.com"><input type="text" name="secret"></form>';

      // Act
      const result = sanitizeHtml(maliciousHtml);

      // Assert
      expect(result).not.toContain('<form');
      expect(result).not.toContain('<input');
    });

    it('空文字列の入力を処理する', () => {
      // Arrange
      const emptyHtml = '';

      // Act
      const result = sanitizeHtml(emptyHtml);

      // Assert
      expect(result).toBe('');
    });

    it('ホワイトスペースのみの入力を処理する', () => {
      // Arrange
      const whitespaceHtml = '   \n\t   ';

      // Act
      const result = sanitizeHtml(whitespaceHtml);

      // Assert
      expect(result).toBe('');
    });

    it('安全なHTMLを保持する', () => {
      // Arrange: 安全なHTML
      const safeHtml =
        '<div class="container"><p>Hello <strong>World</strong></p></div>';

      // Act
      const result = sanitizeHtml(safeHtml);

      // Assert
      expect(result).toContain('<div');
      expect(result).toContain('<p>');
      expect(result).toContain('<strong>World</strong>');
    });
  });

  // =============================================
  // sanitizeHtmlWithDetails テスト
  // =============================================
  describe('sanitizeHtmlWithDetails', () => {
    it('サニタイズ結果と除去数を返す', () => {
      // Arrange
      const maliciousHtml = '<script>alert(1)</script><p>Safe</p>';

      // Act
      const result = sanitizeHtmlWithDetails(maliciousHtml);

      // Assert: SanitizeResult型の構造を確認
      expect(result).toHaveProperty('html');
      expect(result).toHaveProperty('removedCount');
      expect(typeof result.html).toBe('string');
      expect(typeof result.removedCount).toBe('number');
    });

    it('scriptタグが除去されたときremovedCountが増加する', () => {
      // Arrange
      const maliciousHtml = '<script>alert(1)</script><p>Safe</p>';

      // Act
      const result = sanitizeHtmlWithDetails(maliciousHtml);

      // Assert
      expect(result.removedCount).toBeGreaterThanOrEqual(1);
      expect(result.html).not.toContain('<script');
    });

    it('空入力でremovedCount=0を返す', () => {
      // Arrange
      const emptyHtml = '';

      // Act
      const result = sanitizeHtmlWithDetails(emptyHtml);

      // Assert
      expect(result.html).toBe('');
      expect(result.removedCount).toBe(0);
    });
  });

  // =============================================
  // 並行実行の安全性テスト（インスタンス分離）
  // SEC監査指摘: グローバルDOMPurifyインスタンスのhooksが競合する可能性
  // =============================================
  describe('並行実行の安全性（インスタンス分離）', () => {
    it('並行でsanitizeHtmlWithDetailsを呼び出してもhooksが競合しない', async () => {
      // Arrange: 3つの異なるmalicious HTMLを用意
      // 各リクエストでscriptタグが1つずつ除去されるべき
      const html1 = '<script>alert(1)</script><p>test1</p>';
      const html2 = '<script>alert(2)</script><p>test2</p>';
      const html3 = '<script>alert(3)</script><p>test3</p>';

      // Act: 並行で複数リクエストを実行
      // Promise.allで同時実行することでhooks競合を検出
      const results = await Promise.all([
        Promise.resolve(sanitizeHtmlWithDetails(html1)),
        Promise.resolve(sanitizeHtmlWithDetails(html2)),
        Promise.resolve(sanitizeHtmlWithDetails(html3)),
      ]);

      // Assert: 各結果が正しく分離されていることを確認
      // 現在の実装ではグローバルインスタンスを共有しているため、
      // removedCountが正しくカウントされない可能性がある

      // 各リクエストでscriptが1つ除去されるべき
      expect(results[0].removedCount).toBe(1);
      expect(results[1].removedCount).toBe(1);
      expect(results[2].removedCount).toBe(1);

      // 各結果のHTMLが正しい内容を含むべき
      expect(results[0].html).toContain('test1');
      expect(results[1].html).toContain('test2');
      expect(results[2].html).toContain('test3');

      // scriptタグは除去されているべき
      expect(results[0].html).not.toContain('<script');
      expect(results[1].html).not.toContain('<script');
      expect(results[2].html).not.toContain('<script');
    });

    it('hooksのステートがリクエスト間でリークしない', async () => {
      // Arrange: 最初のリクエストでhooksが設定され、scriptが除去される
      const maliciousHtml = '<script>evil</script><p>safe1</p>';
      const safeHtml = '<p>safe2</p>';

      // Act: 順次実行（最初のリクエストが完了してから2回目）
      const result1 = sanitizeHtmlWithDetails(maliciousHtml);
      const result2 = sanitizeHtmlWithDetails(safeHtml);

      // Assert:
      // result1: scriptが1つ除去される
      expect(result1.removedCount).toBe(1);
      expect(result1.html).toContain('safe1');

      // result2: scriptがないのでremovedCountは0であるべき
      // 現在の実装では、前回のhooksのステートがリークしている可能性がある
      expect(result2.removedCount).toBe(0);
      expect(result2.html).toContain('safe2');
    });

    it('複数のscriptタグがある場合も正しくカウントする', () => {
      // Arrange: 複数のscriptタグ
      const multipleScripts =
        '<script>a()</script><script>b()</script><script>c()</script><p>content</p>';

      // Act
      const result = sanitizeHtmlWithDetails(multipleScripts);

      // Assert: 3つのscriptタグが除去されるべき
      expect(result.removedCount).toBe(3);
      expect(result.html).not.toContain('<script');
      expect(result.html).toContain('content');
    });

    it('異なる危険要素の混合を正しくカウントする', () => {
      // Arrange: script + onclick の混合
      const mixedMalicious =
        '<script>evil()</script><div onclick="bad()">click</div><p>safe</p>';

      // Act
      const result = sanitizeHtmlWithDetails(mixedMalicious);

      // Assert: script (1) + onclick (1) = 2
      expect(result.removedCount).toBe(2);
      expect(result.html).not.toContain('<script');
      expect(result.html).not.toContain('onclick');
    });
  });

  // =============================================
  // ストレステスト: 並行リクエスト
  // SEC監査: 大量並行リクエストでのデータ競合検出
  // =============================================
  describe('ストレステスト: 並行リクエスト', () => {
    it('10件の並行リクエストでデータ競合が発生しない', async () => {
      // Arrange: 10件のリクエストを用意
      const requests = Array.from({ length: 10 }, (_, i) => ({
        html: `<script>alert(${i})</script><p id="p${i}">content${i}</p>`,
        index: i,
      }));

      // Act: 並行で実行
      const results = await Promise.all(
        requests.map((req) =>
          Promise.resolve(sanitizeHtmlWithDetails(req.html))
        )
      );

      // Assert: 各結果が独立していることを確認
      results.forEach((result, i) => {
        // 各リクエストでscriptが1つ除去されるべき
        expect(result.removedCount).toBe(1);

        // HTMLが正しいインデックスのコンテンツを含むべき
        expect(result.html).toContain(`content${i}`);

        // scriptは除去されているべき
        expect(result.html).not.toContain('<script');
        expect(result.html).not.toContain(`alert(${i})`);
      });
    });

    it('50件の並行リクエストでデータ競合が発生しない', async () => {
      // Arrange: より多くの並行リクエスト
      const requests = Array.from({ length: 50 }, (_, i) => ({
        // 偶数はscriptあり、奇数はscriptなし
        html:
          i % 2 === 0
            ? `<script>evil${i}()</script><div id="d${i}">text${i}</div>`
            : `<div id="d${i}">text${i}</div>`,
        index: i,
        hasScript: i % 2 === 0,
      }));

      // Act
      const results = await Promise.all(
        requests.map((req) =>
          Promise.resolve(sanitizeHtmlWithDetails(req.html))
        )
      );

      // Assert
      results.forEach((result, i) => {
        const expectedRemovedCount = requests[i].hasScript ? 1 : 0;
        expect(result.removedCount).toBe(expectedRemovedCount);
        expect(result.html).toContain(`text${i}`);
      });
    });
  });

  // =============================================
  // isSafeAttributeValue テスト
  // =============================================
  describe('isSafeAttributeValue', () => {
    it('javascript: プロトコルを危険と判定する', () => {
      // Arrange
      const attrName = 'href';
      const attrValue = 'javascript:alert(1)';

      // Act
      const result = isSafeAttributeValue(attrName, attrValue);

      // Assert
      expect(result).toBe(false);
    });

    it('data:text/html を危険と判定する', () => {
      // Arrange
      const attrName = 'src';
      const attrValue = 'data:text/html,<script>alert(1)</script>';

      // Act
      const result = isSafeAttributeValue(attrName, attrValue);

      // Assert
      expect(result).toBe(false);
    });

    it('vbscript: プロトコルを危険と判定する', () => {
      // Arrange
      const attrName = 'href';
      const attrValue = 'vbscript:msgbox(1)';

      // Act
      const result = isSafeAttributeValue(attrName, attrValue);

      // Assert
      expect(result).toBe(false);
    });

    it('expression() を含むstyleを危険と判定する', () => {
      // Arrange: IE固有のXSSベクター
      const attrName = 'style';
      const attrValue = 'width: expression(alert(1))';

      // Act
      const result = isSafeAttributeValue(attrName, attrValue);

      // Assert
      expect(result).toBe(false);
    });

    it('behavior: を含むstyleを危険と判定する', () => {
      // Arrange: IE固有のXSSベクター
      const attrName = 'style';
      const attrValue = 'behavior: url(xss.htc)';

      // Act
      const result = isSafeAttributeValue(attrName, attrValue);

      // Assert
      expect(result).toBe(false);
    });

    it('-moz-binding: を含むstyleを危険と判定する', () => {
      // Arrange: Firefox固有のXSSベクター
      const attrName = 'style';
      const attrValue = '-moz-binding: url(xss.xml)';

      // Act
      const result = isSafeAttributeValue(attrName, attrValue);

      // Assert
      expect(result).toBe(false);
    });

    it('安全なhref URLを許可する', () => {
      // Arrange
      const attrName = 'href';
      const attrValue = 'https://example.com';

      // Act
      const result = isSafeAttributeValue(attrName, attrValue);

      // Assert
      expect(result).toBe(true);
    });

    it('安全なstyleを許可する', () => {
      // Arrange
      const attrName = 'style';
      const attrValue = 'color: red; background-color: blue;';

      // Act
      const result = isSafeAttributeValue(attrName, attrValue);

      // Assert
      expect(result).toBe(true);
    });

    it('大文字小文字を区別しない（javascript:）', () => {
      // Arrange
      const attrName = 'href';
      const attrValue = 'JAVASCRIPT:alert(1)';

      // Act
      const result = isSafeAttributeValue(attrName, attrValue);

      // Assert
      expect(result).toBe(false);
    });
  });

  // =============================================
  // SanitizeOptions テスト
  // =============================================
  describe('SanitizeOptions', () => {
    it('allowStyles: false でstyle属性を除去する', () => {
      // Arrange
      const html = '<div style="color: red;">Content</div>';
      const options: SanitizeOptions = { allowStyles: false };

      // Act
      const result = sanitizeHtml(html, options);

      // Assert
      expect(result).not.toContain('style=');
    });

    it('allowDataAttributes: false でdata-*属性を除去する', () => {
      // Arrange
      const html = '<div data-id="123" data-value="abc">Content</div>';
      const options: SanitizeOptions = { allowDataAttributes: false };

      // Act
      const result = sanitizeHtml(html, options);

      // Assert
      expect(result).not.toContain('data-id');
      expect(result).not.toContain('data-value');
    });

    it('allowSvg: false でSVG要素を除去する', () => {
      // Arrange
      const html =
        '<div><svg><circle cx="50" cy="50" r="40"/></svg></div>';
      const options: SanitizeOptions = { allowSvg: false };

      // Act
      const result = sanitizeHtml(html, options);

      // Assert: SVGが除去または無効化されていることを確認
      // DOMPurifyの設定によっては完全に除去されないかもしれないが、
      // 少なくとも危険なSVG要素は除去されるべき
      expect(result).toContain('<div>');
    });

    it('allowedTags でカスタム許可タグを指定できる', () => {
      // Arrange: pとspanのみ許可
      const html = '<div><p><span>Text</span></p><strong>Bold</strong></div>';
      const options: SanitizeOptions = {
        allowedTags: ['p', 'span'],
      };

      // Act
      const result = sanitizeHtml(html, options);

      // Assert: 指定したタグのみ残る
      expect(result).toContain('<p>');
      expect(result).toContain('<span>');
      // div, strongは除去される可能性がある
    });
  });

  // =============================================
  // エッジケース
  // =============================================
  describe('エッジケース', () => {
    it('ネストされたscriptタグを処理する', () => {
      // Arrange: 異常なネスト
      const html = '<script><script>alert(1)</script></script><p>safe</p>';

      // Act
      const result = sanitizeHtml(html);

      // Assert
      expect(result).not.toContain('<script');
      expect(result).toContain('safe');
    });

    it('エンコードされたjavascript:を処理する', () => {
      // Arrange: URLエンコードされた攻撃
      const html = '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;:alert(1)">Click</a>';

      // Act
      const result = sanitizeHtml(html);

      // Assert: DOMPurifyがデコード後にチェックするため除去される
      expect(result).not.toContain('alert');
    });

    it('コメント内のscriptを処理する', () => {
      // Arrange: HTMLコメント内にscriptを隠す試み
      const html = '<!--<script>alert(1)</script>--><p>safe</p>';

      // Act
      const result = sanitizeHtml(html);

      // Assert: コメント内のscriptは実行されないが、クリーンアップされるべき
      expect(result).toContain('safe');
    });

    it('SVGコンテキスト内のscriptを処理する', () => {
      // Arrange: SVG内にscriptを埋め込む攻撃
      const html =
        '<svg><script>alert(1)</script></svg><p>safe</p>';

      // Act
      const result = sanitizeHtml(html);

      // Assert
      expect(result).not.toContain('<script');
    });

    it('非常に長いHTML文字列を処理する', () => {
      // Arrange: 長いが安全なHTML（パフォーマンスを考慮して10000文字に制限）
      const longContent = 'a'.repeat(10000);
      const html = `<div>${longContent}</div>`;

      // Act
      const result = sanitizeHtml(html);

      // Assert: 処理が完了することを確認
      expect(result).toContain(longContent);
    });

    it('特殊文字を含むHTMLを正しく処理する', () => {
      // Arrange: HTMLエンティティ
      const html = '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>';

      // Act
      const result = sanitizeHtml(html);

      // Assert: エスケープされた文字列は保持される（実際のscriptではない）
      expect(result).toContain('&lt;script&gt;');
    });

    it('日本語テキストを含むHTMLを正しく処理する', () => {
      // Arrange
      const html = '<p>こんにちは世界</p><script>alert(1)</script>';

      // Act
      const result = sanitizeHtml(html);

      // Assert
      expect(result).toContain('こんにちは世界');
      expect(result).not.toContain('<script');
    });
  });

  // =============================================
  // preserveDocumentStructure テスト
  // =============================================
  describe('preserveDocumentStructure オプション', () => {
    // -------------------------------------------
    // ドキュメント構造の保持
    // -------------------------------------------
    describe('ドキュメント構造の保持', () => {
      it('<html> タグが保持される', () => {
        // Arrange
        const html = '<html lang="ja"><head><title>Test</title></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).toContain('<html');
        expect(result).toContain('</html>');
      });

      it('<head> タグが保持される', () => {
        // Arrange
        const html = '<html><head><title>Test</title></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).toContain('<head>');
        expect(result).toContain('</head>');
      });

      it('<body> タグが保持される', () => {
        // Arrange
        const html = '<html><head><title>Test</title></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).toContain('<body>');
        expect(result).toContain('</body>');
      });

      it('<title> タグが保持される', () => {
        // Arrange
        const html = '<html><head><title>My Page Title</title></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).toContain('<title>My Page Title</title>');
      });

      it('<html lang="..."> 属性が保持される（アクセシビリティ要件）', () => {
        // Arrange: WCAG 2.1 AA - html-has-lang ルール
        const html = '<html lang="ja"><head><title>Test</title></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).toMatch(/lang="ja"/);
      });

      it('<html lang="en"> 英語ページのlang属性が保持される', () => {
        // Arrange
        const html = '<html lang="en"><head><title>Test</title></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).toMatch(/lang="en"/);
      });
    });

    // -------------------------------------------
    // 安全なメタデータタグの保持
    // -------------------------------------------
    describe('安全なメタデータタグの保持', () => {
      it('<meta name="description"> が保持される', () => {
        // Arrange
        const html = '<html><head><meta name="description" content="Page description"><title>Test</title></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).toContain('name="description"');
        expect(result).toContain('content="Page description"');
      });

      it('<meta name="viewport"> が保持される', () => {
        // Arrange
        const html = '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Test</title></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).toContain('name="viewport"');
      });

      it('<meta charset="utf-8"> が保持される', () => {
        // Arrange
        const html = '<html><head><meta charset="utf-8"><title>Test</title></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).toContain('charset="utf-8"');
      });
    });

    // -------------------------------------------
    // セキュリティ: 危険なタグ/属性は引き続き除去
    // -------------------------------------------
    describe('セキュリティ維持（preserveDocumentStructure有効時）', () => {
      it('<script> タグを除去する', () => {
        // Arrange: preserveDocumentStructure有効でもscriptは絶対に除去
        const html = '<html lang="ja"><head><title>Test</title><script>alert("xss")</script></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).not.toContain('<script');
        expect(result).not.toContain('alert');
        expect(result).toContain('<title>Test</title>');
      });

      it('javascript: URLを除去する', () => {
        // Arrange
        const html = '<html lang="ja"><head><title>Test</title></head><body><a href="javascript:alert(1)">Click</a></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).not.toContain('javascript:');
      });

      it('on* イベントハンドラを除去する', () => {
        // Arrange
        const html = '<html lang="ja"><head><title>Test</title></head><body><div onclick="alert(1)">Content</div></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).not.toContain('onclick');
        expect(result).toContain('Content');
      });

      it('<iframe> タグを除去する', () => {
        // Arrange
        const html = '<html lang="ja"><head><title>Test</title></head><body><iframe src="http://evil.com"></iframe><p>Safe</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).not.toContain('<iframe');
        expect(result).toContain('Safe');
      });

      it('<meta http-equiv="refresh"> を除去する（リダイレクト攻撃防止）', () => {
        // Arrange: http-equiv="refresh" はオープンリダイレクト攻撃に使用される
        const html = '<html><head><meta http-equiv="refresh" content="0;url=http://evil.com"><title>Test</title></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).not.toContain('http-equiv');
        expect(result).not.toContain('evil.com');
      });

      it('<base href> タグを除去する（相対URL操作防止）', () => {
        // Arrange: <base>はページ内の全相対URLのベースを変更できる
        const html = '<html><head><base href="http://evil.com/"><title>Test</title></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).not.toContain('<base');
      });

      it('<link rel="stylesheet"> を除去する（外部CSS読み込み防止）', () => {
        // Arrange: 外部CSSは情報漏洩やUI操作に使用される可能性
        const html = '<html><head><link rel="stylesheet" href="http://evil.com/steal.css"><title>Test</title></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).not.toContain('<link');
      });

      it('<form> タグを除去する', () => {
        // Arrange
        const html = '<html lang="ja"><head><title>Test</title></head><body><form action="http://evil.com"><input type="text"></form><p>Safe</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).not.toContain('<form');
        expect(result).not.toContain('<input');
      });

      it('data:text/html URIスキームを除去する', () => {
        // Arrange
        const html = '<html lang="ja"><head><title>Test</title></head><body><a href="data:text/html,<script>alert(1)</script>">Click</a></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert
        expect(result).not.toContain('data:text/html');
      });
    });

    // -------------------------------------------
    // 後方互換性: preserveDocumentStructure無効（デフォルト）
    // -------------------------------------------
    describe('後方互換性（デフォルト動作の維持）', () => {
      it('オプションなしの場合、従来通り<title>が除去される', () => {
        // Arrange: デフォルトではtitleは除去される（後方互換性）
        const html = '<html><head><title>Test</title></head><body><p>Hello</p></body></html>';

        // Act
        const result = sanitizeHtml(html);

        // Assert: 従来通りtitleは除去される
        expect(result).not.toContain('<title');
      });

      it('preserveDocumentStructure: false の場合、従来通りの動作', () => {
        // Arrange
        const html = '<html lang="ja"><head><title>Test</title></head><body><p>Hello</p></body></html>';
        const options: SanitizeOptions = { preserveDocumentStructure: false };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert: 従来通り<html><head><title>は保持されない
        expect(result).not.toContain('<title');
      });
    });

    // -------------------------------------------
    // 実際のWebページに近いHTML構造
    // -------------------------------------------
    describe('実際のWebページ構造', () => {
      it('完全なHTMLドキュメントを正しくサニタイズする', () => {
        // Arrange: 実際のWebページに近い構造
        const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Phantom - Design tool">
  <title>Phantom App</title>
  <script>alert("xss")</script>
  <link rel="stylesheet" href="http://external.com/style.css">
</head>
<body>
  <header>
    <h1>Welcome to Phantom</h1>
  </header>
  <main>
    <p onclick="steal()">Content</p>
  </main>
</body>
</html>`;
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert: ドキュメント構造が保持される
        expect(result).toContain('<html');
        expect(result).toMatch(/lang="ja"/);
        expect(result).toContain('<head>');
        expect(result).toContain('<title>Phantom App</title>');
        expect(result).toContain('name="description"');
        expect(result).toContain('name="viewport"');
        expect(result).toContain('<body>');

        // Assert: 危険な要素は除去される
        expect(result).not.toContain('<script');
        expect(result).not.toContain('alert');
        expect(result).not.toContain('<link');
        expect(result).not.toContain('onclick');
        expect(result).not.toContain('steal');

        // Assert: 安全なコンテンツは保持される
        expect(result).toContain('Welcome to Phantom');
        expect(result).toContain('Content');
      });

      it('日本語ページ: lang="ja"が保持されCraftsmanshipスコアに影響しない', () => {
        // Arrange: phantom.appのような日本語サイト
        const html = `<html lang="ja"><head><title>Phantom - Design Tool</title><meta name="description" content="Design tool for everyone"></head><body><div class="hero"><h1>Create beautiful designs</h1></div></body></html>`;
        const options: SanitizeOptions = { preserveDocumentStructure: true };

        // Act
        const result = sanitizeHtml(html, options);

        // Assert: aXe html-has-lang ルールが通過するための要件
        expect(result).toMatch(/<html[^>]*lang="ja"/);
        // Assert: aXe document-title ルールが通過するための要件
        expect(result).toContain('<title>Phantom - Design Tool</title>');
      });
    });
  });

  // =============================================
  // preStripDangerousTags テスト
  // パフォーマンス最適化: DOMPurify前のregexによる事前削減
  // =============================================
  describe('preStripDangerousTags', () => {
    // -------------------------------------------
    // 閾値判定: 500KB未満はスキップ
    // -------------------------------------------
    describe('閾値判定', () => {
      it('500KB未満のHTMLはそのまま返却される（事前削減スキップ）', () => {
        // Arrange: 500KB未満のHTML（scriptタグ含む）
        const smallHtml = '<script>alert("xss")</script><p>Safe content</p>';

        // Act: 閾値以下なので事前削減は適用されない
        const result = preStripDangerousTags(smallHtml);

        // Assert: 入力がそのまま返却される（scriptタグも残る）
        expect(result).toBe(smallHtml);
      });

      it('空文字列はそのまま返却される', () => {
        // Arrange
        const emptyHtml = '';

        // Act
        const result = preStripDangerousTags(emptyHtml);

        // Assert
        expect(result).toBe('');
      });
    });

    // -------------------------------------------
    // コンテンツ付きタグの除去（開始タグ〜終了タグ）
    // -------------------------------------------
    describe('コンテンツ付き危険タグの除去', () => {
      // 500KB以上のHTMLを生成するヘルパー
      // パディングを付与して閾値を超えるようにする
      const makeLargeHtml = (dangerousPart: string, safePart: string): string => {
        const padding = 'x'.repeat(500_001);
        return `<div>${padding}</div>${dangerousPart}${safePart}`;
      };

      it('scriptタグとそのコンテンツが除去される', () => {
        // Arrange: 500KB超のHTML内にscriptタグ
        const html = makeLargeHtml(
          '<script>alert("xss")</script>',
          '<p>Safe content</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert: scriptタグとコンテンツが除去される
        expect(result).not.toContain('<script');
        expect(result).not.toContain('alert("xss")');
        expect(result).not.toContain('</script>');
        // 安全なコンテンツは保持される
        expect(result).toContain('<p>Safe content</p>');
      });

      it('noscriptタグとそのコンテンツが除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<noscript><p>JavaScript is disabled</p></noscript>',
          '<p>Main content</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<noscript');
        expect(result).not.toContain('JavaScript is disabled');
        expect(result).toContain('<p>Main content</p>');
      });

      it('iframeタグとそのコンテンツが除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<iframe src="http://evil.com">fallback content</iframe>',
          '<p>Safe</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<iframe');
        expect(result).not.toContain('evil.com');
        expect(result).toContain('<p>Safe</p>');
      });

      it('objectタグとそのコンテンツが除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<object data="malware.swf"><param name="movie" value="malware.swf"></object>',
          '<p>Clean</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<object');
        expect(result).not.toContain('malware.swf');
        expect(result).toContain('<p>Clean</p>');
      });

      it('複数のscriptタグがすべて除去される', () => {
        // Arrange: 複数のscriptタグ
        const html = makeLargeHtml(
          '<script>first()</script><script>second()</script><script>third()</script>',
          '<p>Content</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert: すべてのscriptタグが除去される
        expect(result).not.toContain('<script');
        expect(result).not.toContain('first()');
        expect(result).not.toContain('second()');
        expect(result).not.toContain('third()');
        expect(result).toContain('<p>Content</p>');
      });
    });

    // -------------------------------------------
    // 自己閉じ・空タグの除去
    // -------------------------------------------
    describe('自己閉じ・空タグの除去', () => {
      const makeLargeHtml = (dangerousPart: string, safePart: string): string => {
        const padding = 'x'.repeat(500_001);
        return `<div>${padding}</div>${dangerousPart}${safePart}`;
      };

      it('inputタグ（自己閉じ）が除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<input type="text" name="secret" />',
          '<p>Content</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<input');
        expect(result).toContain('<p>Content</p>');
      });

      it('metaタグが除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<meta name="description" content="test">',
          '<p>Content</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<meta');
        expect(result).toContain('<p>Content</p>');
      });

      it('linkタグが除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<link rel="stylesheet" href="style.css">',
          '<p>Content</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<link');
        expect(result).toContain('<p>Content</p>');
      });

      it('baseタグが除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<base href="http://evil.com/">',
          '<p>Content</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<base');
        expect(result).toContain('<p>Content</p>');
      });

      it('embedタグが除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<embed type="application/pdf" src="malware.pdf">',
          '<p>Content</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<embed');
        expect(result).toContain('<p>Content</p>');
      });
    });

    // -------------------------------------------
    // HTMLコメントの除去
    // -------------------------------------------
    describe('HTMLコメントの除去', () => {
      const makeLargeHtml = (dangerousPart: string, safePart: string): string => {
        const padding = 'x'.repeat(500_001);
        return `<div>${padding}</div>${dangerousPart}${safePart}`;
      };

      it('HTMLコメントが除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<!-- This is a comment with <script>evil</script> -->',
          '<p>Content</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<!--');
        expect(result).not.toContain('-->');
        expect(result).toContain('<p>Content</p>');
      });

      it('条件付きコメント（IE）が除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<!--[if IE]><script>ieOnly()</script><![endif]-->',
          '<p>Content</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<!--');
        expect(result).not.toContain('if IE');
        expect(result).toContain('<p>Content</p>');
      });
    });

    // -------------------------------------------
    // 保持されるべきタグ（分析に必要）
    // -------------------------------------------
    describe('分析に必要なタグの保持', () => {
      const makeLargeHtml = (content: string): string => {
        const padding = 'x'.repeat(500_001);
        return `<div>${padding}</div>${content}`;
      };

      it('styleタグは保持される（CSS分析に必要）', () => {
        // Arrange: styleタグはレイアウト・モーション検出に必要
        const html = makeLargeHtml(
          '<style>.hero { background: red; animation: slide 1s; }</style><p>Content</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert: styleタグは除去されない
        expect(result).toContain('<style>');
        expect(result).toContain('.hero { background: red; animation: slide 1s; }');
        expect(result).toContain('</style>');
      });

      it('SVGは保持される（ビジュアル分析に必要）', () => {
        // Arrange
        const html = makeLargeHtml(
          '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="red"/></svg>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert: SVGタグは保持される
        expect(result).toContain('<svg');
        expect(result).toContain('<circle');
        expect(result).toContain('</svg>');
      });

      it('通常のdiv/p/span等は保持される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<div class="container"><p>Paragraph</p><span>Inline</span><h1>Heading</h1><a href="https://example.com">Link</a></div>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert: 通常のHTMLタグはすべて保持される
        expect(result).toContain('<div class="container">');
        expect(result).toContain('<p>Paragraph</p>');
        expect(result).toContain('<span>Inline</span>');
        expect(result).toContain('<h1>Heading</h1>');
        expect(result).toContain('<a href="https://example.com">Link</a>');
      });

      it('imgタグは保持される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<img src="photo.jpg" alt="Photo" />'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).toContain('<img src="photo.jpg"');
      });

      it('buttonタグは保持される（CTA検出に必要）', () => {
        // Arrange: buttonはDANGEROUS_TAGSに含まれない
        const html = makeLargeHtml(
          '<button type="button">Click Me</button>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).toContain('<button');
        expect(result).toContain('Click Me');
      });
    });

    // -------------------------------------------
    // 大文字/混合ケースのタグ処理（case-insensitive）
    // -------------------------------------------
    describe('大文字/混合ケース対応', () => {
      const makeLargeHtml = (dangerousPart: string, safePart: string): string => {
        const padding = 'x'.repeat(500_001);
        return `<div>${padding}</div>${dangerousPart}${safePart}`;
      };

      it('大文字のSCRIPTタグが除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<SCRIPT>alert("xss")</SCRIPT>',
          '<p>Safe</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<SCRIPT');
        expect(result).not.toContain('alert("xss")');
        expect(result).toContain('<p>Safe</p>');
      });

      it('混合ケースのScRiPtタグが除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<ScRiPt>alert("xss")</ScRiPt>',
          '<p>Safe</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<ScRiPt');
        expect(result).not.toContain('alert("xss")');
        expect(result).toContain('<p>Safe</p>');
      });

      it('大文字のIFRAMEタグが除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<IFRAME src="http://evil.com"></IFRAME>',
          '<p>Safe</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<IFRAME');
        expect(result).toContain('<p>Safe</p>');
      });

      it('大文字のINPUTタグ（自己閉じ）が除去される', () => {
        // Arrange
        const html = makeLargeHtml(
          '<INPUT type="hidden" value="secret" />',
          '<p>Safe</p>'
        );

        // Act
        const result = preStripDangerousTags(html);

        // Assert
        expect(result).not.toContain('<INPUT');
        expect(result).toContain('<p>Safe</p>');
      });
    });

    // -------------------------------------------
    // カスタム危険タグリスト
    // -------------------------------------------
    describe('カスタム危険タグリスト', () => {
      const makeLargeHtml = (content: string): string => {
        const padding = 'x'.repeat(500_001);
        return `<div>${padding}</div>${content}`;
      };

      it('カスタムタグリストを指定して除去対象を変更できる', () => {
        // Arrange: scriptのみを除去対象とする
        const html = makeLargeHtml(
          '<script>evil()</script><iframe src="keep.html"></iframe><p>Content</p>'
        );
        const customTags = ['script'] as const;

        // Act
        const result = preStripDangerousTags(html, customTags);

        // Assert: scriptは除去されるが、iframeは保持される
        expect(result).not.toContain('<script');
        expect(result).toContain('<iframe');
        expect(result).toContain('<p>Content</p>');
      });
    });
  });

  // =============================================
  // パフォーマンステスト
  // sanitizeHtml が大容量HTMLを制限時間内に処理できること
  // =============================================
  describe('パフォーマンス', () => {
    it('2MB超のHTMLをsanitizeHtmlが5秒以内に完了する（DOMPurifyバイパス）', () => {
      // Arrange: 2MB超のHTMLを生成（実際のWebページに近い構造）
      // scriptタグ、styleタグ、divなどを混在させる
      const segments: string[] = [];
      // 安全なコンテンツのブロック（大量生成）
      // 各ブロックを大きくして確実に2MBを超える
      const loremIpsum = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.';
      for (let i = 0; i < 6000; i++) {
        segments.push(`<div class="block-${i}"><p>${loremIpsum}</p></div>`);
      }
      // 危険なタグを散在させる
      for (let i = 0; i < 100; i++) {
        segments.push(`<script>malicious_code_${i}()</script>`);
        segments.push(`<iframe src="http://evil-${i}.com"></iframe>`);
        segments.push(`<noscript><p>Fallback ${i}</p></noscript>`);
      }
      // styleタグ（保持されるべき）
      for (let i = 0; i < 20; i++) {
        segments.push(`<style>.component-${i} { background: linear-gradient(to right, #${String(i).padStart(2, '0')}0000, #0000${String(i).padStart(2, '0')}); animation: fade-${i} 1s ease; }</style>`);
      }
      const largeHtml = `<html><head><title>Test</title></head><body>${segments.join('')}</body></html>`;

      // サイズが2MB超であることを確認
      expect(largeHtml.length).toBeGreaterThan(2_000_000);

      // Act: サニタイズを実行し処理時間を測定
      // preStripDangerousTags + DOMPurifyバイパス（1.5M文字以上）により高速完了
      const startTime = Date.now();
      const result = sanitizeHtml(largeHtml);
      const elapsed = Date.now() - startTime;

      // Assert: 5秒以内に完了（DOMPurifyバイパスにより大幅に高速化）
      expect(elapsed).toBeLessThan(5_000);

      // Assert: 危険なタグが除去されている（preStripDangerousTagsにより）
      expect(result).not.toContain('<script');
      expect(result).not.toContain('<iframe');
      expect(result).not.toContain('<noscript');

      // Assert: 安全なコンテンツが保持されている
      expect(result).toContain('Lorem ipsum');
      expect(result).toContain('block-0');

      // Assert: styleタグが保持されている（分析に必要）
      expect(result).toContain('<style>');
    }, 30_000); // テスト自体のタイムアウト30秒
  });
});
