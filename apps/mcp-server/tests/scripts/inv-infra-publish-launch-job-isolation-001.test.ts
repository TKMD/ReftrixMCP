// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-INFRA-PUBLISH-LAUNCH-JOB-ISOLATION-001 (publish.yml structure) and scripts/ci/check-tarball-set.sh
 *
 * Installing the packed tarballs runs a lot of third-party code, so it must not share a job with the one
 * that builds the tarballs or the one that can publish: `verify-launch` has read-only permissions, no id-token,
 * no Environment, no secrets, no cache, uploads nothing, and is pinned to commit SHAs. `verify` hands the
 * checksums to later jobs through a job output; `verify-launch` and `publish` both require the artifact to be
 * exactly that set (no extra, no missing tarball, every sha256 equal).
 *
 * @module tests/scripts/inv-infra-publish-launch-job-isolation-001.test
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { load } from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  permissions?: Record<string, string>;
  environment?: unknown;
  outputs?: Record<string, string>;
  "timeout-minutes"?: number;
  steps: Step[];
}
const text = readFileSync(join(REPO_ROOT, ".github/workflows/publish.yml"), "utf-8");
const jobs = (load(text) as { jobs: Record<string, Job> }).jobs;
const needs = (j: Job): string[] => (Array.isArray(j.needs) ? j.needs : j.needs ? [j.needs] : []);
const SHA = /^[^@]+@[0-9a-f]{40}$/;

describe("INV-INFRA-PUBLISH-LAUNCH-JOB-ISOLATION-001: publish.yml", () => {
  const vl = jobs["verify-launch"];
  it("verify-launch exists, follows verify, and is bounded in time", () => {
    expect(vl).toBeDefined();
    expect(needs(vl)).toContain("verify");
    expect(vl["timeout-minutes"]).toBeGreaterThan(0);
    expect(jobs.verify["timeout-minutes"]).toBeGreaterThan(0);
  });
  it("verify-launch can only read: no id-token, no Environment, no secrets, no artifact upload", () => {
    expect(vl.permissions).toEqual({ contents: "read" });
    expect(vl.environment).toBeUndefined();
    const body = JSON.stringify(vl);
    expect(body).not.toMatch(/secrets\./);
    expect(body).not.toMatch(/id-token/);
    expect(vl.steps.some((s) => String(s.uses).startsWith("actions/upload-artifact"))).toBe(false);
  });
  it("verify-launch checks out without persisting credentials", () => {
    const co = vl.steps.find((s) => String(s.uses).startsWith("actions/checkout"));
    expect(co?.with?.["persist-credentials"]).toBe(false);
  });
  it("R2-a: neither verify-launch nor publish uses actions/cache or a setup-node cache", () => {
    for (const j of [vl, jobs.publish]) {
      for (const s of j.steps) {
        expect(String(s.uses)).not.toMatch(/actions\/cache/);
        expect(s.with?.cache).toBeUndefined();
      }
    }
  });
  it("R2-c: every action of verify-launch is pinned to a 40-hex commit SHA", () => {
    for (const s of vl.steps.filter((x) => x.uses))
      expect(String(s.uses), String(s.name)).toMatch(SHA);
  });
  it("the launch step runs check-packed-launch.sh and lives only in verify-launch", () => {
    const launch = vl.steps.find((s) => s.run?.includes("scripts/ci/check-packed-launch.sh"));
    expect(launch).toBeDefined();
    for (const [name, j] of Object.entries(jobs)) {
      if (name === "verify-launch") continue;
      expect(j.steps.some((s) => s.run?.includes("check-packed-launch"))).toBe(false);
    }
  });
  it("verify publishes the checksums as a job output and runs the tarball-mode runtime deps check", () => {
    expect(jobs.verify.outputs?.checksums).toMatch(/steps\.[\w-]+\.outputs\.checksums/);
    const pack = jobs.verify.steps.find((s) => s.id === "pack");
    expect(pack?.run).toMatch(
      /check-published-runtime-deps\.mjs --tarballs \/tmp\/tarballs --expect-count "\$\{#PUBLISH_PACKAGES\[@\]\}"/
    );
    expect(pack?.run).toMatch(/checksums<</);
  });
  it("R2-b: verify-launch and publish compare the artifact with needs.verify.outputs.checksums", () => {
    const vlCheck = vl.steps.find((s) => s.run?.includes("check-tarball-set.sh"));
    expect(vlCheck?.env?.CHECKSUMS).toBe("${{ needs.verify.outputs.checksums }}");
    const tiers = jobs.publish.steps.find((s) => s.id === "tiers");
    expect(tiers?.env?.CHECKSUMS).toBe("${{ needs.verify.outputs.checksums }}");
    const run = String(tiers?.run);
    expect(run.indexOf("check-tarball-set.sh")).toBeGreaterThanOrEqual(0);
    expect(run.indexOf("check-tarball-set.sh")).toBeLessThan(
      run.indexOf("sha256sum -c checksums.txt")
    );
  });
  it("publish needs both verify and verify-launch", () => {
    expect(needs(jobs.publish)).toEqual(expect.arrayContaining(["verify", "verify-launch"]));
  });
});

describe("scripts/ci/check-tarball-set.sh", () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const SCRIPT = join(REPO_ROOT, "scripts/ci/check-tarball-set.sh");
  function setup(): { dir: string; sums: string } {
    const dir = mkdtempSync(join(tmpdir(), "tarball-set-"));
    dirs.push(dir);
    for (const n of ["a", "b"]) writeFileSync(join(dir, `${n}.tgz`), `content-${n}`);
    const sums = spawnSync("sh", ["-c", "sha256sum ./*.tgz"], {
      cwd: dir,
      encoding: "utf-8",
    }).stdout;
    writeFileSync(join(dir, "checksums.txt"), sums);
    return { dir, sums };
  }
  const run = (dir: string, sums: string): number =>
    spawnSync("bash", [SCRIPT, dir], { env: { PATH: process.env.PATH, CHECKSUMS: sums } }).status ??
    -1;

  it("accepts exactly the verified set", () => {
    const { dir, sums } = setup();
    expect(run(dir, sums)).toBe(0);
  });
  it("fails on an extra tarball", () => {
    const { dir, sums } = setup();
    writeFileSync(join(dir, "c.tgz"), "evil");
    expect(run(dir, sums)).not.toBe(0);
  });
  it("fails on a missing tarball", () => {
    const { dir, sums } = setup();
    rmSync(join(dir, "b.tgz"));
    expect(run(dir, sums)).not.toBe(0);
  });
  it("fails on a changed tarball even when checksums.txt in the artifact was rewritten to match", () => {
    const { dir, sums } = setup();
    writeFileSync(join(dir, "a.tgz"), "tampered");
    writeFileSync(
      join(dir, "checksums.txt"),
      spawnSync("sh", ["-c", "sha256sum ./*.tgz"], { cwd: dir, encoding: "utf-8" }).stdout
    );
    expect(run(dir, sums)).not.toBe(0);
  });
  it("fails on an empty expectation and on a directory without tarballs", () => {
    const { dir } = setup();
    expect(run(dir, "")).not.toBe(0);
    const empty = mkdtempSync(join(tmpdir(), "tarball-set-"));
    dirs.push(empty);
    mkdirSync(join(empty, "x"));
    expect(run(empty, "abc  ./a.tgz\n")).not.toBe(0);
  });
});
