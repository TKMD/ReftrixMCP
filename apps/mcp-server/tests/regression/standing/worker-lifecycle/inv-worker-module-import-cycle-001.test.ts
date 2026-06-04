// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-WORKER-MODULE-IMPORT-CYCLE-001
 *
 * CO-26 split (PR-V3-CO-26-SPLIT) で導入された 3-module split の
 * **cycle-free import contract** を AST gate で検証する。
 *
 * Verifies the **cycle-free import contract** of the 3-module split introduced
 * by CO-26 split (PR-V3-CO-26-SPLIT) via an AST gate.
 *
 * **Forbidden edges (per CO-26 design §3.3) / 禁止される依存**:
 *   - Module B (`worker-supervisor-lifecycle.service.ts`) → Module C
 *     (`worker-supervisor-lock-orchestrator.service.ts`) direct runtime import
 *   - Module C → Module B direct runtime import
 *   - Module A (`worker-supervisor.service.ts`) self-import
 *
 * **Allowed edges**:
 *   - Module A → Module B (composition; A is single owner)
 *   - Module A → Module C (composition; A is single owner)
 *   - Module B → Module A (type-only — `import type`)
 *   - Module C → Module A (type-only — `import type`)
 *
 * AST gate uses `ts-morph` (`^27.0.2`, repo-internal already-declared dep) to
 * traverse `SourceFile.getImportDeclarations()` and reject any import where:
 *   - Module B imports a runtime symbol from Module C, or
 *   - Module C imports a runtime symbol from Module B, or
 *   - Module A imports from itself
 *
 * Type-only imports (`import type { X } from "..."` or
 * `import { type X } from "..."`) are erased at compile time and do NOT
 * generate runtime cycles, so they are explicitly permitted.
 *
 * Type-only imports は compile time に erase されるため runtime cycle を生成しない。
 *
 * @see  §3.3 / §4
 * @see TPA-01 amendment (IO Plan Decision `019df1a3-b9c3-770a-b7d3-27e7dbc548f2`)
 * @see ADR-0011 (Worker Dual-run Prevention) — INV preservation
 */

import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Project } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { assertInvName } from "../_setup/inv-assert";

const SERVICES_ROOT = path.resolve(__dirname, "../../../../src/services");

const MODULE_A_PATH = path.join(SERVICES_ROOT, "worker-supervisor.service.ts");
const MODULE_B_PATH = path.join(SERVICES_ROOT, "worker-supervisor-lifecycle.service.ts");
const MODULE_C_PATH = path.join(SERVICES_ROOT, "worker-supervisor-lock-orchestrator.service.ts");

const MODULE_A_SPEC = "./worker-supervisor.service";
const MODULE_B_SPEC = "./worker-supervisor-lifecycle.service";
const MODULE_C_SPEC = "./worker-supervisor-lock-orchestrator.service";

interface RuntimeImport {
  /** Module specifier (e.g. `./worker-supervisor-lock-orchestrator.service`). */
  specifier: string;
  /** Names of value-level (runtime) imports. Empty when only type imports. */
  runtimeImports: string[];
  /** Whether the entire `import` declaration is `import type {...}`. */
  isTypeOnly: boolean;
}

/**
 * Extract all import declarations from `sourceFile`, classifying each as
 * type-only or value-level (runtime).
 *
 * `import type { X } from "..."` — entire-statement type-only (erased at compile).
 * `import { type X, Y } from "..."` — Y is runtime, type X erased.
 * `import { X } from "..."` — X is runtime.
 */
function extractImports(sourceFile: SourceFile): RuntimeImport[] {
  const imports: RuntimeImport[] = [];
  for (const decl of sourceFile.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    const isTypeOnly = decl.isTypeOnly();
    const runtimeImports: string[] = [];
    if (!isTypeOnly) {
      // Inspect named imports — each may itself be `import { type X }`.
      for (const named of decl.getNamedImports()) {
        if (!named.isTypeOnly()) {
          runtimeImports.push(named.getName());
        }
      }
      // Default import is always runtime if present.
      const defaultImport = decl.getDefaultImport();
      if (defaultImport !== undefined) {
        runtimeImports.push(defaultImport.getText());
      }
      // Namespace import is runtime.
      const namespaceImport = decl.getNamespaceImport();
      if (namespaceImport !== undefined) {
        runtimeImports.push(`* as ${namespaceImport.getText()}`);
      }
    }
    imports.push({ specifier, runtimeImports, isTypeOnly });
  }
  return imports;
}

describe("INV-WORKER-MODULE-IMPORT-CYCLE-001: CO-26 3-module split cycle-free import contract", () => {
  let project: Project;
  let moduleA: SourceFile;
  let moduleB: SourceFile;
  let moduleC: SourceFile;

  beforeAll(() => {
    // ADR-0016 § Invariants: AST-only mode (no type checking).
    project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      skipLoadingLibFiles: true,
      compilerOptions: {
        allowJs: false,
        strict: true,
      },
    });
    moduleA = project.addSourceFileAtPath(MODULE_A_PATH);
    moduleB = project.addSourceFileAtPath(MODULE_B_PATH);
    moduleC = project.addSourceFileAtPath(MODULE_C_PATH);
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-MODULE-IMPORT-CYCLE-001");
  });

  it("INV-WORKER-MODULE-IMPORT-CYCLE-001: Module B does NOT runtime-import Module C / Module B は Module C を runtime import しない", () => {
    const imports = extractImports(moduleB);
    const moduleCImports = imports.filter((imp) => imp.specifier === MODULE_C_SPEC);

    // Module B may import Module C type-only (currently does not, but allowed).
    // It MUST NOT carry any runtime imports from Module C.
    for (const imp of moduleCImports) {
      expect(
        imp.isTypeOnly || imp.runtimeImports.length === 0,
        `Module B (${MODULE_B_SPEC}) MUST NOT runtime-import Module C (${MODULE_C_SPEC}). Found runtime imports: ${imp.runtimeImports.join(", ")}`
      ).toBe(true);
    }
  });

  it("INV-WORKER-MODULE-IMPORT-CYCLE-001: Module C does NOT runtime-import Module B / Module C は Module B を runtime import しない", () => {
    const imports = extractImports(moduleC);
    const moduleBImports = imports.filter((imp) => imp.specifier === MODULE_B_SPEC);

    for (const imp of moduleBImports) {
      expect(
        imp.isTypeOnly || imp.runtimeImports.length === 0,
        `Module C (${MODULE_C_SPEC}) MUST NOT runtime-import Module B (${MODULE_B_SPEC}). Found runtime imports: ${imp.runtimeImports.join(", ")}`
      ).toBe(true);
    }
  });

  it("INV-WORKER-MODULE-IMPORT-CYCLE-001: Module B → Module A is type-only (no runtime cycle) / Module B → Module A は type-only", () => {
    const imports = extractImports(moduleB);
    const moduleAImports = imports.filter((imp) => imp.specifier === MODULE_A_SPEC);

    // Module B → Module A: must be type-only to avoid runtime cycle.
    for (const imp of moduleAImports) {
      expect(
        imp.isTypeOnly || imp.runtimeImports.length === 0,
        `Module B (${MODULE_B_SPEC}) → Module A (${MODULE_A_SPEC}) MUST be type-only to avoid runtime cycle. Found runtime imports: ${imp.runtimeImports.join(", ")}`
      ).toBe(true);
    }
  });

  it("INV-WORKER-MODULE-IMPORT-CYCLE-001: Module C → Module A is type-only (no runtime cycle) / Module C → Module A は type-only", () => {
    const imports = extractImports(moduleC);
    const moduleAImports = imports.filter((imp) => imp.specifier === MODULE_A_SPEC);

    for (const imp of moduleAImports) {
      expect(
        imp.isTypeOnly || imp.runtimeImports.length === 0,
        `Module C (${MODULE_C_SPEC}) → Module A (${MODULE_A_SPEC}) MUST be type-only to avoid runtime cycle. Found runtime imports: ${imp.runtimeImports.join(", ")}`
      ).toBe(true);
    }
  });

  it("INV-WORKER-MODULE-IMPORT-CYCLE-001: Module A does NOT self-import / Module A は自身を import しない", () => {
    const imports = extractImports(moduleA);
    const selfImports = imports.filter(
      (imp) =>
        imp.specifier === MODULE_A_SPEC ||
        imp.specifier === "./worker-supervisor.service.ts" ||
        imp.specifier === "./worker-supervisor.service.js"
    );
    expect(
      selfImports.length,
      `Module A (${MODULE_A_SPEC}) MUST NOT import itself. Found: ${selfImports.map((s) => s.specifier).join(", ")}`
    ).toBe(0);
  });

  it("INV-WORKER-MODULE-IMPORT-CYCLE-001: Module A composes both Module B and Module C / Module A は Module B/C 両方を compose", () => {
    // Positive contract: Module A must be the single owner of B and C.
    const imports = extractImports(moduleA);
    const importsModuleB = imports.some(
      (imp) => imp.specifier === MODULE_B_SPEC && imp.runtimeImports.length > 0
    );
    const importsModuleC = imports.some(
      (imp) => imp.specifier === MODULE_C_SPEC && imp.runtimeImports.length > 0
    );
    expect(
      importsModuleB,
      `Module A MUST runtime-import Module B (${MODULE_B_SPEC}) for composition`
    ).toBe(true);
    expect(
      importsModuleC,
      `Module A MUST runtime-import Module C (${MODULE_C_SPEC}) for composition`
    ).toBe(true);
  });
});
