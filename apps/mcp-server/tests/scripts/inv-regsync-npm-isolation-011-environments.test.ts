// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-REGSYNC-NPM-ISOLATION-011 (a) — scripts/ci/check-environments.sh
 *
 * Environment stub-API table: 200 with the expected policy and reviewer passes; 404 or any
 * non-200, a wrong policy, or a wrong reviewer fails; two fallback rows (R5'): 403 on the
 * token read falls back to an unauthenticated read and passes on 200, and a rate limit
 * (403 on the fallback or without a token) fails with category `network`. The token is
 * only read from the environment, sent on stdin, and never printed. No network: routed
 * curl shim.
 *
 * @module tests/scripts/inv-regsync-npm-isolation-011-environments.test
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers/npm-shim-harness";
import { installRoutedCurl, setRoute, type RouteMode } from "./helpers/gh-curl-shim";

const SCRIPT = join(resolve(__dirname, "../../../.."), "scripts/ci/check-environments.sh");
const REPO = "owner-x/repo-y";
const OWNER = "owner-x";
const API = "https://api.github.com";
// not a real credential shape: assembled at runtime
const TOKEN = ["fake", "step", "credential", "0123"].join("_");

const envUrl = (n: string): string => `${API}/repos/${REPO}/environments/${n}`;
const polUrl = (n: string): string => `${envUrl(n)}/deployment-branch-policies`;
const DBP = { protected_branches: false, custom_branch_policies: true };
type Shape = { dbp?: unknown; branchRule?: boolean };
const envBody = (
  reviewers: string[] = [OWNER],
  bypass: unknown = true,
  { dbp = DBP, branchRule = true }: Shape = {}
): string =>
  JSON.stringify({
    can_admins_bypass: bypass,
    deployment_branch_policy: dbp,
    protection_rules: [
      { type: "wait_timer" },
      ...(branchRule ? [{ type: "branch_policy" }] : []),
      {
        type: "required_reviewers",
        reviewers: reviewers.map((login) => ({ type: "User", reviewer: { login } })),
      },
    ],
  });
const polBody = (p: Array<{ name: string; type: string }>): string =>
  JSON.stringify({ total_count: p.length, branch_policies: p });

const NPM = [{ name: "v*", type: "tag" }];
const REG = [{ name: "main", type: "branch" }];

let h: Harness;
beforeEach(() => {
  h = createHarness();
  installRoutedCurl(h);
});
afterEach(() => {
  h.cleanup();
});

function stubAll(
  o: {
    npmPol?: typeof NPM;
    regPol?: typeof REG;
    npmReviewers?: string[];
    regReviewers?: string[];
    npmShape?: Shape;
    regShape?: Shape;
    mode?: RouteMode;
  } = {}
): void {
  const m = o.mode ?? "any";
  setRoute(h, envUrl("npm-publish"), m, 200, envBody(o.npmReviewers, true, o.npmShape));
  setRoute(h, polUrl("npm-publish"), m, 200, polBody(o.npmPol ?? NPM));
  setRoute(h, envUrl("mcp-registry"), m, 200, envBody(o.regReviewers, true, o.regShape));
  setRoute(h, polUrl("mcp-registry"), m, 200, polBody(o.regPol ?? REG));
}

const run = (env: Record<string, string> = {}): ReturnType<Harness["run"]> =>
  h.run(SCRIPT, [], {
    GITHUB_REPOSITORY: REPO,
    GITHUB_REPOSITORY_OWNER: OWNER,
    GITHUB_TOKEN: TOKEN,
    ...env,
  });

const BAD_SHAPES: Array<[string, Shape]> = [
  ["null deployment_branch_policy", { dbp: null }],
  ["protected_branches only", { dbp: { protected_branches: true, custom_branch_policies: false } }],
  ["no restriction", { dbp: { protected_branches: false, custom_branch_policies: false } }],
  ["no branch_policy rule", { branchRule: false }],
];

describe("check-environments.sh stub-API table", () => {
  describe.each(["npm", "reg"] as const)("%s Environment mode (stale policy list)", (which) => {
    it.each(BAD_SHAPES)("fails with category policy: %s", (_label, shape) => {
      stubAll(which === "npm" ? { npmShape: shape } : { regShape: shape });
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("[policy]");
    });
  });

  it("passes on 200 with the expected policies and reviewer; reads both Environments", () => {
    stubAll();
    const r = run();
    expect(r.status).toBe(0);
    expect(h.calls()).toEqual([
      `curl AUTH ${envUrl("npm-publish")}`,
      `curl AUTH ${polUrl("npm-publish")}`,
      `curl AUTH ${envUrl("mcp-registry")}`,
      `curl AUTH ${polUrl("mcp-registry")}`,
    ]);
  });

  it("prints can_admins_bypass to the Summary only", () => {
    stubAll();
    const summary = h.writeFile("summary.md", "");
    const r = run({ GITHUB_STEP_SUMMARY: summary });
    expect(r.status).toBe(0);
    expect(readFileSync(summary, "utf-8")).toContain("can_admins_bypass=true");
    expect(r.stdout).not.toContain("can_admins_bypass");
  });

  it("fails closed on 404 of mcp-registry (auto-create guard) with category environment-missing", () => {
    stubAll();
    setRoute(h, envUrl("mcp-registry"), "any", 404, "{}");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("environment-missing");
    expect(r.stderr).toContain("mcp-registry");
  });

  it("fails closed on 404 of the policies endpoint", () => {
    stubAll();
    setRoute(h, polUrl("npm-publish"), "any", 404, "{}");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("environment-missing");
  });

  it.each([500, 502, 401])("fails closed on non-200 %i with category network", (code) => {
    stubAll();
    setRoute(h, envUrl("npm-publish"), "any", code, "{}");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[network]");
  });

  it.each([
    ["extra policy", { regPol: [...REG, { name: "dev", type: "branch" }] }],
    ["wrong name", { regPol: [{ name: "master", type: "branch" }] }],
    ["wrong type", { regPol: [{ name: "main", type: "tag" }] }],
    ["no policy", { regPol: [] }],
    ["npm-publish branch instead of tag", { npmPol: [{ name: "v*", type: "branch" }] }],
    ["npm-publish wildcard", { npmPol: [{ name: "*", type: "tag" }] }],
  ])("fails with category policy: %s", (_label, o) => {
    stubAll(o);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[policy]");
  });

  it.each([
    ["other reviewer", { regReviewers: ["someone-else"] }],
    ["extra reviewer", { regReviewers: [OWNER, "someone-else"] }],
    ["no reviewer", { regReviewers: [] }],
    ["npm-publish other reviewer", { npmReviewers: ["someone-else"] }],
  ])("fails with category reviewer: %s", (_label, o) => {
    stubAll(o);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[reviewer]");
  });

  it("fallback row 1: 403 on the token read falls back to an unauthenticated read and passes on 200", () => {
    stubAll({ mode: "anon" });
    for (const u of [
      envUrl("npm-publish"),
      polUrl("npm-publish"),
      envUrl("mcp-registry"),
      polUrl("mcp-registry"),
    ])
      setRoute(h, u, "auth", 403, "{}");
    const r = run();
    expect(r.status).toBe(0);
    const calls = h.calls();
    expect(calls[0]).toBe(`curl AUTH ${envUrl("npm-publish")}`);
    expect(calls[1]).toBe(`curl ANON ${envUrl("npm-publish")}`);
    expect(calls).toHaveLength(8);
  });

  it("fallback row 2: 403 on both reads (rate limit) fails with category network", () => {
    stubAll();
    setRoute(h, envUrl("npm-publish"), "any", 403, '{"message":"API rate limit exceeded"}');
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("[network]");
    expect(h.calls().slice(0, 2)).toEqual([
      `curl AUTH ${envUrl("npm-publish")}`,
      `curl ANON ${envUrl("npm-publish")}`,
    ]);
  });

  it("without a token only unauthenticated reads are made; 403 is a network failure", () => {
    stubAll();
    const ok = run({ GITHUB_TOKEN: "" });
    expect(ok.status).toBe(0);
    expect(h.calls().every((c) => c.startsWith("curl ANON "))).toBe(true);
    setRoute(h, envUrl("mcp-registry"), "any", 403, "{}");
    const limited = run({ GITHUB_TOKEN: "" });
    expect(limited.status).toBe(1);
    expect(limited.stderr).toContain("[network]");
  });
});

describe("check-environments.sh token handling", () => {
  it("never puts the token in argv, stdout, stderr or the Summary, on pass or fail", () => {
    stubAll();
    const summary = h.writeFile("summary.md", "");
    const pass = run({ GITHUB_STEP_SUMMARY: summary });
    setRoute(h, polUrl("mcp-registry"), "any", 500, "{}");
    const fail = run({ GITHUB_STEP_SUMMARY: summary });
    for (const r of [pass, fail]) expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(readFileSync(summary, "utf-8")).not.toContain(TOKEN);
    expect(h.argv().join("\n")).not.toContain(TOKEN);
    expect(h.argv().some((a) => a.includes("-K -"))).toBe(true);
  });

  it("does not trace even when the caller exported xtrace", () => {
    stubAll();
    const r = run({ SHELLOPTS: "xtrace", BASHOPTS: "" });
    expect(r.stderr).not.toContain(TOKEN);
  });

  it("rejects a malformed token without echoing it, before any request", () => {
    const bad = `${TOKEN} injected"\nheader = "X: y`;
    const r = run({ GITHUB_TOKEN: bad });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(h.calls()).toEqual([]);
  });

  it("rejects a bad repository, owner or API base before any request", () => {
    expect(run({ GITHUB_REPOSITORY: "no-slash" }).status).toBe(2);
    expect(run({ GITHUB_REPOSITORY_OWNER: "a b" }).status).toBe(2);
    expect(run({ GITHUB_API_URL: "http://api.github.com" }).status).toBe(2);
    expect(h.calls()).toEqual([]);
  });

  it("the script reads the token only from GITHUB_TOKEN and sends it through stdin config", () => {
    const code = readFileSync(SCRIPT, "utf-8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(code.match(/\$\{?GITHUB_TOKEN/g)?.length).toBe(1);
    expect(code).toContain("-K -");
    expect(code).not.toMatch(/-H\s+["']?Authorization/);
    expect(code).not.toMatch(/\bset -x\b/);
  });
});
