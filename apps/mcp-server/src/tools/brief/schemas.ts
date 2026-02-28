// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * brief.* MCP Tools Zod Schema Definitions
 * Design brief validation tool input/output validation schemas
 *
 * @module @reftrix/mcp-server/tools/brief/schemas
 *
 * Target tools:
 * - brief.validate: Validate design brief and return completeness score
 */
import { z } from 'zod';

// ============================================================================
// Enum Schemas
// ============================================================================

/**
 * Tone enum schema
 * Design tone/mood options for the project
 */
export const toneSchema = z.enum([
  'professional',
  'playful',
  'minimal',
  'bold',
  'elegant',
  'friendly',
  'corporate',
  'creative',
]);
export type Tone = z.infer<typeof toneSchema>;

/**
 * Issue severity enum schema
 * Severity levels for validation issues
 */
export const issueSeveritySchema = z.enum(['error', 'warning', 'suggestion']);
export type IssueSeverity = z.infer<typeof issueSeveritySchema>;

// ============================================================================
// Base Schemas
// ============================================================================

/**
 * HEX color schema
 * Validates 6-digit HEX color format (#RRGGBB)
 */
export const hexColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, {
    message: 'Color must be in HEX format (#RRGGBB)',
  });
export type HexColor = z.infer<typeof hexColorSchema>;

/**
 * Color preferences schema
 * Optional color settings for brand colors
 */
export const colorPreferencesSchema = z.object({
  primary: hexColorSchema.optional(),
  secondary: hexColorSchema.optional(),
  accent: hexColorSchema.optional(),
});
export type ColorPreferences = z.infer<typeof colorPreferencesSchema>;

/**
 * Reference schema
 * URL reference with optional note
 */
export const referenceSchema = z.object({
  url: z.string().url({ message: 'Reference URL must be valid' }),
  note: z
    .string()
    .max(200, { message: 'Note must be 200 characters or less' })
    .optional(),
});
export type Reference = z.infer<typeof referenceSchema>;

/**
 * Constraints schema
 * Must-have and must-avoid constraints for the design
 */
export const constraintsSchema = z.object({
  mustHave: z.array(z.string()).optional(),
  mustAvoid: z.array(z.string()).optional(),
});
export type Constraints = z.infer<typeof constraintsSchema>;

// ============================================================================
// brief.validate Input Schemas
// ============================================================================

/**
 * Brief schema
 * Complete design brief structure
 *
 * @property projectName - Project name (required, 1-200 chars)
 * @property description - Project description (optional, max 2000 chars)
 * @property targetAudience - Target audience description (optional, max 500 chars)
 * @property industry - Industry/sector (optional, max 100 chars)
 * @property tone - Array of tone values (optional)
 * @property colorPreferences - Color settings (optional)
 * @property references - Reference URLs (optional, max 10 items)
 * @property constraints - Must-have/must-avoid constraints (optional)
 */
export const briefSchema = z.object({
  projectName: z
    .string()
    .min(1, { message: 'Project name is required' })
    .max(200, { message: 'Project name must be 200 characters or less' }),
  description: z
    .string()
    .max(2000, { message: 'Description must be 2000 characters or less' })
    .optional(),
  targetAudience: z
    .string()
    .max(500, { message: 'Target audience must be 500 characters or less' })
    .optional(),
  industry: z
    .string()
    .max(100, { message: 'Industry must be 100 characters or less' })
    .optional(),
  tone: z.array(toneSchema).optional(),
  colorPreferences: colorPreferencesSchema.optional(),
  references: z
    .array(referenceSchema)
    .max(10, { message: 'Maximum 10 references allowed' })
    .optional(),
  constraints: constraintsSchema.optional(),
});
export type Brief = z.infer<typeof briefSchema>;

/**
 * brief.validate input schema
 *
 * @property brief - Design brief to validate (required)
 * @property strictMode - Enable strict validation mode (default: false)
 */
export const briefValidateInputSchema = z.object({
  brief: briefSchema,
  strictMode: z.boolean().default(false),
});
export type BriefValidateInput = z.infer<typeof briefValidateInputSchema>;

// ============================================================================
// brief.validate Output Schemas
// ============================================================================

/**
 * Brief issue schema
 * Single validation issue with field, severity, message, and optional suggestion
 */
export const briefIssueSchema = z.object({
  field: z.string(),
  severity: issueSeveritySchema,
  message: z.string(),
  suggestion: z.string().optional(),
});
export type BriefIssue = z.infer<typeof briefIssueSchema>;

/**
 * Brief validation result schema
 * Complete validation result with score and issues
 *
 * @property isValid - Whether the brief passes validation
 * @property completenessScore - Score from 0-100
 * @property issues - Array of validation issues
 * @property suggestions - Array of improvement suggestions
 * @property readyForDesign - Whether the brief is ready for design phase
 */
export const briefValidationResultSchema = z.object({
  isValid: z.boolean(),
  completenessScore: z
    .number()
    .min(0, { message: 'Score must be at least 0' })
    .max(100, { message: 'Score must be at most 100' }),
  issues: z.array(briefIssueSchema),
  suggestions: z.array(z.string()),
  readyForDesign: z.boolean(),
});
export type BriefValidationResult = z.infer<typeof briefValidationResultSchema>;

/**
 * Brief validate error schema
 * Error information for failed validation
 */
export const briefValidateErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type BriefValidateError = z.infer<typeof briefValidateErrorSchema>;

/**
 * brief.validate success response schema
 */
export const briefValidateSuccessOutputSchema = z.object({
  success: z.literal(true),
  data: briefValidationResultSchema,
});

/**
 * brief.validate error response schema
 */
export const briefValidateErrorOutputSchema = z.object({
  success: z.literal(false),
  error: briefValidateErrorSchema,
});

/**
 * brief.validate output schema (discriminated union)
 * Response Object pattern: { success, data } or { success, error }
 */
export const briefValidateOutputSchema = z.discriminatedUnion('success', [
  briefValidateSuccessOutputSchema,
  briefValidateErrorOutputSchema,
]);
export type BriefValidateOutput = z.infer<typeof briefValidateOutputSchema>;

// ============================================================================
// Error Codes
// ============================================================================

/**
 * brief.* tools error codes
 */
export const BRIEF_MCP_ERROR_CODES = {
  /** Validation error */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Invalid brief structure */
  INVALID_BRIEF: 'INVALID_BRIEF',
  /** Internal error */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type BriefMcpErrorCode =
  (typeof BRIEF_MCP_ERROR_CODES)[keyof typeof BRIEF_MCP_ERROR_CODES];

// ============================================================================
// MCP Tool Definitions
// ============================================================================

/**
 * MCP Tool definitions for brief.* tools
 * MCP protocol compliant tool definitions
 */
export const briefMcpTools = {
  'brief.validate': {
    name: 'brief.validate',
    description:
      'Validate design brief and return completeness score with improvement suggestions',
    inputSchema: briefValidateInputSchema,
  },
} as const;

export type BriefMcpToolName = keyof typeof briefMcpTools;
