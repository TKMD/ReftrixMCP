// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Screenshot 永続化サービスの共有型定義
 * Shared type definitions for screenshot persistence service
 *
 * Phase 5 fork orchestrator や GDPR 削除サービスなど、Screenshot 永続化の
 * 一部メソッドのみを必要とするコンポーネント向けの最小インターフェースを
 * 集約する。循環依存を避けるため、型定義のみを切り出している。
 *
 * Collects minimal interfaces for components (Phase 5 fork orchestrator,
 * GDPR deletion service, etc.) that only need a subset of the screenshot
 * persistence API. Kept type-only to avoid circular dependencies.
 *
 * @module services/screenshot-persistence.types
 */

/**
 * Phase 5 / GDPR deletion 等の cleanup 用途に使用する最小 API
 * Minimal API used by cleanup flows (Phase 5, GDPR deletion, etc.)
 *
 * - `IPhase5ScreenshotPersistence` と同等で、`deleteScreenshot()` のみ公開する。
 * - `IPhase5ScreenshotPersistence` is a compatible alias exposing only
 *   `deleteScreenshot()`.
 */
export interface IPhase5ScreenshotPersistence {
  deleteScreenshot: (webPageId: string) => Promise<void>;
}
