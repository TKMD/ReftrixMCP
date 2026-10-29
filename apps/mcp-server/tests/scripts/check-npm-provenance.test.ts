// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-REGSYNC-WAIT-005 (provenance rows) — scripts/ci/check-npm-provenance.sh
 *
 * The integrity source is the npm provenance attestation, never a rebuilt tarball: the
 * script compares the attestation subject digest with the version document's
 * dist.integrity and checks the repository, workflow path and commit. A mismatch fails at
 * once; an attestation that is not yet 200 is retried only until the caller's deadline.
 * All registry traffic goes through the PATH shims in helpers/npm-shim-harness.ts.
 *
 * @module tests/scripts/check-npm-provenance.test
 */
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { join, resolve } from "node:path";
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
const SCRIPT = join(REPO_ROOT, "scripts/ci/check-npm-provenance.sh");
const PKG = "@example/pkg";
const VER = "0.6.1";
const DOC_URL = "https://registry.npmjs.org/@example%2Fpkg/0.6.1";
const ATT_URL = "https://registry.npmjs.org/-/npm/v1/attestations/@example%2fpkg@0.6.1";

let h: Harness;
beforeEach(() => {
  h = createHarness();
  h.setBody("doc", versionDocBody(VER, GOOD_SHA512));
  h.setSequence(DOC_URL, ["200@doc"]);
});
afterEach(() => {
  h.cleanup();
});

const good = (): string => attestationBody({ sha512Hex: GOOD_SHA512 });
const check = (extra: string[] = []): ReturnType<Harness["run"]> =>
  h.run(SCRIPT, [PKG, VER, GOOD_COMMIT, ...extra]);
const attCalls = (): string[] => h.calls().filter((c) => c === `curl ${ATT_URL}`);

describe("INV-REGSYNC-WAIT-005: provenance rows", () => {
  it("passes when digest, repository, workflow path and commit all match", () => {
    h.setBody("att", good());
    h.setSequence(ATT_URL, ["200@att"]);
    expect(check().status).toBe(0);
  });
  it("passes when a later subject matches dist.integrity", () => {
    h.setBody("att", attestationBody({ sha512Hex: ["cd".repeat(64), GOOD_SHA512] }));
    h.setSequence(ATT_URL, ["200@att"]);
    expect(check().status).toBe(0);
  });
  it("asks the lowercase-%2f attestation route over bounded https", () => {
    h.setBody("att", good());
    h.setSequence(ATT_URL, ["200@att"]);
    check();
    expect(attCalls()).toHaveLength(1);
    const argv = h.argv().find((a) => a.endsWith(` ${ATT_URL}`)) ?? "";
    expect(argv).toContain("--max-time 20");
    expect(argv).toContain("--proto =https");
  });
  const FAIL = "provenance check failed: ";
  const fieldRows: Array<[string, Record<string, unknown>, string]> = [
    ["commit mismatch", { commit: "f".repeat(40) }, "commit differs from the tag commit"],
    [
      "a second resolved dependency with another commit",
      { commit: [GOOD_COMMIT, "f".repeat(40)] },
      "commit differs from the tag commit",
    ],
    ["no resolved dependencies", { commit: [] }, "commit differs from the tag commit"],
    ["workflow path mismatch", { path: ".github/workflows/other.yml" }, "workflow path differs"],
    [
      "workflow path with a longer file name",
      { path: ".github/workflows/x-publish.yml" },
      "workflow path differs",
    ],
    [
      "repository mismatch",
      { repository: "https://github.com/someone/else" },
      "repository differs",
    ],
    [
      "repository with a longer name",
      { repository: "https://github.com/TKMD/ReftrixMCP-fork" },
      "repository differs",
    ],
    [
      "subject digest differs from dist.integrity",
      { sha512Hex: "cd".repeat(64) },
      "attestation subject digest differs",
    ],
    ["no SLSA provenance entry", { slsa: false }, "no SLSA v1 provenance entry"],
    ["two SLSA provenance entries", { slsa: 2 }, "more than one SLSA v1 provenance entry"],
    [
      "a payload holding two JSON values",
      { rawPayload: '{"a":1}{"b":2}' },
      "attestation payload is not a single statement",
    ],
    [
      "a payload with trailing garbage",
      { rawPayload: '{"a":1}garbage' },
      "attestation payload is not a single statement",
    ],
  ];
  it.each(fieldRows)("fails at once on %s and names the field", (_label, override, message) => {
    h.setBody("att", attestationBody({ sha512Hex: GOOD_SHA512, ...override }));
    h.setSequence(ATT_URL, ["200@att"]);
    const r = check([String(CLOCK_START + 600)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${FAIL}${message}`);
    expect(h.sleeps()).toEqual([]);
    expect(h.calls()).toEqual([`curl ${DOC_URL}`, `curl ${ATT_URL}`]);
  });
  const docRows: Array<[string, string, string]> = [
    [
      "a version document holding two JSON values",
      `${versionDocBody("9.9.9", GOOD_SHA512)}\n${versionDocBody(VER, GOOD_SHA512)}`,
      "version document version differs",
    ],
    [
      "a version document whose second JSON value is of another version",
      `${versionDocBody(VER, GOOD_SHA512)}\n${versionDocBody("9.9.9", GOOD_SHA512)}`,
      "version document version differs",
    ],
    [
      "a version document without a version field",
      JSON.stringify({
        dist: { integrity: JSON.parse(versionDocBody(VER, GOOD_SHA512)).dist.integrity },
      }),
      "version document version differs",
    ],
    [
      "a version document of another version",
      versionDocBody("9.9.9", GOOD_SHA512),
      "version document version differs",
    ],
    [
      "an integrity that is not sha512",
      JSON.stringify({ version: VER, dist: { integrity: "sha1-AAAA" } }),
      "dist.integrity is not a sha512 value",
    ],
    ["no dist.integrity", JSON.stringify({ version: VER }), "dist.integrity is not a sha512 value"],
    [
      "an integrity that is not valid base64",
      JSON.stringify({ version: VER, dist: { integrity: "sha512-A" } }),
      "dist.integrity is not valid base64",
    ],
    [
      "an integrity of the wrong length",
      JSON.stringify({ version: VER, dist: { integrity: "sha512-AAAA" } }),
      "dist.integrity is not a 64-byte digest",
    ],
  ];
  it.each(docRows)("fails at once on %s", (_label, doc, message) => {
    h.setBody("doc", doc);
    h.setBody("att", good());
    h.setSequence(ATT_URL, ["200@att"]);
    const r = check([String(CLOCK_START + 600)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${FAIL}${message}`);
    expect(h.sleeps()).toEqual([]);
  });
  it("fails on a payload that is not base64", () => {
    h.setBody(
      "att",
      JSON.stringify({
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: { dsseEnvelope: { payload: "!!" } },
          },
        ],
      })
    );
    h.setSequence(ATT_URL, ["200@att"]);
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${FAIL}attestation payload is not valid base64`);
  });
  it("does not echo registry-supplied values into the log", () => {
    h.setBody(
      "att",
      attestationBody({ sha512Hex: GOOD_SHA512, repository: "x\n::error::injected" })
    );
    h.setSequence(ATT_URL, ["200@att"]);
    const r = check();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${FAIL}repository differs`);
    expect(r.stdout + r.stderr).not.toContain("injected");
  });
  it("makes exactly the version-document and attestation requests, never a tarball", () => {
    h.setBody("att", good());
    h.setSequence(ATT_URL, ["200@att"]);
    expect(check().status).toBe(0);
    expect(h.calls()).toEqual([`curl ${DOC_URL}`, `curl ${ATT_URL}`]);
  });
});

describe("INV-REGSYNC-WAIT-005: provenance availability", () => {
  it("default deadline is now: one 404 probe fails without waiting", () => {
    h.setSequence(ATT_URL, ["404"]);
    const r = check();
    expect(r.status).toBe(1);
    expect(attCalls()).toHaveLength(1);
    expect(h.sleeps()).toEqual([]);
  });
  it("waits within the given deadline and passes when the attestation turns up", () => {
    h.setBody("att", good());
    h.setSequence(ATT_URL, ["404", "503", "200@att"]);
    expect(check([String(CLOCK_START + 600)]).status).toBe(0);
    expect(h.sleeps()).toEqual([5, 10]);
  });
  it("doubles the backoff and caps it at 30 seconds", () => {
    h.setBody("att", good());
    h.setSequence(ATT_URL, [...Array(7).fill("404"), "200@att"]);
    expect(check([String(CLOCK_START + 600)]).status).toBe(0);
    expect(h.sleeps()).toEqual([5, 10, 20, 30, 30, 30, 30]);
  });
  it("fails when the attestation is still 404 at the deadline", () => {
    h.setSequence(ATT_URL, ["404"]);
    const r = check([String(CLOCK_START + 60)]);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/last status=404/);
    expect(h.clock() - CLOCK_START).toBeLessThan(60 + 30);
  });
  it("reports a curl failure as such in the attempt log", () => {
    h.setSequence(DOC_URL, ["timeout", "200@doc"]);
    h.setBody("att", good());
    h.setSequence(ATT_URL, ["200@att"]);
    const r = check([String(CLOCK_START + 600)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("version-doc=curl-error-28");
  });
  it("treats a version document that is not 200 as not yet", () => {
    h.setSequence(DOC_URL, ["503", "200@doc"]);
    h.setBody("att", good());
    h.setSequence(ATT_URL, ["200@att"]);
    expect(check([String(CLOCK_START + 600)]).status).toBe(0);
  });
});

describe("INV-REGSYNC-WAIT-005: provenance input checks", () => {
  it("rejects bad arguments and a deadline beyond 1800 s without any call", () => {
    for (const args of [
      ["core", VER, GOOD_COMMIT],
      [PKG, "latest", GOOD_COMMIT],
      [PKG, VER, "abc"],
      [PKG, VER, GOOD_COMMIT.toUpperCase()],
      [PKG, VER, GOOD_COMMIT, String(CLOCK_START + 1801)],
      [PKG, VER, GOOD_COMMIT, "-5"],
      [PKG, VER, GOOD_COMMIT, " 5"],
      [PKG, VER, GOOD_COMMIT, ""],
      [PKG, VER],
    ]) {
      expect(h.run(SCRIPT, args).status).toBe(2);
    }
    expect(h.calls()).toEqual([]);
  });
});

describe("INV-REGSYNC-WAIT-005: CI lints scripts/ci", () => {
  it("runs a version-pinned shellcheck over scripts/ci/*.sh in ci.yml", () => {
    const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf-8");
    expect(ci).toContain("shellcheck-v0.11.0.linux.x86_64.tar.xz");
    expect(ci).toContain(
      "8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198  $RUNNER_TEMP/shellcheck.tar.xz"
    );
    expect(ci).toMatch(/sha256sum -c/);
    expect(ci).toMatch(/curl [^\n]*--retry 3 [^\n]*--max-time 60/);
    expect(ci).toMatch(/shellcheck"? scripts\/ci\/\*\.sh/);
  });
  it("lets neither the digest check nor the step fail open", () => {
    const wf = load(readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf-8")) as {
      jobs: Record<
        string,
        { "continue-on-error"?: unknown; steps: Array<Record<string, unknown>> }
      >;
    };
    const found = Object.values(wf.jobs).flatMap((j) =>
      j.steps
        .filter((st) => String(st.run ?? "").includes("shellcheck.tar.xz"))
        .map((st) => ({ job: j, step: st }))
    );
    expect(found).toHaveLength(1);
    const { job, step } = found[0];
    expect(step).not.toHaveProperty("continue-on-error");
    // an explicit shell: bash runs `bash --noprofile --norc -eo pipefail {0}`; the default is `bash -e {0}`
    expect(step.shell).toBe("bash");
    expect(job).not.toHaveProperty("continue-on-error");
    const run = String(step.run);
    expect(run).not.toMatch(/\|\||;\s*true|\bset [+-]|\btee\b/);
    expect(run.split("\n").map((l) => l.trim())).toContain(
      'echo "8c3be12b05d5c177a04c29e3c78ce89ac86f1595681cab149b65b97c4e227198  $RUNNER_TEMP/shellcheck.tar.xz" | sha256sum -c -'
    );
    expect(run.split("\n").filter((l) => l.includes("sha256sum -c -"))).toHaveLength(1);
  });
});

describe("INV-REGSYNC-WAIT-005: constants shared with the wait script", () => {
  it("keeps the propagation window, backoff and registry base equal in both scripts", () => {
    const value = (file: string, name: string): string | undefined =>
      readFileSync(join(REPO_ROOT, "scripts/ci", file), "utf-8").match(
        new RegExp(`^${name}=(.+)$`, "m")
      )?.[1];
    for (const name of [
      "NPM_PROPAGATION_MAX_SECONDS",
      "BACKOFF_START",
      "BACKOFF_CAP",
      "REGISTRY_BASE",
    ]) {
      expect(value("check-npm-provenance.sh", name), name).toBeDefined();
      expect(value("check-npm-provenance.sh", name), name).toBe(
        value("wait-for-npm-version.sh", name)
      );
    }
  });
  it("pins the GATE_WINDOW literal in publish.yml to the wait script constant", () => {
    const wait = readFileSync(join(REPO_ROOT, "scripts/ci/wait-for-npm-version.sh"), "utf-8");
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/publish.yml"), "utf-8");
    const windowSeconds = wait.match(/^NPM_PROPAGATION_MAX_SECONDS=(\d+)$/m)?.[1];
    expect(windowSeconds).toBeDefined();
    expect(yml.match(/^\s*GATE_WINDOW=(\d+)\b/m)?.[1]).toBe(windowSeconds);
  });
});
