// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Single source for every row where zod 4 output may differ from the zod 3 golden (TPA-B1-03 /
 * TPA-B2A-04). Bulk regeneration of the golden is forbidden; a row is the only way to let a case differ.
 * The 4a / 4b golden comparisons (when zod 4 is installed), the expected values of the bundled
 * zod/v4 test and its closed-set check are all derived from this table.
 *
 * kind "code":    the client-visible error code or field differs (BREAKING, 3 CHANGELOGs).
 * kind "message": code and field are unchanged, only message text / details differ. Non-breaking only
 *                 for 4a; a row whose scope includes 4b is BREAKING for 4b (the raw text the raw-join
 *                 sites send changes; ADR-0051 D1).
 *
 * scope (TPA-B2B-01): which golden comparison the row lets differ.
 *   "4a"   the converted output (formatZodError / formatDetailedValidationError) differs;
 *   "4b"   only the raw default zod message (the text the raw-join sites send) differs;
 *   "both" both differ. The 4a comparison and the bundled-zod/v4 closed set use the rows whose
 *   scope includes 4a; the 4b snapshot comparison skips the rows whose scope includes 4b.
 */
import { createRequire } from "node:module";

export type AllowKind = "code" | "message";
export type AllowScope = "4a" | "4b" | "both";

export interface GoldenAllowRow {
  id: string;
  /** zod major from which the difference exists */
  since: 4;
  kind: AllowKind;
  scope: AllowScope;
  reason: string;
  /** kind "code" only: converted code + field the real zod 4 issues must produce */
  expected?: ReadonlyArray<{ code: string; field?: string }>;
  /**
   * kind "message" only: names of the detail properties (besides `message`) that may differ from the
   * zod 3 golden, at any depth. Everything else must equal it (TDA-PRE2A-L-04).
   */
  changes?: readonly string[];
}

type Expected = NonNullable<GoldenAllowRow["expected"]>;
const code = (id: string, reason: string, expected: Expected): GoldenAllowRow => ({
  id,
  since: 4,
  kind: "code",
  scope: "both",
  reason,
  expected,
});
const message = (id: string, reason: string, changes?: readonly string[]): GoldenAllowRow => ({
  id,
  since: 4,
  kind: "message",
  scope: "both",
  reason,
  ...(changes ? { changes } : {}),
});

/**
 * Cases whose converted output (4a) is unchanged on zod 4 but whose raw default zod message (4b)
 * is not: measured against the zod/v4 bundled in zod 3.25.76, 27 of the 38 raw-join differences of the original 42 cases.
 * (The other 4 cases, custom-refine, custom-refine-default-message, union-no-match-sentinel and
 * discriminated-union-no-match-sentinel, produce the same raw text on both majors; measured on 4.6.7.)
 */
const RAW_JOIN_ONLY_IDS: readonly string[] = [
  "required-missing",
  "type-number-for-string",
  "type-null-for-string",
  "type-array-for-boolean",
  "uuid-invalid-sentinel",
  "url-invalid-sentinel",
  "email-invalid-sentinel",
  "regex-invalid-sentinel",
  "string-too-short",
  "string-too-long-sentinel",
  "array-too-short",
  "array-too-long",
  "array-element-type",
  "record-value-type",
  "required-nested-missing",
  "type-string-for-number-sentinel",
  "uuid-valid-other-field-invalid",
  "string-not-datetime-sentinel",
  "string-length-exact-sentinel",
  "array-length-exact",
  // 4.6.7 reports the tuple shortfall as one too_small on the tuple (same converted output as zod 3)
  "tuple-element-type-and-length",
];

const rawJoinOnly = (id: string): GoldenAllowRow => ({
  id,
  since: 4,
  kind: "message",
  scope: "4b",
  reason: "converted output unchanged; the default zod message text (raw join) is reworded",
});

const NON_STRING_ENUM = "v3 reports invalid_type for a non-string enum input; v4 invalid_value";

export const GOLDEN_ALLOWLIST: readonly GoldenAllowRow[] = [
  code("enum-invalid-number", NON_STRING_ENUM, [{ code: "INVALID_ENUM", field: "mode" }]),
  code("multiple-issues-order", NON_STRING_ENUM, [
    { code: "REQUIRED_FIELD", field: "a" },
    { code: "OUT_OF_RANGE", field: "b" },
    { code: "INVALID_ENUM", field: "c" },
  ]),
  code(
    "instanceof-mismatch-sentinel",
    "v3 custom ('Input not instance of Date'); v4 (4.6.7) invalid_type with expected 'Date'",
    [{ code: "INVALID_TYPE", field: "d" }]
  ),
  code(
    "literal-mismatch-sentinel",
    "v3 invalid_literal; v4 invalid_value (mapped to INVALID_ENUM)",
    [{ code: "INVALID_ENUM", field: "v" }]
  ),
  code("number-not-finite", "v3 not_finite; v4 rejects Infinity as invalid_type first", [
    { code: "INVALID_TYPE", field: "n" },
  ]),
  message(
    "enum-invalid-sentinel",
    "INVALID_ENUM on both; v4 drops the received value (known echo ends)",
    ["received"]
  ),
  message(
    "strict-unrecognized-key-sentinel",
    "UNKNOWN_ERROR on both; unrecognized-key wording changes"
  ),
  message("number-not-int", "INVALID_TYPE on both; names change (integer,float -> int,number)", [
    "expected",
    "received",
  ]),
  message(
    "size-bigint-too-small",
    "UNKNOWN_ERROR on both (no dedicated bigint size code); v3 'Number must be...' -> v4 'Too small: expected bigint...'"
  ),
  message(
    "size-set-too-small",
    "UNKNOWN_ERROR on both (no dedicated set size code); v3 'Invalid input' -> v4 'Too small: expected set...'"
  ),
  message(
    "string-not-startswith-sentinel",
    "INVALID_FORMAT on both; format name 'unknown' -> 'starts_with'; detailed expected '[object Object]' -> 'starts_with'",
    ["expected"]
  ),
  message(
    "string-not-endswith-sentinel",
    "INVALID_FORMAT on both; format name 'unknown' -> 'ends_with'; detailed expected '[object Object]' -> 'ends_with'",
    ["expected"]
  ),
  // TDA-B1-07: the OUT_OF_RANGE text no longer shows the limit as the value ("Value 5 is too small
  // (min: 5)" -> "Value is too small (min: 5)"); code and field are unchanged. Both the converted
  // output (4a) and, because these are also raw-join rows, the default zod text (4b) differ.
  message(
    "number-too-small",
    "OUT_OF_RANGE on both; the limit is no longer shown as the value (TDA-B1-07)"
  ),
  message(
    "number-too-big",
    "OUT_OF_RANGE on both; the limit is no longer shown as the value (TDA-B1-07)"
  ),
  message(
    "number-too-small-and-too-big-merge",
    "OUT_OF_RANGE on both; the limit is no longer shown as the value (TDA-B1-07)"
  ),
  message(
    "number-not-nonnegative",
    "OUT_OF_RANGE on both; the limit is no longer shown as the value (TDA-B1-07)"
  ),
  message(
    "number-not-positive",
    "OUT_OF_RANGE on both; the limit is no longer shown as the value (TDA-B1-07)"
  ),
  message(
    "number-int-below-min",
    "OUT_OF_RANGE on both; the limit is no longer shown as the value (TDA-B1-07)"
  ),
  message(
    "number-int-above-max",
    "OUT_OF_RANGE on both; the limit is no longer shown as the value (TDA-B1-07)"
  ),
  ...RAW_JOIN_ONLY_IDS.map(rawJoinOnly),
];

export function installedZodVersion(): string {
  const pkg = createRequire(__filename)("zod/package.json") as { version: string };
  return pkg.version;
}

export function installedZodMajor(): number {
  return Number(installedZodVersion().split(".")[0]);
}

/** True when the row lets the given golden comparison differ. */
export function rowHasScope(row: GoldenAllowRow, scope: "4a" | "4b"): boolean {
  return row.scope === "both" || row.scope === scope;
}

/**
 * The allowlist row that lets `id` differ from the zod 3 golden of the given comparison (4a:
 * converted output, 4b: raw default message) on the given zod major, if any.
 */
export function allowedDifference(
  id: string,
  scope: "4a" | "4b",
  major: number = installedZodMajor()
): GoldenAllowRow | undefined {
  return GOLDEN_ALLOWLIST.find((r) => r.id === id && major >= r.since && rowHasScope(r, scope));
}
