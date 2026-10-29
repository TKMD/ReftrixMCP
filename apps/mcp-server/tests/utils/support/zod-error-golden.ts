// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Golden helpers for the zod error-contract tests. The golden JSON is taken on zod 3.x and
 * must stay byte-for-byte identical after the zod 4 bump (4a contract).
 * Regenerate only deliberately: GOLDEN_UPDATE=1 pnpm vitest run tests/utils/inv-zod-error-mapping-001.test.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import type { ZodIssue } from "zod";

import {
  formatDetailedValidationError,
  formatZodError,
  setErrorMessageLocale,
  getErrorMessageLocale,
} from "../../../src/utils/error-messages";

import { formatIssueLine } from "../../../src/utils/issue-path";

import { RECORD_ECHO_CASES, ZOD_ERROR_CASES, type ZodErrorCase } from "./zod-error-cases";
import { installedZodMajor, installedZodVersion } from "./zod-golden-allowlist";

export const MAPPING_GOLDEN_PATH = path.join(__dirname, "golden", "zod-error-mapping.golden.json");
export const RAWJOIN_GOLDEN_PATH = path.join(__dirname, "golden", "zod-error-rawjoin.golden.json");
/** Taken on zod 4.6.7 (TPA-L-2): every case, including the record key cases, compared with no allowlist. */
/**
 * The zod version the v4 goldens below were taken on. The goldens are compared with no allowlist,
 * so another version can differ legitimately: the v4 golden test fails until they are taken again
 * on the installed version (GOLDEN_UPDATE=1, after changing this constant).
 */
export const V4_GOLDEN_ZOD_VERSION = "4.6.7";
export const MAPPING_V4_GOLDEN_PATH = path.join(
  __dirname,
  "golden",
  "zod-error-mapping.v4.golden.json"
);
export const RAWJOIN_V4_GOLDEN_PATH = path.join(
  __dirname,
  "golden",
  "zod-error-rawjoin.v4.golden.json"
);
export const V4_GOLDEN_CASES: readonly ZodErrorCase[] = [...ZOD_ERROR_CASES, ...RECORD_ECHO_CASES];

/** JSON round trip so `undefined` properties behave exactly like they do on the wire. */
export function wire<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export type ConvertedIssue = { code: string; message: string; field?: string };

/** The client-visible classification of converted issues: code + field. */
export function codeAndField(
  issues: readonly ConvertedIssue[]
): Array<{ code: string; field?: string }> {
  return issues.map((e) => ({ code: e.code, field: e.field }));
}

export function buildMappingGolden(
  cases: readonly ZodErrorCase[] = ZOD_ERROR_CASES
): Record<string, unknown> {
  const previous = getErrorMessageLocale();
  const out: Record<string, unknown> = {};
  try {
    for (const c of cases) {
      const err = c.run();
      setErrorMessageLocale("en");
      const en = formatZodError(err);
      const detailed = formatDetailedValidationError(err);
      setErrorMessageLocale("ja");
      const ja = formatZodError(err);
      out[c.id] = wire({ en, ja, detailed });
    }
  } finally {
    setErrorMessageLocale(previous);
  }
  return out;
}

/** The "`path: message`" join with ", " that the raw-join snapshot and its echo check both use. */
export function rawJoin(issues: readonly ZodIssue[]): string {
  return issues.map((e) => formatIssueLine(e)).join(", ");
}

export function buildRawJoinSnapshot(
  cases: readonly ZodErrorCase[] = ZOD_ERROR_CASES
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of cases) {
    const err = c.run();
    // the "`path: message`" join with ", ". Not every client-reaching site uses this form: 6 sites join
    // with "; " and 2 narrative sites build a details array (see support/zod-client-reaching.ts)
    out[c.id] = { joined: rawJoin(err.issues), messages: err.issues.map((e) => e.message) };
  }
  return out;
}

export function readGolden(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

/** Writes the golden already formatted by prettier, so format:check passes without a second step. */
export function writeGolden(file: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
  const prettier = createRequire(__filename).resolve("prettier/bin/prettier.cjs");
  execFileSync(process.execPath, [prettier, "--write", file], { stdio: "pipe" });
}

/**
 * Guard for the GOLDEN_UPDATE branches: the goldens keep the zod 3 values (ADR-0051 D1), so they may
 * only be rewritten while zod 3 is installed. On zod 4, declare the differing rows in the allowlist.
 */
export function assertGoldenUpdateAllowed(major: number = installedZodMajor()): void {
  if (major !== 3) {
    throw new Error(
      `GOLDEN_UPDATE refused on zod ${major}: goldens keep the zod 3 values; declare rows in zod-golden-allowlist.ts instead`
    );
  }
}

/** Guard for the v4 goldens: they hold the values of the installed zod 4 and are only rewritten on it. */
export function assertV4GoldenUpdateAllowed(major: number = installedZodMajor()): void {
  if (major !== 4) {
    throw new Error(
      `GOLDEN_UPDATE for the v4 goldens refused on zod ${major}: they are taken on zod 4`
    );
  }
  if (installedZodVersion() !== V4_GOLDEN_ZOD_VERSION) {
    throw new Error(
      `GOLDEN_UPDATE for the v4 goldens: installed zod is ${installedZodVersion()}, set V4_GOLDEN_ZOD_VERSION to it first`
    );
  }
}

/**
 * The value with every `message` property (and the declared extra properties) removed at any depth:
 * the part of a golden a message row may change.
 */
export function withoutMessages(value: unknown, extra: readonly string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutMessages(v, extra));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== "message" && !extra.includes(k))
        .map(([k, v]) => [k, withoutMessages(v, extra)])
    );
  }
  return value;
}
