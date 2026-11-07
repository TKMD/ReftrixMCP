// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * パーツ番号属性（VR-M-01）/ Part number attribute (VR-M-01)
 *
 * 取り込み時に要素へ振る `data-reftrix-pid` と、それを取り除く関数。保存・ハッシュ・埋め込みに
 * 渡る文字列には残してはいけない（`INV-PART-PID-NOT-PERSISTED-001`）。サニタイザーは入口で必ず外す。
 * The `data-reftrix-pid` attribute numbered at ingest and its stripper. It must never reach a
 * persisted, hashed or embedded string (`INV-PART-PID-NOT-PERSISTED-001`); the sanitizers strip
 * it on entry.
 *
 * @module utils/part-pid
 */

/** 要素に振る番号の属性名 / Attribute that carries the element number */
export const PART_PID_ATTR = "data-reftrix-pid";

// page.content() / outerHTML は属性を ` name="value"` で直列化する。番号は数字だけ。
// 断片が属性の途中で切り詰められた（閉じ引用符が無い）場合も外す。
// page.content() / outerHTML serialize the attribute as ` name="value"`; values are digits only.
// A snippet cut inside the attribute (no closing quote) is stripped too.
const PID_ATTR_PATTERN = /\sdata-reftrix-pid="(?:\d{0,7}"|\d{1,7}(?=[^"\d])|\d{0,7}$)/gi;
const PID_VALUE_PATTERN = /\sdata-reftrix-pid="(\d{1,7})"/gi;

/**
 * HTML から番号属性を取り除く。番号を振る前の直列化と同じ文字列に戻る。
 * Removes every pid attribute; the result equals the serialization without numbering.
 */
export function stripPartPids(html: string): string {
  if (!/data-reftrix-pid/i.test(html)) return html;
  return html.replace(PID_ATTR_PATTERN, "");
}

/**
 * 要素の番号属性を読む（0 以上の整数のみ）。/ Reads an element's pid (non-negative integer only).
 */
export function readPartPid(element: { getAttribute(name: string): string | null }): number | null {
  const v = element.getAttribute(PART_PID_ATTR);
  if (v === null || !/^\d{1,7}$/.test(v)) return null;
  return Number(v);
}

/**
 * 直列化した HTML の中で 2 回以上現れる番号を返す。ページのスクリプトが番号を複製した
 * 要素は、位置を別の要素と取り違えうるので使わない（SEC M-1）。
 * Returns pids that appear more than once in the serialized HTML. A pid the page's scripts
 * copied onto another element could pair one element's box with another, so it is not used.
 */
export function duplicatePartPids(html: string): Set<number> {
  const seen = new Set<number>();
  const dup = new Set<number>();
  for (const m of html.matchAll(PID_VALUE_PATTERN)) {
    const pid = Number(m[1]);
    if (seen.has(pid)) dup.add(pid);
    else seen.add(pid);
  }
  return dup;
}
