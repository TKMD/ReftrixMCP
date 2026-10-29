// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Issue path formatting / issue path の文字列化
 *
 * zod 3 の path は string / number だけだが、zod 4 は `PropertyKey[]` で symbol を含みうる
 * （`join` は symbol で TypeError になり、検証エラーが内部エラーに化ける）。
 * 全 segment を `String()` で文字列化してから連結する。string / number の結果は `join(".")` と同一。
 *
 * zod 3 paths hold strings and numbers only, but zod 4 types them as `PropertyKey[]` and a
 * symbol can appear (`join` throws a TypeError on a symbol, turning a validation error into an
 * internal error). Every segment goes through `String()` before joining; the text for string /
 * number paths is the same as `join(".")`.
 */
export function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  return redactRecordKeys(path)
    .map((segment) => String(segment))
    .join(".");
}

/**
 * Names of the fields that hold a `z.record(z.string(), <value>)` whose value can fail. The segment
 * after such a name is a key the client chose, so it is not returned: the converter and the tools
 * put the formatted path into field / hint / message, and returning the key echoes the client's
 * own input. Records of `z.unknown()` with a bare `z.string()` key are left out: neither the value
 * nor the key can fail, so no issue carries a key. The method is by name, so an object field that
 * shares a registered name is redacted too, which only makes that path less specific
 * (`performance.evaluate` `budget.lcp_ms` reads `budget.[key]`, evaluate.tool.ts:72): do not add an
 * object field named like a registered name to a tool input. The set must equal the names found in
 * src and packages/<pkg>/src (INV-ZOD-RECORD-KEY-REDACTION-001).
 *
 * 値が失敗しうる `z.record(z.string(), ...)` のフィールド名。その直後の segment は client が選んだ
 * key なので返さない(key が素の `z.string()` で値が `z.unknown()` の record は対象外)。名前方式なので、
 * 登録名と同名の object フィールドも伏せられる(`budget.lcp_ms` は `budget.[key]`)。tool の入力に
 * 登録名と同名の object フィールドを作らない。src と packages/<pkg>/src の名前と一致させる。
 */
export const RECORD_KEY_FIELD_NAMES: ReadonlySet<string> = new Set([
  "budget",
  "categoryBreakdown",
  "color_mapping",
  "cssStyles",
  "css_variables",
  "googleFontsWeights",
  "patterns_by_scroll_position",
  "rotationAngles",
  "sectionTypes",
  "styles",
  "tokens",
]);

/** The text that stands in for a client-chosen record key. */
export const RECORD_KEY_PLACEHOLDER = "[key]";

/** Replace the segment after a record field name (every occurrence, so nested records work). */
export function redactRecordKeys(path: ReadonlyArray<PropertyKey>): PropertyKey[] {
  return path.map((segment, i) => {
    const prev = path[i - 1];
    // a record key is a string; an array index after a same-named array field is left as it is
    return typeof prev === "string" &&
      typeof segment === "string" &&
      RECORD_KEY_FIELD_NAMES.has(prev)
      ? RECORD_KEY_PLACEHOLDER
      : segment;
  });
}

/**
 * The text that stands in for the default message of an `unrecognized_keys` issue, which carries
 * the key names the client sent. The converter (error-messages.ts) and every place that returns an
 * issue text use this one text.
 *
 * `unrecognized_keys` の既定メッセージは client が送った key 名を含むので、この固定文言に置き換える。
 */
export const UNRECOGNIZED_KEYS_TEXT = "Unrecognized key in input";

/** The parts of a zod issue the formatters read (zod 3 and zod 4 issues both fit). */
export interface FormattableIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly code: string;
  readonly message: string;
}

/** The message of an issue that is safe to return to a client: fixed text for `unrecognized_keys`. */
export function formatIssueMessage(issue: Pick<FormattableIssue, "code" | "message">): string {
  return issue.code === "unrecognized_keys" ? UNRECOGNIZED_KEYS_TEXT : issue.message;
}

/**
 * `<path>: <message>` for one issue: the redacted path plus the client-safe message. Raw joins of
 * `issue.message` go through this (INV-ZOD-ISSUE-PATH-JOIN-001 (d)).
 */
export function formatIssueLine(issue: FormattableIssue): string {
  return `${formatIssuePath(issue.path)}: ${formatIssueMessage(issue)}`;
}
