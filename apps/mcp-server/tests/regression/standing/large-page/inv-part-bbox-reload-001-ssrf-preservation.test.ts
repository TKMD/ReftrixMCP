// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-PART-BBOX-RELOAD-001 (SSRF preservation)
 *
 * Plan v3 T5 V1 §1.4 (U-T5-4) AST scan: ensures the layered Part bbox
 * resolution pipeline (Option A scroll replay / Option B targeted requery /
 * Option C stale detection) does NOT introduce un-guarded `page.goto()`
 * callsites. SSRF guard via `validateExternalUrl()` is preserved by:
 *
 *   (a) `part-bbox-playwright.service.ts` — every `page.goto(url)` callsite
 *       MUST be preceded in the same call frame by `validateExternalUrl(url)`
 *       invocation (or guarded by a parent caller path).
 *   (b) `bbox-resolution-pipeline.ts` (NEW V1) — MUST NOT contain ANY
 *       `page.goto()` AST node. The pipeline operates on a pre-loaded Page
 *       object only; navigation/SSRF is the service-layer concern.
 *
 * **Severity**: M (FIND-PLAN-SEC-T5-02 — preservation invariant).
 *
 * **Cross-INV impact**: complements INV-AUDIT-EMIT-SSOT-IMPORT-001 (ts-morph
 * pattern). Forward-compatible: any future `page.goto()` introduced in the
 * scanned files fails this test immediately at CI time.
 *
 * @see Plan v3 T5 V1 §1.4 U-T5-4 + §3.6 contract preservation
 * @see ADR-0018 §Decision 1 Supplement S3 (`bbox_unresolvable` mutual exclusivity)
 * @module tests/regression/standing/large-page/inv-part-bbox-reload-001-ssrf-preservation
 */

import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { Project, SyntaxKind } from "ts-morph";
import type { CallExpression, SourceFile } from "ts-morph";
import { assertInvName } from "../_setup/inv-assert";

// ============================================================================
// Constants
// ============================================================================

const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../..");
const SRC_ROOT = path.resolve(MCP_SERVER_ROOT, "src");

const SERVICE_FILE = path.resolve(SRC_ROOT, "services/part/part-bbox-playwright.service.ts");
const PIPELINE_FILE = path.resolve(SRC_ROOT, "services/part/bbox-resolution-pipeline.ts");

// ============================================================================
// Helpers
// ============================================================================

function createAstProject(): Project {
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
 * Find every `page.goto(...)` CallExpression in a SourceFile. Pattern: any
 * CallExpression whose expression is a PropertyAccessExpression with `.goto`
 * as the property name (mirrors INV-AUDIT-EMIT-SSOT-IMPORT-001 AST shape).
 */
function findPageGotoCalls(sourceFile: SourceFile): CallExpression[] {
  const calls: CallExpression[] = [];
  sourceFile.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    const call = node as CallExpression;
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const propName = propAccess.getName();
    if (propName === "goto") {
      // Filter to `page.goto` / `currentPage.goto` etc. — any identifier
      // ending in receiver-position whose name suggests a Page object.
      // For SSRF preservation we are conservative: ANY `.goto()` callsite
      // is flagged for inspection.
      calls.push(call);
    }
  });
  return calls;
}

/**
 * Walk up the AST to find a `validateExternalUrl(...)` call in the enclosing
 * function/method body. Returns true when guard is present; false otherwise.
 */
function hasValidateExternalUrlGuard(call: CallExpression): boolean {
  const enclosingFunction =
    call.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration) ??
    call.getFirstAncestorByKind(SyntaxKind.MethodDeclaration) ??
    call.getFirstAncestorByKind(SyntaxKind.ArrowFunction) ??
    call.getFirstAncestorByKind(SyntaxKind.FunctionExpression);
  if (!enclosingFunction) return false;
  const text = enclosingFunction.getText();
  return /validateExternalUrl\s*\(/.test(text);
}

// ============================================================================
// AST scan — SSRF preservation invariant
// ============================================================================

describe("INV-PART-BBOX-RELOAD-001: SSRF preservation AST scan (Plan v3 T5 V1 §1.4 U-T5-4)", () => {
  let serviceFile: SourceFile;
  let pipelineFile: SourceFile;

  beforeAll(() => {
    const project = createAstProject();
    serviceFile = project.addSourceFileAtPath(SERVICE_FILE);
    pipelineFile = project.addSourceFileAtPath(PIPELINE_FILE);
  });

  beforeAll(() => {
    // No-op — assertInvName is checked per-test via `it()` titles.
  });

  it("INV-PART-BBOX-RELOAD-001: bbox-resolution-pipeline.ts contains ZERO page.goto() callsites (structural SSRF immunity)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PART-BBOX-RELOAD-001");

    const gotoCalls = findPageGotoCalls(pipelineFile);

    // Pipeline is a pure orchestrator; navigation is the caller's concern.
    // ANY page.goto() introduced here breaks the V1 §3.6 contract.
    expect(gotoCalls).toHaveLength(0);
  });

  it("INV-PART-BBOX-RELOAD-001: every page.goto() in part-bbox-playwright.service.ts is guarded by validateExternalUrl()", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PART-BBOX-RELOAD-001");

    const gotoCalls = findPageGotoCalls(serviceFile);

    // service.ts has at least 1 known callsite (resolvePartBoundingBoxes
    // navigation) — sanity check the scan is non-empty so a future refactor
    // that *removes* the callsite without consideration also surfaces.
    expect(gotoCalls.length).toBeGreaterThan(0);

    for (const call of gotoCalls) {
      const guarded = hasValidateExternalUrlGuard(call);
      expect(guarded, `Unguarded page.goto() at line ${call.getStartLineNumber()}`).toBe(true);
    }
  });

  it("INV-PART-BBOX-RELOAD-001: bbox-resolution-pipeline.ts contains ZERO direct fetch / http imports (no out-of-band navigation)", () => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PART-BBOX-RELOAD-001");

    const text = pipelineFile.getFullText();
    // Simple regex scan: ensure no `fetch(` / `import('http')` etc. The
    // pipeline must operate purely on the injected Page interface.
    expect(/\bfetch\s*\(/.test(text)).toBe(false);
    expect(/from\s+['"]node:https?['"]/g.test(text)).toBe(false);
    expect(/from\s+['"]https?['"]/g.test(text)).toBe(false);
  });
});
