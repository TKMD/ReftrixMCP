// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-REGSYNC-IDEMPOTENT-003 — scripts/ci/registry-predetect.sh
 *
 * A version that is already registered is skipped only when the existing record is the same
 * package (name, registryType, identifier, version, repository.url); a different record is
 * immutable, so the run fails. 404 means publish; anything else (5xx, timeout, odd status,
 * unreadable body) is retried a bounded number of times and then fails closed, never read
 * as "not registered". All Registry traffic goes through the PATH shims.
 */
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers/npm-shim-harness";

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(REPO_ROOT, "scripts/ci/registry-predetect.sh");
const URL_ =
  "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.TKMD%2Fexample-server/versions/1.2.3";

const record = (over: Record<string, unknown> = {}): Record<string, any> => ({
  name: "io.github.TKMD/example-server",
  description: "Example server",
  version: "1.2.3",
  repository: { url: "https://github.com/TKMD/example", source: "github" },
  packages: [{ registryType: "npm", identifier: "@example/pkg", version: "1.2.3" }],
  ...over,
});

let h: Harness;
let file: string;
beforeEach(() => {
  h = createHarness();
  file = h.writeFile("server.json", JSON.stringify(record()));
});
afterEach(() => {
  h.cleanup();
});

const serve = (...entries: Array<string | Record<string, unknown>>): void => {
  const seq = entries.map((e, i) => {
    if (typeof e === "string") return e;
    h.setBody(`r${i}`, JSON.stringify(e));
    return `200@r${i}`;
  });
  h.setSequence(URL_, seq);
};
const run = (args: string[] = [file]): ReturnType<Harness["run"]> => h.run(SCRIPT, args);
const regCalls = (): string[] => h.calls().filter((c) => c.startsWith("curl "));

describe("INV-REGSYNC-IDEMPOTENT-003: pre-detect", () => {
  it("200 + same identity (bare record) -> skip-registered", () => {
    serve(record());
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("decision=skip-registered");
    expect(r.stdout).toContain("description_drift=false");
  });
  it("200 + same identity (wrapped in {server}) -> skip-registered", () => {
    serve({ server: record(), _meta: { status: "active" } });
    expect(run().stdout).toContain("decision=skip-registered");
  });
  it("asks the %2F version route over bounded https", () => {
    serve(record());
    run();
    expect(regCalls()).toEqual([`curl ${URL_}`]);
    const argv = h.argv()[0] ?? "";
    expect(argv).toContain("--max-time 20");
    expect(argv).toContain("--proto =https");
  });

  const mismatch: Array<[string, Record<string, unknown>, string]> = [
    ["name", { name: "io.github.TKMD/other-server" }, "name"],
    [
      "registryType",
      { packages: [{ registryType: "pypi", identifier: "@example/pkg", version: "1.2.3" }] },
      "registryType",
    ],
    [
      "identifier",
      { packages: [{ registryType: "npm", identifier: "@example/evil", version: "1.2.3" }] },
      "identifier",
    ],
    [
      "package version",
      { packages: [{ registryType: "npm", identifier: "@example/pkg", version: "9.9.9" }] },
      "version",
    ],
    [
      "repository.url",
      { repository: { url: "https://github.com/someone/else", source: "github" } },
      "url",
    ],
    ["missing packages", { packages: undefined }, "registryType,identifier,version"],
  ];
  it.each(mismatch)(
    "200 + %s differs -> fail naming the field, value not echoed",
    (_n, over, field) => {
      serve(record(over));
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`differs in: ${field}`);
      expect(r.stderr).toContain("immutable");
      expect(r.stdout).not.toContain("decision=");
      expect(r.stderr).not.toContain("someone/else");
      expect(r.stderr).not.toContain("@example/evil");
    }
  );

  it("description-only difference -> reported, not failed", () => {
    serve(record({ description: "Older description" }));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("decision=skip-registered");
    expect(r.stdout).toContain("description_drift=true");
    expect(r.stderr).toContain("::notice::");
  });

  it("404 -> publish, one probe, no sleep", () => {
    serve("404");
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("decision=publish");
    expect(regCalls()).toHaveLength(1);
    expect(h.sleeps()).toEqual([]);
  });

  describe("fails closed", () => {
    it.each([["503"], ["500"], ["429"], ["403"], ["timeout"]])(
      "persistent %s -> 3 bounded retries with backoff, then exit 1",
      (entry) => {
        serve(entry);
        const r = run();
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("not readable after 3 retries");
        expect(r.stdout).not.toContain("decision=");
        expect(regCalls()).toHaveLength(4);
        expect(h.sleeps()).toEqual([5, 10, 20]);
      }
    );
    it("503 then 404 -> publish", () => {
      serve("503", "404");
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("decision=publish");
      expect(h.sleeps()).toEqual([5]);
    });
    it("timeout then 200 + match -> skip-registered", () => {
      serve("timeout", record());
      expect(run().stdout).toContain("decision=skip-registered");
    });
    it.each([
      ["a JSON array", "[1]"],
      ["not JSON", "<html>"],
      ["empty", ""],
    ])("200 with %s body -> exit 1, never 'not registered'", (_n, body) => {
      h.setBody("raw", body);
      h.setSequence(URL_, ["200@raw"]);
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain("decision=");
    });
  });

  describe("--recheck (re-GET after a publish error)", () => {
    it("200 + match -> registered (the publish error lost nothing)", () => {
      serve(record());
      const r = run(["--recheck", file]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("decision=registered");
    });
    it("200 + mismatch -> fail", () => {
      serve(record({ name: "io.github.TKMD/other-server" }));
      expect(run(["--recheck", file]).status).toBe(1);
    });
    it("404 -> fail (nothing was registered)", () => {
      serve("404");
      const r = run(["--recheck", file]);
      expect(r.status).toBe(1);
      expect(r.stdout).not.toContain("decision=");
    });
  });

  describe("bad input makes no network call", () => {
    const bad: Array<[string, string]> = [
      ["unsafe name", JSON.stringify(record({ name: "io.github.TKMD/../x" }))],
      ["bad version", JSON.stringify(record({ version: "1.2" }))],
      ["top-level and package version differ", JSON.stringify(record({ version: "1.2.4" }))],
      ["not an object", "[]"],
    ];
    it.each(bad)("%s -> exit 2", (_n, content) => {
      const f = h.writeFile("bad.json", content);
      const r = run([f]);
      expect(r.status).toBe(2);
      expect(regCalls()).toEqual([]);
    });
    it("missing file / no argument -> exit 2", () => {
      expect(run([join(h.dir, "nope.json")]).status).toBe(2);
      expect(run([]).status).toBe(2);
      expect(regCalls()).toEqual([]);
    });
  });
});
