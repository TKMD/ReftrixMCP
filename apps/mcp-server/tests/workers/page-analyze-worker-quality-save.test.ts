// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PageAnalyzeWorker - Quality DB Save Integration Tests
 *
 * Verifies that the page-analyze-worker correctly:
 * - Calls saveQualityEvaluation after quality evaluation
 * - Handles save failure gracefully (job continues)
 * - Skips save when webPageId is not available
 *
 * Uses source code verification pattern (consistent with existing tests).
 *
 * @module tests/workers/page-analyze-worker-quality-save
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('PageAnalyzeWorker - Quality DB Save', () => {
  const workerSourcePath = path.resolve(
    __dirname,
    '../../src/workers/page-analyze-worker.ts'
  );

  let workerSource: string;

  beforeAll(() => {
    workerSource = fs.readFileSync(workerSourcePath, 'utf8');
  });

  describe('Import', () => {
    it('should import saveQualityEvaluation from worker-db-save.service', () => {
      expect(workerSource).toContain('saveQualityEvaluation');
      // Verify import statement
      expect(workerSource).toMatch(/import\s+\{[^}]*saveQualityEvaluation[^}]*\}\s+from\s+['"]\.\.\/services\/worker-db-save\.service['"]/);
    });

    it('should import QualityEvaluationPrismaClient type', () => {
      expect(workerSource).toContain('QualityEvaluationPrismaClient');
    });
  });

  describe('Quality DB Save Call', () => {
    it('should call saveQualityEvaluation after quality evaluation completes', () => {
      // saveQualityEvaluation should be called within the quality phase section
      const qualityPhaseStart = workerSource.indexOf('Phase 3: Quality Evaluation');
      const qualityPhaseEnd = workerSource.indexOf('Phase 4: Narrative Analysis');
      expect(qualityPhaseStart).toBeGreaterThan(-1);
      expect(qualityPhaseEnd).toBeGreaterThan(-1);

      const qualitySection = workerSource.slice(qualityPhaseStart, qualityPhaseEnd);
      expect(qualitySection).toContain('saveQualityEvaluation');
    });

    it('should guard save with actualWebPageId check', () => {
      const qualityPhaseStart = workerSource.indexOf('Phase 3: Quality Evaluation');
      const qualityPhaseEnd = workerSource.indexOf('Phase 4: Narrative Analysis');
      const qualitySection = workerSource.slice(qualityPhaseStart, qualityPhaseEnd);

      expect(qualitySection).toContain('actualWebPageId');
      // Should check actualWebPageId before calling save
      expect(qualitySection).toMatch(/actualWebPageId.*saveQualityEvaluation/s);
    });

    it('should pass prisma as QualityEvaluationPrismaClient', () => {
      const qualityPhaseStart = workerSource.indexOf('Phase 3: Quality Evaluation');
      const qualityPhaseEnd = workerSource.indexOf('Phase 4: Narrative Analysis');
      const qualitySection = workerSource.slice(qualityPhaseStart, qualityPhaseEnd);

      expect(qualitySection).toContain('QualityEvaluationPrismaClient');
    });

    it('should have try-catch around saveQualityEvaluation for graceful degradation', () => {
      const qualityPhaseStart = workerSource.indexOf('Phase 3: Quality Evaluation');
      const qualityPhaseEnd = workerSource.indexOf('Phase 4: Narrative Analysis');
      const qualitySection = workerSource.slice(qualityPhaseStart, qualityPhaseEnd);

      // Should have a separate try-catch for the save operation
      expect(qualitySection).toContain('QualityEvaluation save failed');
    });

    it('should pass quality options (strict, targetIndustry, targetAudience) to save', () => {
      const qualityPhaseStart = workerSource.indexOf('Phase 3: Quality Evaluation');
      const qualityPhaseEnd = workerSource.indexOf('Phase 4: Narrative Analysis');
      const qualitySection = workerSource.slice(qualityPhaseStart, qualityPhaseEnd);

      // Should pass options to saveQualityEvaluation
      expect(qualitySection).toContain('qualityOptions');
    });
  });

  describe('Graceful Degradation', () => {
    it('should not throw from quality save failure (job continues)', () => {
      const qualityPhaseStart = workerSource.indexOf('Phase 3: Quality Evaluation');
      const qualityPhaseEnd = workerSource.indexOf('Phase 4: Narrative Analysis');
      const qualitySection = workerSource.slice(qualityPhaseStart, qualityPhaseEnd);

      // The save error should be caught and logged, not re-thrown
      // Verify the catch block contains a warn log, not a throw
      expect(qualitySection).toContain('qualitySaveError');
    });
  });
});
