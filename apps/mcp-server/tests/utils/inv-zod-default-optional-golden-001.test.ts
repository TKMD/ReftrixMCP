// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: schema-enum-sync (contract test, not standing)
 *
 * INV-ZOD-DEFAULT-OPTIONAL-GOLDEN-001 (DEP1-02 / IO-DEP-06): the 20 `.default(x).optional()` sites
 * are written `.optional().default(x)`, so an omitted key yields `x` on zod 3 exactly as it does on
 * zod 4 (zod 3 returns no key for the old order, so "same output before and after" is NOT the
 * contract; the parse output now carries the default).
 *
 *  (a) the reordered schema returns the default, no `.default(x)` sits inside an `.optional()` /
 *      `.nullish()` of the same chain under apps/mcp-server/src or packages/<pkg>/src, and every
 *      default passes its own inner schema (zod 4 does not run the inner min / max on a default,
 *      so this pins the range check that zod 3 did on parse)
 *  (b) consumer equivalence for the 20 keys: the value the tool-layer reader used when the key was
 *      omitted (measured before the reorder) equals the parsed default, or the change is declared
 *  (c) no site has a transform / refine, and no refine / transform / superRefine / preprocess /
 *      catch body of an ancestor schema reads one of the 20 keys, so the zod 4 short-circuit (the
 *      default skips the inner transform) cannot change a result; the probe shows the difference
 *
 * There is no separate zod 4 assert per site: "zod" is zod 4 now, so the parse assert and the
 * inner-range assert in (a) run on zod 4 against the unchanged golden.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";
import { z as z3 } from "zod/v3";
import { z as z4 } from "zod";

import * as layoutSchemas from "../../src/tools/layout/schemas";
import * as motionSchemas from "../../src/tools/motion/detect.schemas";
import * as preferenceSchemas from "../../src/tools/preference/schemas";

const SRC_ROOT = path.resolve(__dirname, "../../src");
const PACKAGES_ROOT = path.resolve(__dirname, "../../../../packages");
const PACKAGE_SRC_ROOTS = fs
  .readdirSync(PACKAGES_ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(PACKAGES_ROOT, d.name, "src")))
  .map((d) => path.join(PACKAGES_ROOT, d.name, "src"));
const GOLDEN_PATH = path.join(__dirname, "support", "golden", "zod-default-optional.golden.json");

interface Entry {
  id: string;
  module: string;
  schema: string;
  key: string;
  minimal: Record<string, unknown>;
  default: unknown;
  consumer: {
    file: string;
    needle: string;
    effectiveBefore: unknown;
    status: "equal" | "aligned" | "newly-passed" | "unread";
  };
}
const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8")) as { entries: Entry[] };
const ENTRIES = golden.entries;

const MODULES: Record<string, Record<string, unknown>> = {
  "src/tools/layout/schemas.ts": layoutSchemas,
  "src/tools/motion/detect.schemas.ts": motionSchemas,
  "src/tools/preference/schemas.ts": preferenceSchemas,
};

function parseFile(rel: string): ts.SourceFile {
  const abs = path.resolve(SRC_ROOT, "..", rel);
  return ts.createSourceFile(abs, fs.readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true);
}

/** Method names of a call chain, outermost first: `a.b().c()` -> ["c", "b"]. */
function chainOf(expr: ts.Expression): string[] {
  const names: string[] = [];
  let cur: ts.Expression = expr;
  while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
    names.push(cur.expression.name.text);
    cur = cur.expression.expression;
  }
  return names;
}

/** The initializer of `key` inside the `z.object({...})` assigned to exported const `schema`. */
function locateProperty(
  sf: ts.SourceFile,
  schema: string,
  key: string
): { init: ts.Expression; objectCall: ts.CallExpression } {
  let found: { init: ts.Expression; objectCall: ts.CallExpression } | undefined;
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === schema &&
      n.initializer
    ) {
      let obj: ts.CallExpression | undefined;
      const find = (m: ts.Node): void => {
        if (
          !obj &&
          ts.isCallExpression(m) &&
          m.expression.getText() === "z.object" &&
          m.arguments[0] &&
          ts.isObjectLiteralExpression(m.arguments[0])
        ) {
          obj = m;
        }
        ts.forEachChild(m, find);
      };
      find(n.initializer);
      const lit = obj?.arguments[0];
      if (obj && lit && ts.isObjectLiteralExpression(lit)) {
        for (const p of lit.properties) {
          const name = ts.isPropertyAssignment(p) ? p.name.getText().replace(/["']/g, "") : "";
          if (name === key && ts.isPropertyAssignment(p))
            found = { init: p.initializer, objectCall: obj };
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!found) throw new Error(`site not found: ${schema}.${key}`);
  return found;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") walkTs(p, out);
    } else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/**
 * `.default(x)` with an `.optional()` / `.nullish()` further out on the same chain, with any
 * methods (e.g. `.describe()`) in between. Returns the 1-based lines.
 */
function findDefaultInsideOptional(sf: ts.SourceFile): number[] {
  const lines: number[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const chain = chainOf(n);
      if ((chain[0] === "optional" || chain[0] === "nullish") && chain.includes("default")) {
        lines.push(sf.getLineAndCharacterOfPosition(n.getStart()).line + 1);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

interface ZodNode {
  _def: { typeName?: string; type?: string; innerType?: ZodNode; defaultValue?: unknown };
  safeParse(v: unknown): { success: boolean };
}

/** The field's default value and its inner schema with the default / optional wrappers removed. */
function splitDefault(field: ZodNode): { value: unknown; inner: ZodNode } {
  const kind = (n: ZodNode): string => (n._def.typeName ?? n._def.type ?? "").toLowerCase();
  if (!kind(field).endsWith("default")) throw new Error(`not a default: ${kind(field)}`);
  const raw = field._def.defaultValue;
  const value = typeof raw === "function" ? (raw as () => unknown)() : raw; // zod 3 fn, zod 4 value
  let inner = field._def.innerType as ZodNode;
  while (kind(inner).endsWith("optional") && inner._def.innerType) inner = inner._def.innerType;
  return { value, inner };
}

const CALLBACK_METHODS = new Set(["transform", "refine", "superRefine", "preprocess", "catch"]);

/** Exported-or-not `const X = ...` declarations of every src file, by name. */
function declarationsByName(): Map<string, ts.VariableDeclaration[]> {
  const out = new Map<string, ts.VariableDeclaration[]>();
  for (const f of walkTs(SRC_ROOT)) {
    const sf = ts.createSourceFile(f, fs.readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        out.set(n.name.text, [...(out.get(n.name.text) ?? []), n]);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

/** `schema` and every declaration that refers to it, transitively (over-approximated by name). */
function ancestorsOf(
  schema: string,
  decls: Map<string, ts.VariableDeclaration[]>
): ts.VariableDeclaration[] {
  const seen = new Set<string>([schema]);
  const queue = [schema];
  while (queue.length > 0) {
    const name = queue.shift() as string;
    for (const [other, list] of decls) {
      if (seen.has(other)) continue;
      const refers = list.some((d) => {
        let hit = false;
        const visit = (n: ts.Node): void => {
          if (!hit && ts.isIdentifier(n) && n.text === name) hit = true;
          if (!hit) ts.forEachChild(n, visit);
        };
        visit(d.initializer as ts.Expression);
        return hit;
      });
      if (refers) {
        seen.add(other);
        queue.push(other);
      }
    }
  }
  return [...seen].flatMap((n) => decls.get(n) ?? []);
}

/** Bodies of the refine-like callbacks in `init`; an identifier argument is resolved in the file. */
function callbackBodies(init: ts.Expression): ts.Node[] {
  const sf = init.getSourceFile();
  const resolve = (id: ts.Identifier): ts.Node | undefined => {
    let body: ts.Node | undefined;
    const visit = (n: ts.Node): void => {
      if (
        (ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) &&
        n.name?.getText() === id.text
      )
        body = n;
      if (!body) ts.forEachChild(n, visit);
    };
    visit(sf);
    return body;
  };
  const out: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const name = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : "";
      if (CALLBACK_METHODS.has(name)) {
        for (const a of n.arguments) {
          if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) out.push(a);
          else if (ts.isIdentifier(a)) {
            const r = resolve(a);
            if (r) out.push(r);
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(init);
  return out;
}

/** Whether `node` names `key` as an identifier, property name or string literal. */
function mentionsKey(node: ts.Node, key: string): boolean {
  let hit = false;
  const visit = (n: ts.Node): void => {
    if ((ts.isIdentifier(n) || ts.isStringLiteralLike(n)) && n.text === key) hit = true;
    if (!hit) ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

describe("INV-ZOD-DEFAULT-OPTIONAL-GOLDEN-001", () => {
  it("golden has exactly the 20 AST-fixed sites", () => {
    expect(ENTRIES).toHaveLength(20);
    expect(new Set(ENTRIES.map((e) => e.id)).size).toBe(20);
  });

  describe("(a) reordered schema returns the default (golden taken on zod 3, run on the installed zod 4)", () => {
    it("the scan finds a default inside optional / nullish, also with methods in between", () => {
      const fixture = [
        "a.default(1).optional();",
        'a.default(1).describe("d").optional();',
        "a.default(1).nullish();",
        "a.default(1).nullable().optional();",
        "a.optional().default(1);",
        'a.optional().default(1).describe("d");',
        "a.array(b.default(1)).optional();",
      ].join("\n");
      const sf = ts.createSourceFile("f.ts", fixture, ts.ScriptTarget.Latest, true);
      expect(findDefaultInsideOptional(sf)).toEqual([1, 2, 3, 4]);
    });

    it("no `.default(x)` inside `.optional()` / `.nullish()` under src or packages/*/src (AST)", () => {
      expect(PACKAGE_SRC_ROOTS.length).toBeGreaterThanOrEqual(4);
      const left: string[] = [];
      for (const root of [SRC_ROOT, ...PACKAGE_SRC_ROOTS]) {
        for (const f of walkTs(root)) {
          const sf = ts.createSourceFile(
            f,
            fs.readFileSync(f, "utf8"),
            ts.ScriptTarget.Latest,
            true
          );
          for (const line of findDefaultInsideOptional(sf)) {
            left.push(`${path.relative(PACKAGES_ROOT, f)}:${line}`);
          }
        }
      }
      expect(left).toEqual([]);
    });

    it.each(ENTRIES.map((e) => [e.id, e] as const))(
      "%s is written .optional().default(x)",
      (_id, e) => {
        const { init } = locateProperty(parseFile(e.module), e.schema, e.key);
        const chain = chainOf(init);
        expect(chain[0]).toBe("default");
        expect(chain[1]).toBe("optional");
      }
    );

    it.each(ENTRIES.map((e) => [e.id, e] as const))(
      "%s: parse of an omitted key returns the default",
      (_id, e) => {
        const schema = MODULES[e.module]?.[e.schema] as {
          parse(v: unknown): Record<string, unknown>;
        };
        expect(schema.parse(e.minimal)[e.key]).toEqual(e.default);
      }
    );

    it.each(ENTRIES.map((e) => [e.id, e] as const))(
      "%s: the default passes its inner schema (range check zod 4 skips on a default)",
      (_id, e) => {
        const schema = MODULES[e.module]?.[e.schema] as { shape: Record<string, ZodNode> };
        const field = schema.shape[e.key];
        expect(field).toBeDefined();
        const { value, inner } = splitDefault(field as ZodNode);
        expect(value).toEqual(e.default);
        expect(inner.safeParse(value).success).toBe(true);
      }
    );

    it("probe: an explicit value still wins over the default", () => {
      const s = MODULES["src/tools/preference/schemas.ts"]?.["preferenceHearInputSchema"] as {
        parse(v: unknown): Record<string, unknown>;
      };
      expect(s.parse({ limit: 7, offset: 3 })).toMatchObject({ limit: 7, offset: 3 });
    });
  });

  describe("(b) consumer equivalence for the 20 keys", () => {
    it.each(ENTRIES.map((e) => [e.id, e] as const))("%s", (_id, e) => {
      const schema = MODULES[e.module]?.[e.schema] as {
        parse(v: unknown): Record<string, unknown>;
      };
      const parsed = schema.parse(e.minimal)[e.key];
      const consumerSrc = fs.readFileSync(path.resolve(SRC_ROOT, "..", e.consumer.file), "utf8");
      expect(consumerSrc).toContain(e.consumer.needle);
      if (e.consumer.status === "equal" || e.consumer.status === "aligned") {
        expect(parsed).toEqual(e.consumer.effectiveBefore);
      } else if (e.consumer.status === "newly-passed") {
        // before: nothing was passed (undefined); now the documented default is passed
        expect(e.consumer.effectiveBefore).toBeNull();
        expect(parsed).toBe(e.default);
      } else {
        // unread: no reader may look at the key. The function must be found, or slice(-1) would
        // scan an empty tail and pass vacuously.
        const start = consumerSrc.indexOf(`async function ${e.consumer.needle}`);
        expect(start).toBeGreaterThanOrEqual(0);
        const body = consumerSrc.slice(start);
        const fn = body.slice(
          0,
          body.indexOf("\nasync function ", 10) > 0
            ? body.indexOf("\nasync function ", 10)
            : undefined
        );
        expect(fn).not.toMatch(/options\??\.timeout/);
      }
    });
  });

  describe("(c) transform / refine x default", () => {
    const FORBIDDEN = new Set([
      "transform",
      "refine",
      "superRefine",
      "preprocess",
      "pipe",
      "catch",
      "brand",
    ]);

    it.each(ENTRIES.map((e) => [e.id, e] as const))("%s has no transform / refine", (_id, e) => {
      const { init, objectCall } = locateProperty(parseFile(e.module), e.schema, e.key);
      expect(chainOf(init).filter((m) => FORBIDDEN.has(m))).toEqual([]);
      // the enclosing object must not be wrapped by a refine either
      let top: ts.Node = objectCall;
      while (
        top.parent &&
        (ts.isPropertyAccessExpression(top.parent) ||
          (ts.isCallExpression(top.parent) && top.parent.expression === top))
      ) {
        top = top.parent;
      }
      expect(chainOf(top as ts.Expression).filter((m) => FORBIDDEN.has(m))).toEqual([]);
    });

    const DECLS = declarationsByName();

    it("ancestor scan reaches the refine / transform of motionDetectInputSchema", () => {
      const names = ancestorsOf("lighthouseOptionsSchema", DECLS).map((d) => d.name.getText());
      expect(names).toContain("motionDetectInputSchema");
      const top = DECLS.get("motionDetectInputSchema")?.[0]?.initializer;
      expect(top && callbackBodies(top).length).toBeGreaterThanOrEqual(4);
      const probe = ts.createSourceFile(
        "p.ts",
        "const s = o.refine((d) => d.timeout > 0).transform(check);\nfunction check(v) { return v.x; }",
        ts.ScriptTarget.Latest,
        true
      );
      const init = (probe.statements[0] as ts.VariableStatement).declarationList.declarations[0]
        ?.initializer as ts.Expression;
      const bodies = callbackBodies(init);
      expect(bodies).toHaveLength(2);
      // outermost call first: [check (resolved by name), the refine arrow]
      expect(bodies.map((b) => mentionsKey(b, "timeout"))).toEqual([false, true]);
      expect(bodies.map((b) => mentionsKey(b, "x"))).toEqual([true, false]);
    });

    it.each(ENTRIES.map((e) => [e.id, e] as const))(
      "%s: no refine / transform body of an ancestor schema reads the key",
      (_id, e) => {
        const readers: string[] = [];
        for (const d of ancestorsOf(e.schema, DECLS)) {
          for (const body of callbackBodies(d.initializer as ts.Expression)) {
            if (mentionsKey(body, e.key)) {
              const sf = body.getSourceFile();
              readers.push(
                `${d.name.getText()} ${path.relative(SRC_ROOT, sf.fileName)}:${sf.getLineAndCharacterOfPosition(body.getStart()).line + 1}`
              );
            }
          }
        }
        expect(readers).toEqual([]);
      }
    );

    it("probe: the difference the golden guards exists (zod 3 runs the inner transform on the default, zod 4 does not)", () => {
      const f = (n: number): number => n * 2;
      const v3 = z3.object({ a: z3.number().transform(f).default(5) }).parse({}).a;
      const v4 = z4.object({ a: z4.number().transform(f).default(5) }).parse({}).a;
      expect(v3).toBe(10);
      expect(v4).toBe(5);
    });
  });
});
