// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-REGSYNC-WAIT-005 (PR-1a rows) — scripts/ci/wait-for-npm-version.sh
 *
 * Rows: 1800 s constant, version-document primary probe, not-yet handling (5xx / timeout /
 * body mismatch), backoff, deadline, `time[version]` log, 403-republish (classified, then
 * the version document answers 200), 403-other, classifier disabled without a fixture,
 * gate order (success only after a 200 probe; classification before the first probe).
 * All registry traffic goes through the PATH shims in helpers/npm-shim-harness.ts.
 *
 * Rows that belong to PR-1b (Tier order in publish.yml, provenance) are not here.
 *
 * @module tests/scripts/wait-for-npm-version.test
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLOCK_START, createHarness, type Harness } from "./helpers/npm-shim-harness";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(REPO_ROOT, "scripts/ci/wait-for-npm-version.sh");
const PKG = "@example/pkg";
const VER = "0.6.1";
const DOC_URL = "https://registry.npmjs.org/@example%2Fpkg/0.6.1";
// Test-made stand-ins; the shipped classifier has no fixture (see the "disabled" rows).
const FIXTURE_BOTH =
  "# test fixture\nE403\ncannot publish over the previously published versions\n";
const STDERR_REPUBLISH =
  "npm error code E403\nnpm error 403 Forbidden - You cannot publish over the previously published versions: 0.6.1.\n";
const STDERR_OTHER = "npm error code E403\nnpm error 403 Forbidden - Trusted Publisher mismatch\n";

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => {
  h.cleanup();
});

const docCalls = (): string[] => h.calls().filter((c) => c === `curl ${DOC_URL}`);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

describe("INV-REGSYNC-WAIT-005: constants and source", () => {
  const src = (): string => readFileSync(SCRIPT, "utf-8");
  it("names the 1800 s propagation constant", () => {
    expect(src()).toMatch(/^NPM_PROPAGATION_MAX_SECONDS=1800$/m);
  });
  it("probes the version document with a bounded, https-only curl (argv of that call)", () => {
    h.setVersionDoc([`200:${VER}`]);
    h.run(SCRIPT, [PKG, VER]);
    const docArgv = h.argv().filter((a) => a.endsWith(` ${DOC_URL}`));
    expect(docArgv).toHaveLength(1);
    expect(docArgv[0]).toContain("--max-time 20");
    expect(docArgv[0]).toContain("--proto =https");
  });
  it("bounds the log-only npm view (argv of that call)", () => {
    h.setVersionDoc([`200:${VER}`]);
    h.run(SCRIPT, [PKG, VER]);
    const view = h.calls().filter((c) => c.startsWith("npm view "));
    expect(view).toHaveLength(1);
    expect(view[0]).toContain("--fetch-timeout=20000");
    expect(view[0]).toContain("--fetch-retries=0");
  });
  it("uses no absolute-path or alternative network tool in scripts/ci/*.sh", () => {
    const dir = join(REPO_ROOT, "scripts/ci");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sh"));
    expect(files).toContain("wait-for-npm-version.sh");
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf-8");
      expect(text, f).not.toMatch(
        /\/usr\/bin\/curl|\/bin\/curl|command -p|\bwget\b|\/dev\/tcp|\bnc /
      );
    }
  });
});

describe("INV-REGSYNC-WAIT-005: 404 -> 200", () => {
  it("returns 0 after 404, 404, 200 and sleeps 5 then 10 seconds", () => {
    h.setVersionDoc(["404", "404", `200:${VER}`]);
    const r = h.run(SCRIPT, [PKG, VER]);
    expect(r.status).toBe(0);
    expect(docCalls()).toHaveLength(3);
    expect(h.sleeps()).toEqual([5, 10]);
  });
  it("treats 5xx, curl timeout and a version mismatch as not yet", () => {
    h.setVersionDoc(["503", "timeout", "200:0.0.1", `200:${VER}`]);
    const r = h.run(SCRIPT, [PKG, VER]);
    expect(r.status).toBe(0);
    expect(docCalls()).toHaveLength(4);
    expect(h.sleeps()).toEqual([5, 10, 20]);
  });
  it("doubles the backoff and caps it at 30 seconds", () => {
    h.setVersionDoc(["404", "404", "404", "404", "404", "404", `200:${VER}`]);
    h.run(SCRIPT, [PKG, VER]);
    expect(h.sleeps()).toEqual([5, 10, 20, 30, 30, 30]);
  });
  it("logs attempt number, elapsed seconds and HTTP status", () => {
    h.setVersionDoc(["404", `200:${VER}`]);
    const r = h.run(SCRIPT, [PKG, VER]);
    expect(r.stdout).toMatch(/attempt=1 elapsed=0s probe=version-doc status=404/);
    expect(r.stdout).toMatch(/attempt=2 elapsed=5s probe=version-doc status=200/);
  });
  it("labels the primary probe and logs the npm view result", () => {
    h.setVersionDoc([`200:${VER}`]);
    h.setNpmViewOutput(`${VER}\n`);
    const r = h.run(SCRIPT, [PKG, VER]);
    expect(r.stdout).toContain("probe=version-doc");
    expect(r.stdout).toContain(`npm-view=${VER}`);
  });
});

describe("INV-REGSYNC-WAIT-005: success criterion", () => {
  it("exits 0 only after the last probe answered 200", () => {
    h.setVersionDoc(["404", "404", `200:${VER}`]);
    const r = h.run(SCRIPT, [PKG, VER]);
    const probes = r.stdout.split("\n").filter((l) => l.includes("status="));
    expect(r.status).toBe(0);
    expect(probes.at(-1)).toContain("status=200");
    expect(probes.slice(0, -1).every((l) => !l.includes("status=200"))).toBe(true);
  });
  it("never reports success while the version document stays 404", () => {
    h.setVersionDoc(["404"]);
    h.setNpmViewOutput(`${VER}\n`);
    h.setPackumentTime(VER, "2026-10-21T00:00:00.000Z");
    const r = h.run(SCRIPT, [PKG, VER]);
    expect(r.status).toBe(1);
  });
});

describe("INV-REGSYNC-WAIT-005: deadline", () => {
  it("fails after the 1800 s default and reports the last status", () => {
    h.setVersionDoc(["404"]);
    const r = h.run(SCRIPT, [PKG, VER]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/last status=404/);
    expect(h.clock() - CLOCK_START).toBeGreaterThanOrEqual(1800);
    expect(h.clock() - CLOCK_START).toBeLessThan(1800 + 30);
  });
  it("logs time[version] in the last attempt block of a timed-out run", () => {
    h.setVersionDoc(["404"]);
    h.setPackumentTime(VER, "2026-10-21T00:00:00.000Z");
    const r = h.run(SCRIPT, [PKG, VER]);
    const lines = r.stdout.split("\n");
    const last = lines
      .map((l, i) => (l.includes("attempt=") ? i : -1))
      .filter((i) => i >= 0)
      .at(-1) as number;
    expect(lines[last + 1]).toContain(`time[${VER}]=2026-10-21T00:00:00.000Z`);
  });
  it("rejects a deadline_epoch beyond now + 1800 s or longer than 12 digits", () => {
    h.setVersionDoc([`200:${VER}`]);
    expect(h.run(SCRIPT, [PKG, VER, String(CLOCK_START + 1801)]).status).toBe(2);
    expect(h.run(SCRIPT, [PKG, VER, "1234567890123"]).status).toBe(2);
    // 20 digits: rejected with rc 2 (the 12-digit cap and the shell numeric comparison both refuse it;
    // no test can tell the two apart, so the cap removal is an equivalent mutant)
    expect(h.run(SCRIPT, [PKG, VER, "18446744073709551615"]).status).toBe(2);
    expect(h.calls()).toEqual([]);
    expect(h.run(SCRIPT, [PKG, VER, String(CLOCK_START + 1800)]).status).toBe(0);
  });
  it("honours an explicit deadline_epoch", () => {
    h.setVersionDoc(["503"]);
    const r = h.run(SCRIPT, [PKG, VER, String(CLOCK_START + 40)]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/last status=503/);
    expect(h.clock() - CLOCK_START).toBeLessThan(70);
  });
});

describe("INV-REGSYNC-WAIT-005: secondary probes are log only", () => {
  it("logs time[version] from the packument", () => {
    h.setVersionDoc(["404", `200:${VER}`]);
    h.setPackumentTime(VER, "2026-10-21T01:02:03.000Z");
    const r = h.run(SCRIPT, [PKG, VER]);
    expect(r.stdout).toContain(`time[${VER}]=2026-10-21T01:02:03.000Z`);
  });
  it("prints unparsable for a packument time or npm view line that is not well formed", () => {
    h.setVersionDoc([`200:${VER}`]);
    h.setPackumentTime(VER, "2026-10-21\n::warning::injected");
    h.setNpmViewOutput("::error::injected\n");
    const r = h.run(SCRIPT, [PKG, VER]);
    expect(r.stdout).toContain(`time[${VER}]=unparsable`);
    expect(r.stdout).toContain("npm-view=unparsable");
    expect(r.stdout.split("\n").some((l) => l.startsWith("::"))).toBe(false);
  });
  it("logs time[version] as unknown when the packument has none", () => {
    h.setVersionDoc([`200:${VER}`]);
    const r = h.run(SCRIPT, [PKG, VER]);
    expect(r.stdout).toContain(`time[${VER}]=unknown`);
  });
});

describe("INV-REGSYNC-WAIT-005: 403 rows", () => {
  it("403-republish: classified, deadline restarts, then version doc 200 -> 0", () => {
    h.setVersionDoc(["404", "404", `200:${VER}`]);
    const stderr = h.writeFile("publish.stderr", STDERR_REPUBLISH);
    const fixture = h.writeFile("fixture.txt", FIXTURE_BOTH);
    // an already-expired deadline: only the classification time + 1800 s can save the run
    const r = h.run(SCRIPT, [PKG, VER, String(CLOCK_START - 100)], {
      NPM_PUBLISH_STDERR_FILE: stderr,
      NPM_403_FIXTURE: fixture,
    });
    expect(r.status).toBe(0);
    const lines = r.stdout.split("\n");
    const classified = lines.findIndex((l) => l.includes("403 classified as republish"));
    const firstProbe = lines.findIndex((l) => l.includes("attempt=1"));
    expect(classified).toBeGreaterThanOrEqual(0);
    expect(classified).toBeLessThan(firstProbe);
    expect(r.stdout).toContain(`deadline=${CLOCK_START + 1800}`);
  });
  it("403-republish: still fails once classification time + 1800 s passes", () => {
    h.setVersionDoc(["404"]);
    const r = h.run(SCRIPT, [PKG, VER, String(CLOCK_START - 100)], {
      NPM_PUBLISH_STDERR_FILE: h.writeFile("publish.stderr", STDERR_REPUBLISH),
      NPM_403_FIXTURE: h.writeFile("fixture.txt", FIXTURE_BOTH),
    });
    expect(r.status).toBe(1);
    expect(h.clock() - CLOCK_START).toBeGreaterThanOrEqual(1800);
    expect(sum(h.sleeps())).toBeGreaterThanOrEqual(1800 - 30);
  });
  it("403-other: fails at once without probing", () => {
    h.setVersionDoc([`200:${VER}`]);
    const r = h.run(SCRIPT, [PKG, VER], {
      NPM_PUBLISH_STDERR_FILE: h.writeFile("publish.stderr", STDERR_OTHER),
      NPM_403_FIXTURE: h.writeFile("fixture.txt", FIXTURE_BOTH),
    });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/not a republish/);
    expect(h.calls()).toEqual([]);
  });
  it("classifier disabled without a fixture: the republish text still fails", () => {
    h.setVersionDoc([`200:${VER}`]);
    const r = h.run(SCRIPT, [PKG, VER], {
      NPM_PUBLISH_STDERR_FILE: h.writeFile("publish.stderr", STDERR_REPUBLISH),
      NPM_403_FIXTURE: join(h.dir, "does-not-exist.txt"),
    });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/classifier disabled/);
    expect(h.calls()).toEqual([]);
  });
  it("classifier disabled when the fixture lacks one of the two strings", () => {
    for (const body of ["E403\n", "previously published versions\n", "# header only\n"]) {
      const r = h.run(SCRIPT, [PKG, VER], {
        NPM_PUBLISH_STDERR_FILE: h.writeFile("publish.stderr", STDERR_REPUBLISH),
        NPM_403_FIXTURE: h.writeFile("fixture.txt", body),
      });
      expect(r.status).toBe(2);
    }
  });
  it("ships without a fixture, so the default classifier is disabled", () => {
    h.setVersionDoc([`200:${VER}`]);
    const r = h.run(SCRIPT, [PKG, VER], {
      NPM_PUBLISH_STDERR_FILE: h.writeFile("publish.stderr", STDERR_REPUBLISH),
    });
    expect(r.status).toBe(2);
  });
  it("a refusal without E403 fails closed with no probe", () => {
    h.setVersionDoc([`200:${VER}`]);
    for (const body of [
      "npm error code E500\n",
      "npm error code ENEEDAUTH\n",
      "npm error 403 Forbidden - You cannot publish over the previously published versions\n",
      "previously published versions\n",
    ]) {
      const r = h.run(SCRIPT, [PKG, VER], {
        NPM_PUBLISH_STDERR_FILE: h.writeFile("publish.stderr", body),
        NPM_403_FIXTURE: h.writeFile("fixture.txt", FIXTURE_BOTH),
      });
      expect(r.status, body).toBe(2);
    }
    expect(h.calls()).toEqual([]);
  });
  it("a stderr path that is missing, a directory or unreadable fails closed with no probe", () => {
    h.setVersionDoc([`200:${VER}`]);
    // content is a non-republish refusal, so exit 2 holds for root and non-root alike
    const unreadable = h.writeFile("unreadable.stderr", STDERR_OTHER);
    chmodSync(unreadable, 0o000);
    const dir = join(h.dir, "a-directory");
    mkdirSync(dir);
    const isRoot = process.getuid?.() === 0;
    const cases: Array<[string, boolean]> = [
      [join(h.dir, "missing.stderr"), true],
      [dir, true],
      [unreadable, !isRoot],
    ];
    for (const [path, expectMessage] of cases) {
      const r = h.run(SCRIPT, [PKG, VER], {
        NPM_PUBLISH_STDERR_FILE: path,
        NPM_403_FIXTURE: h.writeFile("fixture.txt", FIXTURE_BOTH),
      });
      expect(r.status, path).toBe(2);
      expect(r.stderr).toContain("::error::");
      // the message check cannot hold for an unreadable file when root can read it
      if (expectMessage) expect(r.stderr, path).toContain("not a readable regular file");
    }
    expect(h.calls()).toEqual([]);
  });
  it("without a fixture a non-403 refusal is not reported as a disabled classifier", () => {
    h.setVersionDoc([`200:${VER}`]);
    const r = h.run(SCRIPT, [PKG, VER], {
      NPM_PUBLISH_STDERR_FILE: h.writeFile("publish.stderr", "npm error code ENEEDAUTH\n"),
      NPM_403_FIXTURE: join(h.dir, "does-not-exist.txt"),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not a republish");
    expect(r.stderr).not.toContain("classifier disabled");
    expect(h.calls()).toEqual([]);
  });
  it("an empty NPM_PUBLISH_STDERR_FILE is treated as not given", () => {
    h.setVersionDoc([`200:${VER}`]);
    expect(h.run(SCRIPT, [PKG, VER], { NPM_PUBLISH_STDERR_FILE: "" }).status).toBe(0);
  });
});

describe("INV-REGSYNC-WAIT-005: input checks and isolation", () => {
  it("rejects a malformed package name or version without any call", () => {
    for (const args of [
      ["core", VER],
      ["@example/pkg; id", VER],
      [PKG, "latest"],
      [PKG, VER, "soon"],
      [PKG, VER, "-5"],
      [PKG, VER, " 5"],
      [PKG, VER, ""],
      [],
    ]) {
      const r = h.run(SCRIPT, args);
      expect(r.status).toBe(2);
    }
    expect(h.calls()).toEqual([]);
  });
  it("fails with exit 2 when a required tool is missing", () => {
    const empty = join(h.dir, "empty-path");
    mkdirSync(empty);
    const r = spawnSync("/bin/bash", [SCRIPT, PKG, VER], {
      encoding: "utf-8",
      env: { PATH: empty },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/required tool.*curl/);
  });
  it("talks only to registry.npmjs.org (shim records no unexpected URL)", () => {
    h.setVersionDoc(["404", `200:${VER}`]);
    h.run(SCRIPT, [PKG, VER]);
    const urls = h.calls().filter((c) => c.startsWith("curl "));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((c) => c.startsWith("curl https://registry.npmjs.org/"))).toBe(true);
    expect(h.calls().some((c) => c.includes("UNEXPECTED"))).toBe(false);
  });
});
