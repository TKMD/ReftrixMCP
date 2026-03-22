// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 汎用DIファクトリーユーティリティ / Generic DI Factory Utility
 *
 * MCPツールハンドラーで使用されるDIファクトリーボイラープレートを共通化する。
 * Centralizes the DI factory boilerplate used across MCP tool handlers.
 *
 * @example
 * ```typescript
 * // Before (9 lines per factory):
 * let serviceFactory: (() => IMyService) | null = null;
 * export function setMyServiceFactory(factory: () => IMyService): void {
 *   serviceFactory = factory;
 * }
 * export function resetMyServiceFactory(): void {
 *   serviceFactory = null;
 * }
 *
 * // After (1 line per factory):
 * const myServiceDI = createDIFactory<IMyService>("MyService");
 * export const setMyServiceFactory = myServiceDI.set;
 * export const resetMyServiceFactory = myServiceDI.reset;
 * ```
 */

/**
 * DIファクトリーのインターフェース / DI Factory interface
 *
 * @template T - ファクトリーが生成するサービスの型 / Type of service produced by factory
 */
export interface DIFactory<T> {
  /** 現在のファクトリー関数を取得（未設定時はnull） / Get current factory (null if unset) */
  get: () => (() => T) | null;
  /** ファクトリー関数を設定 / Set factory function */
  set: (factory: () => T) => void;
  /** ファクトリーをnullにリセット / Reset factory to null */
  reset: () => void;
}

/**
 * 汎用DIファクトリーを生成する / Create a generic DI factory
 *
 * 標準パターン（let factory = null / set / reset）のボイラープレートを1行に削減する。
 * Reduces the standard pattern (let factory = null / set / reset) to a single line.
 *
 * @template T - ファクトリーが生成するサービスの型 / Type of service produced by factory
 * @param _name - デバッグ用のファクトリー名（将来のログ拡張用） / Factory name for debugging (reserved for future logging)
 * @returns DIFactory<T> - get / set / reset メソッドを持つオブジェクト / Object with get / set / reset methods
 */
export function createDIFactory<T>(_name: string): DIFactory<T> {
  let factory: (() => T) | null = null;

  return {
    get: (): (() => T) | null => factory,
    set: (f: () => T): void => {
      factory = f;
    },
    reset: (): void => {
      factory = null;
    },
  };
}
