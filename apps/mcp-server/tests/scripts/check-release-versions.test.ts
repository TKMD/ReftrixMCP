// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-REGSYNC-VERSION-001 (script rows) — scripts/ci/check-release-versions.sh
 *
 * Root, the 5 packages of scripts/publish-targets.sh and both version fields of server.json
 * must equal the tag version. Each of the 8 locations is broken on its own and must be named
 * in the output; a hostile version string is never echoed.
 *
 * @module tests/scripts/check-release-versions.test
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(REPO_ROOT, "scripts/ci/check-release-versions.sh");
const PKG_DIRS = [
  "packages/core",
  "packages/database",
  "packages/ml",
  "packages/webdesign-core",
  "apps/mcp-server",
];
const TAG = "v1.2.3";

let dir: string;
const put = (rel: string, body: unknown): void => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), JSON.stringify(body));
};
const seed = (over: Record<string, string> = {}): void => {
  put("package.json", { version: over["package.json"] ?? "1.2.3" });
  for (const p of PKG_DIRS) put(`${p}/package.json`, { version: over[p] ?? "1.2.3" });
  put("server.json", {
    version: over["server.version"] ?? "1.2.3",
    packages: [{ version: over["server.package"] ?? "1.2.3" }],
  });
};
const run = (tag = TAG): { rc: number; out: string } => {
  const r = spawnSync("bash", [SCRIPT, dir, tag], { encoding: "utf-8" });
  return { rc: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rel-ver-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("INV-REGSYNC-VERSION-001: check-release-versions.sh", () => {
  it("exits 0 when all 8 versions equal the tag version", () => {
    seed();
    expect(run().rc).toBe(0);
  });

  it.each([
    ["package.json", "package.json"],
    ...PKG_DIRS.map((p): [string, string] => [p, p]),
    ["server.version", "server.json .version"],
    ["server.package", "server.json .packages[0].version"],
  ])("exits 1 and names the location when %s differs", (key, label) => {
    seed({ [key]: "1.2.4" });
    const r = run();
    expect(r.rc).toBe(1);
    expect(r.out).toContain(`${label}: 1.2.4 != tag 1.2.3`);
  });

  it("exits 1 when a package.json is missing", () => {
    seed();
    rmSync(join(dir, "packages/ml/package.json"));
    const r = run();
    expect(r.rc).toBe(1);
    expect(r.out).toContain("packages/ml: file missing");
  });

  it("exits 1 when server.json has no packages[0].version", () => {
    seed();
    put("server.json", { version: "1.2.3", packages: [] });
    expect(run().rc).toBe(1);
  });

  it("does not echo a version that is not semver", () => {
    seed({ "packages/core": "$(touch pwned)::error::x" });
    const r = run();
    expect(r.rc).toBe(1);
    expect(r.out).toContain("packages/core: version missing or not semver");
    expect(r.out).not.toContain("pwned");
  });

  it("exits 2 for a bad tag or a missing data dir", () => {
    seed();
    expect(run("1.2.3").rc).toBe(2);
    expect(spawnSync("bash", [SCRIPT, join(dir, "nope"), TAG]).status).toBe(2);
    expect(spawnSync("bash", [SCRIPT, dir]).status).toBe(2);
  });
});
