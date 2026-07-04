// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-CROP-COVERAGE-PARITY-001 — crop coverage parity + flag-gate callsite parity
 * (M, W6 Issue A PR-3a, TPA-PR3A-L-01 + SEC-PR3A-M-03).
 *
 * Context / 背景:
 *   PR-3a persists a viewable PNG crop alongside the DINOv2 visual embedding. The
 *   parity contract is scoped to the VISUAL embedding (NOT text): a crop is the
 *   visual artifact that produced the `vision_embedding`, so:
 *       vision_embedding IS NOT NULL  ⇔  crop_storage_path IS NOT NULL
 *   (PII-skipped rows excluded on both sides). Reading this as `text_embedding`-
 *   scoped would make every text-only part violate it (TPA-L-01).
 *
 *   SEC-PR3A-M-03 (flag-gate callsite parity): flag-OFF must stop ALL production
 *   crop generation. ALL 4 save callsites (C1 types.ts in-range, C2
 *   phase-5-raw-decode in-range, C3 types.ts fallback, C4 phase-5-embedding part)
 *   MUST route through the `CROP_PERSISTENCE_ENABLED` gate — pinned here so a
 *   future callsite that bypasses the flag is CI-caught.
 *
 * Invariant / 不変条件 (AST source-pin, deterministic):
 *   - surface 1: the migration adds `crop_storage_path` to BOTH section_embeddings
 *     AND component_part_embeddings (the parity columns, vision-scoped).
 *   - surface 2: the crop save helper is gated by `CROP_PERSISTENCE_ENABLED`
 *     (default OFF) via a single resolver (no production crop write when OFF).
 *   - surface 3 (flag-gate callsite parity, SEC-M-03): the crop persistence is
 *     wired through the flag-gated helper at the section sink AND the part sink
 *     (the crop write is co-located with the `vision_embedding` write = parity).
 *   - surface 4: the crop_storage_path UPDATE is co-located with the
 *     vision_embedding UPDATE (vision-scoped parity, not text).
 *
 * This is a P0 standing regression (large-page domain). CI-failing executable
 * invariant. `.skip()` / `.todo()` / `describe.skip` are prohibited.
 *
 * @see packages/database/prisma/schema.prisma (crop_storage_path x2)
 * @see apps/mcp-server/src/services/part/crop-persistence.helper.ts (CROP_PERSISTENCE_ENABLED gate)
 * @see apps/mcp-server/src/workers/phases/phase-5-embedding.ts (vision-scoped crop write)
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { assertInvName } from "../_setup/inv-assert";
import { sliceFunctionBody } from "../_setup/slice-function-body";

const INV_ID = "INV-CROP-COVERAGE-PARITY-001";

const MCP_SERVER_SRC_ROOT = path.resolve(__dirname, "../../../../src");
const REPO_ROOT = path.resolve(__dirname, "../../../../../..");

function readSrc(relPath: string): string {
  return fs.readFileSync(path.resolve(MCP_SERVER_SRC_ROOT, relPath), "utf8");
}

function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");
}

const PHASE5_REL = "workers/phases/phase-5-embedding.ts";
const CROP_HELPER_REL = "services/part/crop-persistence.helper.ts";

describe("INV-CROP-COVERAGE-PARITY-001: crop coverage parity (vision-scoped) + flag-gate callsite parity (W6 Issue A PR-3a)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-COVERAGE-PARITY-001");
  });

  // ==========================================================================
  // Surface 1 — migration adds crop_storage_path to BOTH embedding models
  // ==========================================================================

  it("INV-CROP-COVERAGE-PARITY-001: surface 1 — schema.prisma declares cropStoragePath on SectionEmbedding AND ComponentPartEmbedding (vision parity columns)", () => {
    const schema = fs.readFileSync(
      path.resolve(REPO_ROOT, "packages/database/prisma/schema.prisma"),
      "utf8"
    );
    // Both embedding models carry the parity column mapped to crop_storage_path.
    const occurrences = (schema.match(/@map\("crop_storage_path"\)/g) ?? []).length;
    expect(
      occurrences >= 2,
      "schema.prisma must declare crop_storage_path on BOTH SectionEmbedding and ComponentPartEmbedding (2 occurrences)"
    ).toBe(true);
    // The migration SQL must add the column to both tables (additive nullable).
    const migrationsDir = path.resolve(REPO_ROOT, "packages/database/prisma/migrations");
    const cropMigration = fs
      .readdirSync(migrationsDir)
      .find((d) => /add_crop_storage_path/.test(d));
    expect(cropMigration, "a *_add_crop_storage_path migration directory must exist").toBeTruthy();
    const sql = fs.readFileSync(
      path.resolve(migrationsDir, cropMigration as string, "migration.sql"),
      "utf8"
    );
    // Allow Prisma's quoted-identifier convention (`"section_embeddings"`).
    expect(
      /ALTER TABLE\s+"?section_embeddings"?\s+ADD COLUMN\s+"?crop_storage_path"?/i.test(sql),
      "migration must ALTER section_embeddings ADD COLUMN crop_storage_path"
    ).toBe(true);
    expect(
      /ALTER TABLE\s+"?component_part_embeddings"?\s+ADD COLUMN\s+"?crop_storage_path"?/i.test(sql),
      "migration must ALTER component_part_embeddings ADD COLUMN crop_storage_path"
    ).toBe(true);
  });

  // ==========================================================================
  // Surface 2 — crop save is gated by CROP_PERSISTENCE_ENABLED (default OFF)
  // ==========================================================================

  it("INV-CROP-COVERAGE-PARITY-001: surface 2 — crop persistence is gated by CROP_PERSISTENCE_ENABLED via a single resolver (default ON, opt-out, W6 Issue A PR-3b W3 flip)", () => {
    const helper = stripLineComments(readSrc(CROP_HELPER_REL));
    expect(
      /CROP_PERSISTENCE_ENABLED/.test(helper),
      "crop helper must reference the CROP_PERSISTENCE_ENABLED flag"
    ).toBe(true);
    // W3 flip (PR-3b): default ON (opt-out): only the literal "false" disables it
    // (additive opt-out, EMBEDDING_CACHE_ENABLED ADR-0040 parity). The flip lands
    // ONLY after W1-W4 (cascade + INV-CROP-RETENTION-001 + C5 + parity surface 5)
    // are GREEN, so a generated crop always has a data.delete reaping path.
    expect(
      /!==\s*["']false["']/.test(helper),
      "CROP_PERSISTENCE_ENABLED must be opt-out (disabled only when === 'false', default ON post-W3-flip)"
    ).toBe(true);
    // Single resolver export so callsites don't re-read process.env inline.
    expect(
      /export\s+function\s+isCropPersistenceEnabled\s*\(/.test(helper),
      "crop helper must export a single isCropPersistenceEnabled() resolver"
    ).toBe(true);
  });

  // ==========================================================================
  // Surface 3 — flag-gate callsite parity: both sinks route through the gate
  // ==========================================================================

  it("INV-CROP-COVERAGE-PARITY-001: surface 3 — both crop sinks (section + part) route through the flag-gated crop helper (SEC-M-03 callsite parity)", () => {
    const phase5 = stripLineComments(readSrc(PHASE5_REL));
    // The crop persistence must be invoked via the helper (single flag gate). The
    // helper internally checks isCropPersistenceEnabled() so callsites cannot
    // bypass the flag. Pin that BOTH section and part crop saves are wired.
    expect(
      /\bpersistSectionCrop\b/.test(phase5),
      "section crop sink must be wired via persistSectionCrop (flag-gated helper)"
    ).toBe(true);
    expect(
      /\bpersistPartCrop\b/.test(phase5),
      "part crop sink must be wired via persistPartCrop (flag-gated helper)"
    ).toBe(true);
  });

  it("INV-CROP-COVERAGE-PARITY-001: surface 3b — phase-5-embedding does NOT read CROP_PERSISTENCE_ENABLED inline (single-resolver discipline, no callsite flag drift)", () => {
    const phase5 = stripLineComments(readSrc(PHASE5_REL));
    // Callsites must NOT re-read process.env.CROP_PERSISTENCE_ENABLED — the gate
    // lives in the helper's isCropPersistenceEnabled() single resolver.
    expect(
      /process\.env\.CROP_PERSISTENCE_ENABLED|process\.env\[["']CROP_PERSISTENCE_ENABLED["']\]/.test(
        phase5
      ),
      "phase-5-embedding must NOT read CROP_PERSISTENCE_ENABLED inline (use the helper's single resolver)"
    ).toBe(false);
  });

  // ==========================================================================
  // Surface 4 — crop_storage_path UPDATE is co-located with vision_embedding
  // ==========================================================================

  it("INV-CROP-COVERAGE-PARITY-001: surface 4 — the crop_storage_path persistence is vision-scoped (co-located with the vision_embedding write, NOT text_embedding)", () => {
    const phase5 = stripLineComments(readSrc(PHASE5_REL));
    // crop_storage_path must be written for rows that get a vision_embedding (the
    // crop is the visual artifact). Pin that crop_storage_path is updated for the
    // section embedding (UPDATE ... crop_storage_path) and the part embedding.
    expect(
      /crop_storage_path\s*=\s*\$/.test(phase5),
      "phase-5-embedding must UPDATE crop_storage_path (vision-scoped parity column)"
    ).toBe(true);
    // Drift guard: crop_storage_path must never be set alongside a text_embedding
    // write (text-only parity is the TPA-L-01 mis-scope this INV prevents).
    const textWithCrop =
      /SET\s+text_embedding[^;]*crop_storage_path|SET\s+crop_storage_path[^;]*text_embedding/;
    expect(
      textWithCrop.test(phase5),
      "crop_storage_path must NOT be co-written with text_embedding (parity is vision-scoped, TPA-L-01)"
    ).toBe(false);
  });

  // ==========================================================================
  // Surface 5 — deep-crop C5 scoped AST-pin (W6 Issue A PR-3b)
  //
  // PR-3a's C1-C4 did NOT cover the section-fallback live-Y path
  // (`processDynamicFallbackBatch`): it generated only a 224-downscale `.raw()`
  // buffer and wrote `vision_embedding` WITHOUT `crop_storage_path`. With the
  // flag ON, that path's sections become `vision_embedding IS NOT NULL ∧
  // crop_storage_path IS NULL`, violating parity. PR-3b adds C5 (crop save in
  // `processDynamicFallbackBatch`). This surface CI-RED's if C5 is missing.
  // ==========================================================================

  it("INV-CROP-COVERAGE-PARITY-001: surface 5a — processDynamicFallbackBatch persists a crop (scoped AST-pin, deep-crop C5 not file-wide false-GREEN)", () => {
    const phase5 = stripLineComments(readSrc(PHASE5_REL));
    // 関数スコープ限定: file-wide regex は section 経路の persistSectionCrop で
    // false-GREEN になるため、processDynamicFallbackBatch 本体内に save callsite
    // (saveCropFromBuffer or persistDynamicFallbackSectionCrop) が ≥1 存在することを
    // pin する (F-05)。
    const fnBody = sliceFunctionBody(phase5, "processDynamicFallbackBatch", INV_ID);
    const hasC5Save =
      /\bpersistDynamicFallbackSectionCrop\b/.test(fnBody) || /\bsaveCropFromBuffer\b/.test(fnBody);
    expect(
      hasC5Save,
      "processDynamicFallbackBatch must persist the crop (deep-crop C5: persistDynamicFallbackSectionCrop or saveCropFromBuffer callsite) — file-wide persistSectionCrop must NOT satisfy this"
    ).toBe(true);
  });

  it("INV-CROP-COVERAGE-PARITY-001: surface 5b — deep-crop C5 crop save is flag-gated (no inline CROP_PERSISTENCE_ENABLED read in processDynamicFallbackBatch)", () => {
    const phase5 = stripLineComments(readSrc(PHASE5_REL));
    const fnBody = sliceFunctionBody(phase5, "processDynamicFallbackBatch", INV_ID);
    // C5 の crop save は viewable PNG を flag-gate で生成する (isCropPersistenceEnabled
    // helper 経由)。process.env を inline 再読込しない (single-resolver discipline,
    // surface 3b parity)。
    expect(
      /process\.env\.CROP_PERSISTENCE_ENABLED|process\.env\[["']CROP_PERSISTENCE_ENABLED["']\]/.test(
        fnBody
      ),
      "processDynamicFallbackBatch must NOT read CROP_PERSISTENCE_ENABLED inline (use the helper's single resolver)"
    ).toBe(false);
    expect(
      /\bisCropPersistenceEnabled\b/.test(fnBody),
      "processDynamicFallbackBatch must flag-gate the viewable PNG generation via isCropPersistenceEnabled()"
    ).toBe(true);
  });

  it("INV-CROP-COVERAGE-PARITY-001: surface 5c — upstream PII filter (sectionsFiltered) is pinned so C5 inherits fail-closed (F-04, no redundant gate)", () => {
    const phase5 = stripLineComments(readSrc(PHASE5_REL));
    // F-04: high-PII section が dynamicFallbackSections に構造的に入れないことを
    // 担保する upstream filter (`sectionsFiltered = sectionsNeedingVisual.filter(
    // !highPiiSectionIdSet.has(...))`) を AST-pin する。将来 refactor でこの filter
    // が消えたら RED (C5 が high-PII crop を生成しうる状態を検出)。
    const hasUpstreamFilter =
      /sectionsFiltered\s*=/.test(phase5) &&
      /highPiiSectionIdSet\.has\(/.test(phase5) &&
      /\.filter\(/.test(phase5);
    expect(
      hasUpstreamFilter,
      "upstream PII filter (sectionsFiltered = sectionsNeedingVisual.filter(!highPiiSectionIdSet.has(...))) must be pinned — C5 inherits fail-closed from it (F-04)"
    ).toBe(true);

    // F-04 over-engineering guard: C5 must NOT add a redundant
    // queryHighPiiPendingSectionPatternIds gate inside processDynamicFallbackBatch
    // (dead code; the upstream 3-layer fail-closed already excludes high-PII).
    const fnBody = sliceFunctionBody(phase5, "processDynamicFallbackBatch", INV_ID);
    expect(
      /\bqueryHighPiiPendingSectionPatternIds\b/.test(fnBody),
      "processDynamicFallbackBatch must NOT add a redundant queryHighPiiPendingSectionPatternIds gate (dead code; upstream sectionsFiltered already fail-closed, F-04 / ADR-0044 §Decision 2)"
    ).toBe(false);
  });

  // ==========================================================================
  // Surface 6 — backfill save→UPDATE pairing + crop-cut SSOT (W6 Issue A PR-4a)
  //
  // F-M-02 winning contract: the crop-cut + truncation/clamp-gate is EXTRACTED
  // from phase-5-embedding.ts into a shared SSOT leaf (`cutCropFromScreenshot`)
  // in crop-persistence.helper.ts. The backfill one-shot script
  // (`scripts/backfill-crops.ts`) cuts crops via that SSOT, then `saveCropFromBuffer`
  // → `crop_storage_path` UPDATE. This surface pins:
  //   (a) the crop-cut SSOT exists in the gated helper (not inline in the script).
  //   (b) the backfill script's per-page flow pairs a crop save with a
  //       `crop_storage_path` UPDATE (vision-scoped backfill parity — a backfill
  //       crop is written ONLY for an already-embedded row, so the
  //       vision_embedding NOT NULL ⇔ crop_storage_path NOT NULL parity is
  //       restored without re-running embedding inference).
  //   (c) the Phase 5 part callsite delegates to the SSOT (drift guard) — the
  //       inline `.extract({left, top, width, height}).png()` viewable-PNG cut is
  //       replaced by a `cutCropFromScreenshot(` call so the clamp gate is not
  //       duplicated across the Phase 5 and backfill paths.
  // ==========================================================================

  const CROP_BACKFILL_SCRIPT_REL = "../scripts/backfill-crops.ts";

  it("INV-CROP-COVERAGE-PARITY-001: surface 6a — crop-cut + clamp-gate is an SSOT leaf (cutCropFromScreenshot) in the gated crop helper, not inline in the backfill script", () => {
    const helper = stripLineComments(readSrc(CROP_HELPER_REL));
    // The crop-cut SSOT must live in crop-persistence.helper.ts (scoped
    // complexity:["error",10] override), returning Buffer | null (null = honest-skip).
    expect(
      /export\s+(?:async\s+)?function\s+cutCropFromScreenshot\s*\(/.test(helper),
      "crop-persistence.helper.ts must export the crop-cut SSOT cutCropFromScreenshot() (F-M-02)"
    ).toBe(true);
  });

  it("INV-CROP-COVERAGE-PARITY-001: surface 6b — backfill script pairs a crop save (via the SSOT cut + saveCropFromBuffer) with a crop_storage_path UPDATE (vision-scoped backfill parity)", () => {
    const scriptPath = path.resolve(MCP_SERVER_SRC_ROOT, CROP_BACKFILL_SCRIPT_REL);
    const script = stripLineComments(fs.readFileSync(scriptPath, "utf8"));
    // The backfill cuts the crop via the SSOT (no inline Sharp clamp duplication).
    expect(
      /\bcutCropFromScreenshot\b/.test(script),
      "backfill-crops.ts must cut crops via the cutCropFromScreenshot SSOT (no inline clamp gate)"
    ).toBe(true);
    // The cut buffer is persisted via the flag-gated saveCropFromBuffer.
    expect(
      /\bsaveCropFromBuffer\b/.test(script),
      "backfill-crops.ts must persist the crop via the flag-gated saveCropFromBuffer"
    ).toBe(true);
    // The crop save is paired with a crop_storage_path UPDATE on the already-embedded row.
    expect(
      /crop_storage_path\s*=\s*\$/.test(script),
      "backfill-crops.ts must UPDATE crop_storage_path for the embedded row (backfill parity)"
    ).toBe(true);
    // Backfill must NOT re-run embedding inference (the crop slice is vision-scoped only).
    expect(
      /generateVisualEmbedding|visual_embedding\s*=\s*\$/.test(script),
      "backfill-crops.ts must NOT re-run embedding inference (crop slice only, Q2)"
    ).toBe(false);
  });

  it("INV-CROP-COVERAGE-PARITY-001: surface 6c — the Phase 5 part crop cut delegates to the cutCropFromScreenshot SSOT (scoped function-slice drift guard, no import/comment false-GREEN)", () => {
    const phase5 = stripLineComments(readSrc(PHASE5_REL));
    // F-M-02: the Phase 5 part viewable-PNG cut is refactored through the SSOT so
    // the clamp gate is single-source. A FILE-WIDE `cutCropFromScreenshot` regex
    // false-GREENs because the `import { cutCropFromScreenshot } from ...` line
    // (and the JSDoc mention) survive even if the delegation callsite is reverted
    // to an inline `.extract().png()`. Slice the `processPartVisualEmbeddingLoop`
    // body (the part-loop where the cut is wired) so only the in-body delegation
    // callsite satisfies this (TDA-IMPL-PR4A-M-01, scoped AST-pin parity with
    // surface 5a's processDynamicFallbackBatch slice).
    const fnBody = sliceFunctionBody(phase5, "processPartVisualEmbeddingLoop", INV_ID);
    expect(
      /\bcutCropFromScreenshot\b/.test(fnBody),
      "processPartVisualEmbeddingLoop must delegate the part viewable-PNG cut to the cutCropFromScreenshot SSOT (F-M-02 drift guard) — the file-wide import line must NOT satisfy this"
    ).toBe(true);
  });
});
