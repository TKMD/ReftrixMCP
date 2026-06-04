// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — schema-enum-sync AST / runtime extractors
 *
 * INV-SCHEMA-ENUM-004 / -B / -C 用の enum 抽出ヘルパー集。
 * ts-morph による TypeScript AST 解析 + `@prisma/client` runtime import により
 * 4 箇所 (Prisma ↔ TS ↔ Zod ↔ MCP tool spec) の enum 値を機械的に取得する。
 *
 * Extractors for INV-SCHEMA-ENUM-004 / -B / -C. Uses ts-morph for TypeScript AST
 * parsing and `@prisma/client` runtime imports to mechanically collect enum values
 * from the 4 sync locations (Prisma ↔ TS ↔ Zod ↔ MCP tool spec).
 *
 * @module tests/regression/standing/schema-enum-sync/_extractors
 */

import fs from "node:fs";
import path from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import * as prismaClient from "@prisma/client";

/**
 * apps/mcp-server source root (monorepo path).
 */
export const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");

/**
 * apps/mcp-server scripts root.
 */
export const MCP_SERVER_SCRIPTS_ROOT = path.resolve(__dirname, "../../../../scripts");

/**
 * Lazily-initialized ts-morph Project (AST parser). Shared across extractors in
 * a single vitest file. Each test file creates its own Project instance via
 * {@link createAstProject}.
 */
export function createAstProject(): Project {
  // ADR-0016 § Invariants: AST-only mode (no type checking required).
  // useInMemoryFileSystem = false so we read from the real repo.
  return new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: {
      allowJs: false,
      strict: true,
    },
  });
}

/**
 * Add a source file at `relPath` (relative to `apps/mcp-server/`) to the given
 * Project and return the SourceFile handle. Throws if the file cannot be read.
 *
 * @param project - ts-morph Project instance
 * @param relPath - path relative to `apps/mcp-server/` (e.g. `src/workers/.../types.ts`)
 */
export function addMcpServerSourceFile(project: Project, relPath: string): SourceFile {
  const abs = path.resolve(__dirname, "../../../../", relPath);
  return project.addSourceFileAtPath(abs);
}

// ============================================================================
// Recursive TypeScript source collection (shared, CO-DID-02 / C-M01-SHARED)
// ============================================================================

/**
 * Recursively collect every `*.ts` file under `root`, excluding `dist/`,
 * `node_modules/`, dot-directories, and (depending on `opts.includeTests`)
 * `.test.ts` / `.spec.ts` files. Returns absolute paths.
 *
 * **C-M01-SHARED (CO-DID bundle, TDA-PLAN-M-01)**: This is the single shared
 * source for the recursive `*.ts` walk previously **copy-pasted inline** in
 * three standing tests:
 *   - `gdpr-delete/inv-audit-emit-ssot-import-001.test.ts`
 *   - `worker-lifecycle/inv-worker-restart-delay-ssot-001-env-only.test.ts`
 *   - `worker-lifecycle/inv-worker-config-legacy-env-var-detection-001.test.ts`
 * and now also consumed by `tests/utils/inv-url-normalize-ssot-001.test.ts`
 * (CO-DID-02 src-wide AST sweep). The signature is byte-compatible with the
 * existing inline copies (`(root, { includeTests }) => string[]`) so the three
 * callsites can co-migrate to this import without behaviour change
 * (tracked: CO-DID-CARRY-01, deadline 2026-06-06). Adding a **new** inline
 * copy is forbidden (would re-introduce the drift this consolidation removes).
 *
 * `*.ts` を再帰収集 (`dist/` / `node_modules/` / dot-dir 除外、test 含む/除く切替)。
 *
 * @param root - absolute directory root to walk
 * @param opts.includeTests - `true` collects only `*.test.ts` / `*.spec.ts`;
 *   `false` collects only non-test `*.ts` (mirrors the existing inline copies)
 * @returns absolute paths of matching `*.ts` files
 */
export function collectTypeScriptSources(root: string, opts: { includeTests: boolean }): string[] {
  const out: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const isTest = entry.name.endsWith(".test.ts") || entry.name.endsWith(".spec.ts");
        if (!opts.includeTests && isTest) continue;
        if (opts.includeTests && !isTest) continue;
        out.push(full);
      }
    }
  }

  walk(root);
  return out;
}

// ============================================================================
// Extract TS const string-array literal (e.g. EMBEDDING_SKIP_REASONS)
// ============================================================================

/**
 * Extract a TypeScript `as const` string-array literal by variable name.
 *
 * Supports both:
 *   - `export const X = ["a", "b"] as const;`
 *   - `export const X: readonly string[] = ["a", "b"] as const;`
 *
 * Fails loudly (throws) when:
 *   - the variable declaration does not exist
 *   - the initializer is not an `AsExpression` wrapping an `ArrayLiteralExpression`
 *   - any element is not a plain string literal (catches `[...spread]` mistakes)
 *
 * @param sourceFile - ts-morph SourceFile containing the declaration
 * @param varName    - variable name, e.g. `"EMBEDDING_SKIP_REASONS"`
 * @returns array of string values in declaration order
 */
export function extractConstStringArray(sourceFile: SourceFile, varName: string): string[] {
  const varDecl = sourceFile.getVariableDeclaration(varName);
  if (!varDecl) {
    throw new Error(
      `[schema-enum-sync] Variable \`${varName}\` not found in ${sourceFile.getFilePath()}`
    );
  }

  const init = varDecl.getInitializer();
  if (!init) {
    throw new Error(
      `[schema-enum-sync] Variable \`${varName}\` has no initializer in ${sourceFile.getFilePath()}`
    );
  }

  // Unwrap `AsExpression` / `SatisfiesExpression` wrappers in any order:
  //   `[...] as const`
  //   `[...] satisfies T`
  //   `[...] as const satisfies T`
  //   `[...] satisfies T as const`
  // Loop until we hit a non-wrapping node (bounded to prevent pathological cases).
  let arrayNode = init;
  for (let i = 0; i < 4; i++) {
    const kind = arrayNode.getKind();
    if (kind === SyntaxKind.AsExpression) {
      arrayNode = arrayNode.asKindOrThrow(SyntaxKind.AsExpression).getExpression();
    } else if (kind === SyntaxKind.SatisfiesExpression) {
      arrayNode = arrayNode.asKindOrThrow(SyntaxKind.SatisfiesExpression).getExpression();
    } else {
      break;
    }
  }

  const arrayLit = arrayNode.asKind(SyntaxKind.ArrayLiteralExpression);
  if (!arrayLit) {
    throw new Error(
      `[schema-enum-sync] Variable \`${varName}\` is not an array literal in ${sourceFile.getFilePath()}`
    );
  }

  const values: string[] = [];
  for (const element of arrayLit.getElements()) {
    const strLit = element.asKind(SyntaxKind.StringLiteral);
    if (!strLit) {
      throw new Error(
        `[schema-enum-sync] \`${varName}\` contains non-string-literal element ` +
          `\`${element.getText()}\` in ${sourceFile.getFilePath()}`
      );
    }
    values.push(strLit.getLiteralValue());
  }

  return values;
}

// ============================================================================
// Extract TS string-literal union type alias
// ============================================================================

/**
 * Extract a TypeScript string-literal union type alias by name.
 *
 * Handles:
 *   - `type T = "a" | "b" | "c";`
 *   - with/without `export`
 *
 * Fails loudly when:
 *   - the type alias does not exist
 *   - the type node is not a `UnionTypeNode`
 *   - any member is not a `LiteralTypeNode` wrapping a `StringLiteral`
 *
 * @param sourceFile - ts-morph SourceFile containing the type alias
 * @param typeName   - type alias name
 * @returns sorted array of string literal values (sorted for stable comparison)
 */
export function extractStringLiteralUnion(sourceFile: SourceFile, typeName: string): string[] {
  const typeAlias = sourceFile.getTypeAlias(typeName);
  if (!typeAlias) {
    throw new Error(
      `[schema-enum-sync] Type alias \`${typeName}\` not found in ${sourceFile.getFilePath()}`
    );
  }

  const typeNode = typeAlias.getTypeNode();
  if (!typeNode) {
    throw new Error(
      `[schema-enum-sync] Type alias \`${typeName}\` has no type node in ${sourceFile.getFilePath()}`
    );
  }

  const unionNode = typeNode.asKind(SyntaxKind.UnionType);
  if (!unionNode) {
    throw new Error(
      `[schema-enum-sync] Type alias \`${typeName}\` is not a union type (got ` +
        `${typeNode.getKindName()}) in ${sourceFile.getFilePath()}`
    );
  }

  const values: string[] = [];
  for (const member of unionNode.getTypeNodes()) {
    const literalType = member.asKind(SyntaxKind.LiteralType);
    if (!literalType) {
      throw new Error(
        `[schema-enum-sync] Union member \`${member.getText()}\` is not a literal type ` +
          `in ${sourceFile.getFilePath()}`
      );
    }
    const literal = literalType.getLiteral();
    const strLit = literal.asKind(SyntaxKind.StringLiteral);
    if (!strLit) {
      throw new Error(
        `[schema-enum-sync] Union member \`${member.getText()}\` is not a string literal ` +
          `in ${sourceFile.getFilePath()}`
      );
    }
    values.push(strLit.getLiteralValue());
  }

  return values;
}

// ============================================================================
// Extract switch-statement case labels (for exhaustiveness cross-check)
// ============================================================================

/**
 * Extract the set of case-clause string literal labels from the switch statement
 * in the named function's body. Used to cross-verify that the exhaustive switch
 * in `skipReasonToBackfillStatus` covers every SSOT enum value.
 *
 * Handles:
 *   - stacked cases: `case "a": case "b": return ...;`
 *
 * Returns only explicit `case` labels (not `default`).
 *
 * @param sourceFile - ts-morph SourceFile containing the function
 * @param fnName     - function name (must contain exactly one top-level switch)
 * @returns unique sorted array of case label string values
 */
export function extractSwitchCaseLabels(sourceFile: SourceFile, fnName: string): string[] {
  const fn = sourceFile.getFunction(fnName);
  if (!fn) {
    throw new Error(
      `[schema-enum-sync] Function \`${fnName}\` not found in ${sourceFile.getFilePath()}`
    );
  }

  const switchStmt = fn.getFirstDescendantByKind(SyntaxKind.SwitchStatement);
  if (!switchStmt) {
    throw new Error(
      `[schema-enum-sync] Function \`${fnName}\` does not contain a switch statement in ` +
        `${sourceFile.getFilePath()}`
    );
  }

  const labels = new Set<string>();
  for (const clause of switchStmt.getCaseBlock().getClauses()) {
    const caseClause = clause.asKind(SyntaxKind.CaseClause);
    if (!caseClause) continue; // skip DefaultClause
    const expr = caseClause.getExpression();
    const strLit = expr.asKind(SyntaxKind.StringLiteral);
    if (!strLit) {
      throw new Error(
        `[schema-enum-sync] \`${fnName}\` contains non-string-literal case label ` +
          `\`${expr.getText()}\` in ${sourceFile.getFilePath()}`
      );
    }
    labels.add(strLit.getLiteralValue());
  }

  return Array.from(labels).sort();
}

// ============================================================================
// Extract named-imports from a source file for a given module specifier
// ============================================================================

/**
 * Collect the named imports for a module specifier that ends with `moduleSuffix`.
 * Used to verify that `EMBEDDING_SKIP_REASONS` is imported by name (not
 * re-declared as a hand-written hard-coded union).
 *
 * @param sourceFile    - ts-morph SourceFile
 * @param moduleSuffix  - tail of the module specifier to match
 *                        (e.g. `"workers/phases/types"`)
 * @returns set of imported symbol names
 */
export function extractNamedImports(sourceFile: SourceFile, moduleSuffix: string): Set<string> {
  const names = new Set<string>();
  for (const decl of sourceFile.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    if (!spec.endsWith(moduleSuffix) && spec !== moduleSuffix) continue;
    for (const ni of decl.getNamedImports()) {
      names.add(ni.getName());
    }
  }
  return names;
}

// ============================================================================
// Prisma runtime enum access
// ============================================================================

/**
 * Load all enum-like objects from `@prisma/client` (generated string-literal
 * enums). Filters out Prisma internals (`Prisma`, `PrismaClient`, `ModelName`,
 * `QueryMode`, `NullTypes`, `*ScalarFieldEnum`, etc.).
 *
 * Prisma generated enums are plain JS objects: `{ key: "value" }`. Returns a map
 * from enum name to sorted string array of values.
 *
 * @returns `Record<string, string[]>` - enum name → values (sorted)
 */
export function loadPrismaEnums(): Record<string, string[]> {
  // `import * as prismaClient` gives us a Module namespace object whose runtime
  // shape includes all Prisma generated enum exports (string-value objects).
  const client = prismaClient as unknown as Record<string, unknown>;
  const enums: Record<string, string[]> = {};

  const SKIP_NAMES = new Set<string>([
    "Prisma",
    "PrismaClient",
    "ModelName",
    "QueryMode",
    "NullTypes",
    "DbNull",
    "JsonNull",
    "AnyNull",
    "SortOrder",
    "NullsOrder",
    "TransactionIsolationLevel",
    "prismaVersion",
  ]);

  for (const [name, value] of Object.entries(client)) {
    if (SKIP_NAMES.has(name)) continue;
    if (name.endsWith("ScalarFieldEnum")) continue;
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) continue;

    const values = Object.values(value as Record<string, unknown>);
    if (values.length === 0) continue;
    if (!values.every((v) => typeof v === "string")) continue;

    enums[name] = (values as string[]).slice().sort();
  }

  return enums;
}

/**
 * Load a single Prisma enum's values by name. Throws if not found.
 *
 * @param enumName - Prisma enum name (e.g. `"EmbeddingBackfillStatus"`)
 * @returns array of string values in declaration order (preserved from @prisma/client)
 */
export function loadPrismaEnumValues(enumName: string): string[] {
  const client = prismaClient as unknown as Record<string, unknown>;
  const enumObj = client[enumName];
  if (!enumObj || typeof enumObj !== "object" || Array.isArray(enumObj)) {
    throw new Error(
      `[schema-enum-sync] Prisma enum \`${enumName}\` not found in @prisma/client. ` +
        `Run \`pnpm --filter @reftrixmcp/database prisma generate\` first.`
    );
  }
  const values = Object.values(enumObj as Record<string, unknown>);
  if (!values.every((v) => typeof v === "string")) {
    throw new Error(`[schema-enum-sync] Prisma enum \`${enumName}\` contains non-string values`);
  }
  return values as string[];
}

// ============================================================================
// Set difference helper (for readable assertion messages)
// ============================================================================

/**
 * Report the asymmetric difference between two string sets.
 *
 * @returns object with `onlyInA` / `onlyInB` arrays (sorted)
 */
export function setDifference(
  a: readonly string[],
  b: readonly string[]
): { onlyInA: string[]; onlyInB: string[] } {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyInA: a.filter((v) => !setB.has(v)).sort(),
    onlyInB: b.filter((v) => !setA.has(v)).sort(),
  };
}
