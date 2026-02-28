// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP引数型変換ミドルウェア
 *
 * MCP プロトコル経由でツールに渡されるパラメータは、一部のクライアントが
 * 数値やブーリアンを文字列としてシリアライズする場合がある。
 * このミドルウェアはJSON Schemaの型定義に基づいて、自動的に型変換を行う。
 *
 * 例:
 * - limit: "20" (string) → limit: 20 (number)
 * - include_html: "true" (string) → include_html: true (boolean)
 *
 * @module middleware/args-type-coercion
 */

import { logger } from '../utils/logger';

/**
 * 型変換マップ
 * キー: ドット区切りのフィールドパス（例: "limit", "options.timeout"）
 * 値: 変換先の型（"number" | "boolean"）
 */
export type CoercionMap = Map<string, 'number' | 'boolean'>;

/**
 * JSON Schema型定義のインターフェース
 */
interface JsonSchemaProperty {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  items?: JsonSchemaProperty;
  default?: unknown;
  [key: string]: unknown;
}

/**
 * JSON Schemaからフィールドの型変換マップを構築する
 *
 * スキーマのプロパティを再帰的に走査し、number/integer/boolean型のフィールドを
 * ドット区切りパスとして記録する。
 *
 * @param schema - JSON Schemaオブジェクト
 * @param prefix - フィールドパスのプレフィックス（再帰用）
 * @returns 型変換マップ
 */
export function buildCoercionMap(
  schema: JsonSchemaProperty,
  prefix: string = ''
): CoercionMap {
  const map: CoercionMap = new Map();

  if (schema.type !== 'object' || !schema.properties) {
    return map;
  }

  for (const [key, prop] of Object.entries(schema.properties)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;

    if (prop.type === 'number' || prop.type === 'integer') {
      map.set(fullPath, 'number');
    } else if (prop.type === 'boolean') {
      map.set(fullPath, 'boolean');
    } else if (prop.type === 'object' && prop.properties) {
      // 再帰的にネストされたオブジェクトを処理
      const nestedMap = buildCoercionMap(prop, fullPath);
      for (const [nestedKey, nestedType] of nestedMap) {
        map.set(nestedKey, nestedType);
      }
    }
  }

  return map;
}

/**
 * 文字列を数値に安全に変換する
 *
 * @param value - 変換対象の値
 * @returns 数値に変換できた場合はnumber、できない場合は元の値
 */
function tryCoerceToNumber(value: unknown): unknown {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value !== 'string' || value === '') {
    return value;
  }
  const num = Number(value);
  if (Number.isNaN(num)) {
    return value;
  }
  return num;
}

/**
 * 文字列をブーリアンに安全に変換する
 *
 * "true" → true, "false" → false のみ変換
 * それ以外の文字列は元の値を返す
 *
 * @param value - 変換対象の値
 * @returns ブーリアンに変換できた場合はboolean、できない場合は元の値
 */
function tryCoerceToBoolean(value: unknown): unknown {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return value;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return value;
}

/**
 * 型変換マップに基づいてオブジェクトのフィールドを再帰的に変換する
 *
 * @param obj - 変換対象のオブジェクト
 * @param coercionMap - 型変換マップ
 * @param prefix - フィールドパスのプレフィックス（再帰用）
 * @returns 変換後の新しいオブジェクト（元のオブジェクトは変更しない）
 */
function applyCoercion(
  obj: Record<string, unknown>,
  coercionMap: CoercionMap,
  prefix: string = ''
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const targetType = coercionMap.get(fullPath);

    if (targetType === 'number') {
      const coerced = tryCoerceToNumber(value);
      if (coerced !== value) {
        logger.debug(`[ArgsCoercion] Coerced ${fullPath}: "${value}" → ${coerced} (number)`);
      }
      result[key] = coerced;
    } else if (targetType === 'boolean') {
      const coerced = tryCoerceToBoolean(value);
      if (coerced !== value) {
        logger.debug(`[ArgsCoercion] Coerced ${fullPath}: "${value}" → ${coerced} (boolean)`);
      }
      result[key] = coerced;
    } else if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      // ネストされたオブジェクトを再帰的に処理
      result[key] = applyCoercion(
        value as Record<string, unknown>,
        coercionMap,
        fullPath
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * JSON Schemaの型定義に基づいてMCPツール引数の型変換を行う
 *
 * MCP クライアントが数値・ブーリアンパラメータを文字列として送信した場合に、
 * スキーマの型定義に基づいて自動的に変換する。
 *
 * 変換ルール:
 * - type: "number" / "integer": 数値文字列 → number（非数値文字列はそのまま）
 * - type: "boolean": "true"/"false" → boolean（他の文字列はそのまま）
 *
 * 変換できない値はそのまま渡し、後段のZodバリデーションでエラーとする。
 * 元のargsオブジェクトは変更しない（新しいオブジェクトを返す）。
 *
 * @param args - MCPツール引数
 * @param schema - ツールのJSON Schema（inputSchema）
 * @returns 型変換後の新しい引数オブジェクト
 */
export function coerceArgs(
  args: Record<string, unknown>,
  schema: JsonSchemaProperty
): Record<string, unknown> {
  const coercionMap = buildCoercionMap(schema);

  if (coercionMap.size === 0) {
    return args;
  }

  return applyCoercion(args, coercionMap);
}

/**
 * ツール名とJSON Schemaのキャッシュマップ
 * サーバー起動後に一度だけ構築し、以降はキャッシュから取得する
 */
const coercionMapCache: Map<string, CoercionMap> = new Map();

/**
 * ツール名に対応する型変換マップをキャッシュ付きで取得する
 *
 * @param toolName - MCPツール名
 * @param schema - ツールのJSON Schema
 * @returns 型変換マップ
 */
export function getCoercionMap(
  toolName: string,
  schema: JsonSchemaProperty
): CoercionMap {
  const cached = coercionMapCache.get(toolName);
  if (cached) {
    return cached;
  }

  const map = buildCoercionMap(schema);
  coercionMapCache.set(toolName, map);
  return map;
}

/**
 * キャッシュをクリアする（テスト用）
 */
export function clearCoercionMapCache(): void {
  coercionMapCache.clear();
}
