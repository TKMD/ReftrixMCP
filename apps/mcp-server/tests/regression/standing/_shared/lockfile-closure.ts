// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — 共有 lockfile 閉包 helper (test-only、`js-yaml` で parse 済みの値だけを受ける)
 * Shared lockfile closure helper for the standing suite (test-only; takes an already-parsed value)
 *
 * `INV-SEC-OSS-CLOSURE-BRACES-001` がこの関数を使う (CO-R2-101)。起点 importer の `devDependencies` を
 * 常に含める。以前は `INV-SEC-AUDIT-IGNORE-BOUND-001` leg (6) が production だけの閉包 (`includeDev: false`)
 * でも使っていたが、ignore 集合を空にした際にその leg を撤去し、呼び手が 0 になった `includeDev` option は
 * 併せて削除した。抽出元は inv-sec-audit-ignore-bound-001.test.ts の `snapshotKey` / `prodClosure`。
 * 別 `.test.ts` から import しない (testing-requirements §9 TPA-02) ため `*.test.ts` ではない本 module に置く。
 *
 * INV-SEC-OSS-CLOSURE-BRACES-001 uses this function (CO-R2-101). It always includes the root importers'
 * `devDependencies`. INV-SEC-AUDIT-IGNORE-BOUND-001 leg (6) used it for the production-only closure
 * (`includeDev: false`) until the ignore set was emptied and that leg was removed; the `includeDev`
 * option, left with no caller, was removed with it. Extracted from the ignore-pin INV's `snapshotKey` /
 * `prodClosure`.
 *
 * 閉包 / Closure:
 * - 起点 = 指定 importer の `dependencies` ∪ `optionalDependencies` ∪ `devDependencies`。dev は**起点
 *   importer にだけ**含める。`link:` で辿った先の importer は起点でなければ
 *   `dependencies` ∪ `optionalDependencies` のみ。
 *   Roots are the given importers' `dependencies` ∪ `optionalDependencies` ∪ `devDependencies`; dev
 *   is included for the root importers only. Importers reached via `link:` that are not roots
 *   contribute `dependencies` ∪ `optionalDependencies` only.
 * - 辺 = `snapshots` の `dependencies` ∪ `optionalDependencies`。`link:` は対象 importer へ、
 *   alias (`name: other@1.2.3`) は `other@1.2.3` の snapshot key へ辿る。
 *   Edges are the snapshots' `dependencies` ∪ `optionalDependencies`; `link:` goes to the target
 *   importer and an alias to its snapshot key.
 * - 辿れない参照 (snapshot / importer の欠落、version を読めない、snapshot 内の `link:`) は
 *   `unresolved` に積む (呼び出し側が violation にする = fail-closed)。
 *   Unresolvable references go to `unresolved` (callers treat them as violations: fail-closed).
 * - `visitedImporters` = 起点 + `link:` で到達した importer の集合 (O 外 importer への到達検出用)。
 *   `visitedImporters` = roots plus importers reached via `link:` (detects reaching outside a set).
 *
 * Registry: security-deps CO-R2-101 plan v1.1 §1.1 / §2 (V1-101-03 / V1-101-09 / P101-15).
 * Regression domain: large-page.
 */

import { posix } from "node:path";

export interface LockfileClosure {
  /** 到達した snapshot key (`name@version(peers)`) / reached snapshot keys */
  keys: Set<string>;
  /** 辿れなかった参照 / unresolvable references */
  unresolved: string[];
  /** 起点 + `link:` で到達した importer / root importers plus those reached via `link:` */
  visitedImporters: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** snapshot 参照を key (`name@version(peers)`) にする。`link:` は `null` */
function snapshotKey(name: string, version: string): string | null {
  if (version.startsWith("link:")) return null;
  // alias: `other@1.2.3` / `@scope/other@1.2.3` (版の前に package 名がある形)
  if (/^(@[^@/]+\/)?[^@(\d][^@(]*@/.test(version)) return version;
  return `${name}@${version}`;
}

/**
 * `importerPaths` (省略時は全 importer) から辿る snapshot 推移閉包。
 * Transitive snapshot closure from `importerPaths` (all importers when omitted).
 */
export function lockfileClosure(
  lock: unknown,
  importerPaths: readonly string[] | undefined
): LockfileClosure {
  const closure: LockfileClosure = {
    keys: new Set(),
    unresolved: [],
    visitedImporters: new Set(),
  };
  if (!isRecord(lock) || !isRecord(lock.importers) || !isRecord(lock.snapshots)) {
    closure.unresolved.push("lockfile に importers / snapshots が無い");
    return closure;
  }
  const importers = lock.importers;
  const snapshots = lock.snapshots;
  const roots = new Set(importerPaths ?? Object.keys(importers));
  const stack: string[] = [];
  const pushDeps = (deps: unknown, from: string, importerPath: string | null): void => {
    if (!isRecord(deps)) return;
    for (const [name, ref] of Object.entries(deps)) {
      const version = isRecord(ref) ? ref.version : ref;
      if (typeof version !== "string") {
        closure.unresolved.push(`${from} > ${name}: version を読めない`);
        continue;
      }
      const key = snapshotKey(name, version);
      if (key !== null) {
        stack.push(key);
      } else if (importerPath !== null) {
        visitImporter(posix.normalize(posix.join(importerPath, version.slice("link:".length))));
      } else {
        closure.unresolved.push(`${from} > ${name}: snapshot 内の link: 参照`);
      }
    }
  };
  const visitImporter = (path: string): void => {
    if (closure.visitedImporters.has(path)) return;
    closure.visitedImporters.add(path);
    const importer = importers[path];
    if (!isRecord(importer)) {
      closure.unresolved.push(`importer ${path} が lockfile に無い`);
      return;
    }
    pushDeps(importer.dependencies, path, path);
    pushDeps(importer.optionalDependencies, path, path);
    // dev は起点 importer にだけ含める (link: で辿った先の非起点 importer は含めない)
    if (roots.has(path)) pushDeps(importer.devDependencies, path, path);
  };
  for (const path of roots) visitImporter(path);
  while (stack.length > 0) {
    const key = stack.pop() as string;
    if (closure.keys.has(key)) continue;
    closure.keys.add(key);
    if (!(key in snapshots)) {
      closure.unresolved.push(`snapshot ${key} が無い`);
      continue;
    }
    const snapshot = snapshots[key];
    if (!isRecord(snapshot)) continue; // `{}` / 空 = 依存なし
    pushDeps(snapshot.dependencies, key, null);
    pushDeps(snapshot.optionalDependencies, key, null);
  }
  return closure;
}
