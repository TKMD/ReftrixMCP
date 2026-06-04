// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-WORKER-LOCK-RESPONSIBILITY-001
 *
 * CO-26 split (PR-V3-CO-26-SPLIT) で導入された Module C (lock orchestrator)
 * の **responsibility boundary contract** を AST gate で検証する。
 *
 * Verifies the **responsibility boundary contract** of Module C
 * (lock orchestrator) introduced by CO-26 split.
 *
 * **Forbidden imports for Module C / Module C が import してはならないもの**:
 *   - Module B (`worker-supervisor-lifecycle.service`) — direct runtime import is
 *     forbidden; lifecycle callsites MUST traverse Module A facade via
 *     `this.supervisor.getLifecycle().X()` indirect path.
 *   - Spawn / IPC / fork-related modules (e.g., `node:child_process` indirectly
 *     through Module B).
 *
 * **Why**: Module C (lock orchestrator) responsibility = Redis lock
 * acquire / release / heartbeat / instance lifecycle. Lifecycle (spawn / IPC /
 * exit) is Module B's responsibility. Direct import of Module B from Module C
 * would violate the cycle-free contract (B → A indirect, C → A indirect, never
 * B ↔ C).
 *
 * Module C が Module B を直接 import すると cycle-free contract を破壊する
 * (B → A → C は indirect path、direct B ↔ C は禁止)。
 *
 * **Allowed**:
 *   - `import type` from any service module (erased at compile time).
 *   - `worker-active-lock.service` (Redis lock service primitive).
 *   - `worker-supervisor-helpers` (helper functions like
 *     `runAcquireLockWithRetryOrchestrator`).
 *
 * @see  §3.1 Module C / §3.3
 * @see TPA-01 amendment (IO Plan Decision `019df1a3-b9c3-770a-b7d3-27e7dbc548f2`)
 * @see SEC L-03 advisory (Module C MUST NOT register process.on('exit') hooks)
 */

import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Project, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { assertInvName } from "../_setup/inv-assert";

const SERVICES_ROOT = path.resolve(__dirname, "../../../../src/services");
const MODULE_C_PATH = path.join(SERVICES_ROOT, "worker-supervisor-lock-orchestrator.service.ts");

/** Specifiers that Module C is forbidden from runtime-importing. */
const FORBIDDEN_RUNTIME_IMPORT_SPECIFIERS: readonly string[] = [
  "./worker-supervisor-lifecycle.service",
  "node:child_process",
];

describe("INV-WORKER-LOCK-RESPONSIBILITY-001: Module C lock-orchestrator responsibility boundary", () => {
  let project: Project;
  let moduleC: SourceFile;

  beforeAll(() => {
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
    moduleC = project.addSourceFileAtPath(MODULE_C_PATH);
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-WORKER-LOCK-RESPONSIBILITY-001");
  });

  it("INV-WORKER-LOCK-RESPONSIBILITY-001: Module C does NOT runtime-import Module B / Module C は Module B を runtime import しない", () => {
    const decls = moduleC.getImportDeclarations();
    const violations: string[] = [];

    for (const decl of decls) {
      const specifier = decl.getModuleSpecifierValue();
      if (specifier !== "./worker-supervisor-lifecycle.service") continue;
      if (decl.isTypeOnly()) continue;
      const runtimeNames: string[] = [];
      for (const named of decl.getNamedImports()) {
        if (!named.isTypeOnly()) runtimeNames.push(named.getName());
      }
      if (decl.getDefaultImport() !== undefined) runtimeNames.push("(default)");
      if (decl.getNamespaceImport() !== undefined) runtimeNames.push("(namespace)");
      if (runtimeNames.length > 0) {
        violations.push(
          `Module C (worker-supervisor-lock-orchestrator.service.ts) directly runtime-imports Module B (${specifier}): ${runtimeNames.join(", ")}. ` +
            `Cross-module call MUST traverse Module A facade via this.supervisor.getLifecycle().`
        );
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("INV-WORKER-LOCK-RESPONSIBILITY-001: Module C does NOT import node:child_process / Module C は node:child_process を import しない", () => {
    // Spawn responsibility is Module B's. Module C MUST NOT import fork/spawn primitives.
    const decls = moduleC.getImportDeclarations();
    const violations: string[] = [];

    for (const decl of decls) {
      const specifier = decl.getModuleSpecifierValue();
      if (specifier !== "node:child_process") continue;
      // node:child_process type-only is irrelevant since types are not normally
      // imported from this module; flag any import.
      const runtimeNames: string[] = [];
      for (const named of decl.getNamedImports()) {
        if (!named.isTypeOnly()) runtimeNames.push(named.getName());
      }
      if (decl.getDefaultImport() !== undefined) runtimeNames.push("(default)");
      if (decl.getNamespaceImport() !== undefined) runtimeNames.push("(namespace)");
      if (runtimeNames.length > 0) {
        violations.push(
          `Module C imports node:child_process: ${runtimeNames.join(", ")}. ` +
            `Spawn / fork is Module B's responsibility.`
        );
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("INV-WORKER-LOCK-RESPONSIBILITY-001: Module C → Module A is type-only / Module C → Module A は type-only", () => {
    const decls = moduleC.getImportDeclarations();
    const violations: string[] = [];

    for (const decl of decls) {
      const specifier = decl.getModuleSpecifierValue();
      if (specifier !== "./worker-supervisor.service") continue;
      if (decl.isTypeOnly()) continue;
      const runtimeNames: string[] = [];
      for (const named of decl.getNamedImports()) {
        if (!named.isTypeOnly()) runtimeNames.push(named.getName());
      }
      if (decl.getDefaultImport() !== undefined) runtimeNames.push("(default)");
      if (decl.getNamespaceImport() !== undefined) runtimeNames.push("(namespace)");
      if (runtimeNames.length > 0) {
        violations.push(
          `Module C → Module A MUST be type-only to avoid runtime cycle. ` +
            `Found runtime imports: ${runtimeNames.join(", ")}`
        );
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("INV-WORKER-LOCK-RESPONSIBILITY-001: Module C import contract enumeration / 全 forbidden specifier の網羅検証", () => {
    const decls = moduleC.getImportDeclarations();
    const allViolations: string[] = [];

    for (const forbiddenSpec of FORBIDDEN_RUNTIME_IMPORT_SPECIFIERS) {
      for (const decl of decls) {
        if (decl.getModuleSpecifierValue() !== forbiddenSpec) continue;
        if (decl.isTypeOnly()) continue;
        const runtimeNames: string[] = [];
        for (const named of decl.getNamedImports()) {
          if (!named.isTypeOnly()) runtimeNames.push(named.getName());
        }
        if (decl.getDefaultImport() !== undefined) runtimeNames.push("(default)");
        if (decl.getNamespaceImport() !== undefined) runtimeNames.push("(namespace)");
        if (runtimeNames.length > 0) {
          allViolations.push(`${forbiddenSpec}: ${runtimeNames.join(", ")}`);
        }
      }
    }

    expect(
      allViolations,
      `Module C forbidden runtime imports detected:\n${allViolations.join("\n")}`
    ).toEqual([]);
  });

  it("INV-WORKER-LOCK-RESPONSIBILITY-001: Module C does NOT register process.on('exit') / Module C は process.on('exit') を登録しない (SEC L-03 advisory)", () => {
    // Static check — Module C MUST NOT contain `process.on('exit'` or
    // `process.once('exit'` actual call expressions (excluding JSDoc / comments).
    // ts-morph's getDescendantsOfKind(CallExpression) gives us only real call
    // expressions, eliminating false positives from doc references.
    const callExpressions = moduleC.getDescendantsOfKind(SyntaxKind.CallExpression);
    const violations: string[] = [];
    for (const call of callExpressions) {
      const text = call.getText();
      // Match `process.on("exit", ...)` / `process.on('exit', ...)` and `process.once`.
      if (/^process\.(on|once)\s*\(\s*["']exit["']/.test(text)) {
        violations.push(text.split("\n")[0] ?? text);
      }
    }
    expect(
      violations,
      `Module C MUST NOT register process.on('exit') / process.once('exit') hooks (SEC L-03 advisory). ` +
        `Lifecycle hooks belong in Module B / Module A. Found: ${violations.join(", ")}`
    ).toEqual([]);
  });
});
