// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: none (zod error contract; not one of the 4 standing domains)
 *
 * INV-ZOD-ERROR-MAPPING-001 (4a)        : formatZodError / formatDetailedValidationError output equals
 *                                          the golden taken on zod 3.x, and keeps equalling it after zod 4.
 * INV-ZOD-CLIENT-NO-INPUT-ECHO-001      : client-facing output does not echo input values (CWE-209).
 * v3/v4 dual-shape                      : zod 4 shaped issues (no `received`, renamed codes) get the same
 *                                          classification as the zod 3 ones.
 */
import { describe, it, expect, afterEach } from "vitest";
import { z, ZodError, type ZodIssue } from "zod";

import {
  ERROR_CODES,
  formatDetailedValidationError,
  formatZodError,
  setErrorMessageLocale,
} from "../../src/utils/error-messages";

import {
  ECHO_SENTINEL,
  RECORD_ECHO_CASES,
  ZOD_ERROR_CASES,
  type ZodErrorCase,
} from "./support/zod-error-cases";
import { allowedDifference } from "./support/zod-golden-allowlist";
import {
  MAPPING_GOLDEN_PATH,
  buildMappingGolden,
  codeAndField,
  readGolden,
  type ConvertedIssue,
  wire,
  writeGolden,
  assertGoldenUpdateAllowed,
  withoutMessages,
} from "./support/zod-error-golden";

afterEach(() => {
  setErrorMessageLocale("en");
});

/** Build a ZodError from hand-written issues (zod 4 shape) without depending on the installed major. */
function errorFrom(issues: Array<Record<string, unknown>>): ZodError {
  return new ZodError(issues as unknown as ZodIssue[]);
}

describe("INV-ZOD-ERROR-MAPPING-001 (4a golden, taken on zod 3.x)", () => {
  if (process.env["GOLDEN_UPDATE"] === "1") {
    it("writes the golden", () => {
      assertGoldenUpdateAllowed();
      writeGolden(MAPPING_GOLDEN_PATH, buildMappingGolden());
    });
    return;
  }

  const golden = readGolden(MAPPING_GOLDEN_PATH);

  it("golden covers every case in the matrix and nothing else", () => {
    expect(Object.keys(golden).sort()).toEqual(ZOD_ERROR_CASES.map((c) => c.id).sort());
  });

  const current = buildMappingGolden();
  for (const c of ZOD_ERROR_CASES) {
    it(`matches golden: ${c.id}`, () => {
      // after the zod 4 bump only rows in the allowlist may differ, and only in the declared kind
      const allowed = allowedDifference(c.id, "4a");
      if (allowed) {
        if (allowed.kind === "code") {
          const en = (current[c.id] as { en: ConvertedIssue[] }).en;
          expect(codeAndField(en)).toEqual(allowed.expected);
        } else {
          // a message row may change message text and its declared detail names only: everything
          // else equals the zod 3 golden
          expect(withoutMessages(current[c.id], allowed.changes)).toEqual(
            withoutMessages(golden[c.id], allowed.changes)
          );
        }
        return;
      }
      expect(current[c.id]).toEqual(golden[c.id]);
    });
  }
});

describe("size subjects without a dedicated code (SEC-B2C1-02 / TPA-B2C1-04)", () => {
  // date is built here, not in the golden: its default message embeds the machine's time zone and locale
  const date = z
    .object({ at: z.date().min(new Date("2026-01-01T00:00:00.000Z")) })
    .safeParse({ at: new Date("2025-01-01T00:00:00.000Z") });
  const errors: Array<[string, ZodError]> = [
    ["date", date.success ? errorFrom([]) : date.error],
    ...["size-bigint-too-small", "size-set-too-small"].map((id): [string, ZodError] => [
      id,
      (ZOD_ERROR_CASES.find((c) => c.id === id) as ZodErrorCase).run(),
    ]),
  ];

  for (const [name, err] of errors) {
    it(`${name}: converted to UNKNOWN_ERROR, detailed as OUT_OF_RANGE`, () => {
      expect(formatZodError(err).map((e) => e.code)).toEqual([ERROR_CODES.UNKNOWN_ERROR]);
      expect(formatDetailedValidationError(err).errors.map((e) => e.code)).toEqual([
        ERROR_CODES.OUT_OF_RANGE,
      ]);
    });
  }
});

/**
 * Known input echoes of the converted output. The set is empty: the enum received value and the
 * unrecognized_keys key names are not returned (SEC-B1-01), and a record key the client chose is
 * replaced in the field path (SEC-PRE-02), so it reaches neither field, hint nor message. A new
 * echo fails the test below; an entry would have to be added on purpose.
 * Key = case id, value = reason.
 */
const KNOWN_ECHO_GAPS: Record<string, string> = {};
const ECHO_CASES = [...ZOD_ERROR_CASES, ...RECORD_ECHO_CASES];

describe("INV-ZOD-CLIENT-NO-INPUT-ECHO-001", () => {
  for (const c of ECHO_CASES.filter((x) => x.carriesSentinel)) {
    it(`no sentinel echo (or pinned known gap): ${c.id}`, () => {
      const err = c.run();
      const out = JSON.stringify({
        en: formatZodError(err),
        detailed: formatDetailedValidationError(err),
      });
      const echoed = out.includes(ECHO_SENTINEL);
      if (c.id in KNOWN_ECHO_GAPS) {
        // tripwire: a pinned gap must still echo, so a closed gap has to leave the set
        expect(echoed).toBe(true);
      } else {
        expect(echoed).toBe(false);
      }
    });
  }

  it("echo gaps are limited to the pinned set", () => {
    const echoing = ECHO_CASES.filter((c) => c.carriesSentinel)
      .filter((c) => {
        const err = c.run();
        return JSON.stringify({
          a: formatZodError(err),
          b: formatDetailedValidationError(err),
        }).includes(ECHO_SENTINEL);
      })
      .map((c) => c.id)
      .sort();
    expect(echoing.every((id) => id in KNOWN_ECHO_GAPS)).toBe(true);
  });

  it("a zod 3 shaped enum issue (with received) and unrecognized_keys do not echo either", () => {
    const err = errorFrom([
      {
        code: "invalid_enum_value",
        options: ["fast", "slow"],
        received: ECHO_SENTINEL,
        path: ["mode"],
        message: `Invalid enum value. Expected 'fast' | 'slow', received '${ECHO_SENTINEL}'`,
      },
      {
        code: "unrecognized_keys",
        keys: [ECHO_SENTINEL],
        path: [],
        message: `Unrecognized key(s) in object: '${ECHO_SENTINEL}'`,
      },
    ]);
    const out = JSON.stringify({ a: formatZodError(err), b: formatDetailedValidationError(err) });
    expect(out).not.toContain(ECHO_SENTINEL);
    expect(out).not.toContain('"received"');
  });

  it("SEC-B1-03: an unknown type name read from the message text is reported as unknown", () => {
    const err = errorFrom([
      {
        code: "invalid_type",
        expected: "string",
        path: ["a"],
        message: `Invalid input: expected string, received ${ECHO_SENTINEL.replace(/[^A-Za-z]/g, "")}`,
      },
    ]);
    const out = formatZodError(err);
    expect(out[0]?.details).toEqual({ expected: "string", received: "unknown" });
  });

  it("zod 4 shaped enum issue (no received) cannot echo anything", () => {
    const err = errorFrom([
      {
        code: "invalid_value",
        values: ["fast", "slow"],
        path: ["mode"],
        message: `Invalid option: expected one of "fast"|"slow"`,
      },
    ]);
    const out = JSON.stringify({ a: formatZodError(err), b: formatDetailedValidationError(err) });
    expect(out).not.toContain(ECHO_SENTINEL);
    expect(formatZodError(err)[0]?.code).toBe(ERROR_CODES.INVALID_ENUM);
  });
});

describe("v3/v4 dual shape: zod 4 issues classify like zod 3 ones", () => {
  const golden = (): Record<
    string,
    { en: Array<{ code: string; message: string; field?: string }> }
  > =>
    (process.env["GOLDEN_UPDATE"] === "1" ? {} : readGolden(MAPPING_GOLDEN_PATH)) as Record<
      string,
      { en: Array<{ code: string; message: string; field?: string }> }
    >;

  it("missing required field (invalid_type, message ends with 'received undefined') -> REQUIRED_FIELD", () => {
    const err = errorFrom([
      {
        code: "invalid_type",
        expected: "string",
        path: ["query"],
        message: "Invalid input: expected string, received undefined",
      },
    ]);
    const [e] = formatZodError(err);
    expect(e?.code).toBe(ERROR_CODES.REQUIRED_FIELD);
    expect(e).toEqual(golden()["required-missing"]?.en[0]);
  });

  it("type mismatch -> INVALID_TYPE with expected/received type names", () => {
    const err = errorFrom([
      {
        code: "invalid_type",
        expected: "string",
        path: ["query"],
        message: "Invalid input: expected string, received number",
      },
    ]);
    const [e] = formatZodError(err);
    expect(e?.code).toBe(ERROR_CODES.INVALID_TYPE);
    expect(e).toEqual(golden()["type-number-for-string"]?.en[0]);
  });

  it("type mismatch with input present (reportInput on) classifies by input, not by message", () => {
    const err = errorFrom([
      {
        code: "invalid_type",
        expected: "string",
        path: ["query"],
        input: undefined,
        message: "custom text",
      },
    ]);
    expect(formatZodError(err)[0]?.code).toBe(ERROR_CODES.REQUIRED_FIELD);
  });

  it("invalid_format uuid -> INVALID_UUID", () => {
    const err = errorFrom([
      { code: "invalid_format", format: "uuid", path: ["id"], message: "Invalid UUID" },
    ]);
    expect(formatZodError(err)[0]).toEqual(golden()["uuid-invalid-sentinel"]?.en[0]);
  });

  it("invalid_format other -> INVALID_FORMAT with the format name", () => {
    const err = errorFrom([
      { code: "invalid_format", format: "url", path: ["url"], message: "Invalid URL" },
    ]);
    expect(formatZodError(err)[0]).toEqual(golden()["url-invalid-sentinel"]?.en[0]);
  });

  it("too_small with origin (not type) -> number / string / array classes", () => {
    const num = errorFrom([
      {
        code: "too_small",
        origin: "number",
        minimum: 1,
        inclusive: true,
        path: ["limit"],
        message: "x",
      },
    ]);
    expect(formatZodError(num)[0]?.code).toBe(ERROR_CODES.OUT_OF_RANGE);
    // the code, field, hint and details are the golden's; the text no longer shows the limit as the value
    expect(formatZodError(num)[0]).toEqual({
      ...golden()["number-too-small"]?.en[0],
      message: "Value is too small (min: 1)",
    });
    const str = errorFrom([
      {
        code: "too_small",
        origin: "string",
        minimum: 3,
        inclusive: true,
        path: ["query"],
        message: "x",
      },
    ]);
    expect(formatZodError(str)[0]).toEqual(golden()["string-too-short"]?.en[0]);
    const arr = errorFrom([
      {
        code: "too_small",
        origin: "array",
        minimum: 2,
        inclusive: true,
        path: ["ids"],
        message: "x",
      },
    ]);
    expect(formatZodError(arr)[0]).toEqual(golden()["array-too-short"]?.en[0]);
  });

  it("too_big with origin (not type) -> number / string / array classes", () => {
    const num = errorFrom([
      {
        code: "too_big",
        origin: "number",
        maximum: 10,
        inclusive: true,
        path: ["limit"],
        message: "x",
      },
    ]);
    expect(formatZodError(num)[0]).toEqual({
      ...golden()["number-too-big"]?.en[0],
      message: "Value is too large (max: 10)",
    });
    const str = errorFrom([
      {
        code: "too_big",
        origin: "string",
        maximum: 5,
        inclusive: true,
        path: ["query"],
        message: "x",
      },
    ]);
    expect(formatZodError(str)[0]?.code).toBe(ERROR_CODES.STRING_TOO_LONG);
    const arr = errorFrom([
      {
        code: "too_big",
        origin: "array",
        maximum: 1,
        inclusive: true,
        path: ["ids"],
        message: "x",
      },
    ]);
    expect(formatZodError(arr)[0]).toEqual(golden()["array-too-long"]?.en[0]);
  });

  it("invalid_value (renamed enum) -> INVALID_ENUM listing the options", () => {
    const err = errorFrom([
      {
        code: "invalid_value",
        values: ["fast", "slow"],
        path: ["mode"],
        message: "Invalid option",
      },
    ]);
    const [e] = formatZodError(err);
    expect(e?.code).toBe(ERROR_CODES.INVALID_ENUM);
    expect(e?.message).toContain("fast, slow");
    expect(e?.details?.["options"]).toEqual(["fast", "slow"]);
  });

  it("custom -> CUSTOM_ERROR keeps the message", () => {
    const err = errorFrom([{ code: "custom", path: ["a"], message: "custom rule failed" }]);
    expect(formatZodError(err)[0]).toEqual(golden()["custom-refine"]?.en[0]);
  });

  it("formatDetailedValidationError classifies zod 4 invalid_type / invalid_format the same way", () => {
    const err = errorFrom([
      {
        code: "invalid_type",
        expected: "string",
        path: ["q"],
        message: "Invalid input: expected string, received undefined",
      },
      { code: "invalid_format", format: "uuid", path: ["id"], message: "Invalid UUID" },
      {
        code: "too_small",
        origin: "string",
        minimum: 3,
        inclusive: true,
        path: ["s"],
        message: "x",
      },
    ]);
    const codes = formatDetailedValidationError(err).errors.map((e) => e.code);
    expect(codes).toEqual([
      ERROR_CODES.REQUIRED_FIELD,
      ERROR_CODES.INVALID_UUID,
      ERROR_CODES.STRING_TOO_SHORT,
    ]);
    expect(wire(formatDetailedValidationError(err).errors[0])).toMatchObject({
      field: "q",
      code: "REQUIRED_FIELD",
    });
  });
});
