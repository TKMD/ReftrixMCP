// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-REGSYNC-WAIT-005 (PR-1b rows) — publish.yml Tier-boundary gates
 *
 * The `publish` job's publish step is extracted from the workflow and run under bash with
 * the PATH shims (npm publish, npm view, curl, sleep, date), so what is asserted is what
 * the workflow really does: no fixed-count sleep loop, Tier-N publish only after the
 * Tier-(N-1) gate, per-package deadline = publish time + 1800 s, `npm_published` only after
 * the Tier-3 gate, publish stderr passed to the wait script only on a failed publish (with
 * workflow commands neutralized), provenance for skipped and failed-then-classified
 * packages, and a job timeout that covers three gates.
 *
 * @module tests/scripts/publish-tier-gates.test
 */
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { load } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLOCK_START,
  GOOD_COMMIT,
  GOOD_SHA512,
  attestationBody,
  createHarness,
  versionDocBody,
  type Harness,
} from "./helpers/npm-shim-harness";

const REPO_ROOT = resolve(__dirname, "../../../..");
const VER = "0.6.1";
// the Tier sets come from the SSOT file, so a package added there is covered here
const tierDirs = (n: 1 | 2 | 3): string[] =>
  spawnSync(
    "bash",
    [
      "-c",
      `source "${join(REPO_ROOT, "scripts/publish-targets.sh")}"; printf '%s\\n' "\${PUBLISH_TIER${n}[@]}"`,
    ],
    { encoding: "utf-8" }
  )
    .stdout.split("\n")
    .filter(Boolean);
const TIERS = ([1, 2, 3] as const).map((n) =>
  tierDirs(n).map((dir): [string, string] => [dir, `@example/${basename(dir)}`])
);
const ALL = TIERS.flat();
const docUrl = (name: string): string =>
  `https://registry.npmjs.org/${name.replace("/", "%2F")}/${VER}`;
const attUrl = (name: string): string =>
  `https://registry.npmjs.org/-/npm/v1/attestations/${name.replace("/", "%2f")}@${VER}`;
const REPUBLISH =
  "npm error code E403\nnpm error 403 Forbidden - You cannot publish over the previously published versions: 0.6.1.\n::error::pwned\n##[error]pwned2\n";

interface Step {
  id?: string;
  shell?: string;
  run?: string;
}
const workflow = load(readFileSync(join(REPO_ROOT, ".github/workflows/publish.yml"), "utf-8")) as {
  jobs: Record<
    string,
    { "timeout-minutes"?: number; outputs?: Record<string, string>; steps: Step[] }
  >;
};
const tierStepObj = (): Step =>
  workflow.jobs.publish.steps.find((s) => s.run?.includes("PUBLISH_TIER1")) as Step;
const tierStep = (): string => tierStepObj().run as string;

let h: Harness;
let ws: string;
beforeEach(() => {
  h = createHarness();
  ws = join(h.dir, "ws");
  mkdirSync(join(ws, "scripts"), { recursive: true });
  copyFileSync(
    join(REPO_ROOT, "scripts/publish-targets.sh"),
    join(ws, "scripts/publish-targets.sh")
  );
  cpSync(join(REPO_ROOT, "scripts/ci"), join(ws, "scripts/ci"), { recursive: true });
  mkdirSync(join(ws, "tarballs"));
  for (const [dir, name] of ALL) {
    mkdirSync(join(ws, dir), { recursive: true });
    writeFileSync(join(ws, dir, "package.json"), JSON.stringify({ name, version: VER }));
    writeFileSync(
      join(ws, "tarballs", `${name.replace("@", "").replace("/", "-")}-${VER}.tgz`),
      name
    );
    h.setSequence(docUrl(name), [`200:${VER}`]);
  }
  spawnSync("sh", ["-c", "sha256sum ./*.tgz > checksums.txt"], { cwd: join(ws, "tarballs") });
});
afterEach(() => {
  h.cleanup();
});

function runTiers(env: Record<string, string> = {}): ReturnType<Harness["run"]> & { out: string } {
  const script = join(h.dir, "step.sh");
  writeFileSync(script, `set -e\n${tierStep().replaceAll("/tmp/tarballs", join(ws, "tarballs"))}`);
  const outFile = join(h.dir, "github-output");
  writeFileSync(outFile, "");
  const r = h.run(
    script,
    [],
    {
      PATH: `${h.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      RELEASE_VERSION: VER,
      RELEASE_DIST_TAG: "latest",
      TAG_COMMIT_SHA: GOOD_COMMIT,
      GITHUB_OUTPUT: outFile,
      ...env,
    },
    ws
  );
  return { ...r, out: readFileSync(outFile, "utf-8") };
}

const at = (needle: string, from = 0): number =>
  h.calls().findIndex((c, i) => i >= from && c.includes(needle));
const lastAt = (needle: string): number =>
  h
    .calls()
    .map((c) => c.includes(needle))
    .lastIndexOf(true);
const safe = (name: string): string => name.replace("@", "").replace("/", "-");
const published = (name: string): number =>
  h
    .calls()
    .findIndex((c) => c.startsWith("npm publish ") && c.includes(`${safe(name)}-${VER}.tgz`));

describe("INV-REGSYNC-WAIT-005: publish.yml structure", () => {
  it("has no fixed-count sleep loop and waits through the wait script", () => {
    const runs = Object.values(workflow.jobs).flatMap((j) => j.steps.map((s) => s.run ?? ""));
    for (const run of runs) {
      expect(run).not.toMatch(/until npm view|ATTEMPT.*-ge 24|sleep 5/);
    }
    expect(tierStep()).toContain("scripts/ci/wait-for-npm-version.sh");
  });
  it("never swallows a failed publish with || true", () => {
    expect(tierStep()).toMatch(/npm publish .*2>"\$err" \|\| rc=\$\?/);
    expect(tierStep()).not.toMatch(/npm publish[^\n]*\|\| true/);
  });
  it("sets a job timeout that covers three 1800 s gates plus margin", () => {
    expect(workflow.jobs.publish["timeout-minutes"]).toBeGreaterThanOrEqual((3 * 1800 + 900) / 60);
  });
  it("exposes npm_published as a job output of the Tier step (id: tiers)", () => {
    expect(workflow.jobs.publish.outputs?.npm_published).toBe(
      "${{ steps.tiers.outputs.npm_published }}"
    );
    expect(tierStepObj().id).toBe("tiers");
  });
  it("uses the runner default shell (bash -e), which runTiers reproduces with set -e", () => {
    expect(tierStepObj()).not.toHaveProperty("shell");
  });
});

describe("INV-REGSYNC-WAIT-005: Tier order", () => {
  it("publishes Tier-N only after the Tier-(N-1) gate and sets npm_published last", () => {
    for (const [, name] of TIERS[0]) h.setSequence(docUrl(name), ["404", "404", `200:${VER}`]);
    h.setSequence(docUrl(TIERS[1][0][1]), ["404", `200:${VER}`]);
    const r = runTiers();
    expect(r.status, r.stderr).toBe(0);
    for (const [, name] of TIERS[0]) expect(published(name)).toBeGreaterThanOrEqual(0);
    const tier1Last = Math.max(...TIERS[0].map(([, n]) => published(n)));
    const tier1FirstGate = at(`curl ${docUrl(TIERS[0][0][1])}`);
    expect(tier1Last).toBeLessThan(tier1FirstGate);
    const tier2Pub = published(TIERS[1][0][1]);
    expect(tier2Pub).toBeGreaterThan(lastAt(`curl ${docUrl(TIERS[0][2][1])}`));
    const tier3Pub = published(TIERS[2][0][1]);
    expect(tier3Pub).toBeGreaterThan(lastAt(`curl ${docUrl(TIERS[1][0][1])}`));
    expect(r.out).toContain("npm_published=true");
  });
  it("stops before Tier 2 when a Tier-1 gate fails, with no npm_published", () => {
    h.setSequence(docUrl(TIERS[0][1][1]), ["404"]);
    const r = runTiers();
    expect(r.status).not.toBe(0);
    expect(r.stderr, "the Tier-1 gate of the database package failed").toContain(
      `${TIERS[0][1][1]}@${VER}: not visible at the deadline`
    );
    expect(published(TIERS[1][0][1])).toBe(-1);
    expect(r.out).not.toContain("npm_published");
  });
  it("does not set npm_published when only the Tier-3 gate fails", () => {
    h.setSequence(docUrl(TIERS[2][0][1]), ["404"]);
    const r = runTiers();
    expect(r.status).not.toBe(0);
    expect(published(TIERS[2][0][1])).toBeGreaterThanOrEqual(0);
    expect(r.out).not.toContain("npm_published");
  });
  it("gives each package publish time + 1800 s, not 1800 s per wait", () => {
    // the first package turns up at ~1700 s, the second never does: the second wait has
    // little time left and the run ends near 1800 s, not near 3600 s
    h.setSequence(docUrl(TIERS[0][0][1]), [...Array(58).fill("404"), `200:${VER}`]);
    h.setSequence(docUrl(TIERS[0][1][1]), ["404"]);
    const r = runTiers();
    expect(r.status).toBe(1);
    expect(h.clock() - CLOCK_START).toBeGreaterThan(1700);
    expect(h.clock() - CLOCK_START).toBeLessThan(1800 + 60);
  });
});

describe("INV-REGSYNC-WAIT-005: deadline base", () => {
  it("starts a package's 1800 s after its publish call returned, not before", () => {
    // the last Tier-1 package takes 600 s to publish and never shows up: the gate ends near
    // publish completion + 1800 s (START + 2400), not near START + 1800
    const slow = TIERS[0][2][1];
    h.setPublishRules([{ match: safe(slow), rc: 0, advance: 600 }]);
    h.setSequence(docUrl(slow), ["404"]);
    const r = runTiers();
    expect(r.status).toBe(1);
    expect(h.clock() - CLOCK_START).toBeGreaterThanOrEqual(600 + 1800);
    expect(h.clock() - CLOCK_START).toBeLessThan(600 + 1800 + 60);
  });
});

describe("INV-REGSYNC-WAIT-005: publish stderr and provenance", () => {
  it("passes no stderr file for a clean publish, and prints none of its stderr", () => {
    // a clean publish that wrote to stderr: had the file been handed to the wait script, the
    // script would exit 2 (fail closed); nothing of it reaches the job log either
    h.setPublishRules([
      { match: "example-database", rc: 0, stderr: "npm notice leak-marker\n::error::leak\n" },
    ]);
    const r = runTiers();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).not.toContain("leak-marker");
    expect(r.out).toContain("npm_published=true");
  });
  it("passes no stderr file for a clean publish and fails closed on a failed one", () => {
    h.setPublishRules([{ match: "example-database", rc: 1, stderr: "npm error code ENEEDAUTH\n" }]);
    const r = runTiers();
    expect(r.status).toBe(2);
    expect(published(TIERS[1][0][1])).toBe(-1);
    expect(r.stderr).toContain("not a republish");
  });
  it("neutralizes workflow commands in the printed publish stderr", () => {
    h.setPublishRules([{ match: "example-database", rc: 1, stderr: REPUBLISH }]);
    const r = runTiers();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("pwned");
    expect(r.stderr).not.toMatch(/::error::pwned/);
    expect(r.stderr).not.toMatch(/^##\[/m);
    expect(r.stderr).toContain("# #[error]pwned2");
  });
  it("classified republish: waits, then checks provenance before the next Tier", () => {
    h.setPublishRules([{ match: "example-database", rc: 1, stderr: REPUBLISH }]);
    const name = TIERS[0][1][1];
    h.setBody("doc", versionDocBody(VER, GOOD_SHA512));
    h.setBody("att", attestationBody({ sha512Hex: GOOD_SHA512 }));
    h.setSequence(docUrl(name), ["404", "200@doc"]);
    h.setSequence(attUrl(name), ["200@att"]);
    const fixture = h.writeFile(
      "fixture.txt",
      "# test fixture\nE403\npreviously published versions\n"
    );
    const r = runTiers({ NPM_403_FIXTURE: fixture });
    expect(r.status, r.stderr).toBe(0);
    const prov = at(`curl ${attUrl(name)}`);
    expect(prov).toBeGreaterThan(-1);
    expect(published(TIERS[1][0][1])).toBeGreaterThan(prov);
  });
  it("skips a published package and still checks its provenance", () => {
    const name = TIERS[0][0][1];
    h.setPublished([name]);
    h.setBody("doc", versionDocBody(VER, GOOD_SHA512));
    h.setBody("att", attestationBody({ sha512Hex: GOOD_SHA512 }));
    h.setSequence(docUrl(name), ["200@doc"]);
    h.setSequence(attUrl(name), ["200@att"]);
    const r = runTiers();
    expect(r.status, r.stderr).toBe(0);
    expect(published(name)).toBe(-1);
    expect(at(`curl ${attUrl(name)}`)).toBeGreaterThan(-1);
    expect(at(`curl ${attUrl(TIERS[0][1][1])}`)).toBe(-1);
  });
  it("fails the job when the provenance of a skipped package does not match", () => {
    const name = TIERS[0][0][1];
    h.setPublished([name]);
    h.setBody("doc", versionDocBody(VER, GOOD_SHA512));
    h.setBody("att", attestationBody({ sha512Hex: GOOD_SHA512, commit: "f".repeat(40) }));
    h.setSequence(docUrl(name), ["200@doc"]);
    h.setSequence(attUrl(name), ["200@att"]);
    const r = runTiers();
    expect(r.status).toBe(1);
    expect(r.stderr, "the provenance check failed, not a gate").toContain(
      `${name}@${VER}: provenance check failed`
    );
    expect(published(TIERS[1][0][1])).toBe(-1);
  });
});
