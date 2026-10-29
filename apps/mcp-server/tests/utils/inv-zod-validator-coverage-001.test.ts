// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: none (zod error contract; not one of the 4 standing domains)
 *
 * INV-ZOD-VALIDATOR-COVERAGE-001 (TPA-B2A-03): every zod method used by a client-reaching schema
 * either has a case in the 4a/4b case table or is listed as one that never produces an issue.
 * A new validator in a client-reaching schema fails here until its case (and golden row) is added,
 * on zod 3, while the v3 default message can still be taken.
 * Backstop (SEC-B2C2C-01): a type-checker pass over the same import closure lists every call whose
 * callee is declared in zod; that set must be a subset of what the syntactic scan found, so a
 * spelling the scan does not follow (a schema behind a property, a parameter, a return value)
 * cannot hide a validator.
 */
import * as path from "node:path";

import { describe, it, expect } from "vitest";
import { z } from "zod";

import {
  CLIENT_REACHING_MESSAGE_JOIN_SITES,
  FORMAT_ZOD_ERROR_CALLERS,
} from "./support/zod-client-reaching";
import {
  ECHO_SENTINEL,
  INT_RANGE_SCHEMA,
  RECORD_ECHO_CASES,
  ZOD_ERROR_CASES,
} from "./support/zod-error-cases";
import { packageCompilerOptions } from "./support/zod-errors-read-scan";
import {
  COVERED_VALIDATORS,
  NO_ISSUE_METHODS,
  TYPE_ONLY_ZOD_CALLS,
  UNUSED_COVERED_KEPT,
  relativeImportClosure,
  scanClientReachingZodMethods,
  typeCheckedZodMethods,
} from "./support/zod-validator-coverage";

const PKG_ROOT = path.resolve(__dirname, "../..");
const ENTRY_FILES = [
  ...new Set([...Object.keys(CLIENT_REACHING_MESSAGE_JOIN_SITES), ...FORMAT_ZOD_ERROR_CALLERS]),
].sort();

describe("INV-ZOD-VALIDATOR-COVERAGE-001 client-reaching validators are covered by the case table", () => {
  const used = scanClientReachingZodMethods(PKG_ROOT, ENTRY_FILES);

  it("the scan sees the schemas (not vacuous)", () => {
    expect(ENTRY_FILES).toHaveLength(29);
    for (const m of ["string", "number", "object", "enum", "int", "uuid", "refine"]) {
      expect(used.has(m)).toBe(true);
    }
  });

  it("every zod method used is covered by a case or listed as issue-free (fail-closed)", () => {
    const unknown = [...used]
      .filter((m) => !(m in COVERED_VALIDATORS) && !(m in NO_ISSUE_METHODS))
      .sort();
    expect(unknown).toEqual([]);
  });

  it("the type checker finds no zod call the syntactic scan missed (backstop)", () => {
    const files = [...relativeImportClosure(PKG_ROOT, ENTRY_FILES).keys()];
    const typed = typeCheckedZodMethods(files, packageCompilerOptions(PKG_ROOT));
    expect(typed.has("string")).toBe(true);
    expect(typed.size).toBeGreaterThanOrEqual(30);
    const missed = [...typed].filter((m) => !used.has(m) && !(m in TYPE_ONLY_ZOD_CALLS)).sort();
    expect(missed).toEqual([]);
    // every type-only entry is still seen, so the list cannot go stale
    expect(Object.keys(TYPE_ONLY_ZOD_CALLS).filter((m) => !typed.has(m))).toEqual([]);
  }, 60_000);

  it("covered and issue-free lists do not overlap", () => {
    expect(Object.keys(COVERED_VALIDATORS).filter((m) => m in NO_ISSUE_METHODS)).toEqual([]);
  });

  it("every case id named in the coverage table exists in the case table", () => {
    const ids = new Set([...ZOD_ERROR_CASES, ...RECORD_ECHO_CASES].map((c) => c.id));
    const missing = Object.entries(COVERED_VALIDATORS).flatMap(([m, cases]) =>
      cases.filter((id) => !ids.has(id)).map((id) => `${m} -> ${id}`)
    );
    expect(missing).toEqual([]);
  });

  it("every covered method is still used by a client-reaching schema, or kept with a reason (staleness)", () => {
    const unused = Object.keys(COVERED_VALIDATORS)
      .filter((m) => !used.has(m))
      .sort();
    expect(unused).toEqual(Object.keys(UNUSED_COVERED_KEPT).sort());
    for (const reason of Object.values(UNUSED_COVERED_KEPT))
      expect(reason.length).toBeGreaterThan(20);
  });

  it("strictObject and object().strict() give the same issues on the installed zod", () => {
    const input = { a: "x", [ECHO_SENTINEL]: 1 };
    const issues = (schema: z.ZodTypeAny): unknown => {
      const r = schema.safeParse(input);
      if (r.success) throw new Error("expected the unknown key to be rejected");
      return JSON.parse(JSON.stringify(r.error.issues));
    };
    const viaStrictObject = issues(z.strictObject({ a: z.string() }));
    const viaStrict = issues(z.object({ a: z.string() }).strict());
    expect(viaStrictObject).toEqual(viaStrict);
    expect(JSON.stringify(viaStrictObject)).toContain("unrecognized_keys");
  });

  it("every covered method names at least one case", () => {
    expect(Object.entries(COVERED_VALIDATORS).filter(([, c]) => c.length === 0)).toEqual([]);
  });
});

describe("INV-ZOD-VALIDATOR-COVERAGE-001 int boundaries (TPA-B1-06)", () => {
  it("the exact minimum and maximum pass", () => {
    expect(INT_RANGE_SCHEMA.safeParse({ limit: 1 }).success).toBe(true);
    expect(INT_RANGE_SCHEMA.safeParse({ limit: 10 }).success).toBe(true);
  });

  it("one below the minimum is too_small and one above the maximum is too_big", () => {
    const codes = (id: string): string[] | undefined =>
      ZOD_ERROR_CASES.find((c) => c.id === id)
        ?.run()
        .issues.map((i) => i.code);
    expect(codes("number-int-below-min")).toEqual(["too_small"]);
    expect(codes("number-int-above-max")).toEqual(["too_big"]);
  });
});
