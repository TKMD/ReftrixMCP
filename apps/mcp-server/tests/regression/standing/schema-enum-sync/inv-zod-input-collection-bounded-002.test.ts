// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-ZOD-INPUT-COLLECTION-BOUNDED-002
 *
 * 登録済み MCP tool (`toolHandlers`) の入力 schema から到達できる Zod の collection
 * (`z.array` / `.array()` / `z.set` / `z.map`) は、すべて `.max(N)` または `.length(N)` を持つ。
 * N は数値リテラル、または数値リテラルで初期化された const に解決でき、N <= 1000 (天井)。
 * 解決できない形は fail-closed (上限なしとして扱う)。
 *
 * Every Zod collection reachable from the input schema of a registered MCP tool must carry
 * `.max(N)` / `.length(N)` with N resolvable to a numeric literal (or a const initialised by one)
 * and N <= 1000. Unresolvable forms are treated as unbounded (fail-closed).
 *
 * 件数 / counts (AST 実測): array 36 / set 0 / map 0 / record 1 / tuple 1。
 * record と tuple は件数と位置を固定する (tuple は固定長、record のキー数上限は tracked)。
 *
 * 未完了一覧 / pending list: まだ上限のない array の `file:line`。無言では増やせない
 * (一覧と PENDING_MAX を増やす diff には SEC の sign-off が必須)。
 * 1 件でも上限が付いたら一覧から外さないと fail し、新しい上限なし array は一覧に足しても
 * 件数上限 (PENDING_MAX) で fail する。
 *
 * @see
 */

import fs from "node:fs";
import path from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import { beforeAll, describe, expect, it } from "vitest";
import {
  TOOL_INPUT_ROOTS,
  createZodCollectionProject,
  scanZodCollections,
} from "./_zod-collections";
import type { ZodCollectionScan } from "./_zod-collections";

const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../../");

/** 天井。これを超える上限は「実質無制限」とみなして fail する。 */
const BOUND_CEILING = 1000;

/** 未完了一覧の最大件数 (無言では増やせない)。 */
const PENDING_MAX = 0;

/** まだ上限のない array (file:line)。上限を付けた分だけ外し、最終的に 0 件にする。 */
const PENDING_UNBOUNDED_ARRAYS: readonly string[] = [];

const EXPECTED_COUNTS = { array: 36, set: 0, map: 0, record: 1, tuple: 1 } as const;
const EXPECTED_RECORD_SITES = ["src/tools/page/input.schemas.ts:1023"];
const EXPECTED_TUPLE_SITES = ["src/tools/schemas/style-schemas.ts:40"];

/** 上限として受理できるか (整数、1 以上、天井以下)。null は fail-closed で不受理。 */
function isAcceptableBound(bound: number | null): boolean {
  return bound !== null && Number.isInteger(bound) && bound >= 1 && bound <= BOUND_CEILING;
}

function readToolHandlerNames(): string[] {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const sf = project.addSourceFileAtPath(path.join(MCP_SERVER_ROOT, "src/tools/index.ts"));
  const init = sf.getVariableDeclarationOrThrow("toolHandlers").getInitializerOrThrow();
  const obj = init.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
  return obj
    .getProperties()
    .map((p) => (p as unknown as { getName: () => string }).getName().replace(/^["']|["']$/g, ""))
    .sort();
}

describe("INV-ZOD-INPUT-COLLECTION-BOUNDED-002: tool input collections are bounded", () => {
  let scan: ZodCollectionScan;

  beforeAll(() => {
    scan = scanZodCollections(createZodCollectionProject());
  }, 120_000);

  it("root map covers exactly the registered toolHandlers and each root is parsed by its handler file", () => {
    const registered = readToolHandlerNames();
    expect(Object.keys(TOOL_INPUT_ROOTS).sort()).toEqual(registered);
    for (const [tool, root] of Object.entries(TOOL_INPUT_ROOTS)) {
      if (!root) {
        // Zod 入力を持たない tool は system.health のみ
        expect(tool).toBe("system.health");
        continue;
      }
      const src = fs.readFileSync(path.join(MCP_SERVER_ROOT, "src/tools", root[0]), "utf8");
      expect(src, `${tool}: ${root[1]} must be parsed in ${root[0]}`).toMatch(
        new RegExp(`\\b${root[1]}\\.(safeParse|parse)(Async)?\\(`)
      );
    }
  });

  it("every schema identifier on the walked paths resolves (fail-closed on unresolved)", () => {
    expect(scan.unresolved).toEqual([]);
  });

  it("collection counts are fixed (array 36 / set 0 / map 0 / record 1 / tuple 1)", () => {
    const count = (k: string): number => scan.collections.filter((c) => c.kind === k).length;
    expect({
      array: count("array"),
      set: count("set"),
      map: count("map"),
      record: count("record"),
      tuple: count("tuple"),
    }).toEqual(EXPECTED_COUNTS);
    expect(scan.collections.filter((c) => c.kind === "record").map((c) => c.site)).toEqual(
      EXPECTED_RECORD_SITES
    );
    expect(scan.collections.filter((c) => c.kind === "tuple").map((c) => c.site)).toEqual(
      EXPECTED_TUPLE_SITES
    );
  });

  it("every array/set/map has a resolvable bound 1 <= N <= 1000, except the pending list", () => {
    const pending = new Set(PENDING_UNBOUNDED_ARRAYS);
    const violations = scan.collections
      .filter((c) => c.kind === "array" || c.kind === "set" || c.kind === "map")
      .filter((c) => !pending.has(c.site))
      .filter((c) => !isAcceptableBound(c.bound))
      .map((c) => `${c.site} [${c.tools.join(",")}] bound=${c.boundText ?? "none"}`);
    expect(violations).toEqual([]);
  });

  it("pending list matches the unbounded arrays exactly and cannot grow silently", () => {
    const unbounded = scan.collections
      .filter(
        (c) => (c.kind === "array" || c.kind === "set" || c.kind === "map") && c.bound === null
      )
      .map((c) => c.site)
      .sort();
    expect(unbounded).toEqual([...PENDING_UNBOUNDED_ARRAYS].sort());
    expect(PENDING_UNBOUNDED_ARRAYS.length).toBeLessThanOrEqual(PENDING_MAX);
    // 一覧は一意
    expect(new Set(PENDING_UNBOUNDED_ARRAYS).size).toBe(PENDING_UNBOUNDED_ARRAYS.length);
  });

  describe("fail-closed behaviour of the extractor (in-memory fixtures)", () => {
    // zod は import 宣言で解決される (識別子名の文字列では判定しない)。z 自体が unresolved に載らない
    const scanFixture = (body: string): ZodCollectionScan => {
      const project = new Project({ useInMemoryFileSystem: true });
      project.createSourceFile(
        "/virtual/fix.ts",
        `import { z } from "zod";\nconst LIMIT = 8;\nconst COMPUTED = Math.min(3, 4);\n${body}`
      );
      return scanZodCollections(project, {
        roots: { fixture: ["fix.ts", "rootSchema"] },
        toolsDir: "/virtual",
      });
    };

    it("resolves numeric literal and numeric const", () => {
      const r = scanFixture(
        `const rootSchema = z.object({ a: z.array(z.string()).max(5), b: z.array(z.string()).length(LIMIT) });`
      );
      expect(r.collections.map((c) => c.bound).sort()).toEqual([5, 8]);
    });

    it("treats computed / call-expression bounds as unresolved (bound=null)", () => {
      const r = scanFixture(
        `const rootSchema = z.object({ a: z.array(z.string()).max(COMPUTED), b: z.array(z.string()).max(Math.min(3, 4)) });`
      );
      expect(r.collections.map((c) => c.bound)).toEqual([null, null]);
    });

    it("treats min/nonempty-only and refine-only length checks as unbounded", () => {
      const r = scanFixture(
        `const rootSchema = z.object({ a: z.array(z.string()).min(1), b: z.array(z.string()).nonempty(), c: z.array(z.string()).refine((v) => v.length < 5) });`
      );
      expect(r.collections.map((c) => c.bound)).toEqual([null, null, null]);
    });

    it("walks .array() chains, spreads, nested arrays and set/map/record/tuple", () => {
      const r = scanFixture(
        `const base = { t: z.string().array() };\n` +
          `const rootSchema = z.object({ ...base, n: z.array(z.array(z.number()).max(2)).max(3), r: z.record(z.string(), z.array(z.string())), s: z.set(z.string()), m: z.map(z.string(), z.string()), p: z.tuple([z.string(), z.string()]) });`
      );
      const byKind = (k: string): number => r.collections.filter((c) => c.kind === k).length;
      expect(byKind("array")).toBe(4);
      expect(byKind("record")).toBe(1);
      expect(byKind("set")).toBe(1);
      expect(byKind("map")).toBe(1);
      expect(byKind("tuple")).toBe(1);
      // 上限なしは .array() の t、record 内の array、set、map
      expect(r.collections.filter((c) => c.bound === null && c.kind === "array")).toHaveLength(2);
    });

    it("negative control: a clean fixture has no unresolved; a missing identifier is the only entry", () => {
      const clean = scanFixture(
        `const rootSchema = z.object({ a: z.array(z.string()).max(5), n: z.number().refine((v) => v > 1) });`
      );
      expect(clean.unresolved).toEqual([]);
      const missing = scanFixture(`const rootSchema = z.object({ a: missingSchema });`);
      expect(missing.unresolved).toHaveLength(1);
      expect(missing.unresolved[0]).toMatch(/ missingSchema \(|missingSchema$/);
    });

    // 以前は黙って捨てていた形。検出する (collection) か、unresolved に載せる
    const root = (fields: string, pre = ""): string =>
      `${pre}\nconst rootSchema = z.object({ ${fields} });`;
    const ARR = [["array", null]];
    const detected: Array<[string, string]> = [
      ["aliased zod import", root("a: zz.array(zz.string())", `import { z as zz } from "zod";`)],
      ["named zod import", root("a: array(z.string())", `import { array } from "zod";`)],
      ["shorthand property", root("items", "const items = z.array(z.string());")],
      ["reassigned let", root("a: z.array(z.string()).max(L)", "let L = 5;\nL = 100000;")],
    ];
    it.each(detected)("detects: %s", (_name, body) => {
      expect(scanFixture(body).collections.map((c) => [c.kind, c.bound])).toEqual(ARR);
    });

    const reported: Array<[string, string, RegExp]> = [
      ["element access", root('a: z["array"](z.string())'), /ElementAccess/],
      [
        "destructuring",
        root("a: inner", "const { inner } = { inner: z.array(z.string()) };"),
        /inner \(Binding/,
      ],
      [
        "class static",
        root("a: S.inner", "class S { static inner = z.array(z.string()); }"),
        /S \(Class/,
      ],
      [
        "new ZodArray",
        root("a: new ZodArray({} as never)", `import { ZodArray } from "zod";`),
        /new ZodArray/,
      ],
      ["object method", root("s() { return z.array(z.string()); }"), /member \(MethodDecl/],
    ];
    it.each(reported)("reports as unresolved: %s", (_name, body, pattern) => {
      expect(scanFixture(body).unresolved.some((u) => pattern.test(u))).toBe(true);
    });

    it("ceiling: a bound above 1000 is not accepted", () => {
      const r = scanFixture(`const rootSchema = z.object({ a: z.array(z.string()).max(1001) });`);
      expect(r.collections[0]?.bound).toBe(1001);
      expect(isAcceptableBound(r.collections[0]?.bound ?? null)).toBe(false);
      expect(isAcceptableBound(1000)).toBe(true);
      expect(isAcceptableBound(0)).toBe(false);
    });
  });
});
