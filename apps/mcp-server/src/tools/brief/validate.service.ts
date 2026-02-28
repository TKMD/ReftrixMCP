// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * brief.validate Service Implementation
 * Design brief validation service with completeness score calculation
 *
 * @module @reftrix/mcp-server/tools/brief/validate.service
 */
import type { Brief, BriefIssue, BriefValidationResult, IssueSeverity } from './schemas';

// ============================================================================
// Validation Rules
// ============================================================================

/**
 * Brief validation rules
 * Defines required, recommended, and optional fields with their constraints
 */
export const VALIDATION_RULES = {
  /** Required fields - error level if missing/invalid */
  required: ['projectName'] as const,

  /** Recommended fields - warning level if missing */
  recommended: ['description', 'targetAudience', 'industry', 'tone'] as const,

  /** Optional fields - suggestion level if missing */
  optional: ['colorPreferences', 'references', 'constraints'] as const,

  /** Minimum lengths for string fields */
  minLengths: {
    projectName: 3,
    description: 50,
    targetAudience: 20,
  } as const,

  /** Strict mode additional rules */
  strictRules: {
    minDescription: 100,
    minReferences: 2,
    requireTone: true,
    requireColors: true,
  } as const,
} as const;

// ============================================================================
// Field Weights for Score Calculation
// ============================================================================

/**
 * Weights for each field in completeness score calculation
 * Total must equal 100
 */
export const FIELD_WEIGHTS = {
  projectName: 10,
  description: 20,
  targetAudience: 15,
  industry: 10,
  tone: 15,
  colorPreferences: 15,
  references: 10,
  constraints: 5,
} as const;

// ============================================================================
// Service Interface
// ============================================================================

/**
 * Brief validation service interface
 * Implements Dependency Injection pattern for testability
 */
export interface IBriefValidateService {
  /**
   * Validate a design brief
   * @param brief - Design brief to validate
   * @param strictMode - Enable strict validation rules
   * @returns Promise<BriefValidationResult> - Validation result
   */
  validate(brief: Brief, strictMode: boolean): Promise<BriefValidationResult>;
}

// ============================================================================
// Japanese Messages
// ============================================================================

const MESSAGES = {
  // Required field errors
  projectNameRequired: 'プロジェクト名は必須です',
  projectNameTooShort: (min: number) => `プロジェクト名は${min}文字以上で入力してください`,

  // Recommended field warnings
  descriptionMissing: 'プロジェクトの説明を追加することを推奨します',
  descriptionTooShort: (min: number) => `説明は${min}文字以上にすることを推奨します`,
  targetAudienceMissing: 'ターゲットオーディエンスを定義することを推奨します',
  targetAudienceTooShort: (min: number) =>
    `ターゲットオーディエンスは${min}文字以上で記述することを推奨します`,
  industryMissing: '業界・分野を指定することを推奨します',
  toneMissing: 'デザインのトーン・雰囲気を指定することを推奨します',

  // Optional field suggestions
  colorPreferencesSuggestion: 'ブランドカラーを設定すると、より一貫性のあるデザインが可能になります',
  referencesSuggestion: '参考サイトを追加すると、デザインの方向性がより明確になります',
  constraintsSuggestion: '制約条件を追加すると、より適切なデザイン提案が可能になります',

  // Strict mode errors
  strictDescriptionTooShort: (min: number) =>
    `厳格モード: 説明は${min}文字以上で入力してください`,
  strictToneRequired: '厳格モード: トーン・雰囲気の指定は必須です',
  strictColorsRequired: '厳格モード: カラー設定は必須です',
  strictReferencesInsufficient: (min: number) =>
    `厳格モード: 参考サイトは${min}件以上必要です`,

  // Suggestions
  suggestionAddDescription: '詳細な説明を追加して、デザインの目的を明確にしましょう',
  suggestionAddTargetAudience: 'ターゲットオーディエンスを定義して、適切なデザインを導きましょう',
  suggestionAddIndustry: '業界・分野を指定して、コンテキストに合ったデザインを実現しましょう',
  suggestionAddTone: 'トーン・雰囲気を選択して、デザインの一貫性を高めましょう',
  suggestionAddColors: 'ブランドカラーを設定して、視覚的な統一感を出しましょう',
  suggestionAddReferences: '参考サイトを追加して、デザインの方向性を明確にしましょう',
  suggestionAddConstraints: '制約条件を設定して、より的確なデザイン提案を受けましょう',
  suggestionMoreDescription: '説明をより詳細にして、プロジェクトの全体像を伝えましょう',
  suggestionMoreReferences: '参考サイトを増やして、より多くのインスピレーションを得ましょう',
} as const;

// ============================================================================
// Pure Functions
// ============================================================================

/**
 * Calculate completeness score for a brief
 * Pure function - no side effects
 *
 * @param brief - Design brief to score
 * @returns number - Score from 0 to 100
 */
export function calculateCompletenessScore(brief: Brief): number {
  let score = 0;

  // projectName: 10 points if >= 3 chars
  if (brief.projectName && brief.projectName.length >= VALIDATION_RULES.minLengths.projectName) {
    score += FIELD_WEIGHTS.projectName;
  }

  // description: 20 points if >= 50 chars
  if (brief.description && brief.description.length >= VALIDATION_RULES.minLengths.description) {
    score += FIELD_WEIGHTS.description;
  }

  // targetAudience: 15 points if >= 20 chars
  if (
    brief.targetAudience &&
    brief.targetAudience.length >= VALIDATION_RULES.minLengths.targetAudience
  ) {
    score += FIELD_WEIGHTS.targetAudience;
  }

  // industry: 10 points if non-empty
  if (brief.industry && brief.industry.length > 0) {
    score += FIELD_WEIGHTS.industry;
  }

  // tone: 15 points if non-empty array
  if (brief.tone && brief.tone.length > 0) {
    score += FIELD_WEIGHTS.tone;
  }

  // colorPreferences: 15 points if has at least primary
  if (brief.colorPreferences && brief.colorPreferences.primary) {
    score += FIELD_WEIGHTS.colorPreferences;
  }

  // references: 10 points if non-empty array
  if (brief.references && brief.references.length > 0) {
    score += FIELD_WEIGHTS.references;
  }

  // constraints: 5 points if has at least one mustHave or mustAvoid
  if (brief.constraints) {
    const hasMustHave = brief.constraints.mustHave && brief.constraints.mustHave.length > 0;
    const hasMustAvoid = brief.constraints.mustAvoid && brief.constraints.mustAvoid.length > 0;
    if (hasMustHave || hasMustAvoid) {
      score += FIELD_WEIGHTS.constraints;
    }
  }

  return score;
}

/**
 * Create a brief issue
 * @param field - Field name
 * @param severity - Issue severity
 * @param message - Issue message
 * @param suggestion - Optional suggestion
 */
function createIssue(
  field: string,
  severity: IssueSeverity,
  message: string,
  suggestion?: string
): BriefIssue {
  const issue: BriefIssue = { field, severity, message };
  if (suggestion) {
    issue.suggestion = suggestion;
  }
  return issue;
}

// ============================================================================
// Service Implementation
// ============================================================================

/**
 * Brief validation service implementation
 */
export class BriefValidateService implements IBriefValidateService {
  /**
   * Validate a design brief
   * @param brief - Design brief to validate
   * @param strictMode - Enable strict validation rules
   * @returns Promise<BriefValidationResult> - Validation result
   */
  async validate(brief: Brief, strictMode: boolean): Promise<BriefValidationResult> {
    const issues: BriefIssue[] = [];
    const suggestions: string[] = [];

    // 1. Validate required fields
    this.validateRequiredFields(brief, issues);

    // 2. Validate recommended fields
    this.validateRecommendedFields(brief, issues, suggestions);

    // 3. Validate optional fields (suggestions only)
    this.validateOptionalFields(brief, issues, suggestions);

    // 4. Apply strict mode rules if enabled
    if (strictMode) {
      this.validateStrictRules(brief, issues);
    }

    // 5. Calculate completeness score
    const completenessScore = calculateCompletenessScore(brief);

    // 6. Determine isValid (no error-level issues)
    const isValid = !issues.some((i) => i.severity === 'error');

    // 7. Determine readyForDesign (score >= 60 and no errors)
    const readyForDesign = isValid && completenessScore >= 60;

    // Log in development
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.info('[BriefValidateService] Validation result:', {
        isValid,
        completenessScore,
        issueCount: issues.length,
        readyForDesign,
      });
    }

    return {
      isValid,
      completenessScore,
      issues,
      suggestions,
      readyForDesign,
    };
  }

  /**
   * Validate required fields
   * Generates error-level issues for missing/invalid required fields
   */
  private validateRequiredFields(brief: Brief, issues: BriefIssue[]): void {
    // projectName validation
    if (!brief.projectName || brief.projectName.length === 0) {
      issues.push(createIssue('projectName', 'error', MESSAGES.projectNameRequired));
    } else if (brief.projectName.length < VALIDATION_RULES.minLengths.projectName) {
      issues.push(
        createIssue(
          'projectName',
          'error',
          MESSAGES.projectNameTooShort(VALIDATION_RULES.minLengths.projectName)
        )
      );
    }
  }

  /**
   * Validate recommended fields
   * Generates warning-level issues for missing/insufficient recommended fields
   */
  private validateRecommendedFields(
    brief: Brief,
    issues: BriefIssue[],
    suggestions: string[]
  ): void {
    // description validation
    if (!brief.description || brief.description.length === 0) {
      issues.push(createIssue('description', 'warning', MESSAGES.descriptionMissing));
      suggestions.push(MESSAGES.suggestionAddDescription);
    } else if (brief.description.length < VALIDATION_RULES.minLengths.description) {
      issues.push(
        createIssue(
          'description',
          'warning',
          MESSAGES.descriptionTooShort(VALIDATION_RULES.minLengths.description)
        )
      );
      suggestions.push(MESSAGES.suggestionMoreDescription);
    }

    // targetAudience validation
    if (!brief.targetAudience || brief.targetAudience.length === 0) {
      issues.push(createIssue('targetAudience', 'warning', MESSAGES.targetAudienceMissing));
      suggestions.push(MESSAGES.suggestionAddTargetAudience);
    } else if (brief.targetAudience.length < VALIDATION_RULES.minLengths.targetAudience) {
      issues.push(
        createIssue(
          'targetAudience',
          'warning',
          MESSAGES.targetAudienceTooShort(VALIDATION_RULES.minLengths.targetAudience)
        )
      );
    }

    // industry validation
    if (!brief.industry || brief.industry.length === 0) {
      issues.push(createIssue('industry', 'warning', MESSAGES.industryMissing));
      suggestions.push(MESSAGES.suggestionAddIndustry);
    }

    // tone validation
    if (!brief.tone || brief.tone.length === 0) {
      issues.push(createIssue('tone', 'warning', MESSAGES.toneMissing));
      suggestions.push(MESSAGES.suggestionAddTone);
    }
  }

  /**
   * Validate optional fields
   * Generates suggestion-level issues for missing optional fields
   */
  private validateOptionalFields(
    brief: Brief,
    issues: BriefIssue[],
    suggestions: string[]
  ): void {
    // colorPreferences validation
    if (!brief.colorPreferences || !brief.colorPreferences.primary) {
      issues.push(createIssue('colorPreferences', 'suggestion', MESSAGES.colorPreferencesSuggestion));
      suggestions.push(MESSAGES.suggestionAddColors);
    }

    // references validation
    if (!brief.references || brief.references.length === 0) {
      issues.push(createIssue('references', 'suggestion', MESSAGES.referencesSuggestion));
      suggestions.push(MESSAGES.suggestionAddReferences);
    }

    // constraints validation
    const hasConstraints =
      brief.constraints &&
      ((brief.constraints.mustHave && brief.constraints.mustHave.length > 0) ||
        (brief.constraints.mustAvoid && brief.constraints.mustAvoid.length > 0));
    if (!hasConstraints) {
      issues.push(createIssue('constraints', 'suggestion', MESSAGES.constraintsSuggestion));
      suggestions.push(MESSAGES.suggestionAddConstraints);
    }
  }

  /**
   * Validate strict mode rules
   * Generates error-level issues for strict mode violations
   */
  private validateStrictRules(brief: Brief, issues: BriefIssue[]): void {
    const { strictRules } = VALIDATION_RULES;

    // description >= 100 chars in strict mode
    if (!brief.description || brief.description.length < strictRules.minDescription) {
      issues.push(
        createIssue(
          'description',
          'error',
          MESSAGES.strictDescriptionTooShort(strictRules.minDescription)
        )
      );
    }

    // tone required in strict mode
    if (strictRules.requireTone && (!brief.tone || brief.tone.length === 0)) {
      issues.push(createIssue('tone', 'error', MESSAGES.strictToneRequired));
    }

    // colorPreferences required in strict mode
    if (strictRules.requireColors && (!brief.colorPreferences || !brief.colorPreferences.primary)) {
      issues.push(createIssue('colorPreferences', 'error', MESSAGES.strictColorsRequired));
    }

    // references >= 2 in strict mode
    if (!brief.references || brief.references.length < strictRules.minReferences) {
      issues.push(
        createIssue(
          'references',
          'error',
          MESSAGES.strictReferencesInsufficient(strictRules.minReferences)
        )
      );
    }
  }
}
