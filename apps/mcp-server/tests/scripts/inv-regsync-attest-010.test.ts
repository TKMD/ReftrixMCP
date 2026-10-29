// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-REGSYNC-ATTEST-010 (synced leg) — scripts/ci/registry-content-hash.sh,
 * scripts/ci/registry-sync-attestation.json (+ schema) and scripts/ci/registry-attestation-check.sh
 *
 * The attestation records User statements that CI cannot verify. CI checks only that the file
 * exists, is schema-valid, is consistent (cc0_rights_held true, publishing_entity equals the namespace
 * owner and the repository owner, and at runtime the repository owner) and that the content hash of
 * server.json is a member of the append-only set (existence, consistency and hash membership).
 * It cannot tell whether the statements are true, who added an entry, or whether the User approved it.
 * The append-only comparison against git history is the private-only leg
 * (inv-regsync-attest-010-private-append-only.test.ts).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
const HASH = join(REPO_ROOT, "scripts/ci/registry-content-hash.sh");
const CHECK = join(REPO_ROOT, "scripts/ci/registry-attestation-check.sh");
const ATTESTATION_PATH = join(REPO_ROOT, "scripts/ci/registry-sync-attestation.json");
const SCHEMA_PATH = join(REPO_ROOT, "scripts/ci/registry-sync-attestation.schema.json");
const SERVER_PATH = join(REPO_ROOT, "server.json");
// byte copy of server.json at the public tag v0.6.1 (the Registry backfill reads the tag's file)
const TAG_PATH = join(__dirname, "fixtures/registry-server-v0.6.1.json");

const read = (p: string): any => JSON.parse(readFileSync(p, "utf-8"));
const SERVER = read(SERVER_PATH);
const TAG = read(TAG_PATH);
const ATT = read(ATTESTATION_PATH);
const SCHEMA = read(SCHEMA_PATH);

const sorted = (v: any): any =>
  Array.isArray(v)
    ? v.map(sorted)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sorted(v[k])])
        )
      : v;
/** independent oracle of the hash definition in the plan (section 7.2) */
const oracle = (s: any, message = ""): string => {
  const env = (s.packages ?? [])
    .flatMap((p: any) => p.environmentVariables ?? [])
    .map((e: any) => ({ name: e.name, description: e.description }))
    .sort((a: any, b: any) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const obj = {
    name: s.name,
    description: s.description,
    repository_url: s.repository.url,
    environment_variables: env,
    deprecation_message: message,
  };
  return createHash("sha256")
    .update(JSON.stringify(sorted(obj)))
    .digest("hex");
};

const withFiles = <T>(files: Record<string, unknown>, fn: (p: (n: string) => string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "attest-"));
  try {
    for (const [n, v] of Object.entries(files)) {
      writeFileSync(join(dir, n), typeof v === "string" ? v : JSON.stringify(v));
    }
    return fn((n) => join(dir, n));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const run = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const r = spawnSync("bash", args, { encoding: "utf-8", timeout: 20_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const hashOf = (doc: unknown, message?: string): { status: number | null; out: string } =>
  withFiles({ "s.json": doc }, (p) => {
    const r = run([HASH, p("s.json"), ...(message === undefined ? [] : [message])]);
    return { status: r.status, out: r.stdout.trim() };
  });
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe("INV-REGSYNC-ATTEST-010: registry-content-hash.sh", () => {
  it("matches the independent oracle for the real file and the tag content", () => {
    expect(hashOf(SERVER)).toEqual({ status: 0, out: oracle(SERVER) });
    expect(hashOf(TAG)).toEqual({ status: 0, out: oracle(TAG) });
  });
  it("includes the deprecation message; no message equals the empty message", () => {
    expect(hashOf(SERVER, "Superseded.").out).toBe(oracle(SERVER, "Superseded."));
    expect(hashOf(SERVER, "Superseded.").out).not.toBe(hashOf(SERVER).out);
    expect(hashOf(SERVER, "").out).toBe(hashOf(SERVER).out);
  });
  it("excludes version fields and fields other than name and description of an env var", () => {
    const base = hashOf(SERVER).out;
    const a = clone(SERVER);
    a.version = "9.9.9";
    a.packages[0].version = "9.9.9";
    a.packages[0].environmentVariables[1].isRequired = true;
    a.packages[0].environmentVariables[1].isSecret = true;
    expect(hashOf(a).out).toBe(base);
  });
  it("ignores the order of environment variables", () => {
    const a = clone(SERVER);
    a.packages[0].environmentVariables.reverse();
    expect(hashOf(a).out).toBe(hashOf(SERVER).out);
  });
  it.each<[string, (d: any) => void]>([
    ["name", (d) => (d.name = "io.github.TKMD/other")],
    ["description", (d) => (d.description += "!")],
    ["repository.url", (d) => (d.repository.url += "x")],
    ["env name", (d) => (d.packages[0].environmentVariables[0].name = "OTHER")],
    ["env description", (d) => (d.packages[0].environmentVariables[2].description += "!")],
    [
      "env var added",
      (d) => d.packages[0].environmentVariables.push({ name: "Z", description: "z" }),
    ],
  ])("changes when %s changes", (_n, fn) => {
    const d = clone(SERVER);
    fn(d);
    expect(hashOf(d).out).not.toBe(hashOf(SERVER).out);
  });
  it("exits 2 on bad input", () => {
    expect(run([HASH]).status).toBe(2);
    expect(run([HASH, "/nonexistent/server.json"]).status).toBe(2);
    expect(hashOf("[1]").status).toBe(2);
    expect(hashOf("not json").status).toBe(2);
    const noDesc = clone(SERVER);
    delete noDesc.description;
    expect(hashOf(noDesc).status).toBe(2);
    const noUrl = clone(SERVER);
    delete noUrl.repository;
    expect(hashOf(noUrl).status).toBe(2);
    const badEnv = clone(SERVER);
    delete badEnv.packages[0].environmentVariables[0].description;
    expect(hashOf(badEnv).status).toBe(2);
  });
});

describe("INV-REGSYNC-ATTEST-010: the recorded attestation", () => {
  const ownerOfName = /^io\.github\.([A-Za-z0-9-]+)\//.exec(SERVER.name)?.[1];
  const ownerOfUrl = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\//.exec(SERVER.repository.url)?.[1];

  it("states the recorded values", () => {
    expect(ATT.cc0_rights_held).toBe(true);
    expect(ATT.publishing_entity).toBe("TKMD");
    expect(ATT.tos_effective).toBe("2025-09-02");
    expect(ATT.decision_ref).toBe("01a15b75-b214-7757-a721-a6fd0b96771e");
    expect(ATT.conditions).toEqual(["condition-2", "condition-3"]);
  });
  it("publishing_entity equals the namespace owner and the repository owner (static basis)", () => {
    expect(ownerOfName).toBe(ATT.publishing_entity);
    expect(ownerOfUrl).toBe(ATT.publishing_entity);
  });
  it("content hash of the tag v0.6.1 content and of the current content are members", () => {
    const set = ATT.attested_content_sha256.map((e: any) => e.sha256);
    expect(set).toContain(oracle(TAG));
    expect(set).toContain(oracle(SERVER));
  });
  it("entries are unique, well formed and every entry carries a date", () => {
    const set = ATT.attested_content_sha256;
    expect(new Set(set.map((e: any) => e.sha256)).size).toBe(set.length);
    for (const e of set) {
      expect(Object.keys(e).sort()).toEqual(["attested_on", "sha256"]);
      expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(e.attested_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
  it("the check script accepts the real files", () => {
    const r = run([CHECK, ATTESTATION_PATH, SERVER_PATH, "TKMD"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("matched entry");
    expect(run([CHECK, ATTESTATION_PATH, TAG_PATH, "TKMD"]).status).toBe(0);
  });
  it("carries no internal-tool token anywhere in this change", () => {
    const token = ["hydl", "ogger"].join("");
    // the private-only leg is not part of the OSS tree
    const privateLeg = join(__dirname, "inv-regsync-attest-010-private-append-only.test.ts");
    const files = [ATTESTATION_PATH, SCHEMA_PATH, HASH, CHECK, TAG_PATH, __filename].concat(
      existsSync(privateLeg) ? [privateLeg] : []
    );
    for (const f of files) {
      expect(readFileSync(f, "utf-8").toLowerCase(), f).not.toContain(token);
    }
  });
});

describe("INV-REGSYNC-ATTEST-010: registry-attestation-check.sh", () => {
  const good = (): Record<string, any> => ({
    ...clone(ATT),
    attested_content_sha256: [{ sha256: oracle(SERVER), attested_on: "2026-01-01" }],
  });
  const check = (att: unknown, server: unknown = SERVER, entity = "TKMD", message?: string) =>
    withFiles({ "a.json": att as any, "s.json": server as any }, (p) =>
      run([CHECK, p("a.json"), p("s.json"), entity, ...(message === undefined ? [] : [message])])
    );

  it("accepts a conforming file and reports the matched entry", () => {
    const r = check(good());
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("2026-01-01");
  });
  it("accepts when the hash covers the deprecation message and only then", () => {
    const att = good();
    att.attested_content_sha256 = [{ sha256: oracle(SERVER, "Gone."), attested_on: "2026-01-01" }];
    expect(check(att, SERVER, "TKMD", "Gone.").status).toBe(0);
    expect(check(att).status).toBe(1);
    expect(check(att, SERVER, "TKMD", "Other.").status).toBe(1);
  });
  it("fails when the file is missing or not one object", () => {
    expect(run([CHECK, "/nonexistent/a.json", SERVER_PATH, "TKMD"]).status).toBe(1);
    expect(check("[1]").status).toBe(1);
    expect(check("not json").status).toBe(1);
  });
  const rows: Array<[string, (a: Record<string, any>) => void]> = [
    ["cc0_rights_held false", (a) => (a.cc0_rights_held = false)],
    ["cc0_rights_held string", (a) => (a.cc0_rights_held = "true")],
    ["entity differs", (a) => (a.publishing_entity = "OTHER")],
    ["extra key", (a) => (a.note = "x")],
    ["missing key", (a) => delete a.tos_effective],
    ["bad date", (a) => (a.attested_on = "22/10/2026")],
    ["bad tos date", (a) => (a.tos_effective = "2025-9-2")],
    ["bad decision_ref", (a) => (a.decision_ref = "not-a-uuid")],
    ["entity with trailing newline", (a) => (a.publishing_entity = "TKMD\n")],
    ["tos date with trailing newline", (a) => (a.tos_effective = "2025-09-02\n")],
    ["attested_on with trailing newline", (a) => (a.attested_on = "2026-10-22\n")],
    [
      "entry attested_on with trailing newline",
      (a) => (a.attested_content_sha256[0].attested_on = "2026-10-22\n"),
    ],
    ["decision_ref with trailing newline", (a) => (a.decision_ref = `${ATT.decision_ref}\n`)],
    ["empty conditions", (a) => (a.conditions = [])],
    ["duplicate conditions", (a) => (a.conditions = ["condition-2", "condition-2"])],
    ["empty set", (a) => (a.attested_content_sha256 = [])],
    ["bad sha", (a) => (a.attested_content_sha256[0].sha256 = "abc")],
    ["uppercase sha", (a) => (a.attested_content_sha256[0].sha256 = oracle(SERVER).toUpperCase())],
    ["entry extra key", (a) => (a.attested_content_sha256[0].by = "x")],
    ["entry bad date", (a) => (a.attested_content_sha256[0].attested_on = "yesterday")],
    [
      "duplicate sha",
      (a) =>
        a.attested_content_sha256.push({
          ...a.attested_content_sha256[0],
          attested_on: "2026-01-02",
        }),
    ],
    [
      "hash not a member",
      (a) => (a.attested_content_sha256[0].sha256 = createHash("sha256").update("x").digest("hex")),
    ],
  ];
  it.each(rows)("fails on %s", (_n, fn) => {
    const a = good();
    fn(a);
    const r = check(a);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("registry-attestation-check");
  });
  it("ends every test() pattern with \\z, never with $ (Oniguruma $ accepts a trailing newline)", () => {
    const src = readFileSync(CHECK, "utf-8");
    expect(src.match(/test\("[^"]*\$"\)/g)).toBeNull();
    expect(src.match(/test\("[^"]*\\\\z"\)/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
  it("fails when server.json content changed without a new entry", () => {
    const s = clone(SERVER);
    s.description = "changed description";
    expect(check(good(), s).status).toBe(1);
  });
  it("fails at runtime when the repository owner differs from the entity", () => {
    expect(check(good(), SERVER, "OTHER").status).toBe(1);
  });
  it("exits 2 on bad usage", () => {
    expect(run([CHECK]).status).toBe(2);
    expect(run([CHECK, ATTESTATION_PATH, SERVER_PATH, "bad entity!"]).status).toBe(2);
  });
});

describe("INV-REGSYNC-ATTEST-010: schema file agrees with the check", () => {
  const props = SCHEMA.properties;
  it("requires exactly the attestation keys and nothing else", () => {
    expect(SCHEMA.additionalProperties).toBe(false);
    expect([...SCHEMA.required].sort()).toEqual(Object.keys(ATT).sort());
    expect(Object.keys(props).sort()).toEqual(Object.keys(ATT).sort());
    const entry = props.attested_content_sha256.items;
    expect(entry.additionalProperties).toBe(false);
    expect([...entry.required].sort()).toEqual(["attested_on", "sha256"]);
    expect(props.attested_content_sha256.minItems).toBe(1);
    expect(props.cc0_rights_held.const).toBe(true);
  });
  it("its patterns accept the real values and reject the malformed ones", () => {
    const re = (p: string): RegExp => new RegExp(p);
    const entry = props.attested_content_sha256.items.properties;
    expect(re(props.attested_on.pattern).test(ATT.attested_on)).toBe(true);
    expect(re(props.tos_effective.pattern).test(ATT.tos_effective)).toBe(true);
    expect(re(props.decision_ref.pattern).test(ATT.decision_ref)).toBe(true);
    expect(re(props.publishing_entity.pattern).test("TKMD")).toBe(true);
    expect(re(entry.sha256.pattern).test(ATT.attested_content_sha256[0].sha256)).toBe(true);
    expect(re(props.attested_on.pattern).test("2026-1-1")).toBe(false);
    expect(re(props.decision_ref.pattern).test("zzz")).toBe(false);
    expect(re(entry.sha256.pattern).test("ABC")).toBe(false);
    expect(re(props.publishing_entity.pattern).test("a b")).toBe(false);
  });
});
