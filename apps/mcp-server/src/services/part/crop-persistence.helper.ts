// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Crop Persistence Helper (W6 Issue A PR-3a)
 *
 * Phase 5 が embedding 生成時に in-memory で作る per-section / per-part の viewable
 * PNG crop を、224-downscale 破棄前に永続化する leaf module。crop は新たな visual
 * PII sink + 新たな path-traversal allowlist root（`<root>/crops/<webPageId>/`）を
 * 導入するため、防御は全て screenshot SSOT（`screenshot-persistence.service.ts`）の
 * 共有 core を import して使い、**弱い第 2 resolver を作らない**（SEC-H-02 ≡ TDA-08）。
 *
 * Persists the per-section / per-part viewable PNG crops that Phase 5 generates
 * in-memory at embedding time, just before the 224-downscale discard. Because the
 * crop is a NEW visual PII sink + a NEW path-traversal allowlist root
 * (`<root>/crops/<webPageId>/`), ALL defenses import the screenshot SSOT shared core
 * (`screenshot-persistence.service.ts`) — there is NO weak second resolver
 * (SEC-H-02 ≡ TDA-08).
 *
 * セキュリティ / Security:
 * - Path Traversal: `buildSafePathWithinRoot` / `validatePathWithinRoot` 共有 core
 *   （realpath + isFile + startsWith）を crops root で再利用（複製ゼロ）。
 * - UUID 検証: `UUID_REGEX` SSOT で webPageId AND entityId を検証（bare literal 禁止）。
 * - パーミッション: `FILE_MODE` / `DIR_MODE` SSOT を screenshot service から import
 *   （owner-only file / dir mode、literal 再宣言禁止、TDA-02）。
 * - atomic rename: tmp 書込 → rename（torn write 回避、screenshot SSOT と同 pattern）。
 *
 * PII gate: crop の生成/保存は **PII-filtered loop の内側**で呼ばれることを前提と
 * する（high-PII section/part は呼び出し側 loop / query で既に除外済 = fail-closed）。
 * 本 helper は PII を再判定しない（gate は呼び出し側の filtered loop が単一 SSOT）。
 *
 * GDPR retention: crop は `data.delete` まで保持（TTL cron 復活なし、ADR-0041 整合）。
 * per-page 決定論 dir `<root>/crops/<webPageId>/` ゆえ section/part id を保持せず
 * page dir 一括 unlink 可能（GDPR cascade は PR-3b で配線）。
 *
 * Feature flag: `CROP_PERSISTENCE_ENABLED`（default ON = opt-out、W6 Issue A
 * PR-3b W3 flip。GDPR sequencing anchor `019ef5ca`: PR-3a では default OFF で
 * crop dir GDPR cascade が GREEN になるまで Art.17 を fail-closed に維持していたが、
 * PR-3b W1-W4 cascade GREEN を gate に default を ON へ反転。operative resolver は
 * `isCropPersistenceEnabled()` (= `process.env.CROP_PERSISTENCE_ENABLED !== "false"`)
 * が T1）。`"false"` のみ OFF（crop file を一切生成しない）。
 *
 * @module services/part/crop-persistence.helper
 */

import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { logger } from "../../utils/logger";
import { sanitizeErrorMessage } from "../../utils/sanitize-error";
import { truncateId } from "../../utils/truncate-id";
import {
  DIR_MODE,
  FILE_MODE,
  UUID_REGEX,
  buildSafePathWithinRoot,
  resolveScreenshotRoot,
  validatePathWithinRoot,
} from "../screenshot-persistence.service";

/** crops サブディレクトリ名（screenshot phase5 dir の sibling） */
/** crops sub-directory name (sibling of the screenshot phase5 dir) */
const CROPS_SUBDIR = "crops";

/** crop の種別（section / part） */
/** Crop kind (section / part) */
export type CropKind = "section" | "part";

/**
 * `CROP_PERSISTENCE_ENABLED` flag の単一 resolver（default ON = opt-out、W6 Issue
 * A PR-3b W3 flip）。
 * Single resolver for the `CROP_PERSISTENCE_ENABLED` flag (default ON = opt-out,
 * W6 Issue A PR-3b W3 flip).
 *
 * GDPR sequencing（anchor `019ef5ca`）: PR-3a では default OFF を保ち crop dir GDPR
 * cascade が PR-3b W1-W4 で GREEN になるまで Art.17 を fail-closed に維持していた。
 * PR-3b W1-W4（cascade dual-path + `INV-CROP-RETENTION-001` + deep-crop C5 + parity
 * surface 5）が GREEN になったため、本 W3 flip で default を ON に反転する。`"false"`
 * のみ OFF、それ以外（未設定 / `"true"` / 不正値）は全て ON（additive opt-out、
 * `EMBEDDING_CACHE_ENABLED` ADR-0040 と同 pattern）。flip 後も `data.delete` の
 * crop-dir cascade が必ず存在するため「crop 生成 ⇒ 回収経路あり」が時系列で成立する。
 *
 * GDPR sequencing (anchor `019ef5ca`): PR-3a kept it default OFF (Art.17
 * fail-closed) until the PR-3b W1-W4 crop-dir GDPR cascade is GREEN. Now that
 * W1-W4 (cascade dual-path + `INV-CROP-RETENTION-001` + deep-crop C5 + parity
 * surface 5) is GREEN, this W3 flip reverses the default to ON. Only the literal
 * `"false"` disables it; everything else (unset / `"true"` / invalid) is ON
 * (additive opt-out, same pattern as `EMBEDDING_CACHE_ENABLED` ADR-0040). The
 * `data.delete` crop-dir cascade always exists post-flip, so "crop generated ⇒
 * reaping path exists" holds in time order.
 *
 * 全 callsite は本 resolver を経由すること（process.env を inline 再読込しない、
 * SEC-M-03 flag-gate callsite parity）。
 * All callsites MUST route through this resolver (no inline process.env reads,
 * SEC-M-03 flag-gate callsite parity).
 */
export function isCropPersistenceEnabled(): boolean {
  return process.env.CROP_PERSISTENCE_ENABLED !== "false";
}

/**
 * crops root（`<screenshotRoot>/crops`）を解決する。
 * Resolve the crops root (`<screenshotRoot>/crops`).
 *
 * screenshot SSOT の `resolveScreenshotRoot()`（realpath + cache + env override）
 * から derive するため、`REFTRIX_SCREENSHOT_ROOT` 変更にも整合する。
 * Derives from the screenshot SSOT `resolveScreenshotRoot()` (realpath + cache +
 * env override) so it stays consistent if `REFTRIX_SCREENSHOT_ROOT` changes.
 */
export async function resolveCropRoot(): Promise<string> {
  const root = await resolveScreenshotRoot();
  return path.join(root, CROPS_SUBDIR);
}

/**
 * webPageId / entityId を `UUID_REGEX` SSOT で検証する（bare literal 禁止、SEC-M-02）。
 * Validate webPageId / entityId via the `UUID_REGEX` SSOT (no bare literal, SEC-M-02).
 *
 * @throws Error if either id is not a valid UUID v4/v7
 */
function assertValidCropIds(webPageId: string, entityId: string): void {
  if (typeof webPageId !== "string" || !UUID_REGEX.test(webPageId)) {
    throw new Error("[CropPersistence] webPageId must be a valid UUID v4/v7");
  }
  if (typeof entityId !== "string" || !UUID_REGEX.test(entityId)) {
    throw new Error("[CropPersistence] entityId must be a valid UUID v4/v7");
  }
}

/**
 * crop の安全な絶対保存パスを構築する（Path Traversal 対策、SEC-M-02 / TDA-02）。
 * Build a safe absolute crop storage path (path traversal defense).
 *
 * crop dir = `<cropRoot>/<webPageId>/${kind}-${entityId}.png`（per-page 決定論 dir）。
 * webPageId / entityId を `UUID_REGEX` で検証し、`buildSafePathWithinRoot` 共有 core
 * で per-page dir 配下であることを保証する（弱い第 2 resolver 禁止）。
 *
 * @throws Error if validation fails or the resolved path escapes the per-page dir
 */
export async function buildSafeCropPath(
  webPageId: string,
  kind: CropKind,
  entityId: string
): Promise<string> {
  assertValidCropIds(webPageId, entityId);
  const cropRoot = await resolveCropRoot();
  const perPageDir = path.join(cropRoot, webPageId);
  // 共有 core で startsWith 検証（複製ゼロ、SEC-H-02）
  // startsWith validation via the shared core (zero duplication, SEC-H-02)
  return buildSafePathWithinRoot(perPageDir, `${kind}-${entityId}.png`);
}

/**
 * per-page crop dir（`<cropRoot>/<webPageId>/`、entityId なし）の安全な絶対パスを
 * 構築する（GDPR crop cascade 用、Path Traversal 対策、W6 Issue A PR-3b F-06）。
 * Build a safe absolute per-page crop dir (`<cropRoot>/<webPageId>/`, no entityId)
 * for the GDPR crop cascade (path traversal defense, F-06).
 *
 * cascade は返り値の validated dir のみ `fs.rm(recursive)` で unlink する。
 * **webPageId を FIRST に `UUID_REGEX` で検証**してから `buildSafePathWithinRoot`
 * 共有 core を経由するため、malformed id（`../sibling`, null-byte 等）が
 * sibling/parent dir を再帰削除することはない（弱い第 2 resolver 禁止、SEC-H-02
 * parity）。batch path は DB-sourced id を回すため、caller 検証に依存せず本関数が
 * **内部再検証**する（defense-in-depth、`assertValidCropIds` の webPageId 部分と同根拠）。
 *
 * The cascade only `fs.rm(recursive)`'s the validated dir this returns. webPageId
 * is validated FIRST via `UUID_REGEX`, then routed through the shared
 * `buildSafePathWithinRoot` core, so a malformed id can never recurse-delete a
 * sibling/parent dir (no weak second resolver, SEC-H-02 parity). The batch path
 * iterates DB-sourced ids, so this function re-validates internally rather than
 * trusting the caller (defense-in-depth).
 *
 * @throws Error if webPageId is not a valid UUID v4/v7 or the resolved dir escapes the crop root
 */
export async function buildSafeCropDir(webPageId: string): Promise<string> {
  if (typeof webPageId !== "string" || !UUID_REGEX.test(webPageId)) {
    throw new Error("[CropPersistence] webPageId must be a valid UUID v4/v7");
  }
  const cropRoot = await resolveCropRoot();
  // 共有 core で per-page dir が crop root 配下であることを startsWith 検証
  // （複製ゼロ、SEC-H-02）。entityId なし版（dir 自身を返す）。
  // startsWith validation via the shared core (zero duplication, SEC-H-02);
  // entityId-less variant returning the dir itself.
  return buildSafePathWithinRoot(cropRoot, webPageId);
}

/**
 * serve-time 用の crop パス検証（realpath + isFile + startsWith、symlink-escape→null）。
 * Serve-time crop path validation (realpath + isFile + startsWith, symlink-escape→null).
 *
 * screenshot SSOT の `validatePathWithinRoot` 共有 core を crops root で再利用する
 * （複製ゼロ）。PR-4 serve route がこの validator を chain する。
 * Reuses the screenshot SSOT `validatePathWithinRoot` core with the crops root
 * (zero duplication). The PR-4 serve route chains this validator.
 *
 * @returns crops root 配下の実ファイルなら realpath 結果、そうでなければ null
 */
export async function validateCropPath(candidatePath: string): Promise<string | null> {
  const cropRoot = await resolveCropRoot();
  return validatePathWithinRoot(candidatePath, cropRoot);
}

/**
 * viewable PNG buffer を crop 保存パスに永続化する（flag-gated, Graceful Degradation）。
 * Persist a viewable PNG buffer to the crop storage path (flag-gated, graceful).
 *
 * flag OFF（`CROP_PERSISTENCE_ENABLED !== "true"`）の場合は何もせず null を返す
 * （production crop 生成を構造的に停止、SEC-M-03）。保存成功時は絶対 crop path を
 * 返し、呼び出し側が DB `crop_storage_path` 列を更新する。
 *
 * No-op returning null when the flag is OFF (structurally stops production crop
 * generation, SEC-M-03). On success returns the absolute crop path for the caller
 * to write into the DB `crop_storage_path` column.
 *
 * 安全装置 / Safety:
 * - atomic rename（tmp 書込 → rename、torn write 回避、screenshot SSOT と同 pattern）。
 * - dir / file mode は SSOT `DIR_MODE` / `FILE_MODE` import（literal 再宣言なし、TDA-02）。
 * - 保存失敗は非致命（`logger.warn` + null 返却、embedding job を fail させない =
 *   Graceful Degradation、catch 内 `isDevelopment()` ガード禁止 = SEC-L-01）。
 *
 * @returns 保存した crop の絶対パス、flag OFF / 失敗時は null
 */
/**
 * 最小限の Prisma `$executeRawUnsafe` 面（leaf helper の DB 依存を狭める）。
 * Minimal Prisma `$executeRawUnsafe` surface for leaf helpers.
 */
interface CropDbExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * deep-crop C5 leaf helper（W6 Issue A PR-3b F-09）: section-fallback live-Y 経路
 * (`processDynamicFallbackBatch`) の viewable PNG crop を永続化し、成功時のみ
 * `section_embeddings.crop_storage_path` を UPDATE する。
 *
 * Deep-crop C5 leaf helper (F-09): persists the viewable PNG crop produced on the
 * section-fallback live-Y path (`processDynamicFallbackBatch`) and, only on
 * success, UPDATEs `section_embeddings.crop_storage_path`.
 *
 * host `processDynamicFallbackBatch` (既に CC>10、`phase-5-embedding.ts` は eslint
 * complexity override 対象外) の per-iteration branch delta を ≤2 に抑えるため、
 * crop save + DB UPDATE ロジックを本 leaf に分離する。本 helper は
 * `crop-persistence.helper.ts`（scoped `complexity: ["error", 10]` override 配下）に
 * 置かれるため CC≤10 が machine-gate される。
 *
 * Extracts the crop-save + DB-UPDATE logic so the host `processDynamicFallbackBatch`
 * (already CC>10; `phase-5-embedding.ts` is outside the eslint complexity override)
 * gains a per-iteration branch delta ≤2. Lives under the scoped
 * `complexity: ["error", 10]` override here, so its CC is machine-gated.
 *
 * - `saveCropFromBuffer` no-ops + returns null when `CROP_PERSISTENCE_ENABLED` is
 *   OFF / on failure → crop_storage_path stays NULL (Graceful Degradation).
 * - PII fail-closed: high-PII section は upstream `sectionsFiltered` で構造的に
 *   除外済ゆえ本経路に到達しない（冗長 gate を追加しない、F-04 / ADR-0044 §Decision 2）。
 * - non-fatal: crop file saved but path column UPDATE failed → embedding は intact、
 *   `logger.warn` のみ（catch 内 isDevelopment() ガード禁止 = SEC-L-01）。
 *
 * @param prisma           `$executeRawUnsafe` を持つ Prisma client
 * @param webPageId        target page UUID（crop dir / filename）
 * @param sectionEmbeddingId  section_embeddings.id（crop_storage_path UPDATE key）
 * @param sectionPatternId    section_patterns.id（crop filename entityId）
 * @param viewablePng      viewable PNG crop buffer（null → no-op）
 */
export async function persistDynamicFallbackSectionCrop(
  prisma: CropDbExecutor,
  webPageId: string,
  sectionEmbeddingId: string,
  sectionPatternId: string,
  viewablePng: Buffer | null
): Promise<void> {
  if (!viewablePng) return;
  const cropPath = await saveCropFromBuffer({
    webPageId,
    kind: "section",
    entityId: sectionPatternId,
    pngBuffer: viewablePng,
  });
  if (cropPath === null) return;
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE section_embeddings
         SET crop_storage_path = $1
       WHERE id = $2::uuid`,
      cropPath,
      sectionEmbeddingId
    );
  } catch (cropDbError) {
    // Non-fatal: crop file saved but path column failed; the embedding is intact.
    // Log in all environments (no isDevelopment() guard, SEC-L-01).
    logger.warn(
      "[CropPersistence] Failed to write dynamic-fallback section crop_storage_path (non-fatal)",
      {
        sectionEmbeddingId: truncateId(sectionEmbeddingId),
        error: sanitizeErrorMessage(cropDbError),
      }
    );
  }
}

/**
 * Raw-pixel Sharp source descriptor (Phase 5 part path that holds a decoded RAW
 * buffer + its dimensions/channels, avoiding a re-decode).
 * Raw-pixel Sharp source descriptor (Phase 5 RAW buffer path).
 */
export interface RawCropSource {
  rawBuffer: Buffer;
  rawMeta: { width: number; height: number; channels: 1 | 2 | 3 | 4 };
}

/**
 * Encoded (PNG/JPEG) Sharp source descriptor (the backfill path reads the
 * persisted full-page screenshot as an encoded buffer).
 * Encoded Sharp source descriptor (the backfill path).
 */
export interface EncodedCropSource {
  pngBuffer: Buffer;
}

/** Crop-cut source: either a decoded RAW buffer (+meta) or an encoded image buffer. */
export type CropCutSource = RawCropSource | EncodedCropSource;

/**
 * Crop-cut parameters: an absolute (already section-offset-applied) bbox + the
 * source image dimensions used for the clamp/off-screen honest-skip gate.
 */
export interface CutCropParams {
  source: CropCutSource;
  /** Absolute bbox in screenshot pixel space (x/y already include any section startY). */
  bbox: { x: number; y: number; width: number; height: number };
  /** Source image dimensions in pixels (the clamp denominator). */
  imgDims: { imgWidth: number; imgHeight: number };
}

/**
 * Build the Sharp pipeline for a crop source (RAW vs encoded). Leaf so the
 * clamp/gate logic in `cutCropFromScreenshot` stays ≤ CC 10 (scoped override).
 * Build the Sharp pipeline for the crop source (RAW vs encoded).
 */
function sharpFromSource(source: CropCutSource): sharp.Sharp {
  if ("rawBuffer" in source) {
    return sharp(source.rawBuffer, {
      raw: {
        width: source.rawMeta.width,
        height: source.rawMeta.height,
        channels: source.rawMeta.channels,
      },
    });
  }
  return sharp(source.pngBuffer);
}

/**
 * 切り出し + truncation/clamp gate の SSOT (W6 Issue A PR-4a, F-M-02)。Phase 5
 * embedding path と backfill path の双方が本 SSOT で viewable PNG crop を切り出し、
 * **clamp-gate を二重実装しない**。
 *
 * Shared SSOT for the viewable-PNG crop cut + truncation/clamp gate (F-M-02). Both
 * the Phase 5 embedding path AND the backfill path cut crops via this single SSOT,
 * so the clamp gate is NOT duplicated.
 *
 * clamp / honest-skip 契約 (`019ecfe4` の garbage 1px-sliver crop を防止):
 *   - NaN / Infinity bbox → null (NaN defense, no garbage crop)。
 *   - fully off-screen (clamped `top >= imgHeight` or `left >= imgWidth`) → null。
 *   - zero-size after clamp (`cropWidth <= 0 || cropHeight <= 0`) → null。
 *   - それ以外は in-viewport 領域に clamp して PNG Buffer を返す (partial off-screen は
 *     viewport 内領域に clamp = honest crop、honest-skip ではない)。
 *
 * clamp / honest-skip contract (prevents the `019ecfe4` garbage 1px-sliver crop):
 *   - NaN / Infinity bbox → null (NaN defense).
 *   - fully off-screen (clamped `top >= imgHeight` or `left >= imgWidth`) → null.
 *   - zero-size after clamp (`cropWidth <= 0 || cropHeight <= 0`) → null.
 *   - otherwise clamp to the in-viewport region and return a PNG Buffer (a partial
 *     off-screen bbox clamps to the visible region = an honest crop, not a skip).
 *
 * 本関数は embedding 推論を一切行わない (pure な Sharp cut leaf)。`crop-persistence.helper.ts`
 * は scoped `complexity: ["error", 10]` override 配下ゆえ CC≤10 が machine-gate される。
 *
 * @returns viewable PNG crop Buffer、honest-skip 時は null
 */
/** Sharp `.extract()` rect (left/top/width/height) in screenshot pixel space. */
interface CropExtractRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Whether a bbox is finite + positive-sized (NaN/Infinity defense). The `width <= 0`
 * comparison is false for NaN, so finiteness is checked first.
 * Whether the bbox is finite and positive-sized (NaN/Infinity defense).
 */
function isBboxFinitePositive(bbox: CutCropParams["bbox"]): boolean {
  return (
    Number.isFinite(bbox.x) &&
    Number.isFinite(bbox.y) &&
    Number.isFinite(bbox.width) &&
    Number.isFinite(bbox.height) &&
    bbox.width > 0 &&
    bbox.height > 0
  );
}

/**
 * Resolve the clamped extract rect for a bbox, or null when the crop would be a
 * NaN / fully-off-screen / zero-size honest-skip. Leaf so `cutCropFromScreenshot`
 * stays ≤ CC 10 (scoped override).
 * Resolve the clamped extract rect, or null on a NaN / off-screen / zero-size skip.
 */
function resolveCropExtractRect(
  bbox: CutCropParams["bbox"],
  imgWidth: number,
  imgHeight: number
): CropExtractRect | null {
  if (!isBboxFinitePositive(bbox)) {
    return null;
  }
  const left = Math.max(0, Math.round(bbox.x));
  const top = Math.max(0, Math.round(bbox.y));
  // Fully off-screen: the clamped left-top corner is at/beyond the bounds → 0 croppable px.
  if (top >= imgHeight || left >= imgWidth) {
    return null;
  }
  const width = Math.min(Math.round(bbox.width), Math.max(1, imgWidth - left));
  const height = Math.min(Math.round(bbox.height), Math.max(1, imgHeight - top));
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { left, top, width, height };
}

export async function cutCropFromScreenshot(params: CutCropParams): Promise<Buffer | null> {
  const rect = resolveCropExtractRect(
    params.bbox,
    params.imgDims.imgWidth,
    params.imgDims.imgHeight
  );
  if (rect === null) {
    return null;
  }
  return sharpFromSource(params.source).extract(rect).png().toBuffer();
}

export async function saveCropFromBuffer(params: {
  webPageId: string;
  kind: CropKind;
  entityId: string;
  pngBuffer: Buffer;
}): Promise<string | null> {
  if (!isCropPersistenceEnabled()) {
    return null;
  }
  const { webPageId, kind, entityId, pngBuffer } = params;
  if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
    logger.warn("[CropPersistence] empty crop buffer, skipping save (non-fatal)", {
      webPageId: truncateId(webPageId),
      kind,
    });
    return null;
  }

  try {
    const destPath = await buildSafeCropPath(webPageId, kind, entityId);
    const destDir = path.dirname(destPath);

    // per-page dir を DIR_MODE で作成（recursive は冪等）+ 既存 dir の権限を harden
    // Create per-page dir with DIR_MODE (recursive is idempotent) + harden existing
    await fs.mkdir(destDir, { recursive: true, mode: DIR_MODE });
    try {
      await fs.chmod(destDir, DIR_MODE);
    } catch (chmodError) {
      logger.warn("[CropPersistence] Failed to chmod crop directory (non-fatal)", {
        webPageId: truncateId(webPageId),
        error: sanitizeErrorMessage(chmodError),
      });
    }

    // Atomic rename: tmp 書込 → rename
    const tmpSuffix = `.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const tmpPath = destPath + tmpSuffix;
    try {
      await fs.writeFile(tmpPath, pngBuffer, { mode: FILE_MODE });
      await fs.rename(tmpPath, destPath);
    } catch (writeError) {
      try {
        await fs.unlink(tmpPath);
      } catch {
        /* tmp may not exist */
      }
      // SEC-L-01: catch 内 isDevelopment() ガード禁止（全環境で logger.warn 出力）
      // SEC-L-01: no isDevelopment() guard in catch (log in all environments)
      logger.warn("[CropPersistence] Failed to write crop file (non-fatal)", {
        webPageId: truncateId(webPageId),
        kind,
        error: sanitizeErrorMessage(writeError),
      });
      return null;
    }
    return destPath;
  } catch (error) {
    // 構築 / 検証失敗も非致命（embedding は継続、crop なし = 視覚未取得）
    // Build/validation failure is also non-fatal (embedding continues, no crop)
    logger.warn("[CropPersistence] crop save failed (non-fatal, embedding continues)", {
      webPageId: truncateId(params.webPageId),
      kind: params.kind,
      error: sanitizeErrorMessage(error),
    });
    return null;
  }
}
