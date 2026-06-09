// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding cache temp-file naming SSOT (Single Source of Truth).
 *
 * Embedding cache の temp ファイル命名の SSOT (Single Source of Truth)。
 *
 * このモジュールは temp ファイル prefix を 1 箇所に集約し、以下 3 箇所が一方向に
 * import して derive する (二重管理排除、coupling drift 検出):
 *   (1) 生成 (`persistent-cache.ts` の `saveToDisk`)
 *   (2) sweep regex (起動時 orphan sweep の whitelist Stage 3)
 *   (3) behavior INV test (readdir filter)
 *
 * **隔離理由 (TDA-RE2-02)**: `persistent-cache.ts` 本体に置くと、起動時 sweep の
 * leaf helper / INV test が cache 本体クラスを transitively import せざるを得ず
 * 循環参照リスクが生じる。本 const は依存を持たない leaf module として隔離し、
 * 全 derive 箇所が一方向 import するだけで済むようにする (url-normalizer.ts の
 * `SEVEN_STEP_MARKERS` SSOT 前例と同型)。
 *
 * This module isolates the temp-file prefix to a single dependency-free leaf so
 * the generation site, the startup-sweep whitelist, and the INV test all import
 * it one-directionally (TDA-RE2-02: circular-import avoidance). Mirrors the
 * `url-normalizer.ts` `SEVEN_STEP_MARKERS` SSOT precedent.
 *
 * @module services/cache-temp-const
 */

/**
 * Temp ファイル名 prefix。実体 = `"<dbPath>/cache.json"` に対する
 * `${storagePath}.tmp.${pid}.${ts}` の `.tmp.` 区切り部分。
 *
 * Temp filename prefix: the `.tmp.` separator appended to the storage path
 * (`cache.json`) before `${pid}.${ts}`.
 *
 * NOTE: 実 temp ファイル名は `cache.json.tmp.<pid>.<ts>` の形をとる。
 *       `CACHE_TEMP_PREFIX` は basename の先頭一致判定に用いる。
 */
export const CACHE_TEMP_PREFIX = "cache.json.tmp." as const;

/**
 * Temp ファイル basename を判定する正規表現。`CACHE_TEMP_PREFIX` から derive する
 * のではなく、同一文字列 literal を SSOT として 1 箇所で確定し regex 化する
 * (prefix と regex は同一 prefix を表す双子の SSOT view)。
 *
 * Regex to match a temp-file basename. The literal here is the canonical SSOT
 * twin of `CACHE_TEMP_PREFIX` (both express the same `cache.json.tmp.` prefix).
 *
 * `^cache\.json\.tmp\.` — basename が prefix で始まることのみを要求し、後続の
 * `<pid>.<ts>` 形式は問わない (誤って `cache.json` 本体にマッチしないよう
 * `\.tmp\.` を必須とする)。
 */
export const CACHE_TEMP_REGEX = /^cache\.json\.tmp\./;
