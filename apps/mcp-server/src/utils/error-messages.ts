// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCPツール用エラーメッセージユーティリティ
 * Zodエラーを人間が読みやすいメッセージに変換する
 *
 * 機能:
 * - Zodエラーの構造化変換
 * - 日本語/英語の多言語対応（環境変数で切り替え可能）
 * - 一貫したエラーコード体系
 * - フィールドパス情報の保持
 *
 * @module @reftrix/mcp-server/utils/error-messages
 */

import { ZodError, type ZodIssue, ZodIssueCode } from 'zod';

// ============================================================================
// 型定義
// ============================================================================

/**
 * MCPツールエラーのインターフェース
 * 統一されたエラーレスポンス構造
 */
export interface McpToolError {
  /** エラーコード（一意の識別子） */
  code: string;
  /** 人間が読めるエラーメッセージ */
  message: string;
  /** エラーのあるフィールド（オプション） */
  field?: string;
  /** 追加情報（オプション） */
  details?: Record<string, unknown>;
}

/**
 * サポートされるロケール
 */
export type ErrorLocale = 'en' | 'ja';

/**
 * エラーコード定義
 */
export const ERROR_CODES = {
  INVALID_UUID: 'INVALID_UUID',
  REQUIRED_FIELD: 'REQUIRED_FIELD',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  INVALID_ENUM: 'INVALID_ENUM',
  STRING_TOO_SHORT: 'STRING_TOO_SHORT',
  STRING_TOO_LONG: 'STRING_TOO_LONG',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_FORMAT: 'INVALID_FORMAT',
  ARRAY_TOO_LONG: 'ARRAY_TOO_LONG',
  ARRAY_TOO_SHORT: 'ARRAY_TOO_SHORT',
  CUSTOM_ERROR: 'CUSTOM_ERROR',
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCodeType = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ============================================================================
// メッセージテンプレート
// ============================================================================

/**
 * 英語のエラーメッセージテンプレート
 */
const englishMessages = {
  INVALID_UUID: (_field: string): string =>
    `Invalid UUID format. Expected: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`,
  REQUIRED_FIELD: (field: string): string => `Required field '${field}' is missing`,
  OUT_OF_RANGE: (value: number, min?: number, max?: number): string => {
    if (min !== undefined && max !== undefined) {
      return `Value ${value} is out of range (min: ${min}, max: ${max})`;
    }
    if (min !== undefined) {
      return `Value ${value} is too small (min: ${min})`;
    }
    if (max !== undefined) {
      return `Value ${value} is too large (max: ${max})`;
    }
    return `Value ${value} is out of range`;
  },
  INVALID_ENUM: (value: string, options: string[]): string =>
    `Invalid value '${value}'. Expected one of: ${options.join(', ')}`,
  STRING_TOO_SHORT: (field: string, min: number): string =>
    `Field '${field}' must have at least ${min} character${min === 1 ? '' : 's'}`,
  STRING_TOO_LONG: (field: string, max: number): string =>
    `Field '${field}' must have at most ${max} character${max === 1 ? '' : 's'}`,
  INVALID_TYPE: (expected: string, received: string): string =>
    `Expected ${expected}, but received ${received}`,
  INVALID_FORMAT: (field: string, format: string): string =>
    `Field '${field}' does not match the required format: ${format}`,
  ARRAY_TOO_LONG: (field: string, max: number): string =>
    `Array '${field}' must have at most ${max} item${max === 1 ? '' : 's'}`,
  ARRAY_TOO_SHORT: (field: string, min: number): string =>
    `Array '${field}' must have at least ${min} item${min === 1 ? '' : 's'}`,
  CUSTOM_ERROR: (message: string): string => message,
  UNKNOWN_ERROR: (message: string): string => `Validation error: ${message}`,
};

/**
 * 日本語のエラーメッセージテンプレート
 */
const japaneseMessages = {
  INVALID_UUID: (_field: string): string =>
    `UUID形式が無効です。期待される形式: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`,
  REQUIRED_FIELD: (field: string): string =>
    `必須フィールド '${field}' が指定されていません`,
  OUT_OF_RANGE: (value: number, min?: number, max?: number): string => {
    if (min !== undefined && max !== undefined) {
      return `値 ${value} は範囲外です (最小: ${min}, 最大: ${max})`;
    }
    if (min !== undefined) {
      return `値 ${value} は小さすぎます (最小: ${min})`;
    }
    if (max !== undefined) {
      return `値 ${value} は大きすぎます (最大: ${max})`;
    }
    return `値 ${value} は範囲外です`;
  },
  INVALID_ENUM: (value: string, options: string[]): string =>
    `値 '${value}' は無効です。次のいずれかを指定してください: ${options.join(', ')}`,
  STRING_TOO_SHORT: (field: string, min: number): string =>
    `フィールド '${field}' は${min}文字以上で入力してください`,
  STRING_TOO_LONG: (field: string, max: number): string =>
    `フィールド '${field}' は${max}文字以下で入力してください`,
  INVALID_TYPE: (expected: string, received: string): string =>
    `${expected}が期待されましたが、${received}が渡されました`,
  INVALID_FORMAT: (field: string, format: string): string =>
    `フィールド '${field}' は指定された形式に一致しません: ${format}`,
  ARRAY_TOO_LONG: (field: string, max: number): string =>
    `配列 '${field}' は${max}個以下の要素にしてください`,
  ARRAY_TOO_SHORT: (field: string, min: number): string =>
    `配列 '${field}' は${min}個以上の要素が必要です`,
  CUSTOM_ERROR: (message: string): string => message,
  UNKNOWN_ERROR: (message: string): string => `バリデーションエラー: ${message}`,
};

/**
 * エラーメッセージ定数（外部エクスポート用）
 */
export const ErrorMessages = {
  en: {
    INVALID_UUID: englishMessages.INVALID_UUID,
    REQUIRED_FIELD: englishMessages.REQUIRED_FIELD,
    OUT_OF_RANGE: englishMessages.OUT_OF_RANGE,
    INVALID_ENUM: englishMessages.INVALID_ENUM,
    STRING_TOO_SHORT: englishMessages.STRING_TOO_SHORT,
    STRING_TOO_LONG: englishMessages.STRING_TOO_LONG,
    INVALID_TYPE: englishMessages.INVALID_TYPE,
    INVALID_FORMAT: englishMessages.INVALID_FORMAT,
    ARRAY_TOO_LONG: englishMessages.ARRAY_TOO_LONG,
    ARRAY_TOO_SHORT: englishMessages.ARRAY_TOO_SHORT,
    CUSTOM_ERROR: englishMessages.CUSTOM_ERROR,
    UNKNOWN_ERROR: englishMessages.UNKNOWN_ERROR,
  },
  ja: {
    INVALID_UUID: japaneseMessages.INVALID_UUID,
    REQUIRED_FIELD: japaneseMessages.REQUIRED_FIELD,
    OUT_OF_RANGE: japaneseMessages.OUT_OF_RANGE,
    INVALID_ENUM: japaneseMessages.INVALID_ENUM,
    STRING_TOO_SHORT: japaneseMessages.STRING_TOO_SHORT,
    STRING_TOO_LONG: japaneseMessages.STRING_TOO_LONG,
    INVALID_TYPE: japaneseMessages.INVALID_TYPE,
    INVALID_FORMAT: japaneseMessages.INVALID_FORMAT,
    ARRAY_TOO_LONG: japaneseMessages.ARRAY_TOO_LONG,
    ARRAY_TOO_SHORT: japaneseMessages.ARRAY_TOO_SHORT,
    CUSTOM_ERROR: japaneseMessages.CUSTOM_ERROR,
    UNKNOWN_ERROR: japaneseMessages.UNKNOWN_ERROR,
  },
} as const;

// ============================================================================
// ロケール管理
// ============================================================================

/**
 * 現在のロケール（デフォルトは英語、環境変数で上書き可能）
 */
let currentLocale: ErrorLocale =
  (process.env.MCP_ERROR_LOCALE as ErrorLocale) ?? 'en';

/**
 * 現在のロケールを取得
 */
export function getErrorMessageLocale(): ErrorLocale {
  return currentLocale;
}

/**
 * ロケールを設定
 * @param locale - 設定するロケール ('en' | 'ja')
 */
export function setErrorMessageLocale(locale: ErrorLocale): void {
  currentLocale = locale;
}

/**
 * 現在のロケールに対応するメッセージ関数を取得
 */
function getMessages(): typeof englishMessages {
  return currentLocale === 'ja' ? japaneseMessages : englishMessages;
}

// ============================================================================
// ZodError変換関数
// ============================================================================

/**
 * ZodIssueからフィールドパスを取得
 */
function getFieldPath(issue: ZodIssue): string {
  return issue.path.join('.');
}

/**
 * McpToolErrorを構築するヘルパー関数
 * exactOptionalPropertyTypesに対応し、空のフィールドはプロパティを含めない
 */
function createMcpToolError(
  code: string,
  message: string,
  field: string,
  details?: Record<string, unknown>
): McpToolError {
  const result: McpToolError = { code, message };
  if (field) {
    result.field = field;
  }
  if (details !== undefined) {
    result.details = details;
  }
  return result;
}

/**
 * ZodIssueを個別のMcpToolErrorに変換
 */
function convertIssueToError(issue: ZodIssue): McpToolError {
  const messages = getMessages();
  const field = getFieldPath(issue);

  switch (issue.code) {
    case ZodIssueCode.invalid_string: {
      // UUID形式エラーを検出
      if (issue.validation === 'uuid') {
        return createMcpToolError(
          ERROR_CODES.INVALID_UUID,
          messages.INVALID_UUID(field),
          field
        );
      }
      // その他の文字列フォーマットエラー
      return createMcpToolError(
        ERROR_CODES.INVALID_FORMAT,
        messages.INVALID_FORMAT(
          field,
          typeof issue.validation === 'string' ? issue.validation : 'unknown'
        ),
        field
      );
    }

    case ZodIssueCode.invalid_type: {
      // 必須フィールド欠落（undefined）
      if (issue.received === 'undefined') {
        return createMcpToolError(
          ERROR_CODES.REQUIRED_FIELD,
          messages.REQUIRED_FIELD(field),
          field
        );
      }
      // 型の不一致
      return createMcpToolError(
        ERROR_CODES.INVALID_TYPE,
        messages.INVALID_TYPE(issue.expected, issue.received),
        field,
        {
          expected: issue.expected,
          received: issue.received,
        }
      );
    }

    case ZodIssueCode.too_small: {
      // 数値の範囲チェック
      if (issue.type === 'number') {
        // minimum値を検出するためにパス情報を使用
        // issueにはmin/maxの完全な情報がないため、minimumのみ返す
        return createMcpToolError(
          ERROR_CODES.OUT_OF_RANGE,
          messages.OUT_OF_RANGE(
            (issue as unknown as { received?: number }).received ?? issue.minimum as number,
            issue.minimum as number,
            undefined // maxはこのissueからは取得できない
          ),
          field,
          {
            value: (issue as unknown as { received?: number }).received,
            min: issue.minimum,
          }
        );
      }
      // 文字列の最小長
      if (issue.type === 'string') {
        return createMcpToolError(
          ERROR_CODES.STRING_TOO_SHORT,
          messages.STRING_TOO_SHORT(field, issue.minimum as number),
          field,
          { min: issue.minimum }
        );
      }
      // 配列の最小長
      if (issue.type === 'array') {
        return createMcpToolError(
          ERROR_CODES.ARRAY_TOO_SHORT,
          messages.ARRAY_TOO_SHORT(field, issue.minimum as number),
          field,
          { min: issue.minimum }
        );
      }
      break;
    }

    case ZodIssueCode.too_big: {
      // 数値の範囲チェック
      if (issue.type === 'number') {
        return createMcpToolError(
          ERROR_CODES.OUT_OF_RANGE,
          messages.OUT_OF_RANGE(
            (issue as unknown as { received?: number }).received ?? issue.maximum as number,
            undefined,
            issue.maximum as number
          ),
          field,
          {
            value: (issue as unknown as { received?: number }).received,
            max: issue.maximum,
          }
        );
      }
      // 文字列の最大長
      if (issue.type === 'string') {
        return createMcpToolError(
          ERROR_CODES.STRING_TOO_LONG,
          messages.STRING_TOO_LONG(field, issue.maximum as number),
          field,
          { max: issue.maximum }
        );
      }
      // 配列の最大長
      if (issue.type === 'array') {
        return createMcpToolError(
          ERROR_CODES.ARRAY_TOO_LONG,
          messages.ARRAY_TOO_LONG(field, issue.maximum as number),
          field,
          { max: issue.maximum }
        );
      }
      break;
    }

    case ZodIssueCode.invalid_enum_value: {
      return createMcpToolError(
        ERROR_CODES.INVALID_ENUM,
        messages.INVALID_ENUM(
          String(issue.received),
          issue.options.map(String)
        ),
        field,
        {
          received: issue.received,
          options: issue.options,
        }
      );
    }

    case ZodIssueCode.custom: {
      return createMcpToolError(
        ERROR_CODES.CUSTOM_ERROR,
        messages.CUSTOM_ERROR(issue.message ?? 'Custom validation failed'),
        field
      );
    }

    default:
      // 未知のエラータイプはデフォルトメッセージで処理
      break;
  }

  // フォールバック
  return createMcpToolError(
    ERROR_CODES.UNKNOWN_ERROR,
    messages.UNKNOWN_ERROR(issue.message),
    field
  );
}

/**
 * ZodErrorを人間が読みやすいMcpToolError配列に変換
 *
 * @param zodError - 変換するZodError
 * @returns McpToolErrorの配列
 * @throws Error - zodErrorがZodErrorインスタンスでない場合
 *
 * @example
 * ```typescript
 * const schema = z.object({ query: z.string().min(1) });
 * const result = schema.safeParse({});
 * if (!result.success) {
 *   const errors = formatZodError(result.error);
 *   // [{ code: 'REQUIRED_FIELD', message: "Required field 'query' is missing", field: 'query' }]
 * }
 * ```
 */
export function formatZodError(zodError: ZodError): McpToolError[] {
  if (!(zodError instanceof ZodError)) {
    throw new Error('formatZodError requires a ZodError instance');
  }

  if (zodError.issues.length === 0) {
    return [];
  }

  // min/maxの情報を保持するために、同じフィールドのエラーをマージする
  const errorMap = new Map<string, McpToolError>();

  for (const issue of zodError.issues) {
    const error = convertIssueToError(issue);
    const key = `${error.field ?? ''}:${error.code}`;

    if (!errorMap.has(key)) {
      errorMap.set(key, error);
    } else {
      // 同じフィールドの範囲エラーをマージ
      const existing = errorMap.get(key);
      if (
        existing &&
        error.code === ERROR_CODES.OUT_OF_RANGE &&
        existing.code === ERROR_CODES.OUT_OF_RANGE
      ) {
        // min/max情報をマージ
        const mergedDetails = {
          ...existing.details,
          ...error.details,
        };
        const min = mergedDetails.min as number | undefined;
        const max = mergedDetails.max as number | undefined;
        const value = mergedDetails.value as number | undefined;
        const messages = getMessages();
        existing.message = messages.OUT_OF_RANGE(value ?? 0, min, max);
        existing.details = mergedDetails;
      }
    }
  }

  return Array.from(errorMap.values());
}

/**
 * ZodErrorからMcpToolError配列を生成するエイリアス
 * formatZodErrorと同じ機能
 *
 * @param zodError - 変換するZodError
 * @returns McpToolErrorの配列
 */
export function createValidationError(zodError: ZodError): McpToolError[] {
  return formatZodError(zodError);
}

// ============================================================================
// ヘルパー関数
// ============================================================================

/**
 * 単一のMcpToolErrorを文字列形式にフォーマット
 *
 * @param error - フォーマットするエラー
 * @returns フォーマットされたエラー文字列
 */
export function formatSingleError(error: McpToolError): string {
  const fieldPart = error.field ? `[${error.field}] ` : '';
  return `${fieldPart}${error.message}`;
}

/**
 * McpToolError配列を単一のエラーメッセージ文字列に結合
 *
 * @param errors - エラーの配列
 * @param separator - 区切り文字（デフォルト: ', '）
 * @returns 結合されたエラーメッセージ
 */
export function formatMultipleErrors(
  errors: McpToolError[],
  separator: string = ', '
): string {
  return errors.map(formatSingleError).join(separator);
}

// ============================================================================
// 拡張エラーメッセージ機能（Phase: バリデーションエラーメッセージ改善）
// ============================================================================

/**
 * 詳細なバリデーションエラー情報
 * 具体的な値、期待値、ヒントを含む
 */
export interface DetailedValidationError {
  /** フィールドパス (e.g., 'items.0.html') */
  field: string;
  /** エラーコード */
  code: string;
  /** 人間が読めるエラーメッセージ */
  message: string;
  /** 期待される値/型の説明 */
  expected?: string;
  /** 実際に受信した値 */
  received?: string;
  /** 修正方法のヒント */
  hint?: string;
}

/**
 * ツール固有のヒントを含むエラー結果
 */
export interface ValidationErrorWithHints {
  /** ツール名 */
  toolName: string;
  /** 詳細なエラー配列 */
  errors: DetailedValidationError[];
}

/**
 * フィールドに基づいてヒントメッセージを生成
 */
function generateHintForField(
  field: string,
  code: string,
  locale: ErrorLocale
): string {
  const hints: Record<ErrorLocale, Record<string, Record<string, string>>> = {
    en: {
      html: {
        [ERROR_CODES.REQUIRED_FIELD]:
          "Provide html content as a string, e.g., '<html>...</html>'",
        [ERROR_CODES.STRING_TOO_SHORT]:
          "HTML content must not be empty. Provide valid HTML markup.",
      },
      name: {
        [ERROR_CODES.REQUIRED_FIELD]:
          "Provide a name for the asset, e.g., 'landing-page'",
        [ERROR_CODES.STRING_TOO_SHORT]: 'Name must be at least 1 character.',
        [ERROR_CODES.STRING_TOO_LONG]: 'Name must be at most 200 characters.',
      },
      url: {
        [ERROR_CODES.INVALID_FORMAT]:
          "Provide a valid URL starting with https://, e.g., 'https://example.com'",
        [ERROR_CODES.INVALID_UUID]:
          "Provide a valid URL starting with https://, e.g., 'https://example.com'",
      },
      source_url: {
        [ERROR_CODES.INVALID_FORMAT]:
          "Provide a valid URL starting with https://, e.g., 'https://example.com/path'",
      },
      id: {
        [ERROR_CODES.INVALID_UUID]:
          'Provide a valid UUID in format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      },
      pageId: {
        [ERROR_CODES.INVALID_UUID]:
          'Provide a valid UUID for pageId in format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      },
      design_system_id: {
        [ERROR_CODES.INVALID_UUID]:
          'Provide a valid UUID for design_system_id in format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      },
    },
    ja: {
      html: {
        [ERROR_CODES.REQUIRED_FIELD]:
          "htmlコンテンツを文字列として指定してください。例: '<html>...</html>'",
        [ERROR_CODES.STRING_TOO_SHORT]:
          'HTMLコンテンツは空にできません。有効なHTMLマークアップを指定してください。',
      },
      name: {
        [ERROR_CODES.REQUIRED_FIELD]:
          "アセットの名前を指定してください。例: 'landing-page'",
        [ERROR_CODES.STRING_TOO_SHORT]: '名前は1文字以上にしてください。',
        [ERROR_CODES.STRING_TOO_LONG]: '名前は200文字以下にしてください。',
      },
      url: {
        [ERROR_CODES.INVALID_FORMAT]:
          "https://から始まる有効なURLを指定してください。例: 'https://example.com'",
      },
      source_url: {
        [ERROR_CODES.INVALID_FORMAT]:
          "https://から始まる有効なURLを指定してください。例: 'https://example.com/path'",
      },
      id: {
        [ERROR_CODES.INVALID_UUID]:
          'UUIDを以下の形式で指定してください: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      },
      pageId: {
        [ERROR_CODES.INVALID_UUID]:
          'pageIdには有効なUUIDを指定してください: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      },
      design_system_id: {
        [ERROR_CODES.INVALID_UUID]:
          'design_system_idには有効なUUIDを指定してください: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      },
    },
  };

  // フィールド名の最後の部分を取得（ネストされたパス対応）
  const fieldName = field.split('.').pop() ?? field;

  const localeHints = hints[locale];
  const fieldHints = localeHints[fieldName];

  if (fieldHints && fieldHints[code]) {
    return fieldHints[code];
  }

  // デフォルトのヒント
  return generateGenericHint(fieldName, code, locale);
}

/**
 * 汎用ヒントを生成
 */
function generateGenericHint(
  field: string,
  code: string,
  locale: ErrorLocale
): string {
  const templates: Record<ErrorLocale, Record<string, string>> = {
    en: {
      [ERROR_CODES.REQUIRED_FIELD]: `Provide a value for '${field}'.`,
      [ERROR_CODES.INVALID_UUID]: `Provide a valid UUID for '${field}' in format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`,
      [ERROR_CODES.INVALID_FORMAT]: `Check the format of '${field}'.`,
      [ERROR_CODES.OUT_OF_RANGE]: `Adjust the value of '${field}' to be within the allowed range.`,
      [ERROR_CODES.INVALID_ENUM]: `Choose a valid option for '${field}'.`,
      [ERROR_CODES.INVALID_TYPE]: `Provide the correct type for '${field}'.`,
      [ERROR_CODES.STRING_TOO_SHORT]: `Provide a longer value for '${field}'.`,
      [ERROR_CODES.STRING_TOO_LONG]: `Shorten the value of '${field}'.`,
      [ERROR_CODES.ARRAY_TOO_SHORT]: `Add more items to '${field}'.`,
      [ERROR_CODES.ARRAY_TOO_LONG]: `Reduce the number of items in '${field}'.`,
      [ERROR_CODES.CUSTOM_ERROR]: `Check the validation requirements for '${field}'.`,
    },
    ja: {
      [ERROR_CODES.REQUIRED_FIELD]: `'${field}' に値を指定してください。`,
      [ERROR_CODES.INVALID_UUID]: `'${field}' には有効なUUIDを指定してください: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`,
      [ERROR_CODES.INVALID_FORMAT]: `'${field}' の形式を確認してください。`,
      [ERROR_CODES.OUT_OF_RANGE]: `'${field}' の値を許容範囲内に調整してください。`,
      [ERROR_CODES.INVALID_ENUM]: `'${field}' には有効な選択肢を指定してください。`,
      [ERROR_CODES.INVALID_TYPE]: `'${field}' には正しい型を指定してください。`,
      [ERROR_CODES.STRING_TOO_SHORT]: `'${field}' にはより長い値を指定してください。`,
      [ERROR_CODES.STRING_TOO_LONG]: `'${field}' の値を短くしてください。`,
      [ERROR_CODES.ARRAY_TOO_SHORT]: `'${field}' に要素を追加してください。`,
      [ERROR_CODES.ARRAY_TOO_LONG]: `'${field}' の要素数を減らしてください。`,
      [ERROR_CODES.CUSTOM_ERROR]: `'${field}' のバリデーション要件を確認してください。`,
    },
  };

  const template = templates[locale][code];
  if (template) {
    return template;
  }
  // デフォルトのテンプレート
  return templates[locale][ERROR_CODES.CUSTOM_ERROR] ?? `Check the validation requirements for '${field}'.`;
}

/**
 * ツール固有のヒントを生成
 */
function generateToolSpecificHint(
  toolName: string,
  field: string,
  code: string,
  originalMessage: string,
  locale: ErrorLocale
): string {
  // refine エラー（カスタムバリデーション）の場合
  if (code === ERROR_CODES.CUSTOM_ERROR) {
    // motion.detect の排他制御
    if (
      toolName === 'motion.detect' &&
      (originalMessage.includes('pageId') || originalMessage.includes('html'))
    ) {
      return locale === 'ja'
        ? "pageId または html のいずれか一方を指定してください。両方を指定することはできません。"
        : "Specify either pageId or html, but not both.";
    }

    // layout.inspect の排他制御
    if (
      toolName === 'layout.inspect' &&
      (originalMessage.includes('id') || originalMessage.includes('html'))
    ) {
      return locale === 'ja'
        ? "id または html のいずれか一方を指定してください。"
        : "Specify either id or html, not both.";
    }

  }

  // フィールド固有のヒント
  return generateHintForField(field, code, locale);
}

/**
 * ZodIssueから詳細なエラー情報を抽出
 */
function extractDetailedError(issue: ZodIssue): DetailedValidationError {
  const field = getFieldPath(issue);
  const locale = currentLocale;

  // 期待値と受信値を抽出
  let expected: string | undefined;
  let received: string | undefined;
  // codeを文字列型として宣言（ERROR_CODESの値を動的に代入するため）
  let code: string = ERROR_CODES.UNKNOWN_ERROR;
  let message = issue.message;

  switch (issue.code) {
    case ZodIssueCode.invalid_type: {
      code =
        issue.received === 'undefined'
          ? ERROR_CODES.REQUIRED_FIELD
          : ERROR_CODES.INVALID_TYPE;
      expected = issue.expected;
      received = issue.received;
      break;
    }
    case ZodIssueCode.invalid_string: {
      if (issue.validation === 'uuid') {
        code = ERROR_CODES.INVALID_UUID;
        expected = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';
      } else if (issue.validation === 'url') {
        code = ERROR_CODES.INVALID_FORMAT;
        expected = 'https://example.com';
      } else {
        code = ERROR_CODES.INVALID_FORMAT;
        expected = String(issue.validation);
      }
      break;
    }
    case ZodIssueCode.too_small: {
      code =
        issue.type === 'string'
          ? ERROR_CODES.STRING_TOO_SHORT
          : issue.type === 'array'
            ? ERROR_CODES.ARRAY_TOO_SHORT
            : ERROR_CODES.OUT_OF_RANGE;
      expected = `>= ${issue.minimum}`;
      // Zodのtoo_smallにはreceivedが含まれないが、入力値から推測
      // issueのmessageに値が含まれていることがある
      break;
    }
    case ZodIssueCode.too_big: {
      code =
        issue.type === 'string'
          ? ERROR_CODES.STRING_TOO_LONG
          : issue.type === 'array'
            ? ERROR_CODES.ARRAY_TOO_LONG
            : ERROR_CODES.OUT_OF_RANGE;
      expected = `<= ${issue.maximum}`;
      break;
    }
    case ZodIssueCode.invalid_enum_value: {
      code = ERROR_CODES.INVALID_ENUM;
      expected = issue.options.map(String).join(', ');
      received = String(issue.received);
      break;
    }
    case ZodIssueCode.custom: {
      code = ERROR_CODES.CUSTOM_ERROR;
      message = issue.message ?? 'Custom validation failed';
      break;
    }
  }

  // ローカライズされたメッセージを生成
  const mcpError = convertIssueToError(issue);
  message = mcpError.message;

  // ヒントを生成
  const hint = generateHintForField(field || 'root', code, locale);

  // exactOptionalPropertyTypes対応: undefinedを明示的に除外
  const result: DetailedValidationError = {
    field: field || 'root',
    code,
    message,
    hint,
  };

  // 値が存在する場合のみプロパティを追加
  if (expected !== undefined) {
    result.expected = expected;
  }
  if (received !== undefined) {
    result.received = received;
  }

  return result;
}

/**
 * ZodErrorを詳細なバリデーションエラー形式に変換
 *
 * @param zodError - 変換するZodError
 * @returns 詳細なエラー情報を含むオブジェクト
 *
 * @example
 * ```typescript
 * const schema = z.object({ html: z.string().min(1) });
 * const result = schema.safeParse({});
 * if (!result.success) {
 *   const detailed = formatDetailedValidationError(result.error);
 *   // { errors: [{ field: 'html', code: 'REQUIRED_FIELD', ... }] }
 * }
 * ```
 */
export function formatDetailedValidationError(zodError: ZodError): {
  errors: DetailedValidationError[];
} {
  if (!(zodError instanceof ZodError)) {
    throw new Error('formatDetailedValidationError requires a ZodError instance');
  }

  const errors = zodError.issues.map(extractDetailedError);
  return { errors };
}

/**
 * ツール固有のヒントを追加してエラー情報を生成
 *
 * @param zodError - 変換するZodError
 * @param toolName - MCPツール名
 * @returns ツール固有のヒントを含むエラー情報
 *
 * @example
 * ```typescript
 * const schema = z.object({ html: z.string().min(1) });
 * const result = schema.safeParse({});
 * if (!result.success) {
 *   const errorWithHints = createValidationErrorWithHints(result.error, 'layout.ingest');
 * }
 * ```
 */
export function createValidationErrorWithHints(
  zodError: ZodError,
  toolName: string
): ValidationErrorWithHints {
  if (!(zodError instanceof ZodError)) {
    throw new Error('createValidationErrorWithHints requires a ZodError instance');
  }

  const locale = currentLocale;
  const errors = zodError.issues.map((issue) => {
    const detailed = extractDetailedError(issue);

    // ツール固有のヒントで上書き
    detailed.hint = generateToolSpecificHint(
      toolName,
      detailed.field,
      detailed.code,
      issue.message,
      locale
    );

    return detailed;
  });

  return {
    toolName,
    errors,
  };
}

/**
 * 詳細エラーを構造化された文字列フォーマットに変換
 *
 * @param error - 詳細なエラー情報
 * @returns フォーマットされた文字列
 *
 * @example
 * Output format:
 * ```
 * Validation Error: html is required
 *   Field: html
 *   Expected: non-empty string
 *   Received: undefined
 *   Hint: Provide html as a string, e.g., '<html>...</html>'
 * ```
 */
export function formatDetailedError(error: DetailedValidationError): string {
  const locale = currentLocale;
  const lines: string[] = [];

  // ヘッダー
  lines.push(
    locale === 'ja'
      ? `バリデーションエラー: ${error.message}`
      : `Validation Error: ${error.message}`
  );

  // フィールド
  if (error.field) {
    lines.push(`  ${locale === 'ja' ? 'フィールド' : 'Field'}: ${error.field}`);
  }

  // 期待値
  if (error.expected) {
    lines.push(`  ${locale === 'ja' ? '期待値' : 'Expected'}: ${error.expected}`);
  }

  // 受信値
  if (error.received !== undefined) {
    lines.push(`  ${locale === 'ja' ? '受信値' : 'Received'}: ${error.received}`);
  }

  // ヒント
  if (error.hint) {
    lines.push(`  ${locale === 'ja' ? 'ヒント' : 'Hint'}: ${error.hint}`);
  }

  return lines.join('\n');
}

/**
 * 複数の詳細エラーをフォーマット
 */
export function formatMultipleDetailedErrors(
  errors: DetailedValidationError[],
  separator: string = '\n\n'
): string {
  return errors.map(formatDetailedError).join(separator);
}

// ============================================================================
// ツール固有のi18nエラーメッセージ
// ============================================================================

/**
 * ツール固有のエラーメッセージ定義
 */
const toolErrorMessages: Record<
  ErrorLocale,
  Record<string, Record<string, string>>
> = {
  en: {
    'layout.inspect': {
      SERVICE_UNAVAILABLE:
        'WebPage service is not available. Please use the "html" parameter to provide HTML content directly instead of using "id".',
      NOT_FOUND: 'WebPage not found with the specified ID.',
    },
  },
  ja: {
    'layout.inspect': {
      SERVICE_UNAVAILABLE:
        'WebPageサービスが利用できません。"id"パラメータの代わりに"html"パラメータを使用して、HTMLコンテンツを直接指定してください。',
      NOT_FOUND: '指定されたIDのWebPageが見つかりません。',
    },
  },
};

/**
 * ツール固有のi18nエラーメッセージを取得
 *
 * @param toolName - MCPツール名 (e.g., 'layout.inspect')
 * @param code - エラーコード (e.g., 'SERVICE_UNAVAILABLE')
 * @returns ローカライズされたエラーメッセージ、見つからない場合はundefined
 *
 * @example
 * ```typescript
 * const message = getToolErrorMessage('layout.inspect', 'SERVICE_UNAVAILABLE');
 * // en: 'WebPage service is not available...'
 * // ja: 'WebPageサービスが利用できません...'
 * ```
 */
export function getToolErrorMessage(
  toolName: string,
  code: string
): string | undefined {
  const locale = currentLocale;
  const localeMessages = toolErrorMessages[locale];
  const toolMessages = localeMessages[toolName];
  return toolMessages?.[code];
}
