// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Node.js runtime floor — SSOT / Node.js 実行時下限の単一の正典
 *
 * 組み込み undici / Brotli の脆弱性 (CVE-2026-111497 を含む 2026-10-21 の security release) を
 * 踏まない版だけを許可する。純関数のみで副作用なし、import なし。
 * Pure functions only: no side effects, no imports. The side-effecting guard lives in
 * `assert-node-runtime.ts`.
 */

export type RuntimeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** 系列 (major) ごとの下限: node の最小版と、その版が同梱する undici の最小版 */
export const NODE_RUNTIME_FLOOR_TABLE = Object.freeze({
  22: Object.freeze({ node: "22.23.4", undici: "6.29.1" }),
  24: Object.freeze({ node: "24.22.1", undici: "7.30.1" }),
  26: Object.freeze({ node: "26.12.1", undici: "8.12.2" }),
});

/** package.json `engines.node` と一致させる範囲文字列 (表から導出) */
export const NODE_ENGINES_RANGE: string = Object.values(NODE_RUNTIME_FLOOR_TABLE)
  .map((row) => `^${row.node}`)
  .join(" || ");

type Triple = readonly [number, number, number];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const OK: RuntimeVerdict = { ok: true };
const reject = (reason: string): RuntimeVerdict => ({ ok: false, reason });

/** `process.versions.*` 形式 (先頭 v / 先頭 0 / prerelease / build を拒否) の厳密な解析 */
export function parseSemver(value: unknown): Triple | null {
  if (typeof value !== "string") return null;
  const m = SEMVER.exec(value);
  if (m === null) return null;
  const t: Triple = [Number(m[1]), Number(m[2]), Number(m[3])];
  return t.every((n) => Number.isSafeInteger(n)) ? t : null;
}

function compare(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function floorFor(major: number): { node: Triple; undici: Triple } | undefined {
  const row = (
    NODE_RUNTIME_FLOOR_TABLE as Record<number, { node: string; undici: string } | undefined>
  )[major];
  const node = parseSemver(row?.node);
  const undici = parseSemver(row?.undici);
  return node === null || undici === null ? undefined : { node, undici };
}

export function evaluateNodeVersion(node: unknown): RuntimeVerdict {
  const v = parseSemver(node);
  if (v === null) return reject("node-version-unparsable");
  const floor = floorFor(v[0]);
  if (floor === undefined) return reject("node-series-unsupported");
  return compare(v, floor.node) >= 0 ? OK : reject("node-below-floor");
}

export function evaluateUndiciVersion(major: number, undici: unknown): RuntimeVerdict {
  const floor = floorFor(major);
  if (floor === undefined) return reject("node-series-unsupported");
  const v = parseSemver(undici);
  if (v === null) return reject("undici-version-unparsable");
  return compare(v, floor.undici) >= 0 ? OK : reject("undici-below-floor");
}

/** CVE-2026-111497 の修正版だけが公開する zlib 定数 (数値) の有無 */
export function evaluateBrotliFixMarker(marker: unknown): RuntimeVerdict {
  return typeof marker === "number" ? OK : reject("brotli-fix-marker-missing");
}

export interface NodeRuntimeInput {
  readonly node: unknown;
  readonly undici: unknown;
  readonly brotliBlockSwitchMarker: unknown;
  readonly releaseName: unknown;
}

export function evaluateNodeRuntime(input: NodeRuntimeInput): RuntimeVerdict {
  const nodeVerdict = evaluateNodeVersion(input.node);
  if (!nodeVerdict.ok) return nodeVerdict;
  const major = parseSemver(input.node)?.[0] ?? -1;
  const undiciVerdict = evaluateUndiciVersion(major, input.undici);
  if (!undiciVerdict.ok) return undiciVerdict;
  const markerVerdict = evaluateBrotliFixMarker(input.brotliBlockSwitchMarker);
  if (!markerVerdict.ok) return markerVerdict;
  return input.releaseName === "node" ? OK : reject("release-name-not-node");
}
