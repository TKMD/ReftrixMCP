// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared case matrix for the zod error-contract tests (4a golden / 4b snapshot / no-echo).
 * Each case runs a real schema against an input and yields the real ZodError of the zod
 * version that is installed (3.x today, 4.x after the bump), so the same table can be
 * replayed after the major bump and compared with the golden taken on 3.x.
 */
import { z, ZodError } from "zod";

/** Marker that must never be echoed back to the client (CWE-209). */
export const ECHO_SENTINEL = "SECRET_SENTINEL_9f3a";

export interface ZodErrorCase {
  id: string;
  /** true when the input carries ECHO_SENTINEL */
  carriesSentinel: boolean;
  run: () => ZodError;
}

function failure(schema: z.ZodTypeAny, input: unknown): ZodError {
  const r = schema.safeParse(input);
  if (r.success) throw new Error("case unexpectedly parsed successfully");
  return r.error;
}

const UUID = "0190a0a0-0000-7000-8000-000000000000";

/** int with both bounds (TPA-B1-06): 1 and 10 pass, 0 and 11 are one outside. */
export const INT_RANGE_SCHEMA = z.object({ limit: z.number().int().min(1).max(10) });

export const ZOD_ERROR_CASES: ZodErrorCase[] = [
  {
    id: "required-missing",
    carriesSentinel: false,
    run: () => failure(z.object({ query: z.string() }), {}),
  },
  {
    id: "required-nested-missing",
    carriesSentinel: false,
    run: () => failure(z.object({ options: z.object({ depth: z.number() }) }), { options: {} }),
  },
  {
    id: "type-number-for-string",
    carriesSentinel: false,
    run: () => failure(z.object({ query: z.string() }), { query: 123 }),
  },
  {
    id: "type-null-for-string",
    carriesSentinel: false,
    run: () => failure(z.object({ query: z.string() }), { query: null }),
  },
  {
    id: "type-string-for-number-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ limit: z.number() }), { limit: ECHO_SENTINEL }),
  },
  {
    id: "type-array-for-boolean",
    carriesSentinel: false,
    run: () => failure(z.object({ flag: z.boolean() }), { flag: [] }),
  },
  {
    id: "uuid-invalid-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ id: z.string().uuid() }), { id: ECHO_SENTINEL }),
  },
  {
    id: "uuid-valid-other-field-invalid",
    carriesSentinel: false,
    run: () => failure(z.object({ id: z.string().uuid(), n: z.number() }), { id: UUID, n: "x" }),
  },
  {
    id: "url-invalid-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ url: z.string().url() }), { url: ECHO_SENTINEL }),
  },
  {
    id: "email-invalid-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ mail: z.string().email() }), { mail: ECHO_SENTINEL }),
  },
  {
    id: "regex-invalid-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ code: z.string().regex(/^[0-9]+$/) }), { code: ECHO_SENTINEL }),
  },
  {
    id: "enum-invalid-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ mode: z.enum(["fast", "slow"]) }), { mode: ECHO_SENTINEL }),
  },
  {
    id: "enum-invalid-number",
    carriesSentinel: false,
    run: () => failure(z.object({ mode: z.enum(["fast", "slow"]) }), { mode: 5 }),
  },
  {
    id: "number-too-small",
    carriesSentinel: false,
    run: () => failure(z.object({ limit: z.number().min(1) }), { limit: 0 }),
  },
  {
    id: "number-too-big",
    carriesSentinel: false,
    run: () => failure(z.object({ limit: z.number().max(10) }), { limit: 11 }),
  },
  {
    id: "number-too-small-and-too-big-merge",
    carriesSentinel: false,
    run: () => failure(z.object({ limit: z.number().min(5).max(3) }), { limit: 4 }),
  },
  {
    id: "number-not-int",
    carriesSentinel: false,
    run: () => failure(z.object({ limit: z.number().int() }), { limit: 1.5 }),
  },
  {
    id: "string-too-short",
    carriesSentinel: false,
    run: () => failure(z.object({ query: z.string().min(3) }), { query: "ab" }),
  },
  {
    id: "string-too-long-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ query: z.string().max(5) }), { query: ECHO_SENTINEL }),
  },
  {
    id: "array-too-short",
    carriesSentinel: false,
    run: () => failure(z.object({ ids: z.array(z.string()).min(2) }), { ids: ["a"] }),
  },
  {
    id: "array-too-long",
    carriesSentinel: false,
    run: () => failure(z.object({ ids: z.array(z.string()).max(1) }), { ids: ["a", "b"] }),
  },
  {
    id: "array-element-type",
    carriesSentinel: false,
    run: () => failure(z.object({ ids: z.array(z.string()) }), { ids: ["a", 2] }),
  },
  {
    id: "custom-refine",
    carriesSentinel: false,
    run: () =>
      failure(
        z
          .object({ a: z.string() })
          .refine(() => false, { message: "custom rule failed", path: ["a"] }),
        { a: "x" }
      ),
  },
  {
    id: "custom-refine-default-message",
    carriesSentinel: false,
    run: () =>
      failure(
        z.string().refine(() => false),
        "x"
      ),
  },
  {
    id: "strict-unrecognized-key-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ a: z.string() }).strict(), { a: "x", [ECHO_SENTINEL]: 1 }),
  },
  {
    id: "union-no-match-sentinel",
    carriesSentinel: true,
    run: () =>
      failure(z.object({ v: z.union([z.string(), z.number()]) }), { v: { k: ECHO_SENTINEL } }),
  },
  {
    id: "literal-mismatch-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ v: z.literal("on") }), { v: ECHO_SENTINEL }),
  },
  {
    id: "multiple-issues-order",
    carriesSentinel: false,
    run: () =>
      failure(z.object({ a: z.string(), b: z.number().min(1), c: z.enum(["x", "y"]) }), {
        b: 0,
        c: 1,
      }),
  },
  {
    id: "discriminated-union-no-match-sentinel",
    carriesSentinel: true,
    run: () =>
      failure(
        z.object({
          v: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("a") }),
            z.object({ kind: z.literal("b") }),
          ]),
        }),
        { v: { kind: ECHO_SENTINEL } }
      ),
  },
  {
    // the record key ("k") reaches the client as part of the path; a sentinel key is a PR-E fixture
    id: "record-value-type",
    carriesSentinel: false,
    run: () => failure(z.object({ m: z.record(z.string(), z.number()) }), { m: { k: "x" } }),
  },
  {
    id: "tuple-element-type-and-length",
    carriesSentinel: false,
    run: () => failure(z.object({ t: z.tuple([z.string(), z.number()]) }), { t: [1] }),
  },
  {
    id: "number-not-nonnegative",
    carriesSentinel: false,
    run: () => failure(z.object({ n: z.number().nonnegative() }), { n: -1 }),
  },
  {
    id: "number-not-positive",
    carriesSentinel: false,
    run: () => failure(z.object({ n: z.number().positive() }), { n: 0 }),
  },
  {
    id: "number-not-finite",
    carriesSentinel: false,
    run: () => failure(z.object({ n: z.number().finite() }), { n: Infinity }),
  },
  {
    id: "number-int-below-min",
    carriesSentinel: false,
    run: () => failure(INT_RANGE_SCHEMA, { limit: 0 }),
  },
  {
    id: "number-int-above-max",
    carriesSentinel: false,
    run: () => failure(INT_RANGE_SCHEMA, { limit: 11 }),
  },
  {
    id: "string-not-datetime-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ at: z.string().datetime() }), { at: ECHO_SENTINEL }),
  },
  {
    id: "string-not-startswith-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ u: z.string().startsWith("https://") }), { u: ECHO_SENTINEL }),
  },
  {
    id: "string-not-endswith-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ f: z.string().endsWith(".png") }), { f: ECHO_SENTINEL }),
  },
  {
    id: "string-length-exact-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ code: z.string().length(3) }), { code: ECHO_SENTINEL }),
  },
  {
    id: "array-length-exact",
    carriesSentinel: false,
    run: () => failure(z.object({ pair: z.array(z.string()).length(2) }), { pair: ["a"] }),
  },
  {
    id: "instanceof-mismatch-sentinel",
    carriesSentinel: true,
    run: () => failure(z.object({ d: z.instanceof(Date) }), { d: ECHO_SENTINEL }),
  },
  // size subjects without a dedicated code (SEC-B2C1-02 / TPA-B2C1-04): UNKNOWN_ERROR when converted,
  // OUT_OF_RANGE in the detailed form (PR-E resolves the asymmetry; until then it is pinned here).
  // date is not a golden case: its default message embeds the local time zone and locale of the
  // machine; see the date test in inv-zod-error-mapping-001.test.ts, which pins codes only.
  {
    id: "size-bigint-too-small",
    carriesSentinel: false,
    run: () => failure(z.object({ n: z.bigint().min(5n) }), { n: 1n }),
  },
  {
    id: "size-set-too-small",
    carriesSentinel: false,
    run: () => failure(z.object({ s: z.set(z.string()).min(2) }), { s: new Set(["a"]) }),
  },
];

/**
 * Record key-name cases (SEC-PRE-01, SEC-PRE-02); apart from ZOD_ERROR_CASES because the zod 3
 * golden has no rows for them. The record sits under a field that is in RECORD_KEY_FIELD_NAMES
 * (`styles`), as it does in the tool schemas; the key is the sentinel.
 */
const S = ECHO_SENTINEL;
export const RECORD_ECHO_CASES: ZodErrorCase[] = [
  {
    id: "record-string-bad-value-sentinel",
    carriesSentinel: true,
    run: () =>
      failure(z.object({ styles: z.record(z.string(), z.string()) }), { styles: { [S]: 1 } }),
  },
  {
    id: "record-string-max-bad-key-sentinel",
    carriesSentinel: true,
    run: () =>
      failure(z.object({ styles: z.record(z.string().max(3), z.string()) }), {
        styles: { [S]: "x" },
      }),
  },
  {
    // the value breaks a size limit: the message text carries the field (SEC-PRE-06)
    id: "record-string-value-too-long-sentinel",
    carriesSentinel: true,
    run: () =>
      failure(z.object({ styles: z.record(z.string(), z.string().max(2)) }), {
        styles: { [S]: "xxxx" },
      }),
  },
  {
    id: "partial-record-enum-unknown-key-sentinel",
    carriesSentinel: true,
    run: () =>
      failure(z.partialRecord(z.enum(["fast", "slow"]), z.string()), { fast: "x", [S]: "y" }),
  },
];
