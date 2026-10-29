// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Validator coverage of the zod error case table (TPA-B2A-03).
 * The v3 default messages cannot be taken after the zod 4 bump, so every zod call that can
 * produce an issue in a client-reaching schema needs a row in zod-error-cases.ts first.
 * The scan follows relative imports from the client-reaching tool files (the schemas live in
 * the services next to them) and collects every method called on a chain that starts at `z`.
 * Chain roots: an import from "zod" (`z`, `import * as zod`, `import { z as zz }`, a default
 * import, `import { string } from "zod"`), and variables a chain was stored in
 * (`const s = z.string(); s.min(1)`; tracked by name across the whole import closure, so an
 * imported schema is followed too: over-reporting is the safe direction here). Not followed: a
 * chain whose root is not a plain identifier (a property, a call result, `this.x`, a parameter),
 * a local re-export of zod, a destructured factory, element access and class fields.
 * `typeCheckedZodMethods` below is the backstop for those.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

/** zod method -> ids of the cases in ZOD_ERROR_CASES that make it fail. */
export const COVERED_VALIDATORS: Readonly<Record<string, readonly string[]>> = {
  array: ["array-element-type"],
  boolean: ["type-array-for-boolean"],
  datetime: ["string-not-datetime-sentinel"],
  discriminatedUnion: ["discriminated-union-no-match-sentinel"],
  endsWith: ["string-not-endswith-sentinel"],
  enum: ["enum-invalid-sentinel", "enum-invalid-number"],
  finite: ["number-not-finite"],
  instanceof: ["instanceof-mismatch-sentinel"],
  int: ["number-not-int", "number-int-below-min", "number-int-above-max"],
  length: ["string-length-exact-sentinel", "array-length-exact"],
  literal: ["literal-mismatch-sentinel"],
  max: ["number-too-big", "string-too-long-sentinel", "array-too-long", "number-int-above-max"],
  min: [
    "number-too-small",
    "string-too-short",
    "array-too-short",
    "number-int-below-min",
    "size-bigint-too-small",
    "size-set-too-small",
  ],
  nonnegative: ["number-not-nonnegative"],
  positive: ["number-not-positive"],
  number: ["type-string-for-number-sentinel"],
  object: ["required-missing", "required-nested-missing"],

  record: ["record-value-type"],
  // an enum-keyed record that accepts a partial key set; its value issue is the record value issue
  // an unknown key of an enum-keyed partialRecord is its own issue (unrecognized_keys), checked directly (TDA-PRE-L-06)
  partialRecord: ["record-value-type", "partial-record-enum-unknown-key-sentinel"],
  refine: ["custom-refine", "custom-refine-default-message"],
  regex: ["regex-invalid-sentinel"],
  startsWith: ["string-not-startswith-sentinel"],
  string: ["type-number-for-string"],
  strict: ["strict-unrecognized-key-sentinel"],
  // z.strictObject(shape) is z.object(shape).strict() on zod 3 (same unknown-key path, same
  // unrecognized_keys issue); the v4 bundled test runs this case with z4.strictObject.
  strictObject: ["strict-unrecognized-key-sentinel"],
  tuple: ["tuple-element-type-and-length"],
  union: ["union-no-match-sentinel"],
  url: ["url-invalid-sentinel"],
  uuid: ["uuid-invalid-sentinel"],
};

/**
 * COVERED_VALIDATORS rows that no client-reaching schema uses any more, and why each is kept
 * (IO-C1B2-03). The inv-zod-validator-coverage test fails when a covered method is unused and not
 * listed here, and when a method listed here is used again (then the entry is stale).
 */
export const UNUSED_COVERED_KEPT: Readonly<Record<string, string>> = {
  endsWith:
    "case and 4a/4b golden rows were taken while a schema used it; kept as a validator baseline",
  finite:
    "case and 4a/4b golden rows were taken while a schema used it; kept as a validator baseline",
  strict:
    "src moved to z.strictObject (the strictObject row covers it); kept because object().strict() is the same unknown-key issue, asserted equal in the coverage test",
};

/** zod methods that never produce an issue of their own; the reason is the evidence. */
export const NO_ISSUE_METHODS: Readonly<Record<string, string>> = {
  default: "fills in a missing value before validation, adds no check",
  describe: "attaches metadata only",
  extend: "adds object fields; each field's validators are counted at their own call",
  merge: "combines two object shapes, adds no check",
  nullable: "widens the accepted type, adds no check",
  optional: "widens the accepted type, adds no check",
  passthrough: "keeps unknown keys, adds no check",
  superRefine: "issues come from ctx.addIssue with a message the caller writes, not a zod default",
  transform: "issues come from ctx.addIssue with a message the caller writes, not a zod default",
  unknown: "accepts any input, adds no check",
};

function resolveRelative(from: string, spec: string): string | undefined {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [`${base}.ts`, path.join(base, "index.ts"), base.replace(/\.js$/, ".ts")]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return undefined;
}

const isZodModule = (spec: string): boolean => spec === "zod" || spec.startsWith("zod/");

/** The import clause of `st` when it imports from zod. */
function zodImportClause(st: ts.Statement): ts.ImportClause | undefined {
  if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) return undefined;
  return isZodModule(st.moduleSpecifier.text) ? st.importClause : undefined;
}

/** `import { z as zz, string } from "zod"`: `z` aliases are roots, other names are direct factories. */
function addNamed(named: ts.NamedImports, roots: Set<string>, direct: Map<string, string>): void {
  for (const el of named.elements) {
    const imported = (el.propertyName ?? el.name).text;
    if (imported === "z") roots.add(el.name.text);
    else direct.set(el.name.text, imported);
  }
}

/** Local names bound to the zod module, and the zod exports imported by name other than `z`. */
function zodImportNames(sf: ts.SourceFile): { roots: Set<string>; direct: Map<string, string> } {
  const roots = new Set<string>();
  const direct = new Map<string, string>();
  for (const clause of sf.statements.map(zodImportClause)) {
    if (clause === undefined) continue;
    const { name, namedBindings } = clause;
    if (name) roots.add(name.text);
    if (namedBindings && ts.isNamespaceImport(namedBindings)) roots.add(namedBindings.name.text);
    if (namedBindings && ts.isNamedImports(namedBindings)) addNamed(namedBindings, roots, direct);
  }
  return { roots, direct };
}

/** Methods that run a schema: what follows them is a parse result, not a schema. */
const RUN_METHODS: readonly string[] = [
  "parse",
  "safeParse",
  "parseAsync",
  "safeParseAsync",
  "spa",
];

/**
 * Innermost expression of a call / property chain, and whether the chain ran a schema before its
 * last link (`schema.safeParse(x).error.issues.map` is not a schema chain).
 */
function chainRoot(expr: ts.Expression): { root: ts.Expression; ranSchema: boolean } {
  let root = expr;
  let ranSchema = false;
  let first = true;
  for (;;) {
    if (ts.isPropertyAccessExpression(root)) {
      if (!first && RUN_METHODS.includes(root.name.text)) ranSchema = true;
      first = false;
      root = root.expression;
    } else if (ts.isCallExpression(root)) {
      first = false;
      root = root.expression;
    } else if (ts.isNonNullExpression(root) || ts.isParenthesizedExpression(root)) {
      root = root.expression;
    } else return { root, ranSchema };
  }
}

/** The entry files and every file they reach through relative imports / re-exports, parsed. */
export function relativeImportClosure(
  pkgRoot: string,
  entryFiles: readonly string[]
): Map<string, ts.SourceFile> {
  const sources = new Map<string, ts.SourceFile>();
  const queue = entryFiles.map((f) => path.join(pkgRoot, f));
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (sources.has(file)) continue;
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    sources.set(file, sf);
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith(".")
      ) {
        const next = resolveRelative(file, node.moduleSpecifier.text);
        if (next) queue.push(next);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return sources;
}

/** Method names called on chains rooted at zod, over the relative-import closure of the entry files. */
export function scanClientReachingZodMethods(
  pkgRoot: string,
  entryFiles: readonly string[]
): Set<string> {
  const sources = relativeImportClosure(pkgRoot, entryFiles);
  const imports = new Map([...sources].map(([f, sf]) => [f, zodImportNames(sf)] as const));
  const isRooted = (f: string, expr: ts.Expression, tracked: ReadonlySet<string>): boolean => {
    const { root, ranSchema } = chainRoot(expr);
    if (ranSchema || !ts.isIdentifier(root)) return false;
    const names = imports.get(f) as ReturnType<typeof zodImportNames>;
    return names.roots.has(root.text) || names.direct.has(root.text) || tracked.has(root.text);
  };

  // variables a zod chain was stored in, to a fixpoint (`const a = z.string(); const b = a.min(1)`)
  const tracked = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const [f, sf] of sources) {
      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          !tracked.has(node.name.text) &&
          isRooted(f, node.initializer, tracked)
        ) {
          tracked.add(node.name.text);
          grew = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  }

  const methods = new Set<string>();
  for (const [f, sf] of sources) {
    const names = imports.get(f) as ReturnType<typeof zodImportNames>;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          isRooted(f, node.expression, tracked)
        ) {
          if (!RUN_METHODS.includes(node.expression.name.text))
            methods.add(node.expression.name.text);
        }
        const callee = node.expression;
        if (ts.isIdentifier(callee) && names.direct.has(callee.text)) {
          methods.add(names.direct.get(callee.text) as string);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return methods;
}

/**
 * Backstop for the scan above (SEC-B2C2C-01): with the type checker, every call in `files` whose
 * callee is declared in the zod package (`z.string`, `ZodString#email`, a destructured factory),
 * whatever the receiver looks like (`mk().email()`, `obj.s.min()`, a parameter, a class field).
 * Parse-running methods are left out. The result must be a subset of the syntactic scan.
 */
export function typeCheckedZodMethods(
  files: readonly string[],
  options: ts.CompilerOptions
): Set<string> {
  const program = ts.createProgram([...files], options);
  const checker = program.getTypeChecker();
  const inZod = (sym: ts.Symbol | undefined): boolean =>
    (sym?.declarations ?? []).some((d) =>
      /\/node_modules\/zod\//.test(d.getSourceFile().fileName.split(path.sep).join("/"))
    );
  const methods = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = zodCalleeName(checker, node.expression, inZod);
      if (name !== undefined && !RUN_METHODS.includes(name)) methods.add(name);
    }
    ts.forEachChild(node, visit);
  };
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (sf) visit(sf);
  }
  return methods;
}

type InZod = (sym: ts.Symbol | undefined) => boolean;

/** `x.name` / `x["name"]`: the written name, when the property is declared in zod. */
function accessedZodName(
  checker: ts.TypeChecker,
  callee: ts.Expression,
  inZod: InZod
): string | undefined {
  const key = ts.isPropertyAccessExpression(callee)
    ? callee.name
    : ts.isElementAccessExpression(callee) && ts.isStringLiteral(callee.argumentExpression)
      ? callee.argumentExpression
      : undefined;
  return key !== undefined && inZod(checker.getSymbolAtLocation(key)) ? key.text : undefined;
}

/** A bare identifier bound to a zod export: the imported name or the destructured key. */
function identifierZodName(
  checker: ts.TypeChecker,
  callee: ts.Identifier,
  inZod: InZod
): string | undefined {
  const sym = checker.getSymbolAtLocation(callee);
  if (!inZod(resolveAlias(checker, sym)) && !inZod(checker.getTypeAtLocation(callee).getSymbol())) {
    return undefined;
  }
  const key = boundKey(sym?.declarations?.[0]);
  return key !== undefined && ts.isIdentifier(key) ? key.text : callee.text;
}

function resolveAlias(checker: ts.TypeChecker, sym: ts.Symbol | undefined): ts.Symbol | undefined {
  return sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
}

/** The exported name an import specifier or a destructuring element reads. */
function boundKey(decl: ts.Declaration | undefined): ts.Node | undefined {
  if (decl === undefined) return undefined;
  if (ts.isImportSpecifier(decl) || ts.isBindingElement(decl))
    return decl.propertyName ?? decl.name;
  return undefined;
}

/**
 * The zod name a callee stands for, as the syntactic scan spells it (`string`, not the zod 3
 * implementation name `stringType`): the property name, the imported name, or the destructured key.
 */
function zodCalleeName(
  checker: ts.TypeChecker,
  callee: ts.Expression,
  inZod: InZod
): string | undefined {
  return ts.isIdentifier(callee)
    ? identifierZodName(checker, callee, inZod)
    : accessedZodName(checker, callee, inZod);
}

/** Zod calls the type checker sees that are not schema methods; the reason is the evidence. */
export const TYPE_ONLY_ZOD_CALLS: Readonly<Record<string, string>> = {
  addIssue: "ctx.addIssue inside superRefine / transform: the caller writes the message",
};
