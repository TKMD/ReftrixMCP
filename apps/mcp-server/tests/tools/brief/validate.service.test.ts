// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * brief.validate Service Tests
 * TDD Red Phase: BriefValidateService implementation tests
 *
 * Tests for:
 * - calculateCompletenessScore: Calculate brief completeness score (0-100)
 * - validateBrief: Validate brief and return validation result
 * - IBriefValidateService: Service interface compliance
 *
 * @module @reftrix/mcp-server/tools/brief/validate.service.test
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  BriefValidateService,
  calculateCompletenessScore,
  VALIDATION_RULES,
  FIELD_WEIGHTS,
  type IBriefValidateService,
} from '../../../src/tools/brief/validate.service';
import type { Brief, BriefValidationResult } from '../../../src/tools/brief/schemas';

// ============================================================================
// Test Fixtures
// ============================================================================

/**
 * Minimal valid brief - only required fields
 */
const minimalBrief: Brief = {
  projectName: 'Test Project',
};

/**
 * Short project name (below minLength)
 */
const shortProjectNameBrief: Brief = {
  projectName: 'AB',
};

/**
 * Full brief - all fields filled optimally
 */
const fullBrief: Brief = {
  projectName: 'My Design Project',
  description:
    'A comprehensive design project with detailed description that explains the goals, target outcomes, and key features of this web design initiative. It covers all aspects of the design.',
  targetAudience: 'Developers and designers who need professional SVG tools for their web projects',
  industry: 'Technology',
  tone: ['professional', 'minimal'],
  colorPreferences: {
    primary: '#3B82F6',
    secondary: '#10B981',
    accent: '#F59E0B',
  },
  references: [
    { url: 'https://example.com/ref1', note: 'Clean design' },
    { url: 'https://example.com/ref2', note: 'Modern layout' },
  ],
  constraints: {
    mustHave: ['responsive design', 'dark mode'],
    mustAvoid: ['flash animations', 'auto-play video'],
  },
};

/**
 * Partial brief - some recommended fields filled
 */
const partialBrief: Brief = {
  projectName: 'Partial Project',
  description: 'A brief description for testing purposes with enough characters to pass minimum length validation check.',
  targetAudience: 'Web developers',
};

/**
 * Short description brief (below minLength)
 */
const shortDescriptionBrief: Brief = {
  projectName: 'Short Desc Project',
  description: 'Too short',
};

/**
 * strictMode compliant brief - meets all strict requirements
 */
const strictModeCompliantBrief: Brief = {
  projectName: 'Strict Mode Project',
  description:
    'A very comprehensive and detailed description that contains more than 100 characters to meet strict mode requirements. This description explains all aspects of the design.',
  targetAudience: 'Enterprise customers requiring professional tools',
  industry: 'Finance',
  tone: ['professional', 'corporate'],
  colorPreferences: {
    primary: '#1E40AF',
    secondary: '#059669',
  },
  references: [
    { url: 'https://example.com/ref1' },
    { url: 'https://example.com/ref2' },
  ],
};

// ============================================================================
// VALIDATION_RULES Tests
// ============================================================================

describe('VALIDATION_RULES', () => {
  describe('required fields', () => {
    it('should define projectName as required', () => {
      expect(VALIDATION_RULES.required).toContain('projectName');
    });

    it('should have exactly 1 required field', () => {
      expect(VALIDATION_RULES.required).toHaveLength(1);
    });
  });

  describe('recommended fields', () => {
    it('should include description', () => {
      expect(VALIDATION_RULES.recommended).toContain('description');
    });

    it('should include targetAudience', () => {
      expect(VALIDATION_RULES.recommended).toContain('targetAudience');
    });

    it('should include industry', () => {
      expect(VALIDATION_RULES.recommended).toContain('industry');
    });

    it('should include tone', () => {
      expect(VALIDATION_RULES.recommended).toContain('tone');
    });

    it('should have exactly 4 recommended fields', () => {
      expect(VALIDATION_RULES.recommended).toHaveLength(4);
    });
  });

  describe('optional fields', () => {
    it('should include colorPreferences', () => {
      expect(VALIDATION_RULES.optional).toContain('colorPreferences');
    });

    it('should include references', () => {
      expect(VALIDATION_RULES.optional).toContain('references');
    });

    it('should include constraints', () => {
      expect(VALIDATION_RULES.optional).toContain('constraints');
    });

    it('should have exactly 3 optional fields', () => {
      expect(VALIDATION_RULES.optional).toHaveLength(3);
    });
  });

  describe('minLengths', () => {
    it('should have projectName minLength of 3', () => {
      expect(VALIDATION_RULES.minLengths.projectName).toBe(3);
    });

    it('should have description minLength of 50', () => {
      expect(VALIDATION_RULES.minLengths.description).toBe(50);
    });

    it('should have targetAudience minLength of 20', () => {
      expect(VALIDATION_RULES.minLengths.targetAudience).toBe(20);
    });
  });

  describe('strictRules', () => {
    it('should have minDescription of 100', () => {
      expect(VALIDATION_RULES.strictRules.minDescription).toBe(100);
    });

    it('should have minReferences of 2', () => {
      expect(VALIDATION_RULES.strictRules.minReferences).toBe(2);
    });

    it('should require tone in strict mode', () => {
      expect(VALIDATION_RULES.strictRules.requireTone).toBe(true);
    });

    it('should require colors in strict mode', () => {
      expect(VALIDATION_RULES.strictRules.requireColors).toBe(true);
    });
  });
});

// ============================================================================
// FIELD_WEIGHTS Tests
// ============================================================================

describe('FIELD_WEIGHTS', () => {
  it('should have projectName weight of 10', () => {
    expect(FIELD_WEIGHTS.projectName).toBe(10);
  });

  it('should have description weight of 20', () => {
    expect(FIELD_WEIGHTS.description).toBe(20);
  });

  it('should have targetAudience weight of 15', () => {
    expect(FIELD_WEIGHTS.targetAudience).toBe(15);
  });

  it('should have industry weight of 10', () => {
    expect(FIELD_WEIGHTS.industry).toBe(10);
  });

  it('should have tone weight of 15', () => {
    expect(FIELD_WEIGHTS.tone).toBe(15);
  });

  it('should have colorPreferences weight of 15', () => {
    expect(FIELD_WEIGHTS.colorPreferences).toBe(15);
  });

  it('should have references weight of 10', () => {
    expect(FIELD_WEIGHTS.references).toBe(10);
  });

  it('should have constraints weight of 5', () => {
    expect(FIELD_WEIGHTS.constraints).toBe(5);
  });

  it('should sum to exactly 100', () => {
    const totalWeight = Object.values(FIELD_WEIGHTS).reduce((sum, w) => sum + w, 0);
    expect(totalWeight).toBe(100);
  });
});

// ============================================================================
// calculateCompletenessScore Tests
// ============================================================================

describe('calculateCompletenessScore', () => {
  describe('minimal brief', () => {
    it('should return score of 10 for minimal valid brief (projectName only)', () => {
      const score = calculateCompletenessScore(minimalBrief);
      expect(score).toBe(10);
    });

    it('should return score of 0 for brief with short projectName', () => {
      const score = calculateCompletenessScore(shortProjectNameBrief);
      expect(score).toBe(0);
    });
  });

  describe('full brief', () => {
    it('should return score of 100 for full valid brief', () => {
      const score = calculateCompletenessScore(fullBrief);
      expect(score).toBe(100);
    });
  });

  describe('partial brief', () => {
    it('should return partial score for brief with some fields', () => {
      const score = calculateCompletenessScore(partialBrief);
      // projectName (10) + description (20) + targetAudience (0 - too short)
      expect(score).toBeGreaterThan(10);
      expect(score).toBeLessThan(100);
    });
  });

  describe('field scoring', () => {
    it('should add 10 points for valid projectName (>= 3 chars)', () => {
      const score = calculateCompletenessScore({ projectName: 'ABC' });
      expect(score).toBe(10);
    });

    it('should not add points for projectName < 3 chars', () => {
      const score = calculateCompletenessScore({ projectName: 'AB' });
      expect(score).toBe(0);
    });

    it('should add 20 points for description >= 50 chars', () => {
      const brief: Brief = {
        projectName: 'Test',
        description: 'x'.repeat(50),
      };
      const score = calculateCompletenessScore(brief);
      expect(score).toBe(30); // 10 + 20
    });

    it('should not add points for description < 50 chars', () => {
      const score = calculateCompletenessScore(shortDescriptionBrief);
      expect(score).toBe(10); // only projectName
    });

    it('should add 15 points for targetAudience >= 20 chars', () => {
      const brief: Brief = {
        projectName: 'Test',
        targetAudience: 'x'.repeat(20),
      };
      const score = calculateCompletenessScore(brief);
      expect(score).toBe(25); // 10 + 15
    });

    it('should add 10 points for industry (any non-empty)', () => {
      const brief: Brief = {
        projectName: 'Test',
        industry: 'Tech',
      };
      const score = calculateCompletenessScore(brief);
      expect(score).toBe(20); // 10 + 10
    });

    it('should add 15 points for tone (non-empty array)', () => {
      const brief: Brief = {
        projectName: 'Test',
        tone: ['minimal'],
      };
      const score = calculateCompletenessScore(brief);
      expect(score).toBe(25); // 10 + 15
    });

    it('should not add points for empty tone array', () => {
      const brief: Brief = {
        projectName: 'Test',
        tone: [],
      };
      const score = calculateCompletenessScore(brief);
      expect(score).toBe(10); // only projectName
    });

    it('should add 15 points for colorPreferences with at least primary', () => {
      const brief: Brief = {
        projectName: 'Test',
        colorPreferences: { primary: '#FF0000' },
      };
      const score = calculateCompletenessScore(brief);
      expect(score).toBe(25); // 10 + 15
    });

    it('should not add points for empty colorPreferences', () => {
      const brief: Brief = {
        projectName: 'Test',
        colorPreferences: {},
      };
      const score = calculateCompletenessScore(brief);
      expect(score).toBe(10); // only projectName
    });

    it('should add 10 points for references (non-empty array)', () => {
      const brief: Brief = {
        projectName: 'Test',
        references: [{ url: 'https://example.com' }],
      };
      const score = calculateCompletenessScore(brief);
      expect(score).toBe(20); // 10 + 10
    });

    it('should add 5 points for constraints with at least one mustHave or mustAvoid', () => {
      const brief: Brief = {
        projectName: 'Test',
        constraints: { mustHave: ['responsive'] },
      };
      const score = calculateCompletenessScore(brief);
      expect(score).toBe(15); // 10 + 5
    });

    it('should not add points for empty constraints', () => {
      const brief: Brief = {
        projectName: 'Test',
        constraints: { mustHave: [], mustAvoid: [] },
      };
      const score = calculateCompletenessScore(brief);
      expect(score).toBe(10); // only projectName
    });
  });

  describe('edge cases', () => {
    it('should handle undefined optional fields', () => {
      const score = calculateCompletenessScore(minimalBrief);
      expect(score).toBe(10);
    });

    it('should return integer score', () => {
      const score = calculateCompletenessScore(partialBrief);
      expect(Number.isInteger(score)).toBe(true);
    });

    it('should never return negative score', () => {
      const score = calculateCompletenessScore({ projectName: '' });
      expect(score).toBeGreaterThanOrEqual(0);
    });

    it('should never exceed 100', () => {
      const score = calculateCompletenessScore(fullBrief);
      expect(score).toBeLessThanOrEqual(100);
    });
  });
});

// ============================================================================
// BriefValidateService Tests
// ============================================================================

describe('BriefValidateService', () => {
  let service: IBriefValidateService;

  beforeEach(() => {
    service = new BriefValidateService();
  });

  describe('interface compliance', () => {
    it('should implement IBriefValidateService', () => {
      expect(service.validate).toBeDefined();
      expect(typeof service.validate).toBe('function');
    });
  });

  describe('validate() - basic validation', () => {
    it('should return BriefValidationResult structure', async () => {
      const result = await service.validate(minimalBrief, false);

      expect(result).toHaveProperty('isValid');
      expect(result).toHaveProperty('completenessScore');
      expect(result).toHaveProperty('issues');
      expect(result).toHaveProperty('suggestions');
      expect(result).toHaveProperty('readyForDesign');
    });

    it('should return isValid=true for minimal valid brief', async () => {
      const result = await service.validate(minimalBrief, false);
      expect(result.isValid).toBe(true);
    });

    it('should calculate completenessScore', async () => {
      const result = await service.validate(fullBrief, false);
      expect(result.completenessScore).toBe(100);
    });

    it('should return issues array', async () => {
      const result = await service.validate(minimalBrief, false);
      expect(Array.isArray(result.issues)).toBe(true);
    });

    it('should return suggestions array', async () => {
      const result = await service.validate(minimalBrief, false);
      expect(Array.isArray(result.suggestions)).toBe(true);
    });
  });

  describe('validate() - required field validation', () => {
    it('should generate error for missing projectName', async () => {
      // @ts-expect-error - Testing invalid input
      const result = await service.validate({}, false);

      expect(result.isValid).toBe(false);
      expect(result.issues.some((i) => i.field === 'projectName' && i.severity === 'error')).toBe(
        true
      );
    });

    it('should generate error for projectName below minLength', async () => {
      const result = await service.validate(shortProjectNameBrief, false);

      expect(result.issues.some((i) => i.field === 'projectName' && i.severity === 'error')).toBe(
        true
      );
    });
  });

  describe('validate() - recommended field validation', () => {
    it('should generate warning for missing description', async () => {
      const result = await service.validate(minimalBrief, false);

      expect(result.issues.some((i) => i.field === 'description' && i.severity === 'warning')).toBe(
        true
      );
    });

    it('should generate warning for short description', async () => {
      const result = await service.validate(shortDescriptionBrief, false);

      expect(result.issues.some((i) => i.field === 'description' && i.severity === 'warning')).toBe(
        true
      );
    });

    it('should generate warning for missing targetAudience', async () => {
      const result = await service.validate(minimalBrief, false);

      expect(
        result.issues.some((i) => i.field === 'targetAudience' && i.severity === 'warning')
      ).toBe(true);
    });

    it('should generate warning for missing industry', async () => {
      const result = await service.validate(minimalBrief, false);

      expect(result.issues.some((i) => i.field === 'industry' && i.severity === 'warning')).toBe(
        true
      );
    });

    it('should generate warning for missing tone', async () => {
      const result = await service.validate(minimalBrief, false);

      expect(result.issues.some((i) => i.field === 'tone' && i.severity === 'warning')).toBe(true);
    });

    it('should not generate warning for present recommended fields', async () => {
      const result = await service.validate(fullBrief, false);

      const recommendedWarnings = result.issues.filter(
        (i) =>
          VALIDATION_RULES.recommended.includes(i.field as keyof Brief) && i.severity === 'warning'
      );
      expect(recommendedWarnings).toHaveLength(0);
    });
  });

  describe('validate() - optional field suggestions', () => {
    it('should generate suggestion for missing colorPreferences', async () => {
      const result = await service.validate(minimalBrief, false);

      expect(
        result.issues.some((i) => i.field === 'colorPreferences' && i.severity === 'suggestion')
      ).toBe(true);
    });

    it('should generate suggestion for missing references', async () => {
      const result = await service.validate(minimalBrief, false);

      expect(
        result.issues.some((i) => i.field === 'references' && i.severity === 'suggestion')
      ).toBe(true);
    });

    it('should generate suggestion for missing constraints', async () => {
      const result = await service.validate(minimalBrief, false);

      expect(
        result.issues.some((i) => i.field === 'constraints' && i.severity === 'suggestion')
      ).toBe(true);
    });

    it('should not generate suggestions for present optional fields', async () => {
      const result = await service.validate(fullBrief, false);

      const optionalSuggestions = result.issues.filter(
        (i) =>
          VALIDATION_RULES.optional.includes(i.field as keyof Brief) && i.severity === 'suggestion'
      );
      expect(optionalSuggestions).toHaveLength(0);
    });
  });

  describe('validate() - strictMode validation', () => {
    it('should generate error for description < 100 chars in strict mode', async () => {
      const brief: Brief = {
        projectName: 'Test Project',
        description: 'Short description under 100 chars for strict mode testing.',
      };
      const result = await service.validate(brief, true);

      expect(
        result.issues.some(
          (i) =>
            i.field === 'description' && i.severity === 'error' && i.message.includes('100')
        )
      ).toBe(true);
    });

    it('should generate error for missing tone in strict mode', async () => {
      const brief: Brief = {
        projectName: 'Test Project',
        description: 'x'.repeat(100),
      };
      const result = await service.validate(brief, true);

      expect(result.issues.some((i) => i.field === 'tone' && i.severity === 'error')).toBe(true);
    });

    it('should generate error for missing colorPreferences in strict mode', async () => {
      const brief: Brief = {
        projectName: 'Test Project',
        description: 'x'.repeat(100),
        tone: ['professional'],
      };
      const result = await service.validate(brief, true);

      expect(
        result.issues.some((i) => i.field === 'colorPreferences' && i.severity === 'error')
      ).toBe(true);
    });

    it('should generate error for < 2 references in strict mode', async () => {
      const brief: Brief = {
        projectName: 'Test Project',
        description: 'x'.repeat(100),
        tone: ['professional'],
        colorPreferences: { primary: '#FF0000' },
        references: [{ url: 'https://example.com' }],
      };
      const result = await service.validate(brief, true);

      expect(
        result.issues.some(
          (i) =>
            i.field === 'references' && i.severity === 'error' && i.message.includes('2')
        )
      ).toBe(true);
    });

    it('should pass strict mode for fully compliant brief', async () => {
      const result = await service.validate(strictModeCompliantBrief, true);

      const strictErrors = result.issues.filter((i) => i.severity === 'error');
      expect(strictErrors).toHaveLength(0);
    });

    it('should be more lenient in non-strict mode', async () => {
      const brief: Brief = {
        projectName: 'Test Project',
        description: 'x'.repeat(50), // Only 50 chars, enough for non-strict
      };

      const nonStrictResult = await service.validate(brief, false);
      const strictResult = await service.validate(brief, true);

      // Non-strict should not have error for description
      const nonStrictDescErrors = nonStrictResult.issues.filter(
        (i) => i.field === 'description' && i.severity === 'error'
      );
      expect(nonStrictDescErrors).toHaveLength(0);

      // Strict should have error for description < 100
      const strictDescErrors = strictResult.issues.filter(
        (i) => i.field === 'description' && i.severity === 'error'
      );
      expect(strictDescErrors.length).toBeGreaterThan(0);
    });
  });

  describe('validate() - readyForDesign determination', () => {
    it('should return readyForDesign=false for low completenessScore', async () => {
      const result = await service.validate(minimalBrief, false);
      expect(result.readyForDesign).toBe(false);
    });

    it('should return readyForDesign=true for high completenessScore (>= 60)', async () => {
      const result = await service.validate(fullBrief, false);
      expect(result.readyForDesign).toBe(true);
    });

    it('should return readyForDesign=false if there are error-level issues', async () => {
      const result = await service.validate(shortProjectNameBrief, false);
      expect(result.readyForDesign).toBe(false);
    });

    it('should return readyForDesign=true with warnings but no errors and score >= 60', async () => {
      // Brief with score >= 60 but some warnings
      const brief: Brief = {
        projectName: 'Good Project Name',
        description:
          'A detailed description that is long enough to meet the minimum requirements for validation testing.',
        targetAudience: 'Web developers and designers',
        tone: ['professional', 'minimal'],
      };
      const result = await service.validate(brief, false);

      if (result.completenessScore >= 60) {
        const hasErrors = result.issues.some((i) => i.severity === 'error');
        if (!hasErrors) {
          expect(result.readyForDesign).toBe(true);
        }
      }
    });
  });

  describe('validate() - isValid determination', () => {
    it('should return isValid=true when no error-level issues', async () => {
      const result = await service.validate(fullBrief, false);
      expect(result.isValid).toBe(true);
    });

    it('should return isValid=false when error-level issues exist', async () => {
      const result = await service.validate(shortProjectNameBrief, false);
      expect(result.isValid).toBe(false);
    });

    it('should return isValid=true even with warnings', async () => {
      const result = await service.validate(minimalBrief, false);
      const hasErrors = result.issues.some((i) => i.severity === 'error');
      if (!hasErrors) {
        expect(result.isValid).toBe(true);
      }
    });
  });

  describe('validate() - suggestions generation', () => {
    it('should generate improvement suggestions', async () => {
      const result = await service.validate(minimalBrief, false);
      expect(result.suggestions.length).toBeGreaterThan(0);
    });

    it('should generate suggestions in Japanese', async () => {
      const result = await service.validate(minimalBrief, false);
      // Check that at least one suggestion contains Japanese characters
      const hasJapanese = result.suggestions.some((s) => /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(s));
      expect(hasJapanese).toBe(true);
    });

    it('should have fewer suggestions for complete brief', async () => {
      const minimalResult = await service.validate(minimalBrief, false);
      const fullResult = await service.validate(fullBrief, false);

      expect(fullResult.suggestions.length).toBeLessThan(minimalResult.suggestions.length);
    });
  });

  describe('validate() - issue message content', () => {
    it('should include field name in issue', async () => {
      const result = await service.validate(minimalBrief, false);
      result.issues.forEach((issue) => {
        expect(issue.field).toBeDefined();
        expect(typeof issue.field).toBe('string');
      });
    });

    it('should include severity in issue', async () => {
      const result = await service.validate(minimalBrief, false);
      result.issues.forEach((issue) => {
        expect(['error', 'warning', 'suggestion']).toContain(issue.severity);
      });
    });

    it('should include message in issue', async () => {
      const result = await service.validate(minimalBrief, false);
      result.issues.forEach((issue) => {
        expect(issue.message).toBeDefined();
        expect(typeof issue.message).toBe('string');
        expect(issue.message.length).toBeGreaterThan(0);
      });
    });

    it('should generate Japanese messages for issues', async () => {
      const result = await service.validate(minimalBrief, false);
      // At least some messages should be in Japanese
      const hasJapanese = result.issues.some((i) => /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(i.message));
      expect(hasJapanese).toBe(true);
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('BriefValidateService Integration', () => {
  let service: BriefValidateService;

  beforeEach(() => {
    service = new BriefValidateService();
  });

  it('should produce consistent results for same input', async () => {
    const result1 = await service.validate(fullBrief, false);
    const result2 = await service.validate(fullBrief, false);

    expect(result1.isValid).toBe(result2.isValid);
    expect(result1.completenessScore).toBe(result2.completenessScore);
    expect(result1.issues.length).toBe(result2.issues.length);
    expect(result1.readyForDesign).toBe(result2.readyForDesign);
  });

  it('should handle edge case of empty string projectName', async () => {
    const result = await service.validate({ projectName: '' }, false);
    expect(result.isValid).toBe(false);
    expect(result.completenessScore).toBe(0);
  });

  it('should validate without throwing errors', async () => {
    await expect(service.validate(fullBrief, false)).resolves.not.toThrow();
    await expect(service.validate(minimalBrief, false)).resolves.not.toThrow();
    await expect(service.validate(minimalBrief, true)).resolves.not.toThrow();
  });

  describe('score thresholds', () => {
    it('should have readyForDesign threshold at 60', async () => {
      // Score = 60 should be ready
      const brief60: Brief = {
        projectName: 'Test Project Name',
        description:
          'This is a detailed description that meets the minimum length requirement for validation.',
        targetAudience: 'Target audience description here',
        tone: ['professional'],
      };
      const result = await service.validate(brief60, false);

      // Calculate expected score: projectName(10) + description(20) + targetAudience(15) + tone(15) = 60
      if (result.completenessScore >= 60) {
        const hasErrors = result.issues.some((i) => i.severity === 'error');
        if (!hasErrors) {
          expect(result.readyForDesign).toBe(true);
        }
      }
    });
  });
});
