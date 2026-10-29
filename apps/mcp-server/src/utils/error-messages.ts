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
 * @module @reftrixmcp/mcp-server/utils/error-messages
 */

import { ZodError, type ZodIssue } from "zod";
import { UNRECOGNIZED_KEYS_TEXT, formatIssuePath } from "./issue-path";

export { formatIssuePath };

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
export type ErrorLocale = "en" | "ja";

/**
 * エラーコード定義
 */
export const ERROR_CODES = {
  INVALID_UUID: "INVALID_UUID",
  REQUIRED_FIELD: "REQUIRED_FIELD",
  OUT_OF_RANGE: "OUT_OF_RANGE",
  INVALID_ENUM: "INVALID_ENUM",
  STRING_TOO_SHORT: "STRING_TOO_SHORT",
  STRING_TOO_LONG: "STRING_TOO_LONG",
  INVALID_TYPE: "INVALID_TYPE",
  INVALID_FORMAT: "INVALID_FORMAT",
  ARRAY_TOO_LONG: "ARRAY_TOO_LONG",
  ARRAY_TOO_SHORT: "ARRAY_TOO_SHORT",
  CUSTOM_ERROR: "CUSTOM_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
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
  // The offending value is not available from a size issue (only the limit is), so the message
  // states the limit and never presents it as the value.
  OUT_OF_RANGE: (min?: number, max?: number): string => {
    if (min !== undefined && max !== undefined) {
      return `Value is out of range (min: ${min}, max: ${max})`;
    }
    if (min !== undefined) {
      return `Value is too small (min: ${min})`;
    }
    if (max !== undefined) {
      return `Value is too large (max: ${max})`;
    }
    return `Value is out of range`;
  },
  INVALID_ENUM: (value: string, options: string[]): string =>
    `Invalid value '${value}'. Expected one of: ${options.join(", ")}`,
  STRING_TOO_SHORT: (field: string, min: number): string =>
    `Field '${field}' must have at least ${min} character${min === 1 ? "" : "s"}`,
  STRING_TOO_LONG: (field: string, max: number): string =>
    `Field '${field}' must have at most ${max} character${max === 1 ? "" : "s"}`,
  INVALID_TYPE: (expected: string, received: string): string =>
    `Expected ${expected}, but received ${received}`,
  INVALID_FORMAT: (field: string, format: string): string =>
    `Field '${field}' does not match the required format: ${format}`,
  ARRAY_TOO_LONG: (field: string, max: number): string =>
    `Array '${field}' must have at most ${max} item${max === 1 ? "" : "s"}`,
  ARRAY_TOO_SHORT: (field: string, min: number): string =>
    `Array '${field}' must have at least ${min} item${min === 1 ? "" : "s"}`,
  CUSTOM_ERROR: (message: string): string => message,
  UNKNOWN_ERROR: (message: string): string => `Validation error: ${message}`,
};

/**
 * 日本語のエラーメッセージテンプレート
 */
const japaneseMessages = {
  INVALID_UUID: (_field: string): string =>
    `UUID形式が無効です。期待される形式: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`,
  REQUIRED_FIELD: (field: string): string => `必須フィールド '${field}' が指定されていません`,
  OUT_OF_RANGE: (min?: number, max?: number): string => {
    if (min !== undefined && max !== undefined) {
      return `値は範囲外です (最小: ${min}, 最大: ${max})`;
    }
    if (min !== undefined) {
      return `値は小さすぎます (最小: ${min})`;
    }
    if (max !== undefined) {
      return `値は大きすぎます (最大: ${max})`;
    }
    return `値は範囲外です`;
  },
  INVALID_ENUM: (value: string, options: string[]): string =>
    `値 '${value}' は無効です。次のいずれかを指定してください: ${options.join(", ")}`,
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
let currentLocale: ErrorLocale = (process.env.MCP_ERROR_LOCALE as ErrorLocale) ?? "en";

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
  return currentLocale === "ja" ? japaneseMessages : englishMessages;
}

// ============================================================================
// ZodError変換関数
// ============================================================================

/**
 * ZodIssueからフィールドパスを取得
 */
function getFieldPath(issue: ZodIssue): string {
  // zod 4 の path は symbol を含みうる（join は symbol で TypeError になる）
  return formatIssuePath(issue.path);
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
 * zod 3 / zod 4 の両方の issue 形に対応するための正規化。
 * - zod 3: invalid_string(validation) / invalid_enum_value(options, received) / too_small(type) / invalid_type(received)
 * - zod 4: invalid_format(format) / invalid_value(values) / too_small(origin) / invalid_type(received なし)
 * クライアントに返す文言と分類は、どちらの形でも同じになるようにする。
 *
 * Normalizes zod 3 and zod 4 issue shapes so that classification and client-facing text
 * are identical for both.
 */
type IssueRecord = Readonly<Record<string, unknown>>;

type NormalizedIssue =
  | { kind: "format"; format: unknown }
  | { kind: "type"; expected: string; received: string; missing: boolean }
  | { kind: "size"; bound: "min" | "max"; subject: string | undefined; limit: unknown }
  | { kind: "enum"; options: unknown[] }
  | { kind: "custom" }
  | { kind: "other" };

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number.NaN;
}

/** zod 4 の invalid_type は received を持たない。型名はメッセージ末尾（"received <type>"）から読む。入力値は読まない。 */
// Assumes zod's default English error map: the type name is parsed from the message text. With a locale or custom errorMap
// the text differs and REQUIRED_FIELD (undefined input) degrades to INVALID_TYPE.
function receivedTypeName(record: IssueRecord, message: string): string {
  if ("input" in record) {
    const input = record["input"];
    if (input === null) return "null";
    if (Array.isArray(input)) return "array";
    return typeof input;
  }
  const match = /received ([A-Za-z]+)\s*$/.exec(message);
  // SEC-B1-03: only a known type name is passed on; anything else read from the text is "unknown"
  return match?.[1] !== undefined && RECEIVED_TYPE_NAMES.has(match[1]) ? match[1] : "unknown";
}

/** Type names zod 4 prints after "received " (parsedType of the default English error map). */
const RECEIVED_TYPE_NAMES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "undefined",
  "null",
  "object",
  "array",
  "function",
  "date",
  "map",
  "set",
  "promise",
  "file",
  "nan",
  "Date",
  "Map",
  "Set",
  "Promise",
  "File",
  "NaN",
]);

type RawNormalizer = (record: IssueRecord, issue: ZodIssue) => NormalizedIssue;

function normalizeInvalidType(record: IssueRecord, issue: ZodIssue): NormalizedIssue {
  const expected = String(record["expected"]);
  const receivedField = record["received"]; // zod 3 only
  if (typeof receivedField === "string") {
    return {
      kind: "type",
      expected,
      received: receivedField,
      missing: receivedField === "undefined",
    };
  }
  const received = receivedTypeName(record, issue.message);
  return { kind: "type", expected, received, missing: received === "undefined" };
}

function normalizeSize(record: IssueRecord, issue: ZodIssue): NormalizedIssue {
  const isMin = String(issue.code) === "too_small";
  const subjectField = record["type"] ?? record["origin"]; // zod 3: type / zod 4: origin
  const subject = typeof subjectField === "string" ? subjectField : undefined;
  return {
    kind: "size",
    bound: isMin ? "min" : "max",
    subject: subject === "int" ? "number" : subject,
    limit: isMin ? record["minimum"] : record["maximum"],
  };
}

function normalizeEnum(record: IssueRecord): NormalizedIssue {
  const list = Array.isArray(record["options"]) ? record["options"] : record["values"];
  return {
    kind: "enum",
    options: Array.isArray(list) ? (list as unknown[]) : [],
  };
}

/** issue code -> normalizer. A code that is not listed is "other" (UNKNOWN_ERROR downstream). */
const NORMALIZERS: ReadonlyMap<string, RawNormalizer> = new Map<string, RawNormalizer>([
  ["invalid_string", (r): NormalizedIssue => ({ kind: "format", format: r["validation"] })], // zod 3
  ["invalid_format", (r): NormalizedIssue => ({ kind: "format", format: r["format"] })], // zod 4
  ["invalid_type", normalizeInvalidType],
  ["too_small", normalizeSize],
  ["too_big", normalizeSize],
  ["invalid_enum_value", normalizeEnum], // zod 3
  ["invalid_value", normalizeEnum], // zod 4
  ["custom", (): NormalizedIssue => ({ kind: "custom" })],
]);

function normalizeIssue(issue: ZodIssue): NormalizedIssue {
  const record: IssueRecord = { ...issue };
  const normalizer = NORMALIZERS.get(String(record["code"]));
  return normalizer ? normalizer(record, issue) : { kind: "other" };
}

/** enum の受信値はクライアントに返さない（message にも details にも出さない）。固定文字列を使う。 */
const ENUM_VALUE_HIDDEN = "(hidden)";

type IssueOf<K extends NormalizedIssue["kind"]> = Extract<NormalizedIssue, { kind: K }>;

interface ConvertContext {
  messages: ReturnType<typeof getMessages>;
  field: string;
  issue: ZodIssue;
}

/** Size codes shared by convert and detailed extraction: subject -> bound -> code. */
const SIZE_CODES: ReadonlyMap<string, Readonly<Record<"min" | "max", string>>> = new Map([
  ["number", { min: ERROR_CODES.OUT_OF_RANGE, max: ERROR_CODES.OUT_OF_RANGE }],
  ["string", { min: ERROR_CODES.STRING_TOO_SHORT, max: ERROR_CODES.STRING_TOO_LONG }],
  ["array", { min: ERROR_CODES.ARRAY_TOO_SHORT, max: ERROR_CODES.ARRAY_TOO_LONG }],
]);

function sizeCode(subject: string | undefined, bound: "min" | "max"): string | undefined {
  return subject === undefined ? undefined : SIZE_CODES.get(subject)?.[bound];
}

function convertFormat(n: IssueOf<"format">, ctx: ConvertContext): McpToolError {
  // UUID形式エラーを検出
  if (n.format === "uuid") {
    return createMcpToolError(
      ERROR_CODES.INVALID_UUID,
      ctx.messages.INVALID_UUID(ctx.field),
      ctx.field
    );
  }
  // その他の文字列フォーマットエラー
  return createMcpToolError(
    ERROR_CODES.INVALID_FORMAT,
    ctx.messages.INVALID_FORMAT(ctx.field, typeof n.format === "string" ? n.format : "unknown"),
    ctx.field
  );
}

function convertType(n: IssueOf<"type">, ctx: ConvertContext): McpToolError {
  // 必須フィールド欠落（undefined）
  if (n.missing) {
    return createMcpToolError(
      ERROR_CODES.REQUIRED_FIELD,
      ctx.messages.REQUIRED_FIELD(ctx.field),
      ctx.field
    );
  }
  // 型の不一致
  return createMcpToolError(
    ERROR_CODES.INVALID_TYPE,
    ctx.messages.INVALID_TYPE(n.expected, n.received),
    ctx.field,
    { expected: n.expected, received: n.received }
  );
}

type SizeTextKey = "STRING_TOO_SHORT" | "STRING_TOO_LONG" | "ARRAY_TOO_SHORT" | "ARRAY_TOO_LONG";

const STRING_SIZE_TEXTS: Readonly<Record<"min" | "max", SizeTextKey>> = {
  min: "STRING_TOO_SHORT",
  max: "STRING_TOO_LONG",
};

const ARRAY_SIZE_TEXTS: Readonly<Record<"min" | "max", SizeTextKey>> = {
  min: "ARRAY_TOO_SHORT",
  max: "ARRAY_TOO_LONG",
};

function sizeMessage(n: IssueOf<"size">, ctx: ConvertContext, limit: number): string {
  const isMin = n.bound === "min";
  if (n.subject === "number") {
    // issue にはもう一方の境界がないため、片側のみ返す
    return ctx.messages.OUT_OF_RANGE(isMin ? limit : undefined, isMin ? undefined : limit);
  }
  // number is handled above; convertSize only passes string / array otherwise
  const texts = n.subject === "string" ? STRING_SIZE_TEXTS : ARRAY_SIZE_TEXTS;
  return ctx.messages[texts[n.bound]](ctx.field, limit);
}

/** number / string / array only; any other subject falls back to UNKNOWN_ERROR. */
function convertSize(n: IssueOf<"size">, ctx: ConvertContext): McpToolError | undefined {
  const code = sizeCode(n.subject, n.bound);
  if (code === undefined) return undefined;
  return createMcpToolError(code, sizeMessage(n, ctx, toNumber(n.limit)), ctx.field, {
    [n.bound]: n.limit,
  });
}

function convertEnum(n: IssueOf<"enum">, ctx: ConvertContext): McpToolError {
  // The received value is never returned (SEC-B1-01): neither in the message nor in details.
  return createMcpToolError(
    ERROR_CODES.INVALID_ENUM,
    ctx.messages.INVALID_ENUM(ENUM_VALUE_HIDDEN, n.options.map(String)),
    ctx.field,
    { options: n.options }
  );
}

function convertCustom(_n: IssueOf<"custom">, ctx: ConvertContext): McpToolError {
  return createMcpToolError(
    ERROR_CODES.CUSTOM_ERROR,
    ctx.messages.CUSTOM_ERROR(ctx.issue.message ?? "Custom validation failed"),
    ctx.field
  );
}

type IssueHandlers<R> = {
  [K in NormalizedIssue["kind"]]: (n: IssueOf<K>, ctx: ConvertContext) => R;
};

/** One handler per normalized kind; "other" has none and falls back to UNKNOWN_ERROR. */
const CONVERT_HANDLERS: IssueHandlers<McpToolError | undefined> = {
  format: convertFormat,
  type: convertType,
  size: convertSize,
  enum: convertEnum,
  custom: convertCustom,
  other: () => undefined,
};

/**
 * Fallback for an issue with no dedicated code. The default message of `unrecognized_keys` carries
 * the key names the client sent (SEC-B1-01), so that issue gets a fixed text instead.
 */
function convertUnknown(issue: ZodIssue, ctx: ConvertContext): McpToolError {
  const text = String(issue.code) === "unrecognized_keys" ? UNRECOGNIZED_KEYS_TEXT : issue.message;
  return createMcpToolError(ERROR_CODES.UNKNOWN_ERROR, ctx.messages.UNKNOWN_ERROR(text), ctx.field);
}

/** Looks up the handler for the normalized kind; the single cast of the handler tables. */
function dispatch<R>(table: IssueHandlers<R>, n: NormalizedIssue, ctx: ConvertContext): R {
  return (table[n.kind] as (n: NormalizedIssue, c: ConvertContext) => R)(n, ctx);
}

/** Converts an already-normalized issue (normalize runs once per issue in the callers). */
function convertNormalized(normalized: NormalizedIssue, ctx: ConvertContext): McpToolError {
  // 未知のエラータイプ・未対応の size subject はフォールバック
  return dispatch(CONVERT_HANDLERS, normalized, ctx) ?? convertUnknown(ctx.issue, ctx);
}

/**
 * ZodIssueを個別のMcpToolErrorに変換
 */
function convertIssueToError(issue: ZodIssue): McpToolError {
  const ctx: ConvertContext = { messages: getMessages(), field: getFieldPath(issue), issue };
  return convertNormalized(normalizeIssue(issue), ctx);
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
    throw new Error("formatZodError requires a ZodError instance");
  }

  if (zodError.issues.length === 0) {
    return [];
  }

  // min/maxの情報を保持するために、同じフィールドのエラーをマージする
  const errorMap = new Map<string, McpToolError>();

  for (const issue of zodError.issues) {
    const error = convertIssueToError(issue);
    const key = `${error.field ?? ""}:${error.code}`;

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
        const messages = getMessages();
        existing.message = messages.OUT_OF_RANGE(min, max);
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
  const fieldPart = error.field ? `[${error.field}] ` : "";
  return `${fieldPart}${error.message}`;
}

/**
 * McpToolError配列を単一のエラーメッセージ文字列に結合
 *
 * @param errors - エラーの配列
 * @param separator - 区切り文字（デフォルト: ', '）
 * @returns 結合されたエラーメッセージ
 */
export function formatMultipleErrors(errors: McpToolError[], separator: string = ", "): string {
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
function generateHintForField(field: string, code: string, locale: ErrorLocale): string {
  const hints: Record<ErrorLocale, Record<string, Record<string, string>>> = {
    en: {
      html: {
        [ERROR_CODES.REQUIRED_FIELD]: "Provide html content as a string, e.g., '<html>...</html>'",
        [ERROR_CODES.STRING_TOO_SHORT]:
          "HTML content must not be empty. Provide valid HTML markup.",
      },
      name: {
        [ERROR_CODES.REQUIRED_FIELD]: "Provide a name for the asset, e.g., 'landing-page'",
        [ERROR_CODES.STRING_TOO_SHORT]: "Name must be at least 1 character.",
        [ERROR_CODES.STRING_TOO_LONG]: "Name must be at most 200 characters.",
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
          "Provide a valid UUID in format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
      pageId: {
        [ERROR_CODES.INVALID_UUID]:
          "Provide a valid UUID for pageId in format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
      design_system_id: {
        [ERROR_CODES.INVALID_UUID]:
          "Provide a valid UUID for design_system_id in format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
    },
    ja: {
      html: {
        [ERROR_CODES.REQUIRED_FIELD]:
          "htmlコンテンツを文字列として指定してください。例: '<html>...</html>'",
        [ERROR_CODES.STRING_TOO_SHORT]:
          "HTMLコンテンツは空にできません。有効なHTMLマークアップを指定してください。",
      },
      name: {
        [ERROR_CODES.REQUIRED_FIELD]: "アセットの名前を指定してください。例: 'landing-page'",
        [ERROR_CODES.STRING_TOO_SHORT]: "名前は1文字以上にしてください。",
        [ERROR_CODES.STRING_TOO_LONG]: "名前は200文字以下にしてください。",
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
          "UUIDを以下の形式で指定してください: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
      pageId: {
        [ERROR_CODES.INVALID_UUID]:
          "pageIdには有効なUUIDを指定してください: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
      design_system_id: {
        [ERROR_CODES.INVALID_UUID]:
          "design_system_idには有効なUUIDを指定してください: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
      },
    },
  };

  // フィールド名の最後の部分を取得（ネストされたパス対応）
  const fieldName = field.split(".").pop() ?? field;

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
function generateGenericHint(field: string, code: string, locale: ErrorLocale): string {
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
  return (
    templates[locale][ERROR_CODES.CUSTOM_ERROR] ??
    `Check the validation requirements for '${field}'.`
  );
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
      toolName === "motion.detect" &&
      (originalMessage.includes("pageId") || originalMessage.includes("html"))
    ) {
      return locale === "ja"
        ? "pageId または html のいずれか一方を指定してください。両方を指定することはできません。"
        : "Specify either pageId or html, but not both.";
    }

    // layout.inspect の排他制御
    if (
      toolName === "layout.inspect" &&
      (originalMessage.includes("id") || originalMessage.includes("html"))
    ) {
      return locale === "ja"
        ? "id または html のいずれか一方を指定してください。"
        : "Specify either id or html, not both.";
    }
  }

  // フィールド固有のヒント
  return generateHintForField(field, code, locale);
}

interface DetailParts {
  code: string;
  expected?: string;
  received?: string;
}

const FORMAT_EXPECTED: ReadonlyMap<string, string> = new Map([
  ["uuid", "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"],
  ["url", "https://example.com"],
]);

function detailFormat(n: IssueOf<"format">): DetailParts {
  const code = n.format === "uuid" ? ERROR_CODES.INVALID_UUID : ERROR_CODES.INVALID_FORMAT;
  const known = typeof n.format === "string" ? FORMAT_EXPECTED.get(n.format) : undefined;
  return { code, expected: known ?? String(n.format) };
}

const DETAIL_HANDLERS: IssueHandlers<DetailParts> = {
  type: (n) => ({
    code: n.missing ? ERROR_CODES.REQUIRED_FIELD : ERROR_CODES.INVALID_TYPE,
    expected: n.expected,
    received: n.received,
  }),
  format: detailFormat,
  // too_small / too_big は受信値を持たない（zod 3 / 4 共通）
  size: (n) => ({
    code: sizeCode(n.subject, n.bound) ?? ERROR_CODES.OUT_OF_RANGE,
    expected: `${n.bound === "min" ? ">=" : "<="} ${String(n.limit)}`,
  }),
  enum: (n) => ({
    code: ERROR_CODES.INVALID_ENUM,
    expected: n.options.map(String).join(", "),
  }),
  custom: () => ({ code: ERROR_CODES.CUSTOM_ERROR }),
  other: () => ({ code: ERROR_CODES.UNKNOWN_ERROR }),
};

/**
 * ZodIssueから詳細なエラー情報を抽出
 */
function extractDetailedError(issue: ZodIssue): DetailedValidationError {
  const field = getFieldPath(issue);
  const normalized = normalizeIssue(issue);
  const ctx: ConvertContext = { messages: getMessages(), field, issue };
  const detail = dispatch(DETAIL_HANDLERS, normalized, ctx);

  // ローカライズされたメッセージとヒントを生成
  const message = convertNormalized(normalized, ctx).message;
  const hint = generateHintForField(field || "root", detail.code, currentLocale);

  // exactOptionalPropertyTypes対応: undefinedを明示的に除外
  const result: DetailedValidationError = {
    field: field || "root",
    code: detail.code,
    message,
    hint,
  };
  if (detail.expected !== undefined) {
    result.expected = detail.expected;
  }
  if (detail.received !== undefined) {
    result.received = detail.received;
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
    throw new Error("formatDetailedValidationError requires a ZodError instance");
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
    throw new Error("createValidationErrorWithHints requires a ZodError instance");
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
    locale === "ja"
      ? `バリデーションエラー: ${error.message}`
      : `Validation Error: ${error.message}`
  );

  // フィールド
  if (error.field) {
    lines.push(`  ${locale === "ja" ? "フィールド" : "Field"}: ${error.field}`);
  }

  // 期待値
  if (error.expected) {
    lines.push(`  ${locale === "ja" ? "期待値" : "Expected"}: ${error.expected}`);
  }

  // 受信値
  if (error.received !== undefined) {
    lines.push(`  ${locale === "ja" ? "受信値" : "Received"}: ${error.received}`);
  }

  // ヒント
  if (error.hint) {
    lines.push(`  ${locale === "ja" ? "ヒント" : "Hint"}: ${error.hint}`);
  }

  return lines.join("\n");
}

/**
 * 複数の詳細エラーをフォーマット
 */
export function formatMultipleDetailedErrors(
  errors: DetailedValidationError[],
  separator: string = "\n\n"
): string {
  return errors.map(formatDetailedError).join(separator);
}

// ============================================================================
// ツール固有のi18nエラーメッセージ
// ============================================================================

/**
 * ツール固有のエラーメッセージ定義
 */
const toolErrorMessages: Record<ErrorLocale, Record<string, Record<string, string>>> = {
  en: {
    "layout.inspect": {
      SERVICE_UNAVAILABLE:
        'WebPage service is not available. Please use the "html" parameter to provide HTML content directly instead of using "id".',
      NOT_FOUND: "WebPage not found with the specified ID.",
    },
  },
  ja: {
    "layout.inspect": {
      SERVICE_UNAVAILABLE:
        'WebPageサービスが利用できません。"id"パラメータの代わりに"html"パラメータを使用して、HTMLコンテンツを直接指定してください。',
      NOT_FOUND: "指定されたIDのWebPageが見つかりません。",
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
export function getToolErrorMessage(toolName: string, code: string): string | undefined {
  const locale = currentLocale;
  const localeMessages = toolErrorMessages[locale];
  const toolMessages = localeMessages[toolName];
  return toolMessages?.[code];
}
