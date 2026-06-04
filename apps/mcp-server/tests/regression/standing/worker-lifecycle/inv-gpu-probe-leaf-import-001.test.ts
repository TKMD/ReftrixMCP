// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-GPU-PROBE-LEAF-IMPORT-001
 *
 * **PR-1 GPU-COORD / IO Plan Decision V1 APPROVE (anchor 019e562d)**
 * **FIND-PLAN-H-02 (TPA-H-02) closure / ADR-0038 §1.3 / ADR-0037 fork-only boundary**
 *
 * ## Contract / 不変条件
 *
 * **The VRAM-threshold leaf module (`vram-thresholds.ts`) and the Phase 5
 * fork-child probe (`phase-5-gpu-probe.ts`) MUST NOT transitively import the
 * in-process full GpuResourceManager (`gpu-resource-manager.ts`).**
 *
 * ADR-0037 (per-job fork-only model) established that the fork child holds NO
 * in-process manager. If the fork child imported `gpu-resource-manager.ts`, the
 * in-process full GpuResourceManager would flow into the fork-only boundary via
 * its transitive dependency graph — violating ADR-0037. Relocating the VRAM
 * threshold constants into a leaf module (with the in-process manager importing
 * FROM the leaf for SSOT, not the reverse) preserves the fork-only boundary.
 *
 * ## AST gate (ts-morph, transitive traversal)
 *
 * Starting from the leaf module and the fork-child probe, this test transitively
 * resolves every relative import edge (within `src/`) and asserts that
 * `gpu-resource-manager.ts` is NEVER reached. Node builtins and bare-specifier
 * (node_modules) imports are leaf-stops. Type-only edges (`import type {...}`)
 * are erased at compile time and excluded.
 *
 * ## Scope (test cases)
 *
 * | # | What it pins                                                                                |
 * | - | ------------------------------------------------------------------------------------------- |
 * | 1 | `vram-thresholds.ts` transitive import graph never reaches `gpu-resource-manager.ts`        |
 * | 2 | `phase-5-gpu-probe.ts` transitive import graph never reaches `gpu-resource-manager.ts`      |
 * | 3 | `vram-thresholds.ts` is a true leaf (zero runtime relative imports)                          |
 * | 4 | SSOT direction: `gpu-resource-manager.ts` imports FROM `vram-thresholds.ts` (not the reverse)|
 *
 * @see ADR-0038 §1.3 / §1.5 (FIND-PLAN-H-02)
 * @see ADR-0037 (per-job fork-only model)
 * @see inv-worker-module-import-cycle-001.test.ts (ts-morph AST gate exemplar)
 * @module tests/regression/standing/worker-lifecycle/inv-gpu-probe-leaf-import-001
 */

import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Project } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { assertInvName } from "../_setup/inv-assert";

const INV = "INV-GPU-PROBE-LEAF-IMPORT-001";

const SRC_ROOT = path.resolve(__dirname, "../../../../src");
const LEAF_PATH = path.join(SRC_ROOT, "services/vision/vram-thresholds.ts");
const PROBE_PATH = path.join(SRC_ROOT, "workers/phases/phase-5-gpu-probe.ts");
const FORBIDDEN_BASENAME = "gpu-resource-manager.ts";

/**
 * Resolve a relative import specifier against the importing file's directory.
 * Returns the absolute `.ts` path if it exists under `src/`, else null
 * (bare specifier / node builtin / unresolvable → leaf-stop).
 */
function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null; // bare specifier / builtin
  const fromDir = path.dirname(fromFile);
  // Strip a trailing .js (ESM import style) and try .ts; also try direct + index.
  const stripped = specifier.replace(/\.js$/, "");
  const candidates = [
    path.resolve(fromDir, `${stripped}.ts`),
    path.resolve(fromDir, stripped, "index.ts"),
    path.resolve(fromDir, specifier),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && c.endsWith(".ts")) return c;
  }
  return null;
}

/**
 * Transitively collect every runtime-reachable `.ts` file from `entry`,
 * excluding type-only import edges. Returns the set of visited absolute paths.
 */
function collectTransitiveRuntimeImports(project: Project, entry: string): Set<string> {
  const visited = new Set<string>();
  const stack: string[] = [entry];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    let sf: SourceFile;
    try {
      sf = project.addSourceFileAtPathIfExists(current) ?? project.addSourceFileAtPath(current);
    } catch {
      continue;
    }

    for (const decl of sf.getImportDeclarations()) {
      if (decl.isTypeOnly()) continue; // type-only edge erased at compile
      // Skip declarations with only type-named imports.
      const hasRuntimeNamed = decl.getNamedImports().some((n) => !n.isTypeOnly());
      const hasDefault = decl.getDefaultImport() !== undefined;
      const hasNamespace = decl.getNamespaceImport() !== undefined;
      const hasSideEffect = decl.getNamedImports().length === 0 && !hasDefault && !hasNamespace;
      if (!hasRuntimeNamed && !hasDefault && !hasNamespace && !hasSideEffect) continue;

      const resolved = resolveRelativeImport(current, decl.getModuleSpecifierValue());
      if (resolved && !visited.has(resolved)) stack.push(resolved);
    }
  }
  return visited;
}

describe(`${INV}: VRAM threshold leaf module preserves ADR-0037 fork-only boundary`, () => {
  let project: Project;

  beforeAll(() => {
    project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      skipLoadingLibFiles: true,
      compilerOptions: { allowJs: false, strict: true },
    });
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", INV);
  });

  it(`${INV}: vram-thresholds.ts transitive graph never reaches gpu-resource-manager.ts`, () => {
    expect(fs.existsSync(LEAF_PATH), `leaf module must exist: ${LEAF_PATH}`).toBe(true);
    const reachable = collectTransitiveRuntimeImports(project, LEAF_PATH);
    const offenders = [...reachable].filter((p) => path.basename(p) === FORBIDDEN_BASENAME);
    expect(
      offenders,
      `vram-thresholds.ts (leaf) MUST NOT transitively import ${FORBIDDEN_BASENAME} ` +
        `(ADR-0037 fork-only boundary). Reached via: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it(`${INV}: phase-5-gpu-probe.ts transitive graph never reaches gpu-resource-manager.ts`, () => {
    expect(fs.existsSync(PROBE_PATH), `probe module must exist: ${PROBE_PATH}`).toBe(true);
    const reachable = collectTransitiveRuntimeImports(project, PROBE_PATH);
    const offenders = [...reachable].filter((p) => path.basename(p) === FORBIDDEN_BASENAME);
    expect(
      offenders,
      `phase-5-gpu-probe.ts (fork-child probe) MUST NOT transitively import ${FORBIDDEN_BASENAME} ` +
        `(ADR-0037 fork-only boundary). Reached via: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  it(`${INV}: vram-thresholds.ts is a true leaf (zero runtime relative imports)`, () => {
    const sf = project.addSourceFileAtPath(LEAF_PATH);
    const runtimeRelativeImports = sf
      .getImportDeclarations()
      .filter((d) => !d.isTypeOnly() && d.getModuleSpecifierValue().startsWith("."))
      .map((d) => d.getModuleSpecifierValue());
    expect(
      runtimeRelativeImports,
      `vram-thresholds.ts MUST be a pure-constant leaf (no runtime relative imports). Found: ${runtimeRelativeImports.join(", ")}`
    ).toEqual([]);
  });

  it(`${INV}: SSOT direction — gpu-resource-manager.ts imports FROM vram-thresholds.ts`, () => {
    const managerPath = path.join(SRC_ROOT, "services/gpu-resource-manager.ts");
    const sf = project.addSourceFileAtPath(managerPath);
    const importsLeaf = sf
      .getImportDeclarations()
      .some((d) => d.getModuleSpecifierValue().includes("vision/vram-thresholds"));
    expect(
      importsLeaf,
      `gpu-resource-manager.ts MUST import VRAM thresholds FROM the leaf SSOT (literal duplication forbidden)`
    ).toBe(true);
  });
});
