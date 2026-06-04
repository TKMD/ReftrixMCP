// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Per-Sub-Phase Fork Dispatch Decision Leaf
 *
 * PR-BT-5 (M-1-RSS, ADR-0039 Decision 1, unblock #9 / TDA-M-02): the dispatch
 * **decision** logic for the per-sub-phase fork model is concentrated here as a
 * dedicated leaf so `runPhase5ViaFork` retains only orchestration (the loop +
 * IPC + result merge). This file is machine-enforced at `complexity ≤ 10`
 * (`packages/config/eslint/index.js` scope block, precedent
 * `phase-5-gpu-probe.ts`), so `pnpm lint` exit 0 is a real complexity guarantee
 * for the dispatch decision path (closes the misleading-exit-0 gap).
 *
 * Each descriptor decides **which** sub-phase forks to dispatch and **whether**
 * each is skipped (empty sub-phase = zero applicable data → no fork). The
 * orchestrator iterates the non-skipped descriptors, dispatching one fork per
 * sub-phase (each loads its single model, processes one sub-phase, `exit(0)`s,
 * letting the OS reclaim the arena — rooting out the inter-sub-phase reload).
 *
 * **Runner = (B) local `runChildProcess` (ADR-0039 Decision 1 / unblock #9)**:
 * this leaf does NOT migrate to `shared/fork-common.ts`; it builds descriptors
 * the orchestrator dispatches via its existing local `runChildProcess`.
 *
 * **Fork-count cap (CWE-770, ADR-0039 §Security / unblock #8)**: the descriptor
 * count is bounded by the static sub-phase enumeration (`PHASE5_TEXT_SUBPHASES`
 * + `PHASE5_VISUAL_SUBPHASES` = 9), data-row-count-INDEPENDENT. A large/hostile
 * page cannot induce unbounded fork spawning.
 *
 * PR-BT-5 (M-1-RSS): per-sub-phase fork の dispatch 決定 leaf。`runPhase5ViaFork`
 * には orchestration のみ残し、decision logic を本 leaf に集約 (CC ≤ 10 を
 * machine-enforce)。各 descriptor は dispatch 対象 sub-phase と skip 判定 (空
 * sub-phase = fork skip) を持つ。fork 数は静的 sub-phase 列挙 (≤ 9) で bound。
 *
 * @module workers/phases/phase-5-subphase-dispatch
 * @see  Decision 1
 * @see phase-5-subphases.const.ts (SSOT sub-phase identifiers)
 * @see phase-5-fork-orchestrator.ts (orchestration: loop + IPC + merge)
 */

import {
  PHASE5_TEXT_SUBPHASES,
  PHASE5_VISUAL_SUBPHASES,
  type Phase5TextSubPhase,
  type Phase5VisualSubPhase,
} from "./phase-5-subphases.const";
import type { EmbeddingPhaseParams } from "./types";

/**
 * Per-sub-phase data-presence predicates (lookup table keyed by sub-phase id).
 *
 * Empty sub-phases (predicate false) are skipped → no fork spawned (ADR-0039
 * R-1 latency mitigation + §Security fixed fork-count cap precondition).
 *
 * NOTE: these intentionally mirror the data-presence guards already inside each
 * `process*EmbeddingChunks` / visual loop (which early-return on empty input).
 * The skip predicate avoids the fork-spawn + model cold-load cost entirely when
 * a sub-phase would be a no-op, but a false "should run" never causes incorrect
 * output (the in-fork guard still early-returns). Kept lenient (presence-only)
 * to avoid duplicating the full per-sub-phase data validation.
 *
 * A lookup table (rather than a switch) keeps the descriptor builders + helpers
 * at CC ≤ 10 (machine-enforced by the eslint scope block, ADR-0039 D2(b)). The
 * `Record` mapped type guarantees exhaustiveness over the SSOT enum at compile
 * time (a missing sub-phase key is a TS error).
 */
const TEXT_SUBPHASE_HAS_DATA: Record<
  Phase5TextSubPhase,
  (params: EmbeddingPhaseParams) => boolean
> = {
  section_text: (p) => (p.sectionSaveResult?.idMapping?.size ?? 0) > 0,
  motion_text: (p) => (p.motionSaveResult?.idMapping?.size ?? 0) > 0,
  vision_motion_text: (p) => (p.scrollVisionSaveResult?.idMapping?.size ?? 0) > 0,
  background_text: (p) => (p.bgSaveResult?.ids?.length ?? 0) > 0,
  js_animation_text: (p) => (p.jsSaveResult?.idMapping?.size ?? 0) > 0,
  responsive_text: (p) => p.responsiveAnalysisId !== undefined && p.responsiveAnalysisId !== "",
  part_text: (p) => (p.partsSavedCount ?? 0) > 0,
};

/**
 * Per-visual-sub-phase data-presence predicates (lookup table). `section_visual`
 * needs section id-mapping; `part_visual` needs parts. The orchestrator
 * additionally gates `part_visual` on screenshot presence (orchestrator's
 * concern; here we only encode per-sub-phase data presence).
 */
const VISUAL_SUBPHASE_HAS_DATA: Record<
  Phase5VisualSubPhase,
  (params: EmbeddingPhaseParams) => boolean
> = {
  section_visual: (p) => (p.sectionSaveResult?.idMapping?.size ?? 0) > 0,
  part_visual: (p) => (p.partsSavedCount ?? 0) > 0,
};

/**
 * A single sub-phase fork dispatch descriptor (decision only — the orchestrator
 * owns IPC + merge). Generic over the sub-phase identifier type `S` so the text
 * builder yields `Phase5TextSubPhase`-narrowed descriptors and the visual
 * builder yields `Phase5VisualSubPhase`-narrowed descriptors (the orchestrator
 * dispatchers expect the narrow per-workload type). `workload` selects the
 * GPU-COORD VRAM threshold ("text" = e5, "visual" = DINOv2) and the child
 * script.
 */
export interface SubPhaseForkDescriptor<S extends Phase5TextSubPhase | Phase5VisualSubPhase> {
  /** The SSOT sub-phase identifier dispatched to the child via the IPC `subPhase` field. */
  subPhase: S;
  /** Workload selects the VRAM threshold (e5 vs DINOv2) and the child entry script. */
  workload: "text" | "visual";
  /** Whether this sub-phase has applicable data (false → orchestrator skips the fork). */
  shouldRun: boolean;
}

/**
 * Build the ordered list of TEXT sub-phase fork descriptors (declaration order
 * = dispatch order). All 7 are returned; the orchestrator skips those with
 * `shouldRun === false`.
 *
 * @param params  embedding phase params (data-presence source)
 * @returns 7 descriptors in `PHASE5_TEXT_SUBPHASES` order
 */
export function buildTextSubPhaseDescriptors(
  params: EmbeddingPhaseParams
): SubPhaseForkDescriptor<Phase5TextSubPhase>[] {
  return PHASE5_TEXT_SUBPHASES.map((subPhase) => ({
    subPhase,
    workload: "text" as const,
    shouldRun: TEXT_SUBPHASE_HAS_DATA[subPhase](params),
  }));
}

/**
 * Build the ordered list of VISUAL sub-phase fork descriptors (declaration
 * order = dispatch order). Both are returned; the orchestrator skips those with
 * `shouldRun === false` and additionally gates on screenshot presence.
 *
 * @param params  embedding phase params (data-presence source)
 * @returns 2 descriptors in `PHASE5_VISUAL_SUBPHASES` order
 */
export function buildVisualSubPhaseDescriptors(
  params: EmbeddingPhaseParams
): SubPhaseForkDescriptor<Phase5VisualSubPhase>[] {
  return PHASE5_VISUAL_SUBPHASES.map((subPhase) => ({
    subPhase,
    workload: "visual" as const,
    shouldRun: VISUAL_SUBPHASE_HAS_DATA[subPhase](params),
  }));
}
