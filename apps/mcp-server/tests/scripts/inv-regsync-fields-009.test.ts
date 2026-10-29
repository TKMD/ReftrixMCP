// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-REGSYNC-FIELDS-009 — scripts/ci/registry-fields-check.sh (synced leg)
 *
 * Everything in server.json must be publishable information: a key allowlist (anything else
 * fails), value rules over every string, the description length, the repository URL, the
 * `name` prefix `io.github.<publishing_entity>/` and the deprecation message. Offending keys
 * are named by path; values are never echoed. The real server.json must pass.
 * Not covered here (workflow files do not exist yet): "fields-check is also present in
 * registry-publish" lands with the registry-sync.yml PR.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(REPO_ROOT, "scripts/ci/registry-fields-check.sh");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "server.json"), "utf-8")) as Record<
  string,
  any
>;

const good = (): Record<string, any> => ({
  $schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "io.github.TKMD/example-server",
  description: "Example server with 40 tools",
  repository: { url: "https://github.com/TKMD/ReftrixMCP", source: "github" },
  version: "1.2.3",
  packages: [
    {
      registryType: "npm",
      identifier: "@example/pkg",
      version: "1.2.3",
      transport: { type: "stdio" },
      environmentVariables: [
        {
          name: "DATABASE_URL",
          description: "PostgreSQL connection string",
          isRequired: true,
          format: "string",
          isSecret: true,
        },
        {
          name: "NODE_ENV",
          description: "Node environment",
          isRequired: false,
          format: "string",
          isSecret: false,
        },
      ],
    },
  ],
});

const check = (
  doc: unknown,
  entity = "TKMD",
  message?: string
): { status: number | null; stderr: string; stdout: string } => {
  const dir = mkdtempSync(join(tmpdir(), "fields-"));
  try {
    const f = join(dir, "server.json");
    writeFileSync(f, typeof doc === "string" ? doc : JSON.stringify(doc));
    const r = spawnSync("bash", [SCRIPT, f, entity, ...(message === undefined ? [] : [message])], {
      encoding: "utf-8",
      timeout: 20_000,
    });
    return { status: r.status, stderr: r.stderr, stdout: r.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const mutate = (fn: (d: Record<string, any>) => void): Record<string, any> => {
  const d = good();
  fn(d);
  return d;
};

describe("INV-REGSYNC-FIELDS-009: allowlist and value rules", () => {
  it("accepts a conforming file and the real server.json", () => {
    expect(check(good()).status).toBe(0);
    expect(check(REAL).status).toBe(0);
  });
  it("accepts a conforming deprecation message", () => {
    expect(check(good(), "TKMD", "Superseded by a newer release.").status).toBe(0);
  });

  describe("key allowlist", () => {
    const rows: Array<[string, (d: Record<string, any>) => void, string]> = [
      ["top-level key", (d) => (d.license = "AGPL-3.0-only"), "$.license"],
      ["_meta", (d) => (d._meta = {}), "$._meta"],
      ["repository key", (d) => (d.repository.id = "x"), "$.repository.id"],
      ["package key", (d) => (d.packages[0].runtimeHint = "npx"), "$.packages[0].runtimeHint"],
      ["transport key", (d) => (d.packages[0].transport.url = "x"), "$.packages[0].transport.url"],
      [
        "env var value",
        (d) => (d.packages[0].environmentVariables[1].value = "development"),
        "environmentVariables[1].value",
      ],
      [
        "env var default",
        (d) => (d.packages[0].environmentVariables[1].default = "development"),
        "environmentVariables[1].default",
      ],
      [
        "env var _meta",
        (d) => (d.packages[0].environmentVariables[0]._meta = {}),
        "environmentVariables[0]._meta",
      ],
    ];
    it.each(rows)("rejects %s", (_n, fn, path) => {
      const r = check(mutate(fn));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(path);
      expect(r.stderr).toContain("not in allowlist");
    });
    it("rejects a secret entry that carries a value", () => {
      const r = check(
        mutate((d) => (d.packages[0].environmentVariables[0].value = "postgres://x"))
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("secret entry carries a value");
    });
    it("rejects wrong shapes (repository, packages, environmentVariables)", () => {
      expect(check(mutate((d) => (d.repository = "x"))).status).toBe(1);
      expect(check(mutate((d) => (d.packages = {}))).status).toBe(1);
      expect(check(mutate((d) => (d.packages[0].environmentVariables = "x"))).status).toBe(1);
    });
  });

  describe("value rules over every string", () => {
    // token-shaped and URL-credential fixtures are assembled at run time so the runbook secret_scan pattern 10 does not flag this file
    const secrets: Array<[string, string, string]> = [
      ["e-mail", "contact someone@example.com", "e-mail address"],
      ["/home/ path", "see /home/alice/notes", "absolute local path"],
      ["/Users/ path", "see /Users/alice/notes", "absolute local path"],
      ["Windows path", "see C:\\Users\\alice", "absolute local path"],
      ["file URL", "file:///etc/passwd", "file:// URL"],
      ["FILE URL (upper case)", "FILE:///etc/x", "file:// URL"],
      ["file:/ without slashes", "file:/home2/x", "file:// URL"],
      ["URL credentials", ["https://user", "pw@host.example/x"].join(":"), "credentials in a URL"],
      ["URL token", "https://tok@host.example/x", "credentials in a URL"],
      ["PEM", ["-----BEGIN", "PRIVATE KEY-----"].join(" "), "PEM header"],
      ["ghp_ token", ["gh", "p_abcdefghijklmnop"].join(""), "token prefix"],
      ["AWS key", ["AKIA", "ABCDEFGHIJKLMNOP"].join(""), "token prefix"],
      ["slack token", ["xox", "b-1234"].join(""), "token prefix"],
    ];
    it.each(secrets)(
      "rejects %s in an env var description, naming the path not the value",
      (_n, text, rule) => {
        const r = check(mutate((d) => (d.packages[0].environmentVariables[1].description = text)));
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(`packages.0.environmentVariables.1.description: ${rule}`);
        expect(r.stderr).not.toContain(text);
      }
    );
    it("applies to the top-level description and $schema too", () => {
      expect(check(mutate((d) => (d.description = "mail me@example.com"))).status).toBe(1);
      expect(check(mutate((d) => (d.$schema = "file:///x"))).status).toBe(1);
    });
    it("does not flag a scoped package name or a localhost URL", () => {
      const d = mutate((x) => {
        x.packages[0].environmentVariables[1].description =
          "API base URL (default: http://localhost:11434)";
      });
      expect(check(d).status).toBe(0);
    });
  });

  describe("leaf types of known keys", () => {
    const e = (d: Record<string, any>): Record<string, any>[] => d.packages[0].environmentVariables;
    const rows: Array<[string, (d: Record<string, any>) => void, string]> = [
      ["transport.type", (d) => (d.packages[0].transport.type = {}), "transport.type: type"],
      ["env description", (d) => (e(d)[1].description = {}), "[1].description: type"],
      [
        "environmentVariables",
        (d) => (d.packages[0].environmentVariables = false),
        "Variables: type",
      ],
      ["isSecret", (d) => (e(d)[0].isSecret = "x"), "[0].isSecret: type"],
    ];
    it.each(rows)("rejects a wrong type for %s", (_n, fn, msg) => {
      const r = check(mutate(fn));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(msg);
    });
  });

  describe("description, repository and name", () => {
    it("accepts a 100-character description and rejects 101", () => {
      expect(check(mutate((d) => (d.description = "a".repeat(100)))).status).toBe(0);
      const r = check(mutate((d) => (d.description = "a".repeat(101))));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("$.description");
    });
    it("rejects an empty or missing description", () => {
      expect(check(mutate((d) => (d.description = ""))).status).toBe(1);
      expect(check(mutate((d) => delete d.description)).status).toBe(1);
    });
    it("requires the expected repository URL", () => {
      const r = check(mutate((d) => (d.repository.url = "https://github.com/other/repo")));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("$.repository.url");
    });
    const names: Array<[string, string, string, number]> = [
      ["matching owner", "io.github.TKMD/example-server", "TKMD", 0],
      ["other owner than the entity", "io.github.other/example-server", "TKMD", 1],
      ["entity is a prefix of the owner", "io.github.TKMDX/example-server", "TKMD", 1],
      ["no namespace", "example-server", "TKMD", 1],
      ["wrong host", "io.gitlab.TKMD/example-server", "TKMD", 1],
      ["uppercase slug", "io.github.TKMD/Example", "TKMD", 1],
      ["nested slug", "io.github.TKMD/a/b", "TKMD", 1],
      ["entity differs", "io.github.TKMD/example-server", "other", 1],
    ];
    it.each(names)("name %s", (_n, name, entity, status) => {
      expect(
        check(
          mutate((d) => (d.name = name)),
          entity
        ).status
      ).toBe(status);
    });
    it("rejects a name with a trailing newline", () => {
      expect(check(mutate((d) => (d.name = "io.github.TKMD/x\n"))).status).toBe(1);
    });
    it("rejects a bad publishing_entity argument as bad input (exit 2)", () => {
      expect(check(good(), "TK MD").status).toBe(2);
    });
  });

  describe("deprecation message", () => {
    it("accepts 500 characters, rejects 501 and empty", () => {
      expect(check(good(), "TKMD", "m".repeat(500)).status).toBe(0);
      expect(check(good(), "TKMD", "m".repeat(501)).status).toBe(1);
      expect(check(good(), "TKMD", "").status).toBe(1);
    });
    it("applies the value rules to the message without echoing it", () => {
      const r = check(good(), "TKMD", "ask me@example.com");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("deprecation message: e-mail address");
      expect(r.stderr).not.toContain("me@example.com");
    });
  });

  describe("bad input", () => {
    it.each([["[]"], ["not json"], [""], ["{} {}"]])("rejects %j as bad input (exit 2)", (doc) => {
      expect(check(doc).status).toBe(2);
    });
  });
});
