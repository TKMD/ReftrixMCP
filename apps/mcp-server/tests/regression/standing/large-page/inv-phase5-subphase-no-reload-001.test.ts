// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-PHASE5-SUBPHASE-NO-RELOAD-001
 *
 * PR-BT-5 (M-1-RSS, ADR-0039 Decision 2, unblock #1 / TPA-H-01). Verifies the
 * **correctly-defined** no-reload invariant for the per-sub-phase fork model.
 *
 * **No false invariant (no-fake-success)**: "each fork loads e5/DINOv2 exactly
 * once" is FALSE for multi-chunk sub-phases (the chunk-boundary
 * `disposeEmbeddingPipeline()` → next-chunk in-process re-load remains). Burning
 * an "exactly 1 load" invariant is FORBIDDEN. The correct, testable proposition
 * is TWO parts (ADR-0039 Decision 2 / Design §5.1):
 *
 *   (a) **Source-pin**: `terminateAndRespawnEmbeddingPipeline()` is REMOVED from
 *       the fork-child path — its invocation count across BOTH
 *       `phase-5-embedding.ts` AND the extracted chunk-loop driver
 *       `phase-5-chunked-text-loop.ts` is 0 (AST CallExpression sweep). This
 *       roots out the inter-sub-phase reload (the M-1-RSS root cause): the
 *       fork-boundary OS reclamation replaces it. A regression that re-adds the
 *       call in either file is detected here.
 *
 *   (b) **Intra-fork reload upper bound = max(1, chunkCount)**: the
 *       chunk-boundary `disposeEmbeddingPipeline()` is RETAINED (transient
 *       memory recovery). A multi-chunk sub-phase still re-loads the model per
 *       chunk inside its single fork (NOT rescued by fork exit). This test
 *       pins that the chunk-boundary dispose is RETAINED (so the bound is the
 *       documented `max(1, chunkCount)`, not zero and not "exactly 1").
 *
 * **PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a) refactor note**:
 * the canonical chunk loop (originally inline in `processSectionTextEmbeddingChunks`
 * / `processPartTextEmbeddingChunks`) was extracted into the shared
 * `runChunkedTextEmbeddingLoop` driver (`phase-5-chunked-text-loop.ts`) so all
 * text sub-phases consume the identical C1 per-chunk RSS budget break +
 * chunk-boundary dispose. The chunk-boundary `disposeEmbeddingPipeline()` therefore
 * now lives in the DRIVER file, not the per-processor bodies. This test scans
 * BOTH files for (a) and (b) so the invariant's intent (no `terminateAndRespawn`;
 * chunk-boundary dispose RETAINED) is preserved across the refactor — it is NOT
 * weakened (the dispose merely relocated; a regression that deletes it from the
 * driver, or re-adds `terminateAndRespawn` to either file, still fails).
 *
 * a CI-failing executable invariant. `.skip()` / `.todo()` are forbidden; any
 * failure is a P0 incident handled by pipeline-engineer +
 * capture-embedding-engineer.
 *
 * @see  Decision 2
 * @see src/workers/phases/phase-5-embedding.ts (sub-phase functions)
 * @module tests/regression/standing/large-page/inv-phase5-subphase-no-reload-001
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import path from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { assertInvName } from "../_setup/inv-assert";

/** The forbidden wrapper method name (removed from fork-child path, ADR-0039 D2). */
const FORBIDDEN_RELOAD_CALL = "terminateAndRespawnEmbeddingPipeline";

/** The retained chunk-boundary transient-recovery method name. */
const RETAINED_CHUNK_DISPOSE = "disposeEmbeddingPipeline";

describe("INV-PHASE5-SUBPHASE-NO-RELOAD-001: per-sub-phase fork no-reload invariant", () => {
  /** Fork-child path source files: the embedding orchestrator + the chunk-loop driver. */
  let forkChildFiles: SourceFile[];
  let combinedSource: string;

  beforeAll(() => {
    const project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      skipLoadingLibFiles: true,
      compilerOptions: { allowJs: false, strict: true },
    });
    // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): the canonical
    // chunk loop was extracted into `phase-5-chunked-text-loop.ts`, so the
    // fork-child path now spans BOTH files. Scan both so the invariant's intent
    // is preserved (not weakened) across the refactor.
    const embeddingAbs = path.resolve(
      __dirname,
      "../../../../src/workers/phases/phase-5-embedding.ts"
    );
    const loopAbs = path.resolve(
      __dirname,
      "../../../../src/workers/phases/phase-5-chunked-text-loop.ts"
    );
    forkChildFiles = [
      project.addSourceFileAtPath(embeddingAbs),
      project.addSourceFileAtPath(loopAbs),
    ];
    combinedSource = forkChildFiles.map((f) => f.getFullText()).join("\n");
  });

  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-PHASE5-SUBPHASE-NO-RELOAD-001");
  });

  it("INV-PHASE5-SUBPHASE-NO-RELOAD-001 (a): terminateAndRespawnEmbeddingPipeline() has ZERO invocation sites across the fork-child path (AST source-pin)", () => {
    // AST CallExpression sweep across BOTH fork-child files: count call
    // expressions whose callee is a property access ending in
    // `.terminateAndRespawnEmbeddingPipeline`. Comment references ("...is
    // REMOVED...") are NOT CallExpressions, so this is invocation-precise (more
    // rigorous than a substring grep).
    const offendingCalls: Array<{ file: string; text: string; line: number }> = [];
    for (const file of forkChildFiles) {
      file.forEachDescendant((node) => {
        const call = node.asKind(SyntaxKind.CallExpression);
        if (!call) return;
        const callee = call.getExpression();
        const pae = callee.asKind(SyntaxKind.PropertyAccessExpression);
        if (!pae) return;
        if (pae.getName() === FORBIDDEN_RELOAD_CALL) {
          offendingCalls.push({
            file: path.basename(file.getFilePath()),
            text: call.getText().slice(0, 120),
            line: call.getStartLineNumber(),
          });
        }
      });
    }

    expect(
      offendingCalls,
      `The fork-child path (phase-5-embedding.ts + phase-5-chunked-text-loop.ts) ` +
        `must NOT invoke \`${FORBIDDEN_RELOAD_CALL}()\` (ADR-0039 Decision 2: the ` +
        `inter-sub-phase reload is rooted out by the fork-boundary OS reclamation, ` +
        `NOT by this call). A regression that re-adds it reintroduces the M-1-RSS ` +
        `arena accumulation. Found: ${JSON.stringify(offendingCalls)}`
    ).toEqual([]);
  });

  it("INV-PHASE5-SUBPHASE-NO-RELOAD-001 (b): chunk-boundary disposeEmbeddingPipeline() is RETAINED across the fork-child path (intra-fork reload upper bound = max(1, chunkCount))", () => {
    // The correct invariant is NOT "exactly 1 load". Multi-chunk sub-phases
    // retain the chunk-boundary dispose → next-chunk in-process re-load, which
    // is the documented `max(1, chunkCount)` upper bound. After the chunk-fork
    // contingency refactor the chunk-boundary dispose lives in the shared driver
    // (phase-5-chunked-text-loop.ts); scan BOTH files so the retained-dispose
    // intent is preserved. Assert >= 1 chunk-boundary dispose somewhere in the
    // fork-child path (the false "exactly 1 load" invariant would have required
    // deleting it entirely).
    const disposeCalls: Array<{ file: string; line: number }> = [];
    for (const file of forkChildFiles) {
      file.forEachDescendant((node) => {
        const call = node.asKind(SyntaxKind.CallExpression);
        if (!call) return;
        const pae = call.getExpression().asKind(SyntaxKind.PropertyAccessExpression);
        if (!pae) return;
        if (pae.getName() === RETAINED_CHUNK_DISPOSE) {
          disposeCalls.push({
            file: path.basename(file.getFilePath()),
            line: call.getStartLineNumber(),
          });
        }
      });
    }

    expect(
      disposeCalls.length,
      `The fork-child path (phase-5-embedding.ts + phase-5-chunked-text-loop.ts) ` +
        `must RETAIN the chunk-boundary \`${RETAINED_CHUNK_DISPOSE}()\` call ` +
        `(transient intra-fork recovery). Removing it would imply a false ` +
        `"exactly 1 load" invariant. Found ${disposeCalls.length} call(s): ` +
        `${JSON.stringify(disposeCalls)}`
    ).toBeGreaterThanOrEqual(1);
  });

  it("INV-PHASE5-SUBPHASE-NO-RELOAD-001 (c): both fork-child buildChildEnv() implementations neutralize the e5 in-process recycle via PIPELINE_RECYCLE_THRESHOLD=0 (PR-BT-5 M-1-RSS)", () => {
    // PR-BT-5 (M-1-RSS): the real-machine CPU verification proved the e5-base
    // in-process pipeline recycle (EmbeddingService.recyclePipelineIfNeeded,
    // threshold=30) is, inside a one-shot per-sub-phase fork, not just redundant
    // (the fork exit(0)s so the OS reclaims the whole arena) but actively harmful:
    // when chunk size (=30) equals the recycle threshold (=30) the recycle resets
    // the arena at chunk end and MASKS the immediately-following C1 per-chunk RSS
    // budget check's post-encode reading, defeating runaway-loop detection and
    // letting background_text reach delta 4711MB → SIGKILL.
    //
    // The fix neutralizes the recycle in the fork child by injecting
    // `PIPELINE_RECYCLE_THRESHOLD=0` (reusing the existing `if (threshold <= 0)
    // return;` guard) in BOTH fork-child env builders:
    //   - phase-5-fork-orchestrator.ts buildChildEnv()  (page.analyze Phase5 fork)
    //   - shared/fork-common.ts        buildChildEnv()  (EmbeddingBackfillWorker fork)
    // Pin BOTH so a regression that drops the injection from either path (which
    // would reintroduce the C1-masking SIGKILL) fails CI. AST-precise: assert an
    // assignment `... .PIPELINE_RECYCLE_THRESHOLD = "0"` exists in each file.
    const project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      skipLoadingLibFiles: true,
      compilerOptions: { allowJs: false, strict: true },
    });
    const orchestratorAbs = path.resolve(
      __dirname,
      "../../../../src/workers/phases/phase-5-fork-orchestrator.ts"
    );
    const forkCommonAbs = path.resolve(
      __dirname,
      "../../../../src/workers/phases/shared/fork-common.ts"
    );
    const envBuilderFiles = [
      { name: "phase-5-fork-orchestrator.ts", file: project.addSourceFileAtPath(orchestratorAbs) },
      { name: "shared/fork-common.ts", file: project.addSourceFileAtPath(forkCommonAbs) },
    ];

    const missing: string[] = [];
    for (const { name, file } of envBuilderFiles) {
      let found = false;
      file.forEachDescendant((node) => {
        if (found) return;
        const assign = node.asKind(SyntaxKind.BinaryExpression);
        if (!assign) return;
        if (assign.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return;
        const lhs = assign.getLeft().asKind(SyntaxKind.PropertyAccessExpression);
        if (!lhs || lhs.getName() !== "PIPELINE_RECYCLE_THRESHOLD") return;
        // RHS must be the string literal "0" (the disable sentinel).
        const rhsText = assign.getRight().getText().replace(/['"]/g, "");
        if (rhsText === "0") found = true;
      });
      if (!found) missing.push(name);
    }

    expect(
      missing,
      `Both fork-child buildChildEnv() implementations MUST inject ` +
        `\`PIPELINE_RECYCLE_THRESHOLD = "0"\` to neutralize the e5 in-process recycle ` +
        `inside the one-shot fork (PR-BT-5 M-1-RSS: the recycle masks the C1 ` +
        `per-chunk RSS budget guard and caused background_text SIGKILL at 4711MB). ` +
        `Missing injection in: ${JSON.stringify(missing)}`
    ).toEqual([]);
  });

  it("INV-PHASE5-SUBPHASE-NO-RELOAD-001: the false 'exactly 1 load' invariant is explicitly forbidden in source comments (no-fake-success documentation)", () => {
    // The source must document that the reload is bounded by max(1, chunkCount),
    // NOT "exactly 1". This pins the no-fake-success rationale in-source so a
    // future edit cannot silently re-introduce the false invariant framing. The
    // doc string may live in either fork-child file post-refactor.
    expect(
      combinedSource,
      `The fork-child path must document the max(1, chunkCount) intra-fork ` +
        `reload bound rationale (ADR-0039 Decision 2 / no-fake-success).`
    ).toMatch(/max\(1,\s*chunkCount\)/);
  });
});
