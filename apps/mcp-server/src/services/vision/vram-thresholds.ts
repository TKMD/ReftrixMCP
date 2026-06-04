// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VRAM threshold constants — fork-child-importable leaf module (SSOT)
 *
 * ADR-0038 §1.3 (FIND-PLAN-H-02): VRAM 閾値定数 (`DINOV2_MIN_VRAM_MB` /
 * `EMBEDDING_MIN_VRAM_MB`) を **fork-child-importable な leaf module** に SSOT
 * として export する。`gpu-resource-manager.ts` (in-process full GpuResourceManager)
 * は本 module から import して従来の参照を維持 (literal 重複禁止)。
 *
 * **なぜ leaf module か (ADR-0037 fork-only 境界保全) / Why a leaf module**:
 *   Phase 5 fork child が `gpu-resource-manager.ts` を import すると、in-process
 *   full GpuResourceManager がその transitive dependency 経由で fork-only 境界に
 *   流入する。これは ADR-0037 (per-job fork-only model) の「fork child は in-process
 *   manager を一切持ち込まない」契約に違反する。閾値定数を leaf module へ分離する
 *   ことで、fork child / in-process path の双方が同一 leaf 定数を参照しつつ、
 *   fork child は in-process manager を transitively 含まない。
 *
 *   When the Phase 5 fork child imports `gpu-resource-manager.ts`, the in-process
 *   full GpuResourceManager flows into the fork-only boundary via its transitive
 *   dependencies, violating ADR-0037's "fork child holds no in-process manager"
 *   contract. Separating the threshold constants into a leaf module lets both the
 *   fork child and the in-process path reference the same SSOT constants while
 *   the fork child carries zero transitive dependency on the in-process manager.
 *
 * **leaf module 不変条件 / Leaf module invariant (INV-GPU-PROBE-LEAF-IMPORT-001)**:
 *   本 module の import グラフは (a) Node.js builtin + (b) 同 leaf 階層の純粋 util
 *   のみで閉じ、`gpu-resource-manager.ts` / Prisma / Worker lifecycle 等の
 *   in-process-only 依存を一切 transitively 含まない。現状は **import を一切持たない**
 *   (pure constants)。CI で import-graph を AST 検証する (INV-GPU-PROBE-LEAF-IMPORT-001)。
 *
 * @see ADR-0038 §1.3 / §1.5 (FIND-PLAN-H-02)
 * @see ADR-0037 (per-job fork-only model)
 * @module services/vision/vram-thresholds
 */

/**
 * Ollama Vision (llama3.2-vision) に必要な最小 VRAM (MB)。
 *
 * Minimum free VRAM (MB) required for Ollama Vision (llama3.2-vision).
 */
export const VISION_MIN_VRAM_MB = 8192;

/**
 * ONNX Embedding (multilingual-e5-base) CUDA に必要な最小 VRAM (MB)。
 *
 * Minimum free VRAM (MB) required for ONNX Embedding (e5-base) CUDA inference.
 * Phase 5 fork child の child-local probe (`resolveChildExecutionProvider`) が
 * free VRAM をこの閾値と比較して CUDA-vs-CPU を意図選択する (ADR-0038 §1.1)。
 */
export const EMBEDDING_MIN_VRAM_MB = 2048;

/**
 * DINOv2 推論に必要な最小 VRAM (MB) — ~1-2GB。
 *
 * Minimum free VRAM (MB) required for DINOv2 ViT-B/14 visual embedding inference.
 * Phase 5 fork child の visual-embedding child-local probe がこの閾値と比較する
 * (ADR-0038 §1.1)。
 */
export const DINOV2_MIN_VRAM_MB = 1536;
