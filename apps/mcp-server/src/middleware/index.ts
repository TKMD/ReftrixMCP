// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ミドルウェアモジュールのエクスポート
 *
 * @module middleware
 */

export {
  ResponseSizeWarning,
  responseSizeWarning,
  calculateResponseSize,
  formatSize,
  DEFAULT_WARNING_THRESHOLD_KB,
  DEFAULT_CRITICAL_THRESHOLD_KB,
  type ResponseSizeWarningOptions,
  type ResponseSizeResult,
} from './response-size-warning';

export {
  createAuthMiddleware,
  validateApiKey,
  checkPermission,
  PERMISSIONS,
  ROLES,
  TOOL_PERMISSIONS,
  PUBLIC_TOOLS,
  type Role,
  type AuthContext,
  type AuthMiddlewareOptions,
  type AuthMiddlewareInstance,
  type AuthResult,
  type AuthErrorCode,
  type Permission,
} from './auth';

export {
  LightResponseController,
  lightResponseController,
  applyLightResponse,
  extractLightResponseOptions,
  DEFAULT_LIGHT_RESPONSE_CONFIG,
  TOOL_FIELD_CONFIGS,
  type LightResponseOptions,
  type LightResponseControllerOptions,
  type ToolFieldConfig,
} from './light-response-controller';

export {
  coerceArgs,
  buildCoercionMap,
  getCoercionMap,
  clearCoercionMapCache,
  type CoercionMap,
} from './args-type-coercion';
