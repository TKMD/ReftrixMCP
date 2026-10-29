// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-REGSYNC-PIN-006 — scripts/ci/install-mcp-publisher.sh + scripts/ci/mcp-publisher.pin
 *
 * Explicit version in the URL; tarball SHA-256 literal; full cosign identity + issuer in the
 * pin file; no checksums file fetched at run time; extraction under $RUNNER_TEMP, only the
 * `mcp-publisher` member; no binary in the repo. No network: PATH-shim curl serves a fixture
 * tarball built here. (The `--registry` constant and SHA-pinned `uses:` belong to the workflow PRs; the
 * existing workflows are not SHA-pinned yet.)
 *
 * @module tests/scripts/inv-regsync-pin-006.test
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers/npm-shim-harness";
import { installRoutedCurl, setRoute } from "./helpers/gh-curl-shim";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(REPO_ROOT, "scripts/ci/install-mcp-publisher.sh");
const REAL_PIN = join(REPO_ROOT, "scripts/ci/mcp-publisher.pin");
const VERSION = "v9.9.9";
const URL = `https://github.com/modelcontextprotocol/registry/releases/download/${VERSION}/mcp-publisher_linux_amd64.tar.gz`;

let h: Harness;
let work: string;
let cwd: string;
let runnerTemp: string;

const sha256 = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");

function buildTarball(name: string, members: Record<string, string>): string {
  const src = mkdtempSync(join(work, "src-"));
  for (const [m, body] of Object.entries(members)) writeFileSync(join(src, m), body);
  const out = join(work, name);
  const r = spawnSync("tar", ["-czf", out, "-C", src, ...Object.keys(members)]);
  if (r.status !== 0) throw new Error("fixture tar failed");
  return out;
}

function pinFor(sha: string, url = URL, version = VERSION): string {
  return h.writeFile(
    "fixture.pin",
    [
      "# fixture",
      `MCP_PUBLISHER_VERSION=${version}`,
      `MCP_PUBLISHER_URL=${url}`,
      `MCP_PUBLISHER_SHA256=${sha}`,
      "",
    ].join("\n")
  );
}

const install = (pin: string, env: Record<string, string> = {}): ReturnType<Harness["run"]> =>
  h.run(SCRIPT, [pin], { RUNNER_TEMP: runnerTemp, ...env }, cwd);

const FIXTURE_FILES = {
  "mcp-publisher": "#!/bin/sh\necho fixture\n",
  LICENSE: "license text\n",
  "README.md": "readme\n",
};

beforeEach(() => {
  h = createHarness();
  installRoutedCurl(h);
  work = mkdtempSync(join(tmpdir(), "pin006-"));
  cwd = join(work, "workspace");
  runnerTemp = join(work, "runner-temp");
  mkdirSync(cwd);
  mkdirSync(runnerTemp);
});
afterEach(() => {
  h.cleanup();
  rmSync(work, { recursive: true, force: true });
});

describe("install-mcp-publisher.sh", () => {
  it("downloads the fixed URL, verifies the sha, extracts only the binary under RUNNER_TEMP", () => {
    const tarball = buildTarball("good.tar.gz", FIXTURE_FILES);
    setRoute(h, URL, "any", 200, `@file:${tarball}`);
    const githubPath = join(work, "github_path");
    writeFileSync(githubPath, "");
    const r = install(pinFor(sha256(tarball)), { GITHUB_PATH: githubPath });
    expect(r.status).toBe(0);
    const bin = r.stdout.trim();
    expect(bin.startsWith(`${runnerTemp}/mcp-publisher.`)).toBe(true);
    expect(bin.endsWith("/bin/mcp-publisher")).toBe(true);
    expect(statSync(bin).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(bin, ".."))).toEqual(["mcp-publisher"]);
    expect(readdirSync(cwd)).toEqual([]);
    expect(readFileSync(githubPath, "utf-8").trim()).toBe(join(bin, ".."));
    expect(h.calls()).toEqual([`curl ANON ${URL}`]);
    const argv = h.argv().join("\n");
    expect(argv).toContain("--proto =https");
    expect(argv).toContain("--fail");
  });

  it("fails on a sha mismatch and leaves no binary", () => {
    const tarball = buildTarball("good.tar.gz", FIXTURE_FILES);
    setRoute(h, URL, "any", 200, `@file:${tarball}`);
    const r = install(pinFor("0".repeat(64)));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("sha256");
    expect(existsSync(join(runnerTemp, "bin"))).toBe(false);
    const found = spawnSync("find", [runnerTemp, "-name", "mcp-publisher"], { encoding: "utf-8" });
    expect(found.stdout.trim()).toBe("");
  });

  it("fails when the served tarball differs from the pinned one", () => {
    const pinned = buildTarball("pinned.tar.gz", FIXTURE_FILES);
    const other = buildTarball("other.tar.gz", { ...FIXTURE_FILES, "mcp-publisher": "evil\n" });
    setRoute(h, URL, "any", 200, `@file:${other}`);
    expect(install(pinFor(sha256(pinned))).status).toBe(1);
  });

  it("fails on a download error", () => {
    setRoute(h, URL, "any", 404, "");
    const r = install(pinFor("a".repeat(64)));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("download failed");
  });

  it("fails when the tarball has no mcp-publisher member", () => {
    const tarball = buildTarball("nomember.tar.gz", { LICENSE: "x\n" });
    setRoute(h, URL, "any", 200, `@file:${tarball}`);
    expect(install(pinFor(sha256(tarball))).status).toBe(1);
  });

  it("rejects a pin whose URL is not the fixed URL for its version, before any download", () => {
    const bad = [
      URL.replace("modelcontextprotocol/registry", "someone-else/registry"),
      URL.replace(`/${VERSION}/`, "/latest/"),
      URL.replace("https://", "http://"),
    ];
    for (const u of bad) {
      const r = install(pinFor("a".repeat(64), u));
      expect(r.status).toBe(2);
    }
    expect(h.calls()).toEqual([]);
  });

  it("rejects a malformed sha or version in the pin file", () => {
    expect(install(pinFor("A".repeat(64))).status).toBe(2);
    expect(install(pinFor("a".repeat(63))).status).toBe(2);
    expect(install(pinFor("a".repeat(64), URL, "latest")).status).toBe(2);
    expect(h.calls()).toEqual([]);
  });

  it("requires an absolute RUNNER_TEMP outside the work tree", () => {
    const pin = pinFor("a".repeat(64));
    expect(h.run(SCRIPT, [pin], {}, cwd).status).toBe(2);
    expect(h.run(SCRIPT, [pin], { RUNNER_TEMP: "relative" }, cwd).status).toBe(2);
    const inside = join(cwd, "tmp");
    mkdirSync(inside);
    expect(h.run(SCRIPT, [pin], { RUNNER_TEMP: inside }, cwd).status).toBe(2);
    expect(h.calls()).toEqual([]);
  });

  it("never reads or sources the pin file as code", () => {
    const tarball = buildTarball("good.tar.gz", FIXTURE_FILES);
    setRoute(h, URL, "any", 200, `@file:${tarball}`);
    const marker = join(work, "pwned");
    const pin = h.writeFile(
      "evil.pin",
      [
        `touch ${marker}`,
        `MCP_PUBLISHER_VERSION=${VERSION}`,
        `MCP_PUBLISHER_URL=${URL}`,
        `MCP_PUBLISHER_SHA256=${sha256(tarball)}`,
      ].join("\n")
    );
    expect(install(pin).status).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("mcp-publisher.pin and repository state", () => {
  const pin = readFileSync(REAL_PIN, "utf-8");
  const value = (k: string): string =>
    pin
      .split("\n")
      .find((l) => l.startsWith(`${k}=`))
      ?.slice(k.length + 1) ?? "";

  it("pins an explicit version, the tarball sha, and the full cosign identity + issuer", () => {
    const version = value("MCP_PUBLISHER_VERSION");
    expect(version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(value("MCP_PUBLISHER_URL")).toBe(
      `https://github.com/modelcontextprotocol/registry/releases/download/${version}/mcp-publisher_linux_amd64.tar.gz`
    );
    expect(value("MCP_PUBLISHER_SHA256")).toMatch(/^[0-9a-f]{64}$/);
    expect(value("COSIGN_CERTIFICATE_IDENTITY")).toBe(
      `https://github.com/modelcontextprotocol/registry/.github/workflows/release.yml@refs/tags/${version}`
    );
    expect(value("COSIGN_CERTIFICATE_OIDC_ISSUER")).toBe(
      "https://token.actions.githubusercontent.com"
    );
  });

  it("pins the measured v1.8.1 tarball sha", () => {
    expect(value("MCP_PUBLISHER_VERSION")).toBe("v1.8.1");
    expect(value("MCP_PUBLISHER_SHA256")).toBe(
      "a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc"
    );
  });

  it("the install script fetches no checksums file and runs no cosign at run time", () => {
    const code = readFileSync(SCRIPT, "utf-8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/checksums/i);
    expect(code).not.toMatch(/cosign/i);
    expect(code).not.toMatch(/GITHUB_WORKSPACE/);
    expect(code).toContain("sha256sum -c");
    expect(code).toContain("set +x");
  });

  it("no mcp-publisher binary is tracked in the repository", () => {
    const r = spawnSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf-8" });
    if (r.status !== 0) return; // not a git checkout (OSS export): nothing to assert
    const bad = r.stdout
      .split("\n")
      .filter((f) => /(^|\/)mcp-publisher(_[^/]*)?(\.tar\.gz|\.zip)?$/.test(f));
    expect(bad).toEqual([]);
  });
});
