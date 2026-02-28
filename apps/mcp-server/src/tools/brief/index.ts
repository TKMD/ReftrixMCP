// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * brief.* MCP Tools
 * Design brief validation tools exports
 *
 * @module @reftrix/mcp-server/tools/brief
 */

// Schema exports
export {
  // Enum schemas
  toneSchema,
  issueSeveritySchema,
  // Base schemas
  hexColorSchema,
  colorPreferencesSchema,
  referenceSchema,
  constraintsSchema,
  // Input schemas
  briefSchema,
  briefValidateInputSchema,
  // Output schemas
  briefIssueSchema,
  briefValidationResultSchema,
  briefValidateErrorSchema,
  briefValidateSuccessOutputSchema,
  briefValidateErrorOutputSchema,
  briefValidateOutputSchema,
  // Error codes
  BRIEF_MCP_ERROR_CODES,
  // MCP Tool definitions
  briefMcpTools,
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
  type BriefValidateError,
  type BriefValidateOutput,
  type BriefMcpErrorCode,
  type BriefMcpToolName,
} from './schemas';

// Service exports
export {
  // Service class
  BriefValidateService,
  // Pure functions
  calculateCompletenessScore,
  // Constants
  VALIDATION_RULES,
  FIELD_WEIGHTS,
  // Interface
  type IBriefValidateService,
} from './validate.service';

// Handler exports
export {
  // Handler function
  briefValidateHandler,
  // Tool definition
  briefValidateToolDefinition,
  // DI functions
  setBriefValidateServiceFactory,
  resetBriefValidateServiceFactory,
  // Types
  type IBriefValidateServiceFactory,
} from './validate.handler';
