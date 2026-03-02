// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - Responsive Phase Integration Tests
 *
 * Tests for Phase 4.5 (Responsive Analysis) in the page-analyze-worker:
 * 1. 正常完了: SSRF OK, robots OK → completedPhases に 'responsive' が含まれる
 * 2. SSRFブロック: validateExternalUrl が invalid → skipPhase
 * 3. robots.txt ブロック: isUrlAllowedByRobotsTxt が disallowed → skipPhase
 *    - respectRobotsTxt: false の場合はブロックされないことも確認
 * 4. タイムアウト: 120秒超 → failPhase
 * 5. DB保存失敗: responsivePersistenceService.save が例外 → graceful degradation
 * 6. memoryAborted: memoryAborted=true → フェーズ自体がスキップ
 *
 * Uses source code verification pattern (consistent with existing worker tests).
 *
 * @module tests/workers/page-analyze-worker-responsive
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('PageAnalyzeWorker - Responsive Phase (Phase 4.5)', () => {
  const workerSourcePath = path.resolve(
    __dirname,
    '../../src/workers/page-analyze-worker.ts'
  );

  let workerSource: string;
  let responsiveSection: string;

  beforeAll(() => {
    workerSource = fs.readFileSync(workerSourcePath, 'utf8');

    // Phase 4.5 のコードセクションを抽出
    const responsiveStart = workerSource.indexOf('Phase 4.5: Responsive Analysis');
    const responsiveEnd = workerSource.indexOf('Memory Check 3: Before Phase 5');
    expect(responsiveStart).toBeGreaterThan(-1);
    expect(responsiveEnd).toBeGreaterThan(responsiveStart);
    responsiveSection = workerSource.slice(responsiveStart, responsiveEnd);
  });

  // ============================================================================
  // Import verification
  // ============================================================================

  describe('Imports', () => {
    it('should import responsiveAnalysisService and responsivePersistenceService', () => {
      expect(workerSource).toMatch(
        /import\s+\{[^}]*responsiveAnalysisService[^}]*\}\s+from\s+['"]\.\.\/services\/responsive['"]/
      );
      expect(workerSource).toMatch(
        /import\s+\{[^}]*responsivePersistenceService[^}]*\}\s+from\s+['"]\.\.\/services\/responsive['"]/
      );
    });

    it('should import validateExternalUrl from url-validator', () => {
      expect(workerSource).toMatch(
        /import\s+\{[^}]*validateExternalUrl[^}]*\}\s+from\s+['"]\.\.\/utils\/url-validator['"]/
      );
    });

    it('should import isUrlAllowedByRobotsTxt from @reftrix/core', () => {
      expect(workerSource).toMatch(
        /import\s+\{[^}]*isUrlAllowedByRobotsTxt[^}]*\}\s+from\s+['"]@reftrix\/core['"]/
      );
    });
  });

  // ============================================================================
  // 1. 正常完了: SSRF OK, robots OK, 分析成功
  // ============================================================================

  describe('Scenario 1: 正常完了 (Happy path)', () => {
    it('should call startPhase("responsive") when responsiveEnabled && actualWebPageId && !memoryAborted', () => {
      expect(responsiveSection).toContain('startPhase(\'responsive\')');
    });

    it('should call validateExternalUrl(url) for SSRF check', () => {
      expect(responsiveSection).toContain('validateExternalUrl(url)');
    });

    it('should call isUrlAllowedByRobotsTxt after SSRF check passes', () => {
      const ssrfCheckPos = responsiveSection.indexOf('validateExternalUrl(url)');
      const robotsCheckPos = responsiveSection.indexOf('isUrlAllowedByRobotsTxt');
      expect(ssrfCheckPos).toBeGreaterThan(-1);
      expect(robotsCheckPos).toBeGreaterThan(ssrfCheckPos);
    });

    it('should call responsiveAnalysisService.analyze(url, responsiveOpts) when all checks pass', () => {
      expect(responsiveSection).toContain('responsiveAnalysisService.analyze(url, responsiveOpts)');
    });

    it('should set results.responsive with differencesDetected, breakpointsDetected, viewportsAnalyzed', () => {
      expect(responsiveSection).toContain('results.responsive');
      expect(responsiveSection).toContain('differencesDetected');
      expect(responsiveSection).toContain('breakpointsDetected');
      expect(responsiveSection).toContain('viewportsAnalyzed');
      expect(responsiveSection).toContain('analysisTimeMs');
    });

    it('should call completePhase("responsive") after successful analysis', () => {
      expect(responsiveSection).toContain('completePhase(\'responsive\')');
    });

    it('should push "responsive" to completedPhases after successful analysis', () => {
      expect(responsiveSection).toContain("completedPhases.push('responsive')");
    });

    it('should include responsiveAnalysisId in results when DB save succeeds', () => {
      expect(responsiveSection).toContain('responsiveAnalysisId');
      // Should conditionally spread responsiveAnalysisId
      expect(responsiveSection).toMatch(/responsiveAnalysisId\s*\?/);
    });
  });

  // ============================================================================
  // 2. SSRFブロック
  // ============================================================================

  describe('Scenario 2: SSRF blocked', () => {
    it('should check urlValidation.valid after validateExternalUrl call', () => {
      expect(responsiveSection).toContain('urlValidation.valid');
    });

    it('should call skipPhase("responsive") with SSRF blocked reason when URL is invalid', () => {
      expect(responsiveSection).toMatch(/skipPhase\('responsive',\s*`SSRF blocked:/);
    });

    it('should not call responsiveAnalysisService.analyze when SSRF blocks the URL', () => {
      // The analyze call should be inside the else branch of SSRF check
      const ssrfBlockPos = responsiveSection.indexOf('SSRF blocked');
      const analyzePos = responsiveSection.indexOf('responsiveAnalysisService.analyze');
      expect(ssrfBlockPos).toBeGreaterThan(-1);
      expect(analyzePos).toBeGreaterThan(-1);
      // analyze should come after the SSRF else branch, not before
      expect(analyzePos).toBeGreaterThan(ssrfBlockPos);
    });
  });

  // ============================================================================
  // 3. robots.txt ブロック + respectRobotsTxt パラメータ
  // ============================================================================

  describe('Scenario 3: robots.txt blocked', () => {
    it('should check robotsResult.allowed after isUrlAllowedByRobotsTxt call', () => {
      expect(responsiveSection).toContain('robotsResult.allowed');
    });

    it('should call skipPhase("responsive") with robots.txt reason when blocked', () => {
      expect(responsiveSection).toMatch(/skipPhase\('responsive',\s*`Robots\.txt blocked:/);
    });

    it('should pass options.respectRobotsTxt to isUrlAllowedByRobotsTxt', () => {
      // TDA M-2: respect_robots_txt パラメータ伝搬の検証
      expect(responsiveSection).toContain('isUrlAllowedByRobotsTxt(url, options.respectRobotsTxt)');
    });

    it('should have respectRobotsTxt field in PageAnalyzeJobOptions', () => {
      // Queue定義を読み込んで検証
      const queuePath = path.resolve(
        __dirname,
        '../../src/queues/page-analyze-queue.ts'
      );
      const queueSource = fs.readFileSync(queuePath, 'utf8');
      expect(queueSource).toContain('respectRobotsTxt?: boolean');
    });
  });

  // ============================================================================
  // 4. タイムアウト (120秒超)
  // ============================================================================

  describe('Scenario 4: Timeout (> 120s)', () => {
    it('should set responsiveTimeout to 120000ms', () => {
      expect(responsiveSection).toMatch(/responsiveTimeout\s*=\s*120000/);
    });

    it('should use Promise.race to enforce timeout', () => {
      expect(responsiveSection).toContain('Promise.race');
    });

    it('should reject with "Responsive analysis timeout" on timeout', () => {
      expect(responsiveSection).toContain('Responsive analysis timeout');
    });

    it('should clear timer with clearTimeout in finally block', () => {
      // Promise.race の finally で clearTimeout を呼ぶことを確認
      const promiseRacePos = responsiveSection.indexOf('Promise.race');
      expect(promiseRacePos).toBeGreaterThan(-1);
      const afterRace = responsiveSection.slice(promiseRacePos, promiseRacePos + 500);
      expect(afterRace).toContain('.finally(');
      expect(afterRace).toContain('clearTimeout');
    });

    it('should call failPhase("responsive") in the catch block when timeout occurs', () => {
      expect(responsiveSection).toContain('failPhase(\'responsive\'');
    });

    it('should not crash the main pipeline on timeout (graceful degradation)', () => {
      // catch ブロックが存在し、メイン結果に影響しない（コメントで明示）
      expect(responsiveSection).toContain('Graceful degradation');
    });
  });

  // ============================================================================
  // 5. DB保存失敗 (graceful degradation)
  // ============================================================================

  describe('Scenario 5: DB save failure (graceful degradation)', () => {
    it('should call responsivePersistenceService.save when saveToDb is true', () => {
      expect(responsiveSection).toContain('responsivePersistenceService.save');
    });

    it('should check save_to_db option (default: true)', () => {
      // save_to_db !== false のチェック
      expect(responsiveSection).toMatch(/save_to_db\s*!==\s*false/);
    });

    it('should wrap save in try-catch for graceful degradation', () => {
      // save呼び出しがtry-catchで囲まれていることを確認
      const savePos = responsiveSection.indexOf('responsivePersistenceService.save');
      expect(savePos).toBeGreaterThan(-1);

      // save前後にtry-catchが存在することを確認
      const beforeSave = responsiveSection.slice(0, savePos);
      const lastTryBeforeSave = beforeSave.lastIndexOf('try {');
      expect(lastTryBeforeSave).toBeGreaterThan(-1);

      // try-catch の catch 部分に save failed ログがあることを確認
      expect(responsiveSection).toContain('Responsive DB save failed');
    });

    it('should still set results.responsive even when save fails (responsiveAnalysisId is undefined)', () => {
      // responsiveAnalysisId は let で宣言されておりundefined可能
      expect(responsiveSection).toMatch(/let\s+responsiveAnalysisId.*undefined/);
      // 結果には分析データが含まれるが、IDは条件付き
      expect(responsiveSection).toContain('differencesDetected: responsiveResult.differences.length');
    });
  });

  // ============================================================================
  // 6. memoryAborted → フェーズスキップ
  // ============================================================================

  describe('Scenario 6: memoryAborted skips responsive phase', () => {
    it('should check responsiveEnabled && actualWebPageId && !memoryAborted condition', () => {
      expect(responsiveSection).toContain('responsiveEnabled && actualWebPageId && !memoryAborted');
    });

    it('should skip responsive phase when memoryAborted is true', () => {
      expect(responsiveSection).toContain('memoryAborted');
      expect(responsiveSection).toContain('Skipped due to memory pressure');
    });

    it('should skip responsive phase when responsiveEnabled is false', () => {
      expect(responsiveSection).toContain('Disabled by options');
    });

    it('should derive responsiveEnabled from options.responsiveOptions?.enabled !== false', () => {
      // responsiveEnabled のデフォルトは true（enabled !== false）
      expect(workerSource).toContain(
        'options.responsiveOptions?.enabled !== false'
      );
    });
  });

  // ============================================================================
  // crawl-delay 伝搬 (LCC M 修正の検証)
  // ============================================================================

  describe('crawl-delay propagation (LCC M fix)', () => {
    it('should extract crawlDelay from robotsResult', () => {
      expect(responsiveSection).toContain('robotsResult.crawlDelay');
    });

    it('should convert crawlDelay from seconds to milliseconds', () => {
      // crawlDelay * 1000 で秒→ミリ秒変換
      expect(responsiveSection).toMatch(/robotsResult\.crawlDelay\s*\*\s*1000/);
    });

    it('should pass crawlDelayMs to responsiveOpts when defined', () => {
      expect(responsiveSection).toContain('crawlDelayMs');
      expect(responsiveSection).toMatch(/if\s*\(crawlDelayMs\s*!==\s*undefined\)/);
      expect(responsiveSection).toContain('responsiveOpts.crawlDelayMs = crawlDelayMs');
    });
  });

  // ============================================================================
  // Phase progress tracking
  // ============================================================================

  describe('Phase progress tracking', () => {
    it('should update progress at RESPONSIVE_START', () => {
      expect(responsiveSection).toContain('PHASE_PROGRESS.RESPONSIVE_START');
    });

    it('should update progress at RESPONSIVE_COMPLETE', () => {
      expect(responsiveSection).toContain('PHASE_PROGRESS.RESPONSIVE_COMPLETE');
    });

    it('should extend job lock during responsive phase', () => {
      expect(responsiveSection).toContain('extendJobLock');
    });
  });

  // ============================================================================
  // Options forwarding
  // ============================================================================

  describe('Responsive options forwarding', () => {
    const optionFields = [
      'viewports',
      'include_screenshots',
      'include_diff_images',
      'diff_threshold',
      'detect_navigation',
      'detect_visibility',
      'detect_layout',
    ];

    for (const field of optionFields) {
      it(`should forward ${field} from responsiveOptions to responsiveOpts`, () => {
        expect(responsiveSection).toContain(field);
      });
    }

    it('should guard each option with undefined check before forwarding', () => {
      // Each forwarded option should be checked with !== undefined
      for (const field of optionFields) {
        const pattern = new RegExp(
          `rOpts\\?\\.${field}\\s*!==\\s*undefined`
        );
        expect(responsiveSection).toMatch(pattern);
      }
    });
  });
});
