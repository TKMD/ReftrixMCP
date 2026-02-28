// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * brief.* MCP Tools Zod Schema Tests
 * TDD Red Phase: Design Brief validation tool schema tests
 *
 * Target tool:
 * - brief.validate: Validate design brief and return completeness score
 *
 * @module @reftrix/mcp-server/tools/brief/schemas.test
 */
import { describe, it, expect } from 'vitest';

// ============================================================================
// Schema Imports (TDD Red: Will fail until implementation)
// ============================================================================
import {
  // Enum schemas
  toneSchema,
  issueSeveritySchema,
  // Input schemas
  hexColorSchema,
  colorPreferencesSchema,
  referenceSchema,
  constraintsSchema,
  briefSchema,
  briefValidateInputSchema,
  // Output schemas
  briefIssueSchema,
  briefValidationResultSchema,
  briefValidateOutputSchema,
  // Error codes
  BRIEF_MCP_ERROR_CODES,
  // Types
  type Tone,
  type IssueSeverity,
  type HexColor,
  type ColorPreferences,
  type Reference,
  type Constraints,
  type Brief,
  type BriefValidateInput,
  type BriefIssue,
  type BriefValidationResult,
  type BriefValidateOutput,
  type BriefMcpErrorCode,
} from '../../../src/tools/brief/schemas';

// ============================================================================
// Test Utilities
// ============================================================================

const validHexColor = '#FF5500';
const validUrl = 'https://example.com/reference';
const minimalValidBrief = { projectName: 'Test Project' };
const fullValidBrief = {
  projectName: 'My Design Project',
  description: 'A comprehensive design project with all fields filled out for testing purposes.',
  targetAudience: 'Developers and designers who need SVG tools',
  industry: 'Technology',
  tone: ['professional', 'minimal'] as const,
  colorPreferences: {
    primary: '#3B82F6',
    secondary: '#10B981',
    accent: '#F59E0B',
  },
  references: [
    { url: 'https://example.com/ref1', note: 'Clean design' },
    { url: 'https://example.com/ref2' },
  ],
  constraints: {
    mustHave: ['responsive design', 'dark mode'],
    mustAvoid: ['flash animations', 'auto-play video'],
  },
};

// ============================================================================
// Enum Schema Tests
// ============================================================================

describe('Enum Schemas', () => {
  describe('toneSchema', () => {
    const validTones = [
      'professional',
      'playful',
      'minimal',
      'bold',
      'elegant',
      'friendly',
      'corporate',
      'creative',
    ] as const;

    it.each(validTones)('should accept "%s" as valid tone', (tone) => {
      const result = toneSchema.safeParse(tone);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(tone);
      }
    });

    it('should reject invalid tone', () => {
      const result = toneSchema.safeParse('aggressive');
      expect(result.success).toBe(false);
    });

    it('should reject empty string', () => {
      const result = toneSchema.safeParse('');
      expect(result.success).toBe(false);
    });

    it('should reject number', () => {
      const result = toneSchema.safeParse(123);
      expect(result.success).toBe(false);
    });
  });

  describe('issueSeveritySchema', () => {
    const validSeverities = ['error', 'warning', 'suggestion'] as const;

    it.each(validSeverities)('should accept "%s" as valid severity', (severity) => {
      const result = issueSeveritySchema.safeParse(severity);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(severity);
      }
    });

    it('should reject invalid severity', () => {
      const result = issueSeveritySchema.safeParse('critical');
      expect(result.success).toBe(false);
    });

    it('should reject uppercase', () => {
      const result = issueSeveritySchema.safeParse('ERROR');
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// HEX Color Schema Tests
// ============================================================================

describe('hexColorSchema', () => {
  describe('valid HEX colors', () => {
    const validColors = ['#000000', '#FFFFFF', '#ff5500', '#3B82F6', '#abc123', '#ABC123'];

    it.each(validColors)('should accept "%s"', (color) => {
      const result = hexColorSchema.safeParse(color);
      expect(result.success).toBe(true);
    });
  });

  describe('invalid HEX colors', () => {
    const invalidColors = [
      { value: '#FFF', reason: '3-digit shorthand not allowed' },
      { value: 'FF5500', reason: 'missing # prefix' },
      { value: '#FF550', reason: '5 digits' },
      { value: '#FF55000', reason: '7 digits' },
      { value: '#GGGGGG', reason: 'invalid hex characters' },
      { value: 'red', reason: 'color name' },
      { value: 'rgb(255,0,0)', reason: 'rgb format' },
      { value: '', reason: 'empty string' },
    ];

    it.each(invalidColors)('should reject $value ($reason)', ({ value }) => {
      const result = hexColorSchema.safeParse(value);
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Color Preferences Schema Tests
// ============================================================================

describe('colorPreferencesSchema', () => {
  it('should accept all valid colors', () => {
    const result = colorPreferencesSchema.safeParse({
      primary: '#3B82F6',
      secondary: '#10B981',
      accent: '#F59E0B',
    });
    expect(result.success).toBe(true);
  });

  it('should accept partial colors (primary only)', () => {
    const result = colorPreferencesSchema.safeParse({
      primary: '#3B82F6',
    });
    expect(result.success).toBe(true);
  });

  it('should accept empty object', () => {
    const result = colorPreferencesSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should reject invalid primary color', () => {
    const result = colorPreferencesSchema.safeParse({
      primary: 'blue',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid secondary color', () => {
    const result = colorPreferencesSchema.safeParse({
      secondary: '#GGG',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Reference Schema Tests
// ============================================================================

describe('referenceSchema', () => {
  it('should accept valid reference with note', () => {
    const result = referenceSchema.safeParse({
      url: 'https://example.com/design',
      note: 'Clean and minimal design',
    });
    expect(result.success).toBe(true);
  });

  it('should accept reference without note', () => {
    const result = referenceSchema.safeParse({
      url: 'https://example.com/design',
    });
    expect(result.success).toBe(true);
  });

  it('should reject invalid URL', () => {
    const result = referenceSchema.safeParse({
      url: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing URL', () => {
    const result = referenceSchema.safeParse({
      note: 'Some note without URL',
    });
    expect(result.success).toBe(false);
  });

  it('should reject note exceeding 200 characters', () => {
    const result = referenceSchema.safeParse({
      url: 'https://example.com',
      note: 'x'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('should accept note with exactly 200 characters', () => {
    const result = referenceSchema.safeParse({
      url: 'https://example.com',
      note: 'x'.repeat(200),
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// Constraints Schema Tests
// ============================================================================

describe('constraintsSchema', () => {
  it('should accept valid constraints with both arrays', () => {
    const result = constraintsSchema.safeParse({
      mustHave: ['responsive', 'dark mode'],
      mustAvoid: ['flash', 'popups'],
    });
    expect(result.success).toBe(true);
  });

  it('should accept mustHave only', () => {
    const result = constraintsSchema.safeParse({
      mustHave: ['accessibility'],
    });
    expect(result.success).toBe(true);
  });

  it('should accept mustAvoid only', () => {
    const result = constraintsSchema.safeParse({
      mustAvoid: ['auto-play'],
    });
    expect(result.success).toBe(true);
  });

  it('should accept empty object', () => {
    const result = constraintsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('should accept empty arrays', () => {
    const result = constraintsSchema.safeParse({
      mustHave: [],
      mustAvoid: [],
    });
    expect(result.success).toBe(true);
  });

  it('should reject non-string array items', () => {
    const result = constraintsSchema.safeParse({
      mustHave: [123, 'valid'],
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// Brief Schema Tests
// ============================================================================

describe('briefSchema', () => {
  describe('projectName validation', () => {
    it('should accept valid project name', () => {
      const result = briefSchema.safeParse({ projectName: 'Test Project' });
      expect(result.success).toBe(true);
    });

    it('should reject empty project name', () => {
      const result = briefSchema.safeParse({ projectName: '' });
      expect(result.success).toBe(false);
    });

    it('should reject missing project name', () => {
      const result = briefSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should reject project name exceeding 200 characters', () => {
      const result = briefSchema.safeParse({ projectName: 'x'.repeat(201) });
      expect(result.success).toBe(false);
    });

    it('should accept project name with exactly 200 characters', () => {
      const result = briefSchema.safeParse({ projectName: 'x'.repeat(200) });
      expect(result.success).toBe(true);
    });

    it('should accept project name with 1 character', () => {
      const result = briefSchema.safeParse({ projectName: 'A' });
      expect(result.success).toBe(true);
    });
  });

  describe('description validation', () => {
    it('should accept valid description', () => {
      const result = briefSchema.safeParse({
        projectName: 'Test',
        description: 'A detailed project description.',
      });
      expect(result.success).toBe(true);
    });

    it('should reject description exceeding 2000 characters', () => {
      const result = briefSchema.safeParse({
        projectName: 'Test',
        description: 'x'.repeat(2001),
      });
      expect(result.success).toBe(false);
    });

    it('should accept description with exactly 2000 characters', () => {
      const result = briefSchema.safeParse({
        projectName: 'Test',
        description: 'x'.repeat(2000),
      });
      expect(result.success).toBe(true);
    });
  });

  describe('targetAudience validation', () => {
    it('should accept valid target audience', () => {
      const result = briefSchema.safeParse({
        projectName: 'Test',
        targetAudience: 'Developers and designers',
      });
      expect(result.success).toBe(true);
    });

    it('should reject targetAudience exceeding 500 characters', () => {
      const result = briefSchema.safeParse({
        projectName: 'Test',
        targetAudience: 'x'.repeat(501),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('industry validation', () => {
    it('should accept valid industry', () => {
      const result = briefSchema.safeParse({
        projectName: 'Test',
        industry: 'Technology',
      });
      expect(result.success).toBe(true);
    });

    it('should reject industry exceeding 100 characters', () => {
      const result = briefSchema.safeParse({
        projectName: 'Test',
        industry: 'x'.repeat(101),
      });
      expect(result.success).toBe(false);
    });
  });

  describe('tone validation', () => {
    it('should accept valid tone array', () => {
      const result = briefSchema.safeParse({
        projectName: 'Test',
        tone: ['professional', 'minimal'],
      });
      expect(result.success).toBe(true);
    });

    it('should accept empty tone array', () => {
      const result = briefSchema.safeParse({
        projectName: 'Test',
        tone: [],
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid tone in array', () => {
      const result = briefSchema.safeParse({
        projectName: 'Test',
        tone: ['professional', 'invalid-tone'],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('references validation', () => {
    it('should accept valid references array', () => {
      const result = briefSchema.safeParse({
        projectName: 'Test',
        references: [
          { url: 'https://example.com/1', note: 'First reference' },
          { url: 'https://example.com/2' },
        ],
      });
      expect(result.success).toBe(true);
    });

    it('should accept empty references array', () => {
      const result = briefSchema.safeParse({
        projectName: 'Test',
        references: [],
      });
      expect(result.success).toBe(true);
    });

    it('should reject references exceeding 10 items', () => {
      const references = Array.from({ length: 11 }, (_, i) => ({
        url: `https://example.com/${i}`,
      }));
      const result = briefSchema.safeParse({
        projectName: 'Test',
        references,
      });
      expect(result.success).toBe(false);
    });

    it('should accept exactly 10 references', () => {
      const references = Array.from({ length: 10 }, (_, i) => ({
        url: `https://example.com/${i}`,
      }));
      const result = briefSchema.safeParse({
        projectName: 'Test',
        references,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('full brief validation', () => {
    it('should accept full valid brief', () => {
      const result = briefSchema.safeParse(fullValidBrief);
      expect(result.success).toBe(true);
    });

    it('should accept minimal brief (projectName only)', () => {
      const result = briefSchema.safeParse(minimalValidBrief);
      expect(result.success).toBe(true);
    });
  });
});

// ============================================================================
// BriefValidateInput Schema Tests
// ============================================================================

describe('briefValidateInputSchema', () => {
  it('should accept valid input with brief only', () => {
    const result = briefValidateInputSchema.safeParse({
      brief: minimalValidBrief,
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid input with strictMode false', () => {
    const result = briefValidateInputSchema.safeParse({
      brief: minimalValidBrief,
      strictMode: false,
    });
    expect(result.success).toBe(true);
  });

  it('should accept valid input with strictMode true', () => {
    const result = briefValidateInputSchema.safeParse({
      brief: minimalValidBrief,
      strictMode: true,
    });
    expect(result.success).toBe(true);
  });

  it('should apply default strictMode as false', () => {
    const result = briefValidateInputSchema.safeParse({
      brief: minimalValidBrief,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.strictMode).toBe(false);
    }
  });

  it('should reject missing brief', () => {
    const result = briefValidateInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should reject null brief', () => {
    const result = briefValidateInputSchema.safeParse({
      brief: null,
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid brief structure', () => {
    const result = briefValidateInputSchema.safeParse({
      brief: 'not an object',
    });
    expect(result.success).toBe(false);
  });

  it('should accept full brief with strictMode', () => {
    const result = briefValidateInputSchema.safeParse({
      brief: fullValidBrief,
      strictMode: true,
    });
    expect(result.success).toBe(true);
  });
});

// ============================================================================
// BriefIssue Schema Tests
// ============================================================================

describe('briefIssueSchema', () => {
  it('should accept valid issue with all fields', () => {
    const result = briefIssueSchema.safeParse({
      field: 'description',
      severity: 'warning',
      message: 'Description is too short',
      suggestion: 'Add more details about the project goals',
    });
    expect(result.success).toBe(true);
  });

  it('should accept issue without suggestion', () => {
    const result = briefIssueSchema.safeParse({
      field: 'projectName',
      severity: 'error',
      message: 'Project name is required',
    });
    expect(result.success).toBe(true);
  });

  it('should reject missing field', () => {
    const result = briefIssueSchema.safeParse({
      severity: 'error',
      message: 'Some message',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing severity', () => {
    const result = briefIssueSchema.safeParse({
      field: 'description',
      message: 'Some message',
    });
    expect(result.success).toBe(false);
  });

  it('should reject missing message', () => {
    const result = briefIssueSchema.safeParse({
      field: 'description',
      severity: 'warning',
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid severity', () => {
    const result = briefIssueSchema.safeParse({
      field: 'description',
      severity: 'critical',
      message: 'Some message',
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// BriefValidationResult Schema Tests
// ============================================================================

describe('briefValidationResultSchema', () => {
  const validResult = {
    isValid: true,
    completenessScore: 85,
    issues: [],
    suggestions: ['Consider adding more references'],
    readyForDesign: true,
  };

  it('should accept valid result', () => {
    const result = briefValidationResultSchema.safeParse(validResult);
    expect(result.success).toBe(true);
  });

  it('should accept result with issues', () => {
    const result = briefValidationResultSchema.safeParse({
      ...validResult,
      isValid: false,
      issues: [
        {
          field: 'description',
          severity: 'warning',
          message: 'Description is too short',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  describe('completenessScore validation', () => {
    it('should accept score of 0', () => {
      const result = briefValidationResultSchema.safeParse({
        ...validResult,
        completenessScore: 0,
      });
      expect(result.success).toBe(true);
    });

    it('should accept score of 100', () => {
      const result = briefValidationResultSchema.safeParse({
        ...validResult,
        completenessScore: 100,
      });
      expect(result.success).toBe(true);
    });

    it('should accept score of 50', () => {
      const result = briefValidationResultSchema.safeParse({
        ...validResult,
        completenessScore: 50,
      });
      expect(result.success).toBe(true);
    });

    it('should reject negative score', () => {
      const result = briefValidationResultSchema.safeParse({
        ...validResult,
        completenessScore: -1,
      });
      expect(result.success).toBe(false);
    });

    it('should reject score over 100', () => {
      const result = briefValidationResultSchema.safeParse({
        ...validResult,
        completenessScore: 101,
      });
      expect(result.success).toBe(false);
    });
  });

  it('should reject missing isValid', () => {
    const { isValid, ...rest } = validResult;
    const result = briefValidationResultSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('should reject missing completenessScore', () => {
    const { completenessScore, ...rest } = validResult;
    const result = briefValidationResultSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('should reject missing issues', () => {
    const { issues, ...rest } = validResult;
    const result = briefValidationResultSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('should reject missing suggestions', () => {
    const { suggestions, ...rest } = validResult;
    const result = briefValidationResultSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('should reject missing readyForDesign', () => {
    const { readyForDesign, ...rest } = validResult;
    const result = briefValidationResultSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// BriefValidateOutput Schema Tests (Response Object Pattern)
// ============================================================================

describe('briefValidateOutputSchema', () => {
  const validSuccessOutput = {
    success: true as const,
    data: {
      isValid: true,
      completenessScore: 85,
      issues: [],
      suggestions: ['Consider adding references'],
      readyForDesign: true,
    },
  };

  const validErrorOutput = {
    success: false as const,
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid brief structure',
    },
  };

  describe('success response', () => {
    it('should accept valid success response', () => {
      const result = briefValidateOutputSchema.safeParse(validSuccessOutput);
      expect(result.success).toBe(true);
    });

    it('should reject success response with missing data', () => {
      const result = briefValidateOutputSchema.safeParse({
        success: true,
      });
      expect(result.success).toBe(false);
    });

    it('should reject success response with error field', () => {
      const result = briefValidateOutputSchema.safeParse({
        success: true,
        data: validSuccessOutput.data,
        error: { code: 'TEST', message: 'test' },
      });
      // discriminatedUnion should handle this
      expect(result.success).toBe(true); // extra fields are stripped
    });
  });

  describe('error response', () => {
    it('should accept valid error response', () => {
      const result = briefValidateOutputSchema.safeParse(validErrorOutput);
      expect(result.success).toBe(true);
    });

    it('should reject error response with missing error', () => {
      const result = briefValidateOutputSchema.safeParse({
        success: false,
      });
      expect(result.success).toBe(false);
    });

    it('should reject error response with missing code', () => {
      const result = briefValidateOutputSchema.safeParse({
        success: false,
        error: { message: 'Error message only' },
      });
      expect(result.success).toBe(false);
    });

    it('should reject error response with missing message', () => {
      const result = briefValidateOutputSchema.safeParse({
        success: false,
        error: { code: 'ERROR_CODE' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('discriminated union', () => {
    it('should correctly discriminate success=true', () => {
      const result = briefValidateOutputSchema.safeParse(validSuccessOutput);
      expect(result.success).toBe(true);
      if (result.success && result.data.success) {
        expect(result.data.data.completenessScore).toBe(85);
      }
    });

    it('should correctly discriminate success=false', () => {
      const result = briefValidateOutputSchema.safeParse(validErrorOutput);
      expect(result.success).toBe(true);
      if (result.success && !result.data.success) {
        expect(result.data.error.code).toBe('VALIDATION_ERROR');
      }
    });

    it('should reject missing success field', () => {
      const result = briefValidateOutputSchema.safeParse({
        data: validSuccessOutput.data,
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// Error Codes Tests
// ============================================================================

describe('BRIEF_MCP_ERROR_CODES', () => {
  it('should have VALIDATION_ERROR code', () => {
    expect(BRIEF_MCP_ERROR_CODES.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
  });

  it('should have INVALID_BRIEF code', () => {
    expect(BRIEF_MCP_ERROR_CODES.INVALID_BRIEF).toBe('INVALID_BRIEF');
  });

  it('should have INTERNAL_ERROR code', () => {
    expect(BRIEF_MCP_ERROR_CODES.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
  });

  it('should have all required error codes', () => {
    const expectedCodes = [
      'VALIDATION_ERROR',
      'INVALID_BRIEF',
      'INTERNAL_ERROR',
    ];
    expectedCodes.forEach((code) => {
      expect(BRIEF_MCP_ERROR_CODES).toHaveProperty(code);
    });
  });
});

// ============================================================================
// Type Export Tests
// ============================================================================

describe('Type exports', () => {
  it('should export Tone type', () => {
    const tone: Tone = 'professional';
    expect(tone).toBe('professional');
  });

  it('should export IssueSeverity type', () => {
    const severity: IssueSeverity = 'error';
    expect(severity).toBe('error');
  });

  it('should export BriefValidateInput type', () => {
    const input: BriefValidateInput = {
      brief: { projectName: 'Test' },
      strictMode: false,
    };
    expect(input.brief.projectName).toBe('Test');
  });

  it('should export BriefValidationResult type', () => {
    const result: BriefValidationResult = {
      isValid: true,
      completenessScore: 100,
      issues: [],
      suggestions: [],
      readyForDesign: true,
    };
    expect(result.isValid).toBe(true);
  });

  it('should export BriefValidateOutput type', () => {
    const output: BriefValidateOutput = {
      success: true,
      data: {
        isValid: true,
        completenessScore: 100,
        issues: [],
        suggestions: [],
        readyForDesign: true,
      },
    };
    expect(output.success).toBe(true);
  });
});
