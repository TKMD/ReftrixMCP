// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * preference MCPツール エクスポート
 * preference MCP tools export
 *
 * Tools:
 * - preference.hear: ユーザー嗜好ヒアリングセッション / User preference hearing session
 * - preference.get: プロファイル取得 / Get profile
 * - preference.reset: プロファイルリセット / Reset profile
 *
 * @module tools/preference
 */

// schemas
export {
  preferenceHearInputSchema,
  preferenceGetInputSchema,
  preferenceResetInputSchema,
  feedbackRatingSchema,
  feedbackItemSchema,
  PREFERENCE_MCP_ERROR_CODES,
  type PreferenceHearInput,
  type PreferenceGetInput,
  type PreferenceResetInput,
  type FeedbackRating,
  type FeedbackItem,
  type PreferenceMcpErrorCode,
} from './schemas';

// preference.hear
export {
  preferenceHearHandler,
  preferenceHearToolDefinition,
  setPreferenceServiceFactory as setPreferenceHearServiceFactory,
  resetPreferenceServiceFactory as resetPreferenceHearServiceFactory,
  type IPreferenceService,
  type PreferenceSample,
  type SamplesResult,
  type FeedbackResult,
  type ProfileData,
  type ResetResult,
  type PreferenceHearOutput,
  type HearingProgress,
  type GetSamplesOptions,
} from './hear.tool';

// preference.get
export {
  preferenceGetHandler,
  preferenceGetToolDefinition,
  setPreferenceServiceFactory as setPreferenceGetServiceFactory,
  resetPreferenceServiceFactory as resetPreferenceGetServiceFactory,
  type PreferenceGetOutput,
} from './get.tool';

// preference.reset
export {
  preferenceResetHandler,
  preferenceResetToolDefinition,
  setPreferenceServiceFactory as setPreferenceResetServiceFactory,
  resetPreferenceServiceFactory as resetPreferenceResetServiceFactory,
  type PreferenceResetOutput,
} from './reset.tool';
