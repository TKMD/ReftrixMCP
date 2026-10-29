// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Crop Path Helper (read / delete side only)
 *
 * crop の生成（書込み）は終了した（2026-10-26）。本 module は、既存（legacy）の
 * `<root>/crops/<webPageId>/` を扱う読み取り・削除側の path 解決だけを残す:
 * `buildSafeCropDir`（`data.delete` の crop dir cascade 用）と `resolveCropRoot`。
 * crop を読む sink は存在しない（内部 read API は撤去済み）。防御は全て screenshot SSOT
 * （`screenshot-persistence.service.ts`）の共有 core を import して使う
 * （弱い第 2 resolver を作らない）。
 *
 * Crop generation (the write path) has ended (2026-10-26). This module keeps only
 * the read / delete-side path resolution for existing (legacy) crops under
 * `<root>/crops/<webPageId>/`: `buildSafeCropDir` (the `data.delete` crop-dir
 * cascade) and `resolveCropRoot`. No sink reads crops any more (the internal read
 * API was removed). All defenses import the screenshot SSOT shared core
 * (`screenshot-persistence.service.ts`); there is no weak second resolver.
 *
 * GDPR retention: legacy crop は `data.delete` まで保持（ADR-0041 / ADR-0044 整合）。
 * Legacy crops are retained until `data.delete` (ADR-0041 / ADR-0044).
 *
 * @module services/part/crop-persistence.helper
 */

import path from "node:path";
import {
  UUID_REGEX,
  buildSafePathWithinRoot,
  resolveScreenshotRoot,
} from "../screenshot-persistence.service";

/** crops sub-directory name (sibling of the screenshot phase5 dir) */
const CROPS_SUBDIR = "crops";

/** crop の種別（section / part） */
/** Crop kind (section / part) */
export type CropKind = "section" | "part";

/**
 * crops root（`<screenshotRoot>/crops`）を解決する。
 * Resolve the crops root (`<screenshotRoot>/crops`).
 *
 * screenshot SSOT の `resolveScreenshotRoot()`（realpath + cache + env override）
 * から derive するため、`REFTRIX_SCREENSHOT_ROOT` 変更にも整合する。
 * Derives from the screenshot SSOT `resolveScreenshotRoot()` so it stays consistent
 * if `REFTRIX_SCREENSHOT_ROOT` changes.
 */
export async function resolveCropRoot(): Promise<string> {
  const root = await resolveScreenshotRoot();
  return path.join(root, CROPS_SUBDIR);
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
 * **内部再検証**する（defense-in-depth）。
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
