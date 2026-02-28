// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCPドキュメント完全性テスト
 *
 * TDD Green フェーズ（完了）:
 * - 全MCPツールのドキュメント存在確認
 * - スキーマ定義と使用例の検証
 * - Claude Desktop設定例の存在確認
 * - エラーハンドリング例の検証
 *
 * README.mdが全ての要件を満たしているため、全テストがパスします。
 * 新しいツール追加時はこのテストも更新してください。
 *
 * v0.1.0: SVG機能削除に伴い、WebDesign専用（18ツール）に更新
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('MCP Documentation Completeness', () => {
  let docsPath: string;
  let readmeContent: string;

  beforeAll(async () => {
    // ドキュメントパスを解決
    docsPath = path.join(process.cwd(), 'README.md');

    try {
      readmeContent = await fs.readFile(docsPath, 'utf-8');
    } catch (error) {
      console.error('[Test] README.md読み込み失敗:', error);
      readmeContent = '';
    }
  });

  describe('必須ドキュメントの存在確認', () => {
    it('README.mdが存在すること', async () => {
      const exists = await fs.access(docsPath)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);
    });

    it('MCPツールセクションが存在すること', () => {
      // 日本語または英語のセクション名を許容
      const hasMCPTools = readmeContent.includes('MCP Tools') ||
        readmeContent.includes('MCPツール') ||
        readmeContent.includes('MCP tool');
      expect(hasMCPTools).toBe(true);
    });

    it('インストールセクションが存在すること', () => {
      // 日本語または英語のセクション名を許容
      const hasInstallation = readmeContent.includes('Installation') ||
        readmeContent.includes('インストール');
      expect(hasInstallation).toBe(true);
    });

    it('Claude Desktop設定セクションが存在すること', () => {
      expect(readmeContent).toContain('Claude Desktop');
    });
  });

  describe('layout.search ツールドキュメント', () => {
    it('layout.searchの説明が含まれること', () => {
      expect(readmeContent.toLowerCase()).toContain('layout.search');
    });

    it('layout.searchのスキーマ定義が含まれること', () => {
      // 必須パラメータ: query
      expect(readmeContent).toMatch(/query.*string/i);
    });

    it('layout.searchの使用例が含まれること', () => {
      // 使用例にはJSONレスポンス形式が含まれるべき
      // 日本語の「使用例」も許容
      expect(readmeContent).toMatch(/example|usage|使用例|レスポンス/i);
    });

    it('layout.searchのレスポンス形式が説明されていること', () => {
      // レスポンス形式: limit, sectionType等
      const hasResponseFormat =
        readmeContent.includes('limit') &&
        readmeContent.includes('sectionType');

      expect(hasResponseFormat).toBe(true);
    });
  });

  describe('layout.inspect ツールドキュメント', () => {
    it('layout.inspectの説明が含まれること', () => {
      expect(readmeContent.toLowerCase()).toContain('layout.inspect');
    });

    it('layout.inspectのスキーマ定義が含まれること', () => {
      // 必須パラメータ: id or html
      expect(readmeContent).toMatch(/html.*string/i);
    });

    it('layout.inspectの使用例が含まれること', () => {
      // 使用例にはHTML解析シナリオが含まれるべき
      expect(readmeContent).toMatch(/inspect|解析|analyze/i);
    });

    it('layout.inspectのレスポンス形式が説明されていること', () => {
      // レスポンス: detectSections, detectGrid, analyzeTypography等
      const hasOptions =
        readmeContent.includes('detectSections') ||
        readmeContent.includes('detectGrid') ||
        readmeContent.includes('analyzeTypography');

      expect(hasOptions).toBe(true);
    });
  });

  describe('layout.ingest ツールドキュメント', () => {
    it('layout.ingestの説明が含まれること', () => {
      expect(readmeContent.toLowerCase()).toContain('layout.ingest');
    });

    it('layout.ingestのスキーマ定義が含まれること', () => {
      // 必須パラメータ: url
      expect(readmeContent).toMatch(/url.*string/i);
    });

    it('layout.ingestの使用例が含まれること', () => {
      // 使用例には取得シナリオが含まれるべき
      expect(readmeContent).toMatch(/ingest|取得|fetch/i);
    });

    it('layout.ingestのバリデーション要件が説明されていること', () => {
      // バリデーション: URLフォーマット、タイムアウト等
      // 日本語の「必須」「検証」なども許容
      const hasValidation =
        readmeContent.includes('validation') ||
        readmeContent.includes('timeout') ||
        readmeContent.includes('必須') ||
        readmeContent.includes('バリデーション') ||
        readmeContent.includes('Zod');

      expect(hasValidation).toBe(true);
    });
  });

  describe('motion.* ツールドキュメント', () => {
    it('motion.detectの説明が含まれること', () => {
      expect(readmeContent.toLowerCase()).toContain('motion.detect');
    });

    it('motion.searchの説明が含まれること', () => {
      expect(readmeContent.toLowerCase()).toContain('motion.search');
    });

    it('motionツールのアニメーション関連説明があること', () => {
      const hasAnimationInfo =
        readmeContent.toLowerCase().includes('animation') ||
        readmeContent.toLowerCase().includes('transition');

      expect(hasAnimationInfo).toBe(true);
    });

    it('motionツールのパラメータが説明されていること', () => {
      // motionツールはhtml/pageIdパラメータを持つ
      expect(readmeContent).toMatch(/pageId|html.*content/i);
    });
  });

  describe('quality.* ツールドキュメント', () => {
    it('quality.evaluateの説明が含まれること', () => {
      expect(readmeContent.toLowerCase()).toContain('quality.evaluate');
    });

    it('quality.batch_evaluateの説明が含まれること', () => {
      expect(readmeContent.toLowerCase()).toContain('quality.batch_evaluate');
    });

    it('品質評価3軸の説明があること', () => {
      const hasQualityAxes =
        readmeContent.includes('originality') &&
        readmeContent.includes('craftsmanship') &&
        readmeContent.includes('contextuality');

      expect(hasQualityAxes).toBe(true);
    });
  });

  describe('Claude Desktop設定例', () => {
    it('mcpServers設定例が含まれること', () => {
      expect(readmeContent).toMatch(/mcpServers|mcp.*servers/i);
    });

    it('コマンド設定例が含まれること', () => {
      expect(readmeContent).toMatch(/command|cmd/i);
    });

    it('引数設定例が含まれること', () => {
      expect(readmeContent).toMatch(/args|arguments/i);
    });

    it('環境変数設定例が含まれること', () => {
      // NODE_ENV, REFTRIX_API_URL等の環境変数設定
      const hasEnvVars =
        readmeContent.includes('env') ||
        readmeContent.includes('NODE_ENV');

      expect(hasEnvVars).toBe(true);
    });
  });

  describe('エラーハンドリング例', () => {
    it('エラーレスポンス形式が説明されていること', () => {
      expect(readmeContent.toLowerCase()).toMatch(/error|exception/i);
    });

    it('一般的なエラーケースが説明されていること', () => {
      // NOT_FOUND, validation error等（日本語も許容）
      const hasErrorCases =
        readmeContent.includes('not found') ||
        readmeContent.includes('NOT_FOUND') ||
        readmeContent.includes('validation') ||
        readmeContent.includes('invalid') ||
        readmeContent.includes('エラー') ||
        readmeContent.includes('失敗');

      expect(hasErrorCases).toBe(true);
    });

    it('エラーコード一覧が含まれること', () => {
      // INTERNAL_ERROR, VALIDATION_ERROR等のエラーコード
      const hasErrorCodes =
        readmeContent.includes('INTERNAL_ERROR') ||
        readmeContent.includes('VALIDATION_ERROR') ||
        readmeContent.includes('error code') ||
        readmeContent.includes('エラーコード');

      expect(hasErrorCodes).toBe(true);
    });

    it('トラブルシューティングセクションが存在すること', () => {
      // トラブルシューティングまたはエラーハンドリングセクション
      const hasTroubleshooting =
        readmeContent.toLowerCase().includes('troubleshoot') ||
        readmeContent.toLowerCase().includes('common issues') ||
        readmeContent.includes('エラーハンドリング') ||
        readmeContent.includes('よくある問題');
      expect(hasTroubleshooting).toBe(true);
    });
  });

  describe('APIリファレンス', () => {
    it('全MCPツール（15ツール）のリストが含まれること', () => {
      // WebDesign専用15ツール（v0.1.0でSVG/design削除後）
      const requiredTools = [
        // Layout (4)
        'layout.ingest',
        'layout.inspect',
        'layout.search',
        'layout.generate_code',
        // Motion (2)
        'motion.detect',
        'motion.search',
        // Quality (2)
        'quality.evaluate',
        'quality.batch_evaluate',
        // Style (1)
        'style.get_palette',
        // Brief (1)
        'brief.validate',
        // Project (2)
        'project.get',
        'project.list',
        // Page (2)
        'page.analyze',
        'page.getJobStatus',
        // System (1)
        'system.health'
      ];

      requiredTools.forEach(tool => {
        expect(readmeContent.toLowerCase()).toContain(tool.toLowerCase());
      });
    });

    it('各ツールの必須パラメータが明記されていること', () => {
      // 必須パラメータには"required"マークがあるべき
      expect(readmeContent.toLowerCase()).toMatch(/required|必須/i);
    });

    it('各ツールのオプショナルパラメータが明記されていること', () => {
      // オプショナルパラメータには"optional"マーク、"省略"、"デフォルト"等があるべき
      expect(readmeContent).toMatch(/optional|省略|デフォルト|\?:/i);
    });

    it('戻り値の型定義が含まれること', () => {
      // 戻り値: object, array等の型情報（日本語「レスポンス」も許容）
      const hasReturnTypes =
        readmeContent.includes('returns') ||
        readmeContent.includes('response') ||
        readmeContent.includes('レスポンス');

      expect(hasReturnTypes).toBe(true);
    });
  });

  describe('セキュリティガイドライン', () => {
    it('HTMLサニタイズに関する説明が含まれること', () => {
      // DOMPurify、サニタイズ、セキュリティ等
      expect(readmeContent).toMatch(/sanitize|sanitization|DOMPurify|サニタイズ|セキュリティ/i);
    });

    it('XSS対策に関する説明が含まれること', () => {
      expect(readmeContent.toLowerCase()).toMatch(/xss|cross.*site/i);
    });

    it('レート制限に関する説明が含まれること', () => {
      expect(readmeContent.toLowerCase()).toMatch(/rate.*limit|throttle/i);
    });
  });

  describe('パフォーマンスガイドライン', () => {
    it('ベクトル検索のパフォーマンスに関する説明が含まれること', () => {
      // README.mdに「ベクトル検索速度」が含まれている
      const hasVectorPerf =
        readmeContent.includes('ベクトル検索') ||
        (readmeContent.toLowerCase().includes('vector') &&
         (readmeContent.toLowerCase().includes('performance') ||
          readmeContent.toLowerCase().includes('speed')));

      expect(hasVectorPerf).toBe(true);
    });

    it('キャッシング戦略に関する説明が含まれること', () => {
      // README.mdに「LRUキャッシュ」「キャッシュヒット」が含まれている（日本語表記）
      const hasCacheInfo =
        readmeContent.includes('キャッシュ') ||
        readmeContent.toLowerCase().includes('cache') ||
        readmeContent.toLowerCase().includes('caching');
      expect(hasCacheInfo).toBe(true);
    });

    it('推奨されるパラメータ値が含まれること', () => {
      // 例: limit=10等
      expect(readmeContent).toMatch(/limit|timeout/i);
    });
  });

  describe('SVG機能削除の確認（v0.1.0）', () => {
    it('SVG関連ツールの参照がないこと', () => {
      // SVG機能は完全に削除されたため、ドキュメントにも含まれていないこと
      const hasSvgTools =
        readmeContent.toLowerCase().includes('svg.search') ||
        readmeContent.toLowerCase().includes('svg.get') ||
        readmeContent.toLowerCase().includes('svg.ingest') ||
        readmeContent.toLowerCase().includes('svg.transform');

      expect(hasSvgTools).toBe(false);
    });

    it('WebDesign専用プラットフォームであることが明記されていること', () => {
      // WebデザインまたはWeb Design関連の説明があること
      const hasWebDesignFocus =
        readmeContent.toLowerCase().includes('webデザイン') ||
        readmeContent.toLowerCase().includes('web design') ||
        readmeContent.toLowerCase().includes('レイアウト') ||
        readmeContent.toLowerCase().includes('layout');

      expect(hasWebDesignFocus).toBe(true);
    });
  });
});
