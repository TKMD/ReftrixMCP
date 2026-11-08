// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
/**
 * INV-SEC-GLOB-MINIMATCH-FLOOR-001
 *
 * lockfile に脆弱な glob / minimatch が 1 つも残っていないことを確かめる。
 * - GHSA-g3hv-75wg-m249 (minimatch): 影響 >=7 <11.0.1、修正 11.0.1
 * - GHSA-3g3m-2fjr-6pw4 (glob): 影響 >=9.0.0 <=14.0.1、修正 14.0.2
 * root `package.json` の `pnpm.overrides` がこの下限を守る（Dependabot #214 / #216）。
 *
 * Asserts the lockfile resolves no vulnerable glob / minimatch version. The root
 * `pnpm.overrides` enforce the floor; dropping or loosening them makes this test fail.
 *
 * @module tests/scripts/inv-sec-glob-minimatch-floor-001
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../../../..");
const LOCK = process.env["LOCKFILE_UNDER_TEST"] ?? join(ROOT, "pnpm-lock.yaml");

type Version = [number, number, number];

const parse = (v: string): Version => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`unparsable version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

const cmp = (a: Version, b: Version): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** `packages:` section keys such as `  minimatch@11.0.3:` (no peer suffix for these names). */
const resolvedVersions = (lock: string, name: string): string[] => {
  const re = new RegExp(`^  '?${name.replace(/[/@]/g, "\\$&")}@(\\d+\\.\\d+\\.\\d+[^:'(]*)`, "gm");
  return [...new Set([...lock.matchAll(re)].map((m) => m[1] as string))];
};

describe("INV-SEC-GLOB-MINIMATCH-FLOOR-001", () => {
  const lock = readFileSync(LOCK, "utf8");

  it("resolves no minimatch in the affected range >=7 <11.0.1", () => {
    const versions = resolvedVersions(lock, "minimatch");
    expect(versions.length).toBeGreaterThan(0);
    const vulnerable = versions.filter(
      (v) => cmp(parse(v), [7, 0, 0]) >= 0 && cmp(parse(v), [11, 0, 1]) < 0
    );
    expect(vulnerable).toEqual([]);
  });

  it("resolves no glob in the affected range >=9.0.0 <=14.0.1", () => {
    const versions = resolvedVersions(lock, "glob");
    expect(versions.length).toBeGreaterThan(0);
    const vulnerable = versions.filter(
      (v) => cmp(parse(v), [9, 0, 0]) >= 0 && cmp(parse(v), [14, 0, 1]) <= 0
    );
    expect(vulnerable).toEqual([]);
  });

  it("keeps the root overrides that enforce the floor", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      pnpm?: { overrides?: Record<string, string> };
    };
    const overrides = pkg.pnpm?.overrides ?? {};
    const floor = (name: string): Version => {
      const spec = overrides[name];
      expect(spec, `pnpm.overrides["${name}"]`).toBeTypeOf("string");
      const m = /(\d+\.\d+\.\d+)/.exec(spec as string);
      expect(m).not.toBeNull();
      return parse((m as RegExpExecArray)[1] as string);
    };
    expect(cmp(floor("minimatch"), [11, 0, 1])).toBeGreaterThanOrEqual(0);
    expect(cmp(floor("glob"), [14, 0, 2])).toBeGreaterThanOrEqual(0);
  });
});
