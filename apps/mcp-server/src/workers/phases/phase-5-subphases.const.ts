// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Per-Sub-Phase Fork — SSOT sub-phase identifier constants
 *
 * PR-BT-5 (M-1-RSS, ADR-0039 Decision 1/3): the Single Source of Truth for the
 * 9 Phase 5 embedding sub-phase identifiers. The per-sub-phase fork model
 * (ADR-0039) dispatches one fork per entry of these arrays so each fork loads
 * its single model type, processes ONE sub-phase, and `exit(0)`s — letting the
 * OS reclaim the whole arena (rooting out the inter-sub-phase reload that was
 * the M-1-RSS root cause).
 *
 * **SSOT-derive contract (ADR-0039 Decision 3, Conflict 1)**: the IPC
 * `subPhase` enum in `phase-5-child-ipc.ts` is derived from these arrays via
 * `z.enum(PHASE5_TEXT_SUBPHASES)` / `z.enum(PHASE5_VISUAL_SUBPHASES)` — NO
 * hand-written enum literals. The dedicated AST guard
 * `tests/regression/standing/schema-enum-sync/inv-schema-enum-004-phase5-subphase.test.ts`
 * enforces this (same named-import + hand-written-literal red-flag sweep pattern
 * as `inv-schema-enum-004-c.test.ts`).
 *
 * **Scope = IPC-internal 2-site (TS const ↔ Zod) ONLY**: `subPhase` is neither
 * Prisma-persisted nor MCP-tool-spec-exposed, so the Prisma↔TS↔Zod↔MCP 4-site
 * exhaustive mapping of `INV-SCHEMA-ENUM-004` is **N/A** for this enum family
 * (IO V-4 correction). The sync verification is limited to TS const ↔ Zod.
 *
 * PR-BT-5 (M-1-RSS, ADR-0039 Decision 1/3): Phase 5 embedding sub-phase 識別子の
 * SSOT。per-sub-phase fork model は本配列の各要素に対し 1 fork を dispatch し、
 * 各 fork は単一 model を load → 1 sub-phase 処理 → `exit(0)` で OS が arena を
 * 全回収する (M-1-RSS 真因の inter-sub-phase reload を根絶)。`phase-5-child-ipc.ts`
 * の `subPhase` enum は本配列から `z.enum()` で derive する (hand-written literal
 * 禁止)。scope は IPC-internal 2-site (TS const ↔ Zod) のみ、Prisma↔MCP 4-site は
 * N/A (subPhase は Prisma 非永続・MCP spec 非露出)。
 *
 * @module workers/phases/phase-5-subphases.const
 * @see  Decision 1/3
 * @see phase-5-child-ipc.ts (z.enum(PHASE5_TEXT_SUBPHASES / PHASE5_VISUAL_SUBPHASES))
 */

/**
 * Text embedding sub-phases (e5-base). 7 fully-separate forks (no grouping):
 * `motion_text` and `vision_motion_text` are distinct forks because their
 * `processMotionTextEmbeddingChunks` / `processVisionMotionEmbeddingChunks`
 * functions each carry their own chunk dispose — grouping them would
 * re-introduce inter-sub-phase reload within that fork (ADR-0039 Decision 1 /
 * unblock #4). Declaration order is the dispatch order.
 *
 * e5-base text embedding sub-phase の 7 完全分離 fork (grouping なし)。宣言順 =
 * dispatch 順。
 */
export const PHASE5_TEXT_SUBPHASES = [
  "section_text",
  "motion_text",
  "vision_motion_text",
  "background_text",
  "js_animation_text",
  "responsive_text",
  "part_text",
] as const;

/**
 * Visual embedding sub-phases (DINOv2 ViT-B/14). 2 separate forks.
 * `part_visual` is dispatched after `resolvePartBboxFn` runs in the parent
 * (the bbox resolution needs the sharedBrowser which cannot cross the process
 * boundary — ADR-0039 B-3).
 *
 * DINOv2 visual embedding sub-phase の 2 分離 fork。宣言順 = dispatch 順。
 */
export const PHASE5_VISUAL_SUBPHASES = ["section_visual", "part_visual"] as const;

/**
 * A text-embedding sub-phase identifier (e5-base).
 */
export type Phase5TextSubPhase = (typeof PHASE5_TEXT_SUBPHASES)[number];

/**
 * A visual-embedding sub-phase identifier (DINOv2).
 */
export type Phase5VisualSubPhase = (typeof PHASE5_VISUAL_SUBPHASES)[number];

/**
 * Any Phase 5 sub-phase identifier (text or visual).
 */
export type Phase5SubPhase = Phase5TextSubPhase | Phase5VisualSubPhase;

/**
 * Total number of distinct sub-phase forks (data-row-count-independent upper
 * bound). Used by `INV-PHASE5-SUBPHASE-FORK-EXIT-001` as the CWE-770 fork-count
 * cap assertion (≤ 9, ADR-0039 §Security / unblock #8): a malicious/large page
 * cannot induce unbounded fork spawning because the bound is this static count.
 *
 * sub-phase fork の合計数 (データ件数非依存の固定上限)。CWE-770 fork-count cap
 * (≤ 9) として `INV-PHASE5-SUBPHASE-FORK-EXIT-001` が assert する。
 */
export const PHASE5_TOTAL_SUBPHASE_FORK_COUNT =
  PHASE5_TEXT_SUBPHASES.length + PHASE5_VISUAL_SUBPHASES.length;
