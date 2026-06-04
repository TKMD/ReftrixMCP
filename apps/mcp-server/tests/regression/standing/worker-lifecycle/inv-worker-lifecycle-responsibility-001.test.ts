// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-WORKER-LIFECYCLE-RESPONSIBILITY-001
 *
 * CO-26 split (PR-V3-CO-26-SPLIT) で導入された Module B (lifecycle) の
 * **responsibility boundary contract** を AST gate で検証する。
 *
 * Verifies the **responsibility boundary contract** of Module B (lifecycle)
 * introduced by CO-26 split.
 *
 * **Forbidden imports for Module B / Module B が import してはならないもの**:
 *   - `worker-active-lock.service` (Redis lock service) — direct runtime import is forbidden;
 *     all lock callsites MUST traverse Module A facade via
 *     `this.supervisor.getLockOrchestrator().X()` indirect path.
 *
 * **Why**: Module B (lifecycle) responsibility = spawn / IPC dispatch / exit
 * handling / initiated restart. Lock orchestration is Module C's responsibility.
 * Direct import of `worker-active-lock.service` from Module B would violate
 * the explicit state-sharing accessor pattern (TPA-01) and create a hidden
 * coupling that bypasses the cycle-free contract.
 *
 * Module B が `worker-active-lock.service` を直接 import すると Module A facade を
 * bypass する hidden coupling になり、cycle-free contract を破壊する。
 *
 * **Allowed**:
 *   - `import type` from `worker-active-lock.service` (e.g. `WorkerActiveLockService` type
 *     for type guards in callbacks). Type-only is erased at compile time.
 *   - `worker-supervisor-helpers` (helper functions like `executeSelfChainedRespawn`,
 *     `clearLockHeartbeatTimer`) — helpers are layered architecture, NOT module C.
 *
 * @see  §3.1 Module B / §3.3
 * @see TPA-01 amendment (IO Plan Decision `019df1a3-b9c3-770a-b7d3-27e7dbc548f2`)
 */

import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Project } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { assertInvName } from "../_setup/inv-assert";

const SERVICES_ROOT = path.resolve(__dirname, "../../../../src/services");
const MODULE_B_PATH = path.join(SERVICES_ROOT, "worker-supervisor-lifecycle.service.ts");

/** Specifiers that Module B is forbidden from runtime-importing (advisory: Module C). */
const FORBIDDEN_RUNTIME_IMPORT_SPECIFIERS: readonly string[] = [
  "./worker-active-lock.service",
  "./worker-supervisor-lock-orchestrator.service",
];

describe("INV-WORKER-LIFECYCLE-RESPONSIBILITY-001: Module B lifecycle responsibility boundary", () => {
  let project: Project;
  let moduleB: SourceFile;

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
    moduleB = project.addSourceFileAtPath(MODULE_B_PATH);
  });

  beforeEach(() => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-WORKER-LIFECYCLE-RESPONSIBILITY-001"
    );
  });

  it("INV-WORKER-LIFECYCLE-RESPONSIBILITY-001: Module B does NOT runtime-import worker-active-lock.service / Module B は worker-active-lock.service を runtime import しない", () => {
    const decls = moduleB.getImportDeclarations();
    const violations: string[] = [];

    for (const decl of decls) {
      const specifier = decl.getModuleSpecifierValue();
      if (specifier !== "./worker-active-lock.service") continue;
      // Type-only is allowed.
      if (decl.isTypeOnly()) continue;
      // Inspect named imports — if all named are type-only, it's still safe.
      const runtimeNames: string[] = [];
      for (const named of decl.getNamedImports()) {
        if (!named.isTypeOnly()) {
          runtimeNames.push(named.getName());
        }
      }
      if (decl.getDefaultImport() !== undefined) {
        runtimeNames.push("(default import)");
      }
      if (decl.getNamespaceImport() !== undefined) {
        runtimeNames.push("(namespace import)");
      }
      if (runtimeNames.length > 0) {
        violations.push(
          `Module B (worker-supervisor-lifecycle.service.ts) directly runtime-imports from worker-active-lock.service: ${runtimeNames.join(", ")}. ` +
            `Lock orchestration is Module C's responsibility; access via this.supervisor.getLockOrchestrator() instead.`
        );
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("INV-WORKER-LIFECYCLE-RESPONSIBILITY-001: Module B does NOT runtime-import Module C directly / Module B は Module C を直接 runtime import しない", () => {
    const decls = moduleB.getImportDeclarations();
    const violations: string[] = [];

    for (const decl of decls) {
      const specifier = decl.getModuleSpecifierValue();
      if (specifier !== "./worker-supervisor-lock-orchestrator.service") continue;
      if (decl.isTypeOnly()) continue;
      const runtimeNames: string[] = [];
      for (const named of decl.getNamedImports()) {
        if (!named.isTypeOnly()) runtimeNames.push(named.getName());
      }
      if (decl.getDefaultImport() !== undefined) runtimeNames.push("(default)");
      if (decl.getNamespaceImport() !== undefined) runtimeNames.push("(namespace)");
      if (runtimeNames.length > 0) {
        violations.push(
          `Module B directly runtime-imports Module C (${specifier}): ${runtimeNames.join(", ")}. ` +
            `Cross-module call MUST traverse Module A facade via this.supervisor.getLockOrchestrator().`
        );
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("INV-WORKER-LIFECYCLE-RESPONSIBILITY-001: Module B import contract enumeration / 全 forbidden specifier の網羅検証", () => {
    const decls = moduleB.getImportDeclarations();
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
      `Module B forbidden runtime imports detected:\n${allViolations.join("\n")}`
    ).toEqual([]);
  });
});
