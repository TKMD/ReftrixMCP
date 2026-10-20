// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — 共有 semver / lockfile helper の pin test (INV ではない)
 * Pin test for the shared semver / lockfile helpers (not an INV)
 *
 * `./semver-lockfile` の公開関数の現挙動を定数期待値で固定する。依存する INV:
 * Pins the current behaviour of the public helpers with constant expectations. Guarded INVs:
 * // INV-SEC-OVERRIDE-BOUND-001 (harness) / // INV-SHARP-DECLARED-RANGE-001 (sharp precedent)
 * (新 INV は作らない / no new INV is introduced.)
 *
 * - `parseVersion` は strict (prerelease は `null`)。新規 INV はこちらを使う。
 *   `parseVersion` is strict (prerelease returns `null`); new INVs use it.
 * - `parseVersionPrefix` は sharp precedent 専用 (prerelease を落として読む fail-open)。
 *   `parseVersionPrefix` is for the sharp precedent only (reads past the prerelease, fail-open).
 *
 * | leg      | 対象 / target                                     | 入口 / entry                                      |
 * | -------- | ------------------------------------------------- | ------------------------------------------------- |
 * | P1       | `parseVersionPrefix` vs `parseVersion`            | 直呼び / direct                                    |
 * | P2–P7    | caret / tilde / 完全一致 / `>=` の境界             | `rangeAdmits(parseRange(r), parseVersion(v))`     |
 * | P8       | 未対応形は `null` (fail-closed)                    | `parseSimpleRange` + `parseRange`                 |
 * | P9–P10   | `readLockDefinition` (overrides / root importer)  | 合成 lock text / synthetic lock text              |
 * | P11      | `collectLockVersions` / `collectPeerSuffixVersions` | 合成 lock text                                  |
 * | P12      | `parseBoundedRange` (部分版 cap / partial cap)     | 直呼び / direct                                    |
 * | G-PREFIX | `parseVersionPrefix` の import 元の集合            | standing dir の TypeScript AST 走査               |
 *
 * 期待値は定数で書き、module の関数で期待値を計算しない。合成 lock text は fs に書かない。
 * G-PREFIX は `./semver-lockfile` へ解決する import / re-export の named specifier
 * (`parseVersionPrefix as x` の alias を含む) と namespace import 経由の property 参照で判定し、
 * comment 中の言及と shared module 自身は数えない (TypeScript の AST で読むため)。
 * Expectations are constants. Synthetic lock text never touches the filesystem. G-PREFIX reads
 * the TypeScript AST: named specifiers (aliases included) of imports / re-exports resolving to
 * `./semver-lockfile`, plus property access through a namespace import; comments and the shared
 * module itself are not counted.
 * 非主張: 対象は相対 specifier のみ。`@/` alias、`export *` / `export * as ns`、dynamic `import()` は検出しない。
 * Non-claim: only relative specifiers are checked; the `@/` alias, `export *` / `export * as ns`
 * and dynamic `import()` are not detected.
 *
 * Regression domain: large-page.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  type SemVer,
  collectLockVersions,
  collectPeerSuffixVersions,
  parseBoundedRange,
  parseRange,
  parseSimpleRange,
  parseVersion,
  parseVersionPrefix,
  rangeAdmits,
  readLockDefinition,
} from "./semver-lockfile";

const HERE = dirname(fileURLToPath(import.meta.url));
const STANDING_DIR = dirname(HERE);
const SHARED_MODULE_NO_EXT = join(HERE, "semver-lockfile");

/** INV と同じ入口 / same entry point as the INVs (harness `admits` helper) */
function admits(range: string, version: string): boolean {
  const spec = parseRange(range);
  const v = parseVersion(version);
  if (spec === null || v === null) {
    throw new Error(`fixture must parse: range=${range} version=${version}`);
  }
  return rangeAdmits(spec, v);
}

function v(major: number, minor: number, patch: number): SemVer {
  return { major, minor, patch };
}

// pnpm の実出力形: `importers:` / `packages:` の直後は空行、importer 間も空行。
// pnpm's on-disk shape: blank line after `importers:` / `packages:` and between importers.
const LOCK_FULL = [
  "lockfileVersion: '9.0'",
  "",
  "settings:",
  "  autoInstallPeers: true",
  "",
  "overrides:",
  "  dompurify: '>=3.4.16 <4'",
  "  '@scope/pkg': ^1.0.0",
  "  plain: 1.2.3",
  "",
  "importers:",
  "",
  "  .:",
  "    dependencies:",
  "      runtime-dep:",
  "        specifier: ^2.0.0",
  "        version: 2.0.1",
  "    devDependencies:",
  "      dev-dep:",
  "        specifier: '>=4.28.7 <5'",
  "        version: 4.28.7",
  "      '@scope/dev':",
  "        specifier: ~3.1.0",
  "        version: 3.1.4",
  "",
  "  apps/x:",
  "    devDependencies:",
  "      only-in-app:",
  "        specifier: ^9.0.0",
  "        version: 9.0.0",
  "      dev-dep:",
  "        specifier: ^7.0.0",
  "        version: 7.0.0",
  "",
  "packages:",
  "",
  "  dev-dep@4.28.7:",
  "    resolution: {integrity: sha512-x}",
  "",
].join("\n");

const LOCK_NO_OVERRIDES = [
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "",
  "  .:",
  "    devDependencies:",
  "      dev-dep:",
  "        specifier: ^1.0.0",
  "        version: 1.0.0",
  "",
].join("\n");

const LOCK_NO_IMPORTERS = [
  "lockfileVersion: '9.0'",
  "",
  "overrides:",
  "  plain: 1.2.3",
  "",
  "packages:",
  "",
].join("\n");

const LOCK_NO_ROOT_IMPORTER = [
  "lockfileVersion: '9.0'",
  "",
  "importers:",
  "",
  "  apps/x:",
  "    devDependencies:",
  "      dev-dep:",
  "        specifier: ^7.0.0",
  "        version: 7.0.0",
  "",
].join("\n");

const LOCK_KEYS = [
  "lockfileVersion: '9.0'",
  "",
  "snapshots:",
  "",
  "  'foo@1.2.3(bar@4.5.6(baz@7.8.9))':",
  "    dependencies:",
  "      bar: 4.5.6(baz@7.8.9)",
  "",
  "  foo@1.2.3:",
  "    dependencies: {}",
  "",
  "  foobar@9.9.9:",
  "    dependencies: {}",
  "",
  "  'qux@2.0.0(bar@4.5.7)':",
  "    dependencies: {}",
  "",
].join("\n");

describe("shared semver-lockfile helper pins", () => {
  describe("P1 parseVersionPrefix vs parseVersion", () => {
    it("should read the leading triple of a prerelease with parseVersionPrefix only", () => {
      expect(parseVersionPrefix("0.35.4-rc.1")).toEqual(v(0, 35, 4));
      expect(parseVersion("0.35.4-rc.1")).toBeNull();
    });

    it("should read a plain triple identically with both parsers", () => {
      expect(parseVersion("4.1.11")).toEqual(v(4, 1, 11));
      expect(parseVersionPrefix("4.1.11")).toEqual(v(4, 1, 11));
    });
  });

  describe("P2 caret with major > 0 (^3.4.16)", () => {
    it("should admit the floor and the top of the major", () => {
      expect(admits("^3.4.16", "3.4.16")).toBe(true);
      expect(admits("^3.4.16", "3.99.99")).toBe(true);
    });

    it("should not admit the next major", () => {
      expect(admits("^3.4.16", "4.0.0")).toBe(false);
    });

    it("should not admit the version just below the floor", () => {
      expect(admits("^3.4.16", "3.4.15")).toBe(false);
    });
  });

  describe("P3 caret ^0.x (^0.35.3)", () => {
    it("should bound the range to the same minor", () => {
      expect(admits("^0.35.3", "0.35.99")).toBe(true);
      expect(admits("^0.35.3", "0.36.0")).toBe(false);
      expect(admits("^0.35.3", "0.35.2")).toBe(false);
    });
  });

  describe("P4 caret ^0.0.z (^0.0.3)", () => {
    it("should admit only the same patch", () => {
      expect(admits("^0.0.3", "0.0.3")).toBe(true);
      expect(admits("^0.0.3", "0.0.4")).toBe(false);
    });
  });

  describe("P5 tilde (~1.2.3)", () => {
    it("should bound the range to the same minor", () => {
      expect(admits("~1.2.3", "1.2.99")).toBe(true);
      expect(admits("~1.2.3", "1.3.0")).toBe(false);
    });
  });

  describe("P6 exact (1.2.3 and =1.2.3)", () => {
    it.each(["1.2.3", "=1.2.3"])("should admit only 1.2.3 for %s", (range) => {
      expect(admits(range, "1.2.3")).toBe(true);
      expect(admits(range, "1.2.4")).toBe(false);
      expect(admits(range, "1.2.2")).toBe(false);
    });
  });

  describe("P7 >= (>=4.28.7)", () => {
    it("should have no ceiling and admit any later major", () => {
      expect(parseRange(">=4.28.7")).toEqual({ floor: v(4, 28, 7), ceiling: null });
      expect(admits(">=4.28.7", "999.0.0")).toBe(true);
      expect(admits(">=4.28.7", "4.28.6")).toBe(false);
    });
  });

  describe("P8 unsupported forms fail closed", () => {
    const UNSUPPORTED = [
      "^4.0.0 || ^5.0.0",
      "*",
      "latest",
      "npm:dompurify@^3.4.16",
      ">3.4.16",
      "3.4.x",
      "3.4.16 - 3.5.0",
      "^3.4.16-rc.1",
    ];

    it.each(UNSUPPORTED)("should return null from parseSimpleRange for %s", (range) => {
      expect(parseSimpleRange(range)).toBeNull();
    });

    it.each(UNSUPPORTED)("should return null from parseRange for %s", (range) => {
      expect(parseRange(range)).toBeNull();
    });
  });

  describe("P9 readLockDefinition overrides branch", () => {
    it("should unquote a quoted value", () => {
      expect(readLockDefinition(LOCK_FULL, { name: "dompurify", source: "overrides" })).toBe(
        ">=3.4.16 <4"
      );
    });

    it("should read a quoted scoped key", () => {
      expect(readLockDefinition(LOCK_FULL, { name: "@scope/pkg", source: "overrides" })).toBe(
        "^1.0.0"
      );
    });

    it("should read an unquoted key and value", () => {
      expect(readLockDefinition(LOCK_FULL, { name: "plain", source: "overrides" })).toBe("1.2.3");
    });

    it("should return undefined when the overrides section is missing", () => {
      expect(
        readLockDefinition(LOCK_NO_OVERRIDES, { name: "dev-dep", source: "overrides" })
      ).toBeUndefined();
    });

    it("should return undefined when the key is missing or only a prefix matches", () => {
      expect(
        readLockDefinition(LOCK_FULL, { name: "absent", source: "overrides" })
      ).toBeUndefined();
      expect(readLockDefinition(LOCK_FULL, { name: "dom", source: "overrides" })).toBeUndefined();
    });
  });

  describe("P10 readLockDefinition root importer branch", () => {
    it("should read the root devDependencies specifier and unquote it", () => {
      expect(readLockDefinition(LOCK_FULL, { name: "dev-dep", source: "devDependencies" })).toBe(
        ">=4.28.7 <5"
      );
    });

    it("should read a quoted scoped key in the root importer", () => {
      expect(readLockDefinition(LOCK_FULL, { name: "@scope/dev", source: "devDependencies" })).toBe(
        "~3.1.0"
      );
    });

    it("should read the root dependencies specifier the same way", () => {
      expect(
        readLockDefinition(LOCK_FULL, { name: "runtime-dep", source: "devDependencies" })
      ).toBe("^2.0.0");
    });

    it("should not read a key that only a non-root importer declares", () => {
      expect(
        readLockDefinition(LOCK_FULL, { name: "only-in-app", source: "devDependencies" })
      ).toBeUndefined();
    });

    it("should return undefined when the importers section is missing", () => {
      expect(
        readLockDefinition(LOCK_NO_IMPORTERS, { name: "plain", source: "devDependencies" })
      ).toBeUndefined();
    });

    it("should return undefined when the root importer is missing", () => {
      expect(
        readLockDefinition(LOCK_NO_ROOT_IMPORTER, { name: "dev-dep", source: "devDependencies" })
      ).toBeUndefined();
    });
  });

  describe("P11 collectLockVersions / collectPeerSuffixVersions", () => {
    it("should collect key-line versions and keep duplicates", () => {
      expect(collectLockVersions(LOCK_KEYS, "foo")).toEqual(["1.2.3", "1.2.3"]);
      expect(collectLockVersions(LOCK_KEYS, "foobar")).toEqual(["9.9.9"]);
    });

    it("should collect peer suffix versions including nested peers", () => {
      expect(collectPeerSuffixVersions(LOCK_KEYS, "bar")).toEqual(["4.5.6", "4.5.7"]);
      expect(collectPeerSuffixVersions(LOCK_KEYS, "baz")).toEqual(["7.8.9", "7.8.9"]);
    });
  });

  describe("P12 parseBoundedRange partial caps", () => {
    it("should expand a major-only cap", () => {
      expect(parseBoundedRange(">=4.28.7 <5")).toEqual({ floor: v(4, 28, 7), ceiling: v(5, 0, 0) });
    });

    it("should expand a major.minor cap", () => {
      expect(parseBoundedRange(">=0.16.3 <0.17")).toEqual({
        floor: v(0, 16, 3),
        ceiling: v(0, 17, 0),
      });
    });

    it("should return null when the floor is partial", () => {
      expect(parseBoundedRange(">=4 <5")).toBeNull();
    });
  });

  describe("G-PREFIX parseVersionPrefix importers", () => {
    it("should be imported only by the sharp precedent and this pin test", () => {
      const users = listParseVersionPrefixUsers(STANDING_DIR);
      expect(users).toEqual([
        "_shared/semver-lockfile.test.ts",
        "large-page/inv-sharp-declared-range-001.test.ts",
      ]);
    });
  });
});

/** standing dir 配下の `.ts` (shared module 自身を除く) で `parseVersionPrefix` を参照する file */
function listParseVersionPrefixUsers(root: string): string[] {
  const files = (readdirSync(root, { recursive: true }) as string[])
    .filter((p) => p.endsWith(".ts"))
    .map((p) => join(root, p))
    .filter((abs) => abs.replace(/\.ts$/, "") !== SHARED_MODULE_NO_EXT);
  return files
    .filter((abs) => usesParseVersionPrefix(abs))
    .map((abs) => relative(root, abs).split("\\").join("/"))
    .sort();
}

function resolvesToSharedModule(fromFile: string, specifier: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const target = resolve(dirname(fromFile), specifier).replace(/\.(js|ts)$/, "");
  return target === SHARED_MODULE_NO_EXT;
}

function usesParseVersionPrefix(file: string): boolean {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest);
  const namespaces = new Set<string>();
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      resolvesToSharedModule(file, node.moduleSpecifier.text)
    ) {
      const bindings = ts.isImportDeclaration(node)
        ? node.importClause?.namedBindings
        : node.exportClause;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      } else if (
        bindings !== undefined &&
        (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
      ) {
        for (const el of bindings.elements) {
          if ((el.propertyName ?? el.name).text === "parseVersionPrefix") found = true;
        }
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "parseVersionPrefix" &&
      ts.isIdentifier(node.expression) &&
      namespaces.has(node.expression.text)
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
