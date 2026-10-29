// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: none (zod error contract; not one of the 4 standing domains)
 *
 * INV-ZOD-SCANNER-FIXTURES-001: every form the zod scanners claim to see is detected in a fixture,
 * and the near-misses are not (TPA-B2B-02). The expected lines come from marker comments in the
 * fixture files, so a fixture cannot drift from its expectation silently. The scans of `src`
 * themselves are pinned in the rawjoin test; this file shows each of them can turn red.
 * Also pins that GOLDEN_UPDATE output is byte-identical to the committed golden (TDA-B2A-05).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import {
  MAPPING_GOLDEN_PATH,
  RAWJOIN_GOLDEN_PATH,
  buildMappingGolden,
  buildRawJoinSnapshot,
  writeGolden,
  assertGoldenUpdateAllowed,
} from "./support/zod-error-golden";
import { installedZodMajor } from "./support/zod-golden-allowlist";
import {
  scanFirstIssueInSource,
  scanFormatZodErrorCallers,
  scanMessageJoinInSource,
} from "./support/zod-message-join-scan";
import { packageCompilerOptions } from "./support/zod-errors-read-scan";
import { parseFile } from "./support/zod-scan-common";
import {
  relativeImportClosure,
  scanClientReachingZodMethods,
  typeCheckedZodMethods,
} from "./support/zod-validator-coverage";

const PKG_ROOT = path.resolve(__dirname, "../..");
const FIXTURES = "tests/utils/support/fixtures";
const source = (file: string): ReturnType<typeof parseFile> =>
  parseFile(PKG_ROOT, path.join(PKG_ROOT, FIXTURES, file));

/** `line:marker` for every marker comment `// <prefix>...` in the fixture. */
function marks(file: string, prefix: string): string[] {
  return fs
    .readFileSync(path.join(PKG_ROOT, FIXTURES, file), "utf8")
    .split("\n")
    .flatMap((text, i) => {
      const at = text.indexOf(`// ${prefix}`);
      return at < 0 ? [] : [`${i + 1}:${text.slice(at + 3 + prefix.length).trim()}`];
    });
}

describe("INV-ZOD-SCANNER-FIXTURES-001 message-join scan", () => {
  it("detects every join form (inline / named / unresolved callback, for-of, aliases, wrappers)", () => {
    const sites = scanMessageJoinInSource(source("join/violations.ts")).map(
      (s) => `${s.line}:${s.form}`
    );
    expect(sites).toEqual(marks("join/violations.ts", "JOIN:"));
    expect(new Set(sites.map((s) => s.split(":")[1]))).toEqual(
      new Set(["inline-callback", "named-callback", "unresolved-callback", "for-of"])
    );
  });

  it("does not report callbacks that do not read the message or lists that are not issue lists", () => {
    expect(scanMessageJoinInSource(source("join/negatives.ts"))).toEqual([]);
  });
});

describe("INV-ZOD-SCANNER-FIXTURES-001 first-issue scan", () => {
  it("detects index / at / find / shift / array-destructuring reads and the message reads through them", () => {
    const sites = scanFirstIssueInSource(source("join/first-issue.ts")).map(
      (s) => `${s.line}:${s.kind}`
    );
    const expected = fs
      .readFileSync(path.join(PKG_ROOT, FIXTURES, "join/first-issue.ts"), "utf8")
      .split("\n")
      .flatMap((text, i) => [
        ...(/\/\/ READ\b/.test(text) ? [`${i + 1}:first-issue-read`] : []),
        ...(/\/\/ (READ )?MSG\b/.test(text) ? [`${i + 1}:first-issue-message`] : []),
      ]);
    expect([...sites].sort()).toEqual([...expected].sort());
    expect(expected.length).toBeGreaterThan(15);
  });

  it("does not report plain length / slice / path reads", () => {
    expect(scanFirstIssueInSource(source("join/negatives.ts"))).toEqual([]);
  });
});

describe("INV-ZOD-SCANNER-FIXTURES-001 formatZodError callers (AST)", () => {
  it("finds calls, aliased imports, namespace access, re-exports and users of an exported wrapper, and skips unrelated files", () => {
    expect(scanFormatZodErrorCallers(PKG_ROOT, `${FIXTURES}/callers`)).toEqual(
      ["alias", "call", "namespace", "reexport", "wrapper"].map(
        (n) => `${FIXTURES}/callers/${n}.ts`
      )
    );
  });
});

describe("INV-ZOD-SCANNER-FIXTURES-001 validator method scan", () => {
  const methods = (...files: string[]): string[] =>
    [
      ...scanClientReachingZodMethods(
        PKG_ROOT,
        files.map((f) => `${FIXTURES}/validators/${f}`)
      ),
    ].sort();

  it("follows `import * as zod`, aliased `z`, direct named imports and a default import", () => {
    expect(methods("namespace-import.ts")).toEqual(["max", "min", "number", "string"]);
    expect(methods("default-import.ts")).toEqual(["startsWith", "string"]);
    expect(methods("aliased-import.ts")).toEqual(["max", "number"]);
    expect(methods("named-import.ts")).toEqual(["string", "url"]);
  });

  it("follows a chain stored in a variable, and stops at the call that runs the schema", () => {
    expect(methods("variable-chain.ts")).toEqual(["email", "max", "string"]);
  });

  it("follows an imported schema variable through the relative import", () => {
    expect(methods("imports-shared.ts")).toEqual(["string", "uuid"]);
  });

  it("ignores chains that do not start at zod", () => {
    expect(methods("non-zod.ts")).toEqual([]);
  });

  it("the type-checker backstop sees the forms the syntactic scan misses", () => {
    const entry = [`${FIXTURES}/validators/hidden-forms.ts`];
    const files = [...relativeImportClosure(PKG_ROOT, entry).keys()];
    const typed = typeCheckedZodMethods(files, packageCompilerOptions(PKG_ROOT));
    const scanned = scanClientReachingZodMethods(PKG_ROOT, entry);
    expect([...typed].filter((m) => !scanned.has(m)).sort()).toEqual([
      "boolean",
      "email",
      "int",
      "length",
      "max",
      "min",
      "number",
      "url",
      "uuid",
    ]);
  }, 60_000);
});

describe("INV-ZOD-SCANNER-FIXTURES-001 golden regeneration (TDA-B2A-05)", () => {
  // the committed goldens keep the zod 3 values; PR-E does not regenerate them (declare rows in the allowlist)
  const onZod3 = installedZodMajor() === 3;
  const regenerated = (data: Record<string, unknown>): string => {
    // next to the committed goldens, so prettier resolves the same config as for them
    const file = path.join(path.dirname(MAPPING_GOLDEN_PATH), `.regen-${process.pid}.json`);
    try {
      writeGolden(file, data);
      return fs.readFileSync(file, "utf8");
    } finally {
      fs.rmSync(file, { force: true });
    }
  };

  it.runIf(onZod3)("writeGolden output equals the committed mapping golden byte for byte", () => {
    expect(regenerated(buildMappingGolden())).toBe(fs.readFileSync(MAPPING_GOLDEN_PATH, "utf8"));
  });

  it.runIf(onZod3)(
    "writeGolden output equals the committed raw-join snapshot byte for byte",
    () => {
      expect(regenerated(buildRawJoinSnapshot())).toBe(
        fs.readFileSync(RAWJOIN_GOLDEN_PATH, "utf8")
      );
    }
  );
});

describe("INV-ZOD-SCANNER-FIXTURES-001 golden update guard (TPA-B2C2A-M1)", () => {
  it("throws when GOLDEN_UPDATE would run on zod 4", () => {
    expect(() => assertGoldenUpdateAllowed(4)).toThrow(/zod 3/);
  });

  it("passes on zod 3", () => {
    expect(() => assertGoldenUpdateAllowed(3)).not.toThrow();
  });
});
