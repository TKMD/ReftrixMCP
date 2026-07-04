// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-PAGE-EVALUATE-NO-NAME-INJECTION-001 (H)
 *
 * W6 Issue A (part bbox `__name` ReferenceError fix). Asserts that the
 * `page.evaluate` callback **serialized body** of `runBboxPageEvaluate`
 * (`part-bbox-playwright.service.ts`) contains **no `__name(...)` helper call**
 * after a tsx-faithful keepNames transform.
 *
 * 真因 / Root cause: a named arrow `const` binding (`const finalize = (...) => {}`)
 * inside a `page.evaluate` callback is wrapped by esbuild keepNames into
 * `const finalize = __name((...) => {}, "finalize")`. `page.evaluate` serializes
 * the callback via `Function.prototype.toString()`, so `__name(...)` leaks into
 * the browser where the `__name` helper does not exist →
 * `ReferenceError: __name is not defined`. The throw is swallowed by the sweep
 * catch and sanitised → `resolvedCount: 0` on every page. The fix decomposes the
 * named inline helpers into argument-position anonymous callbacks (`.map` /
 * `[selector].map(...)[0]`), which esbuild keepNames does NOT wrap.
 *
 * Host-independent by construction: this is a **transform-level** assertion
 * (esbuild + ts-morph over production source), so the CI host's launch path
 * (tsx vs dist) is irrelevant — it asserts the SOURCE cannot emit `__name` under
 * a tsx keepNames transform, which is true regardless of how a given host
 * launches the worker.
 *
 * **Make-or-break L-11 detail**: the `__name` count is scoped to the **callback
 * body span**, NOT the whole transformed module. The whole-module output also
 * contains the OUTER `runBboxPageEvaluate` function's own keepNames `__name`
 * wrap (and ~16 unrelated wraps elsewhere in the file), so a whole-module count
 * would false-RED a clean fix. The locator scopes to the `page.evaluate`
 * argument-callback body, which is the only place a serialize-injected `__name`
 * is a real browser bug.
 *
 * **non-vacuity 2-guard (M-3)**:
 *   (a) positive-control: a fixture with a named-bound `page.evaluate` callback
 *       MUST emit `__name` in its callback body under the same transform (proves
 *       the 0-count assertion is not vacuous and the transform opts still inject).
 *   (b) locator-guard: the AST-locate MUST extract ≥1 `page.evaluate` callback
 *       from `runBboxPageEvaluate` (proves "0 callbacks found → vacuous GREEN" is
 *       structurally excluded).
 *
 * **L-3 derive-from-tsx**: the transform opts (`keepNames` + `minifyWhitespace`)
 * are pinned to the installed tsx's own frozen transform options via a provenance
 * guard that reads tsx's dist. If a future tsx drops keepNames/minifyWhitespace,
 * the provenance guard RED-flags the drift (forcing re-derivation), so the opts
 * never silently diverge from production tsx (config-drift false-GREEN防止).
 *
 * **Severity**: H (code + CI). The `__name` leak made `resolvePartBoundingBoxes`
 * return `resolvedCount: 0` on every page → part visual embeddings all lost.
 *
 * **Tier**: Tier1 (gating) = `runBboxPageEvaluate` only. A codebase-wide Tier2
 * scan is intentionally NOT landed here: PRE-step 2 (the M-2 codebase-wide
 * harness) found additional tsx-reachable unsafe bodies in motion/animation
 * detectors that are out of THIS PR's scope, so an allowlist-free codebase-wide
 * INV would land standing-RED (P0). Tier2 lands in a follow-up PR once those are
 * fixed (per plan §5.5 / §9 case-C / M-2).
 *
 * @see  §6
 * @see  (M-3 / L-2 / L-3 / L-11)
 * @module tests/regression/standing/large-page/inv-page-evaluate-no-name-injection-001
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";
import { transformSync } from "esbuild";
import { Project, SyntaxKind } from "ts-morph";
import type { Node } from "ts-morph";
import { assertInvName } from "../_setup/inv-assert";

// ============================================================================
// Constants / paths (L-2: repo-anchored fixed glob; env/argv cannot redirect)
// ============================================================================

const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../..");
const SRC_ROOT = path.resolve(MCP_SERVER_ROOT, "src");
const BBOX_SERVICE_FILE = path.resolve(SRC_ROOT, "services/part/part-bbox-playwright.service.ts");

/** The function whose `page.evaluate` body is the gating subject. */
const GATE_FUNCTION = "runBboxPageEvaluate";

/** `__name(` helper-call detector (word-boundary, optional whitespace). */
const NAME_CALL_RE = /\b__name\s*\(/g;

// ============================================================================
// L-3 — transform opts derived/pinned from tsx's own frozen transform options
// ============================================================================

/**
 * tsx (4.x) transforms every `.ts` module with esbuild using its frozen options
 * `{ target: node<ver>, loader: "default", sourcemap, sourcesContent,
 * minifyWhitespace: true, keepNames: true }` (ESM format). The two options that
 * govern `__name` injection are `keepNames` + `minifyWhitespace`. We replicate
 * those here and pin them to the installed tsx via `assertTsxKeepNamesProvenance`.
 */
const TSX_DERIVED_TRANSFORM = {
  loader: "ts",
  format: "esm",
  target: `node${process.versions.node}`,
  minifyWhitespace: true,
  keepNames: true,
  sourcemap: false,
} as const;

/**
 * L-3 provenance guard: read the installed tsx's dist transform module and
 * assert it still uses `keepNames` + `minifyWhitespace`. If a future tsx changes
 * these, this RED-flags the drift so `TSX_DERIVED_TRANSFORM` cannot silently
 * diverge from production tsx behavior.
 */
function assertTsxKeepNamesProvenance(): { distFilesChecked: number; matched: number } {
  const require = createRequire(path.join(MCP_SERVER_ROOT, "package.json"));
  const tsxPkgJson = require.resolve("tsx/package.json");
  const tsxDist = path.join(path.dirname(tsxPkgJson), "dist");
  const distFiles = fs
    .readdirSync(tsxDist)
    .filter((f) => /^index-.*\.(cjs|mjs)$/.test(f))
    .map((f) => path.join(tsxDist, f));
  // esbuild minified booleans: `true` → `!0`. tsx frozen options literal is
  // `minifyWhitespace:!0,keepNames:!0` (whitespace-tolerant).
  const provenanceRe = /minifyWhitespace:\s*!0\s*,\s*keepNames:\s*!0/;
  let matched = 0;
  for (const f of distFiles) {
    if (provenanceRe.test(fs.readFileSync(f, "utf8"))) matched++;
  }
  return { distFilesChecked: distFiles.length, matched };
}

// ============================================================================
// Transform + AST-locate helpers (L-11: callback body span scoping)
// ============================================================================

function transformLikeTsx(src: string): string {
  return transformSync(src, TSX_DERIVED_TRANSFORM).code;
}

/**
 * Count `__name(` occurrences inside the body span of every `page.evaluate` /
 * `page.evaluateHandle` argument-callback that lives inside `fnName`. The body
 * span scoping (L-11) excludes the OUTER `fnName` keepNames wrap and any
 * unrelated wraps elsewhere in the module — only a serialize-injected `__name`
 * inside the callback body is a real browser bug.
 *
 * @param jsCode  tsx-transformed JS (whole module).
 * @param fnName  the function whose evaluate-callbacks are inspected (undefined =
 *                whole module — used only for the standalone positive-control fixture).
 */
function countNameInEvaluateCallbacks(
  jsCode: string,
  fnName?: string
): { callbacks: number; nameInBody: number } {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile("transformed.js", jsCode, { overwrite: true });

  let scope: Node = sf;
  if (fnName) {
    const fn = sf.getFunction(fnName);
    if (!fn) {
      throw new Error(
        `[INV-PAGE-EVALUATE-NO-NAME-INJECTION-001] ${fnName} not found in transformed output ` +
          `(keepNames should preserve the function name)`
      );
    }
    scope = fn;
  }

  const calls = scope.getDescendantsOfKind(SyntaxKind.CallExpression);
  let callbacks = 0;
  let nameInBody = 0;
  for (const call of calls) {
    const exprText = call.getExpression().getText();
    if (!exprText.endsWith(".evaluate") && !exprText.endsWith(".evaluateHandle")) continue;
    const arg0 = call.getArguments()[0];
    if (!arg0) continue;
    const kind = arg0.getKind();
    if (kind !== SyntaxKind.ArrowFunction && kind !== SyntaxKind.FunctionExpression) continue;
    callbacks++;
    const body = arg0.asKindOrThrow(kind).getBody();
    nameInBody += (body.getText().match(NAME_CALL_RE) || []).length;
  }
  return { callbacks, nameInBody };
}

// ============================================================================
// Tier1 — runBboxPageEvaluate gating
// ============================================================================

describe("INV-PAGE-EVALUATE-NO-NAME-INJECTION-001: Tier1 bbox gate", () => {
  it("INV-PAGE-EVALUATE-NO-NAME-INJECTION-001: runBboxPageEvaluate page.evaluate callback body emits no __name under tsx keepNames transform", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-PAGE-EVALUATE-NO-NAME-INJECTION-001"
    );
    const src = fs.readFileSync(BBOX_SERVICE_FILE, "utf8");
    const transformed = transformLikeTsx(src);
    const { callbacks, nameInBody } = countNameInEvaluateCallbacks(transformed, GATE_FUNCTION);
    // M-3(b) locator-guard: a page.evaluate callback MUST be found inside the gate
    // function (else "0 found → vacuous GREEN").
    expect(callbacks).toBeGreaterThanOrEqual(1);
    // Tier1 gating assertion: zero serialize-injected `__name` in the callback body.
    expect(nameInBody).toBe(0);
  });
});

// ============================================================================
// non-vacuity 2-guard (M-3)
// ============================================================================

describe("INV-PAGE-EVALUATE-NO-NAME-INJECTION-001: non-vacuity guards", () => {
  it("INV-PAGE-EVALUATE-NO-NAME-INJECTION-001: (M-3a positive-control) a named-bound page.evaluate callback DOES emit __name under the same transform", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-PAGE-EVALUATE-NO-NAME-INJECTION-001"
    );
    // A deliberately named const arrow inside a page.evaluate callback. If the
    // transform opts ever stop injecting `__name` (e.g. a tsx keepNames change),
    // THIS guard RED-flags it, proving the Tier1 0-count is not vacuous.
    const fixture = [
      "async function pcFixture(page, selectors) {",
      "  return page.evaluate((data) => {",
      "    const finalize = (x) => x.id;",
      "    return data.map(finalize);",
      "  }, selectors);",
      "}",
    ].join("\n");
    const transformed = transformLikeTsx(fixture);
    const { callbacks, nameInBody } = countNameInEvaluateCallbacks(transformed, "pcFixture");
    expect(callbacks).toBeGreaterThanOrEqual(1);
    expect(nameInBody).toBeGreaterThanOrEqual(1);
  });

  it("INV-PAGE-EVALUATE-NO-NAME-INJECTION-001: (L-3 provenance) installed tsx still uses keepNames + minifyWhitespace (opts pinned to tsx)", () => {
    assertInvName(
      expect.getState().currentTestName ?? "",
      "INV-PAGE-EVALUATE-NO-NAME-INJECTION-001"
    );
    const { distFilesChecked, matched } = assertTsxKeepNamesProvenance();
    // tsx ships ≥1 dist transform module; at least one must carry the frozen
    // `minifyWhitespace:!0,keepNames:!0` options literal we replicate.
    expect(distFilesChecked).toBeGreaterThanOrEqual(1);
    expect(matched).toBeGreaterThanOrEqual(1);
  });
});
