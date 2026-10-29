// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: none (zod error contract; not one of the 4 standing domains)
 *
 * INV-ZOD-RECORD-KEY-REDACTION-001 (SEC-PRE-02): a key the client chose in a
 * `z.record(z.string(), <value>)` is not returned in an error. In the path of an issue the key
 * follows the name of the field that holds the record, so `formatIssuePath` (used by the converter
 * and by the tools that join the path) replaces the segment after such a name.
 *
 *  (a) the names in RECORD_KEY_FIELD_NAMES are exactly the fields of src and packages/<pkg>/src that
 *      hold a record whose key can fail (AST). The scan fails closed: a record that needs a name
 *      but is not the direct value of a named property (inside `z.array` / `z.tuple` / `z.map` /
 *      another record, or a top-level const), a key that is a variable other than an enum declared
 *      in the same file, and a record built through a root other than `z` are all reported
 *  (b) controls: the scan finds one-line and multi-line forms and skips unknown-valued (bare
 *      `z.string()` key only) and enum-keyed ones; every fail-closed form has a negative fixture
 *  (c) the path text: the key is replaced, other segments and array indexes are not
 *  (d) end to end through the converter: field, hint and message carry no key
 *
 * Cost of the name-based method: the replacement applies to every path that has a registered name
 * followed by a segment, so an object field with the same name in a tool that goes through the
 * converter is also made less specific (`budget.lcp_ms` reads `budget.[key]`; `budget` is the
 * `performance.evaluate` input object at src/tools/performance/evaluate.tool.ts:72). Do not add an
 * object field named like a registered name to a tool input; add the name to the registry for a record.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";
import { z } from "zod";

import { formatDetailedValidationError, formatZodError } from "../../src/utils/error-messages";
import {
  RECORD_KEY_FIELD_NAMES,
  RECORD_KEY_PLACEHOLDER,
  formatIssuePath,
} from "../../src/utils/issue-path";

import { ECHO_SENTINEL } from "./support/zod-error-cases";
import { accessName, walkTsFiles } from "./support/zod-scan-common";

const SRC_ROOT = path.resolve(__dirname, "../../src");
const PACKAGES_ROOT = path.resolve(__dirname, "../../../../packages");
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const SCAN_ROOTS = [
  SRC_ROOT,
  ...fs
    .readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PACKAGES_ROOT, d.name, "src")))
    .map((d) => path.join(PACKAGES_ROOT, d.name, "src")),
];

interface RecordSite {
  name: string;
  line: number;
}
interface RecordViolation {
  line: number;
  reason: "wrapped" | "non-enum-key" | "non-z-root";
}
interface RecordScan {
  sites: RecordSite[];
  violations: RecordViolation[];
}

const RECORD_METHODS: readonly string[] = ["record", "partialRecord", "looseRecord"];

/** Local names bound by an import from "zod" / "zod/...", and the names that import `record` itself. */
function zodImports(sf: ts.SourceFile): { names: Set<string>; recordImports: number[] } {
  const names = new Set<string>();
  const recordImports: number[] = [];
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const mod = st.moduleSpecifier.text;
    if (mod !== "zod" && !mod.startsWith("zod/")) continue;
    const clause = st.importClause;
    if (!clause) continue;
    if (clause.name) names.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) names.add(nb.name.text);
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        names.add(el.name.text);
        if (RECORD_METHODS.includes((el.propertyName ?? el.name).text)) {
          recordImports.push(sf.getLineAndCharacterOfPosition(el.getStart()).line + 1);
        }
      }
    }
  }
  return { names, recordImports };
}

/** Names declared in this file as `const x = z.enum(...)` / `z.nativeEnum(...)`. */
function enumDeclarations(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      /^z\.(enum|nativeEnum)\(/.test(n.initializer.getText().replace(/\s+/g, ""))
    ) {
      out.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function leftmostIdentifier(e: ts.Expression): string | undefined {
  let cur: ts.Expression = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isCallExpression(cur)) cur = cur.expression;
    else break;
  }
  return ts.isIdentifier(cur) ? cur.text : undefined;
}

/** The property that holds `n` directly, through method chains (`.optional()`, `.describe()`) only. */
function holdingProperty(n: ts.Node): string | undefined {
  let child: ts.Node = n;
  for (let p: ts.Node | undefined = n.parent; p; child = p, p = p.parent) {
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)) {
      continue;
    }
    if (ts.isPropertyAccessExpression(p) && p.expression === child) continue;
    if (ts.isCallExpression(p) && p.expression === child) continue;
    if (ts.isPropertyAssignment(p) && p.initializer === child) {
      return p.name.getText().replace(/^["']|["']$/g, "");
    }
    return undefined;
  }
  return undefined;
}

/** Fail-closed scan of every `record` / `partialRecord` / `looseRecord` call built from zod. */
function scanRecords(sf: ts.SourceFile): RecordScan {
  const out: RecordScan = { sites: [], violations: [] };
  const { names, recordImports } = zodImports(sf);
  const enums = enumDeclarations(sf);
  const lineOfNode = (n: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  for (const line of recordImports) out.violations.push({ line, reason: "non-z-root" });
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && RECORD_METHODS.includes(accessName(n.expression) ?? "")) {
      const callee = n.expression as ts.PropertyAccessExpression | ts.ElementAccessExpression;
      const root = leftmostIdentifier(callee.expression);
      const viaZ = ts.isIdentifier(callee.expression) && callee.expression.text === "z";
      if (!viaZ && root !== undefined && (root === "z" || names.has(root))) {
        out.violations.push({ line: lineOfNode(n), reason: "non-z-root" });
      } else if (viaZ && n.arguments.length >= 1) {
        const one = n.arguments.length === 1;
        const key = one ? "z.string()" : n.arguments[0]!.getText().replace(/\s+/g, "");
        const value = n.arguments[one ? 0 : 1]!.getText().replace(/\s+/g, "");
        const isEnumKey =
          /^z\.(enum|nativeEnum)\(/.test(key) || (/^[A-Za-z_$][\w$]*$/.test(key) && enums.has(key));
        if (isEnumKey) {
          // covered by INV-ZOD-RECORD-ENUM-KEY-001
        } else if (!key.startsWith("z.string(")) {
          out.violations.push({ line: lineOfNode(n), reason: "non-enum-key" });
        } else if (key === "z.string()" && value === "z.unknown()") {
          // the value cannot fail and the key cannot fail: no issue carries a key
        } else {
          const name = holdingProperty(n);
          if (name === undefined) out.violations.push({ line: lineOfNode(n), reason: "wrapped" });
          else out.sites.push({ name, line: lineOfNode(n) });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const fixture = (lines: string[]): ts.SourceFile =>
  ts.createSourceFile("fixture.ts", lines.join("\n"), ts.ScriptTarget.Latest, true);

describe("INV-ZOD-RECORD-KEY-REDACTION-001 (a) the registry equals the record fields of src", () => {
  const scanned = SCAN_ROOTS.flatMap((root) => walkTsFiles(root)).map((file) => ({
    rel: path.relative(REPO_ROOT, file).split(path.sep).join("/"),
    scan: scanRecords(
      ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
    ),
  }));
  const sites = scanned.flatMap(({ rel, scan }) => scan.sites.map((s) => ({ ...s, rel })));

  it("no record that needs a name is wrapped, keyed by a variable, or built through a root other than z", () => {
    expect(
      scanned.flatMap(({ rel, scan }) => scan.violations.map((v) => `${rel}:${v.line} ${v.reason}`))
    ).toEqual([]);
  });

  it("the registered names equal the names found in src and packages/*/src", () => {
    expect([...RECORD_KEY_FIELD_NAMES].sort()).toEqual(
      [...new Set(sites.map((s) => s.name))].sort()
    );
  });

  it("the scan reaches packages/<pkg>/src and is not vacuous", () => {
    expect(sites.length).toBeGreaterThanOrEqual(8);
    expect(sites.some((s) => s.rel.startsWith("packages/"))).toBe(true);
  });
});

describe("INV-ZOD-RECORD-KEY-REDACTION-001 (b) scan controls", () => {
  const names = (lines: string[]): string[] => scanRecords(fixture(lines)).sites.map((s) => s.name);
  const reasons = (lines: string[]): string[] =>
    scanRecords(fixture(lines)).violations.map((v) => v.reason);

  it("finds one-line, multi-line and chained string-keyed records with a failing value", () => {
    expect(
      names([
        "const a = { tokens: z.record(z.string(), colorTokenSchema) };",
        "const b = { styles: z\n  .record(z.string().max(3), z.string()) };",
        "const c = { budget: z.record(z.string(), z.number()).optional().describe('x') };",
      ])
    ).toEqual(["tokens", "styles", "budget"]);
  });

  it("a string key with a constraint and an unknown value still needs a name (invalid_key carries the key)", () => {
    expect(names(["const a = { meta: z.record(z.string().max(3), z.unknown()) };"])).toEqual([
      "meta",
    ]);
  });

  it("skips a bare-string unknown-valued record and enum-keyed ones", () => {
    const sf = fixture([
      "const e = z.enum(['a', 'b']);",
      "const a = { metadata: z.record(z.string(), z.unknown()) };",
      "const b = { byType: z.partialRecord(e, z.number()) };",
      "const c = { byType: z.record(z.enum(['a']), z.number()) };",
    ]);
    expect(scanRecords(sf)).toEqual({ sites: [], violations: [] });
  });

  it("negative: a record wrapped in an array, tuple, map, another record or a top-level const is reported", () => {
    expect(reasons(["const a = { items: z.array(z.record(z.string(), z.number())) };"])).toEqual([
      "wrapped",
    ]);
    expect(reasons(["const a = { t: z.tuple([z.record(z.string(), z.number())]) };"])).toEqual([
      "wrapped",
    ]);
    expect(
      reasons(["const a = { t: z.map(z.string(), z.record(z.string(), z.number())) };"])
    ).toEqual(["wrapped"]);
    expect(
      reasons(["const a = { o: z.record(z.string(), z.record(z.string(), z.number())) };"])
    ).toEqual(["wrapped"]);
    expect(reasons(["const top = z.record(z.string(), z.number());"])).toEqual(["wrapped"]);
  });

  it("negative: a key that is a variable other than a same-file enum is reported", () => {
    expect(reasons(["const a = { m: z.record(uuidSchema, z.number()) };"])).toEqual([
      "non-enum-key",
    ]);
    expect(reasons(["const a = { m: z.partialRecord(z.uuid(), z.number()) };"])).toEqual([
      "non-enum-key",
    ]);
  });

  it("negative: a root other than z is reported; a method of another object is not", () => {
    expect(
      reasons([
        'import * as zod from "zod";',
        "const a = { m: zod.record(zod.string(), zod.number()) };",
      ])
    ).toEqual(["non-z-root"]);
    expect(reasons(["const a = { m: z.core.record(z.string(), z.number()) };"])).toEqual([
      "non-z-root",
    ]);
    expect(reasons(['import { record } from "zod";', "const a = 1;"])).toEqual(["non-z-root"]);
    expect(reasons(["const r = recorder.record(url, options);"])).toEqual([]);
  });
});

describe("INV-ZOD-RECORD-KEY-REDACTION-001 (c) path text", () => {
  it("replaces the key after a record field name, at every level", () => {
    expect(formatIssuePath(["styles", "color"])).toBe(`styles.${RECORD_KEY_PLACEHOLDER}`);
    expect(formatIssuePath(["items", 2, "tokens", "primary", "hex"])).toBe(
      `items.2.tokens.${RECORD_KEY_PLACEHOLDER}.hex`
    );
  });

  it("leaves other paths and array indexes alone", () => {
    expect(formatIssuePath(["options", "viewport", "width"])).toBe("options.viewport.width");
    expect(formatIssuePath(["tokens", 0, "hex"])).toBe("tokens.0.hex");
    expect(formatIssuePath(["styles"])).toBe("styles");
    expect(formatIssuePath([])).toBe("");
  });
});

describe("INV-ZOD-RECORD-KEY-REDACTION-001 (d) end to end through the converter", () => {
  const cases: Array<[string, z.ZodType, unknown]> = [
    [
      "bad value type",
      z.object({ styles: z.record(z.string(), z.string()) }),
      { styles: { [ECHO_SENTINEL]: 1 } },
    ],
    [
      "value too long",
      z.object({ styles: z.record(z.string(), z.string().max(2)) }),
      { styles: { [ECHO_SENTINEL]: "xxxx" } },
    ],
    [
      "key too long",
      z.object({ styles: z.record(z.string().max(3), z.string()) }),
      { styles: { [ECHO_SENTINEL]: "x" } },
    ],
  ];
  for (const [name, schema, input] of cases) {
    it(`no key in field, hint or message: ${name}`, () => {
      const r = schema.safeParse(input);
      if (r.success) throw new Error("expected a failure");
      const out = JSON.stringify({
        a: formatZodError(r.error),
        b: formatDetailedValidationError(r.error),
      });
      expect(out).not.toContain(ECHO_SENTINEL);
      expect(out).toContain(RECORD_KEY_PLACEHOLDER);
    });
  }
});
