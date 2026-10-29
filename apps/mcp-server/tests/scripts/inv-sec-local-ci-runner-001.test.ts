// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-SEC-LOCAL-CI-RUNNER-001
 *
 * Table test for `scripts/oss-sync-local-ci.py` (local CI reproduction used by the OSS sync gate): start-up env / URL / port checks.
 * The runner is executed as-is (`python3 scripts/oss-sync-local-ci.py plan|run`) on synthetic workflow
 * fixtures in a temp dir; `psql` is a stub on a private PATH. docker / own container / run_id are added in a later PR.
 * Spec tags: [S3] psql tokens, [S4] PGPORT / PGHOST, [S5] MODEL_CACHE_DIR, [S6] fixed live ports, [A-01] strict URL hosts (SEC-A2-01),
 * [A-02] DATABASE_URL / REDIS_URL and step env values, [A-03] valid_port, [A1] redis single plain host + REDIS_HOST / REDIS_PORT.
 * Every env value of a step is also matched with the legacy `[:=]<live port>` form; a URL that is not a strict single plain host
 * (several redis hosts, a non-IPv6 `[...]`, U+00A0 prefix) counts as "no port" = the default port (a hit in a step, a stop at start-up).
 * The runner injects REDIS_HOST / REDIS_PORT (derived from the effective REDIS_URL); an explicit one that differs stops the run.
 * NOTE: a live port in the inherited environment (e.g. 5432) makes every step STOP (rc 125); the injection overrides REDIS_HOST / REDIS_PORT only.
 * Output-format contract defined here (the implementer follows it):
 *   - live ports are the fixed set 26432 / 27379 / 5432
 *   - start-up stop: `local_ci stop reason=<reason>` (rc 2; no clone / summary line; nothing runs). Reasons:
 *     env_file_lacks_pgport_or_pghost | env_file_lacks_model_cache_dir | pgport_invalid | env_file_pgport_live |
 *     env_file_lacks_db_redis_url | env_file_url_port_live | env_file_redis_host_port_mismatch
 *   - a step whose env values (PORT-suffixed keys as integers, postgres / redis URLs incl. several hosts, ?port=, absent port = default port)
 *     or whose tokens after `psql` carry a live port -> `kind=run rc=125 reason=live_port`, counted in `live_port_hits`
 *   - clone / summary lines keep the existing field order (the summary still ends with ` bd_needs_approval=<n> live_port_hits=<n>`)
 *
 * @module tests/scripts/inv-sec-local-ci-runner-001
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../..");
const RUNNER = join(REPO_ROOT, "scripts/oss-sync-local-ci.py");

interface Step {
  name: string;
  run?: string;
  env?: Record<string, string>;
}

interface Opts {
  ci: Step[];
  wfEnv?: Record<string, string>;
  /** merged over the default env-file; null removes the key. "@MC" populated cache, "@EMPTYDIR", "@MISSING". */
  env?: Record<string, string | null>;
  extra?: string[];
  /** extra environment of the runner process (inherited environment) */
  stubEnv?: Record<string, string>;
}

interface Result {
  rc: number | null;
  meta: string[];
  stubLog: string[];
  logDir: string;
  line: (name: string) => Record<string, string> | undefined;
  summary: () => Record<string, string> | undefined;
  raw: (re: RegExp) => string[];
}

const BASE_TOOLS = ["ls", "git", "bash", "env", "cat", "sh", "mkdir", "touch", "rm", "dirname"];
const STUBS: Record<string, string> = {
  psql: `#!/bin/bash
echo "psql $*" >> "$STUB_LOG"
exit 0
`,
};

let root = "";
let stubDir = "";
let python = "";
const sh = (cmd: string): string => execFileSync("sh", ["-c", cmd], { encoding: "utf8" }).trim();

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "local-ci-runner-"));
  stubDir = join(root, "stubs");
  mkdirSync(stubDir);
  for (const [n, body] of Object.entries(STUBS)) {
    const p = join(stubDir, n);
    writeFileSync(p, body);
    chmodSync(p, 0o755);
  }
  python = sh("command -v python3");
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

let seq = 0;
const kv = (line: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/(\w+)=("[^"]*"|\S+)/g)) out[m[1] ?? ""] = m[2] ?? "";
  return out;
};
const wfDoc = (name: string, steps: Step[], env?: Record<string, string>): string =>
  JSON.stringify({
    name,
    on: { push: {} },
    ...(env ? { env } : {}),
    jobs: {
      main: {
        "runs-on": "ubuntu-latest",
        steps: steps.map((s) => ({
          name: s.name,
          ...(s.run !== undefined ? { run: s.run } : {}),
          ...(s.env ? { env: s.env } : {}),
        })),
      },
    },
  });
const git = (repo: string, ...a: string[]): string =>
  execFileSync(
    "git",
    ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a],
    {
      encoding: "utf8",
    }
  ).trim();

function commitAll(repo: string, msg: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", msg);
  return git(repo, "rev-parse", "HEAD");
}

function binDir(w: string, tools: string[]): string {
  const bin = join(w, "bin");
  mkdirSync(bin, { recursive: true });
  for (const t of BASE_TOOLS) symlinkSync(sh(`command -v ${t}`), join(bin, t));
  for (const t of tools) symlinkSync(join(stubDir, t), join(bin, t));
  return bin;
}

function envFile(
  w: string,
  mc: Record<string, string>,
  over: Record<string, string | null> | undefined
): string {
  const m: Record<string, string | null> = {
    PGPORT: "15432",
    PGHOST: "127.0.0.1",
    DATABASE_URL: "postgres://u@127.0.0.1:15432/db",
    REDIS_URL: "redis://127.0.0.1:16379",
    MODEL_CACHE_DIR: "@MC",
    ...over,
  };
  const lines: string[] = [];
  for (const [k, v] of Object.entries(m)) {
    if (v === null) continue;
    lines.push(`${k}=${v.startsWith("@") ? (mc[v] ?? v) : v}`);
  }
  const p = join(w, `env-${++seq}.txt`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

function runCase(o: Opts): Result {
  const w = mkdtempSync(join(root, "case-"));
  const repo = join(w, "repo");
  const wfDir = join(repo, ".github", "workflows");
  mkdirSync(wfDir, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(wfDir, "ci.yml"), wfDoc("ci", o.ci, o.wfEnv));
  writeFileSync(
    join(wfDir, "regression-standing.yml"),
    wfDoc("regression-standing", [{ name: "noop-regression", run: "true" }])
  );
  writeFileSync(join(repo, "README.md"), "x\n");
  commitAll(repo, "first");
  const mcDir = join(w, "mc");
  mkdirSync(mcDir);
  writeFileSync(join(mcDir, "model.onnx"), "x");
  const emptyDir = join(w, "mc-empty");
  mkdirSync(emptyDir);
  const mc = { "@MC": mcDir, "@EMPTYDIR": emptyDir, "@MISSING": join(w, "no-such-dir") };

  const stubLogPath = join(w, "stub.log");
  writeFileSync(stubLogPath, "");
  const bin = binDir(w, ["psql"]);
  const env: Record<string, string> = {
    PATH: bin,
    HOME: w,
    LANG: "C.UTF-8",
    STUB_LOG: stubLogPath,
    ...o.stubEnv,
  };
  const meta = join(w, "meta.txt");
  const expected = join(w, "expected.tsv");
  const logDir = join(w, "logs");
  const plan = spawnSync(
    python,
    [RUNNER, "plan", "--repo", repo, "--out", expected, "--meta", meta],
    { env, encoding: "utf8" }
  );
  if (plan.status !== 0) throw new Error(`plan failed: ${plan.stderr}`);
  const r = spawnSync(
    python,
    [
      RUNNER,
      "run",
      "--repo",
      repo,
      "--expected",
      expected,
      "--meta",
      meta,
      "--log-dir",
      logDir,
      "--env-file",
      envFile(w, mc, o.env),
      ...(o.extra ?? []),
    ],
    { env, encoding: "utf8", timeout: 60_000 }
  );
  const lines = readFileSync(meta, "utf8").split("\n").filter(Boolean);
  const stubLog = readFileSync(stubLogPath, "utf8").split("\n").filter(Boolean);
  return {
    rc: r.status,
    meta: lines,
    stubLog,
    logDir,
    line: (name) => {
      const l = lines.find((x) => x.startsWith("local_ci wf=") && x.includes(` name="${name}"`));
      return l ? kv(l) : undefined;
    },
    summary: () => {
      const l = [...lines].reverse().find((x) => x.startsWith("local_ci summary "));
      return l ? kv(l) : undefined;
    },
    raw: (re) => lines.filter((x) => re.test(x)),
  };
}
const step = (name: string, run: string, env?: Record<string, string>): Step => ({
  name,
  run,
  ...(env ? { env } : {}),
});
// redis URLs that are not a single plain host; how Node `new URL(u)` reads each one:
//  [0] "redis://h:16379,h:16380"  -> Invalid URL (port "16379,h" is not numeric)
//  [1] "redis://[1.2.3.4]:16379"  -> Invalid URL (brackets need an IPv6 literal)
//  [2] "redis://[1:2]:16379"      -> Invalid URL (too few IPv6 groups)
//  [3] "redis://[:]:16379"        -> Invalid URL
//  [4] "\u00a0redis://127.0.0.1:16379" -> Invalid URL (only C0 controls and space are stripped, not U+00A0)
//  [5] "redis://[fe80::1%eth0]:16379"   -> Invalid URL (no zone id in a URL host)
const REDIS_BAD = [
  "redis://h:16379,h:16380",
  "redis://[1.2.3.4]:16379",
  "redis://[1:2]:16379",
  "redis://[:]:16379",
  "\u00a0redis://127.0.0.1:16379",
  "redis://[fe80::1%eth0]:16379",
];
const nb = (u: string): string => u.replace("\u00a0", "<nbsp>");
const logOf = (r: Result): string => readFileSync(join(r.logDir, "ci-main-1.log"), "utf8");
const SHOW = `printf '%s|%s' "$REDIS_HOST" "$REDIS_PORT"`;
let plain: Result; // one shared clean run (a single `true` step)
beforeAll(() => {
  plain = runCase({ ci: [step("plain", "true")] });
});

describe("INV-SEC-LOCAL-CI-RUNNER-001", () => {
  it("should have python3 with PyYAML available (fails, never skips)", () => {
    const r = spawnSync("python3", ["-c", "import yaml"], { encoding: "utf8" });
    expect(r.status).toBe(0);
  });

  describe("baseline output contract (verdict sed in the runbook is coupled to it)", () => {
    it("should keep clone / summary field order and end the summary with live_port_hits", () => {
      expect(plain.rc).toBe(0);
      const clone = plain.raw(/^local_ci clone head=/)[0] ?? "";
      expect(clone).toMatch(
        /^local_ci clone head=[0-9a-f]{40} runner_sha256=[0-9a-f]{64} expected_sha256=[0-9a-f]{64}$/
      );
      const sum = plain.raw(/^local_ci summary /)[0] ?? "";
      expect(sum).toMatch(/ match=1 nonzero=0 /);
      expect(sum).toMatch(/ bd_needs_approval=0 live_port_hits=0$/);
    });
  });

  describe("start-up checks stop the run (rc 2, stop line, no clone / summary)", () => {
    const stopCases: Array<[string, string, Record<string, string | null>, Partial<Opts>?]> = [
      ["[S4] PGPORT missing", "env_file_lacks_pgport_or_pghost", { PGPORT: null }],
      ["[S4] PGHOST missing", "env_file_lacks_pgport_or_pghost", { PGHOST: null }],
      [
        "[S5] MODEL_CACHE_DIR missing from the env-file",
        "env_file_lacks_model_cache_dir",
        { MODEL_CACHE_DIR: null },
      ],
      [
        "[S5] MODEL_CACHE_DIR empty value",
        "env_file_lacks_model_cache_dir",
        { MODEL_CACHE_DIR: "" },
      ],
      [
        "[S5] MODEL_CACHE_DIR points to a missing dir",
        "env_file_lacks_model_cache_dir",
        { MODEL_CACHE_DIR: "@MISSING" },
      ],
      [
        "[S5] MODEL_CACHE_DIR dir holds 0 files",
        "env_file_lacks_model_cache_dir",
        { MODEL_CACHE_DIR: "@EMPTYDIR" },
      ],
      ["[S6] PGPORT is the live dev PostgreSQL port", "env_file_pgport_live", { PGPORT: "26432" }],
      ["[S6] PGPORT is the live dev Redis port", "env_file_pgport_live", { PGPORT: "27379" }],
      ["[S6] PGPORT is 5432 (listening on this host)", "env_file_pgport_live", { PGPORT: "5432" }],
      [
        "[S6] --env PGPORT= overrides the env-file with a live port",
        "env_file_pgport_live",
        {},
        { extra: ["--env", "PGPORT=26432"] },
      ],
      ["[A-03] PGPORT leading zero", "pgport_invalid", { PGPORT: "026432" }],
      ["[A-03] PGPORT with a sign", "pgport_invalid", { PGPORT: "+26432" }],
      ["[A-03] PGPORT list", "pgport_invalid", { PGPORT: "26432,55432" }],
      ["[A-03] PGPORT above 65535", "pgport_invalid", { PGPORT: "70000" }],
      ["[A-03] --env PGPORT= (empty)", "pgport_invalid", {}, { extra: ["--env", "PGPORT="] }],
      ["[A-02] DATABASE_URL missing", "env_file_lacks_db_redis_url", { DATABASE_URL: null }],
      ["[A-02] REDIS_URL missing", "env_file_lacks_db_redis_url", { REDIS_URL: null }],
      [
        "[A-02] REDIS_URL without a port",
        "env_file_lacks_db_redis_url",
        { REDIS_URL: "redis://h" },
      ],
      [
        "[A-02] DATABASE_URL without a port",
        "env_file_lacks_db_redis_url",
        { DATABASE_URL: "postgresql://localhost/x" },
      ],
      [
        "[A-02] DATABASE_URL wrong scheme",
        "env_file_lacks_db_redis_url",
        { DATABASE_URL: "x://h:1" },
      ],
      [
        "[A-02] DATABASE_URL port is not a valid port",
        "env_file_lacks_db_redis_url",
        { DATABASE_URL: "postgres://h:026432/x" },
      ],
      [
        "[A-01] REDIS_URL host with a space before the port",
        "env_file_lacks_db_redis_url",
        { REDIS_URL: "redis://127.0.0.1 :16379" },
      ],
      [
        "[A-01] REDIS_URL host with ^",
        "env_file_lacks_db_redis_url",
        { REDIS_URL: "redis://h^x:16379" },
      ],
      [
        "[A-01] DATABASE_URL host with |",
        "env_file_lacks_db_redis_url",
        { DATABASE_URL: "postgres://h|x:15432/db" },
      ],
      [
        "[A-02] DATABASE_URL port is the live dev PostgreSQL port",
        "env_file_url_port_live",
        { DATABASE_URL: "postgres://u@127.0.0.1:26432/db" },
      ],
      [
        "[A-02] DATABASE_URL port is 5432",
        "env_file_url_port_live",
        { DATABASE_URL: "postgresql://u@127.0.0.1:5432/db" },
      ],
      [
        "[A-02] REDIS_URL port is the live dev Redis port",
        "env_file_url_port_live",
        { REDIS_URL: "redis://127.0.0.1:27379" },
      ],
      ["[A1] PGPORT leading zero, 5 digits", "pgport_invalid", { PGPORT: "05432" }],
      [
        "[A1] DATABASE_URL port leading zero, 5 digits",
        "env_file_lacks_db_redis_url",
        { DATABASE_URL: "postgres://h:05432/x" },
      ],
      ...REDIS_BAD.map((u): [string, string, Record<string, string | null>] => [
        `[A1] REDIS_URL not a single plain host: ${nb(u)}`,
        "env_file_lacks_db_redis_url",
        { REDIS_URL: u },
      ]),
      ["[A1] REDIS_PORT differs", "env_file_redis_host_port_mismatch", { REDIS_PORT: "16380" }],
      ["[A1] REDIS_HOST differs", "env_file_redis_host_port_mismatch", { REDIS_HOST: "other" }],
      [
        "[A1] --env REDIS_PORT= differs",
        "env_file_redis_host_port_mismatch",
        {},
        { extra: ["--env", "REDIS_PORT=16380"] },
      ],
      [
        "[A1] REDIS_PORT is not a number",
        "env_file_redis_host_port_mismatch",
        { REDIS_PORT: "\u00b2" },
      ],
      [
        "[A-02] DATABASE_URL second host is live",
        "env_file_url_port_live",
        { DATABASE_URL: "postgres://h1:15432,h2:26432/db" },
      ],
      [
        "[A-02] DATABASE_URL ?port= is live",
        "env_file_url_port_live",
        { DATABASE_URL: "postgres://h:15432/db?port=26432" },
      ],
    ];

    it.each(stopCases)("%s", (_n, reason, env, more) => {
      const r = runCase({
        ci: [step("must-not-run", 'echo ran > "$RUNNER_TEMP/ran"')],
        env,
        ...more,
      });
      expect(r.rc).toBe(2);
      const stops = r.raw(/^local_ci stop /);
      expect(stops).toHaveLength(1);
      expect(stops[0]).toBe(`local_ci stop reason=${reason}`);
      expect(r.raw(/^local_ci (clone|summary) /)).toHaveLength(0);
      expect(existsSync(join(r.logDir, "runner-temp", "ran"))).toBe(false);
    });
  });

  describe("[A-02] step env values are checked as numbers and URLs", () => {
    const cases: Array<[string, Record<string, string>, Record<string, string>]> = [
      ["inherited CACHE_PORT=27379", {}, { CACHE_PORT: "27379" }],
      [
        "port list with a live port after ?port=",
        { U: "postgres://h:55432/x?port=55432,26432" },
        {},
      ],
      ...REDIS_BAD.map((u): [string, Record<string, string>, Record<string, string>] => [
        `redis URL not a single plain host: ${nb(u)}`,
        { U: u },
        {},
      ]),
      ["redis URL without a port", { U: "redis://localhost" }, {}],
      ["postgres URL without a port", { U: "postgres://localhost/x" }, {}],
      ["postgresql URL without a port", { U: "postgresql://localhost/x" }, {}],
      ["postgresql multi-host", { U: "postgresql://h1:55432,h2:26432/x" }, {}],
      ["URL second host port with a leading zero", { U: "postgresql://h1:55432,h2:026432/x" }, {}],
      ["redis URL port with a leading zero", { U: "redis://h:027379" }, {}],
      ["?port= query", { U: "postgres://h:55432/x?port=26432" }, {}],
      ["port with a leading zero", { X_PORT: "026432" }, {}],
      ["PORT list", { X_PORT: "55432,26432" }, {}],
      ["PORT 5432", { X_PORT: "5432" }, {}],
      ["host with a space before the port", { U: "redis://127.0.0.1 :16379" }, {}],
      ["host with ^", { U: "redis://h^x:16379" }, {}],
      ["host with |", { U: "redis://h|x:16379" }, {}],
      ["legacy host:port form", { X: "localhost:26432" }, {}],
    ];
    it.each(cases)("should refuse (rc 125, live_port): %s", (_n, stepEnv, stubEnv) => {
      const r = runCase({ ci: [step("p", "true", stepEnv)], stubEnv });
      expect(r.line("p")?.["rc"]).toBe("125");
      expect(r.line("p")?.["reason"]).toBe("live_port");
      // an inherited value reaches both workflow steps (p + noop-regression); a step env value only step p
      expect(r.summary()?.["live_port_hits"]).toBe(Object.keys(stubEnv).length > 0 ? "2" : "1");
    });

    it("should refuse a live port that the workflow env hands to the step", () => {
      const r = runCase({
        ci: [step("p", "true")],
        wfEnv: { DB_PORT: "26432" },
      });
      expect(r.line("p")?.["rc"]).toBe("125");
    });

    it("should not crash on a non-ASCII digit in a PORT value", () => {
      const r = runCase({ ci: [step("p", "true", { X_PORT: "\u00b2" })] });
      expect(r.line("p")?.["rc"]).toBe("0");
      expect(r.summary()).toBeDefined();
    });

    const safe: Array<[string, Record<string, string>]> = [
      ["PORT 55432", { X_PORT: "55432" }],
      ["postgres URL with an own port", { U: "postgres://h:55432/x" }],
      ["redis URL with an own port", { U: "redis://h:16379" }],
      ["a value that only mentions the port", { NOTE: "port 26432 is only text" }],
      ["redis URL with an IPv6 literal", { U: "redis://[::1]:16379" }],
    ];
    it.each(safe)("should run a step that carries no live port: %s", (_n, stepEnv) => {
      const r = runCase({ ci: [step("p", "true", stepEnv)] });
      expect(r.line("p")?.["rc"]).toBe("0");
      expect(r.summary()?.["live_port_hits"]).toBe("0");
    });
  });

  describe("[S3] psql port judgement", () => {
    const live: string[] = [
      `psql -h "$PGHOST" -p 27379 -c 'select 1'`,
      `psql --port=26432 -c x`,
      `psql --port 26432 -c x`,
      `psql -p26432 -c x`,
      `PGPASSWORD=x psql -p 27379 -d d`,
      `ls -p; psql -p 27379 -c x`,
      `psql 'postgresql://u@127.0.0.1:26432/db' -c x`,
      `echo ok && psql "host=127.0.0.1 port=26432 dbname=x" -c y`,
      `psql -p 026432 -c x`,
      `psql --port=26432,55432 -c x`,
      `psql -p 70000 -c x`,
      `psql -p 05432 -c x`,
      `psql "" -p 26432 -c x`,
    ];
    it.each(live)(
      "should refuse (rc 125, live_port) when the psql tokens carry a live port: %s",
      (cmd) => {
        const r = runCase({ ci: [step("psql-live", cmd)] });
        const l = r.line("psql-live");
        expect(l?.["rc"]).toBe("125");
        expect(l?.["reason"]).toBe("live_port");
        expect(r.summary()?.["live_port_hits"]).toBe("1");
        expect(r.stubLog.filter((x) => x.startsWith("psql "))).toHaveLength(0);
        expect(r.rc).toBe(1);
      }
    );

    const safe: string[] = [
      `psql -h "$PGHOST" -p 55432 -c x`,
      `echo -p 27379; psql -p 55432 -c x`,
      `psql -c x`,
      `echo "port 26432 is only text"`,
    ];
    it.each(safe)("should run when no token after psql carries a live port: %s", (cmd) => {
      const r = runCase({ ci: [step("psql-safe", cmd)] });
      const l = r.line("psql-safe");
      expect(l?.["rc"]).toBe("0");
      expect(r.summary()?.["live_port_hits"]).toBe("0");
    });
  });

  describe("[A1] REDIS_HOST / REDIS_PORT are injected from the effective REDIS_URL", () => {
    const show = (o: Partial<Opts>): Result => runCase({ ci: [step("p", SHOW)], ...o });
    it("should expose the derived host / port to a step", () => {
      expect(logOf(show({}))).toBe("127.0.0.1|16379");
    });
    it("should override an inherited REDIS_HOST / REDIS_PORT", () => {
      const r = show({ stubEnv: { REDIS_HOST: "localhost", REDIS_PORT: "6379" } });
      expect(logOf(r)).toBe("127.0.0.1|16379");
    });
    it("should not refuse an inherited REDIS_PORT=27379 (it is replaced)", () => {
      const r = show({ stubEnv: { REDIS_PORT: "27379" } });
      expect(r.line("p")?.["rc"]).toBe("0");
      expect(logOf(r)).toBe("127.0.0.1|16379");
    });
    it("should derive from a --env REDIS_URL override", () => {
      const r = show({ extra: ["--env", "REDIS_URL=redis://127.0.0.1:16390"] });
      expect(logOf(r)).toBe("127.0.0.1|16390");
    });
    it("should hand an IPv6 host over without brackets", () => {
      expect(logOf(show({ env: { REDIS_URL: "redis://[::1]:16379" } }))).toBe("::1|16379");
    });
    it("should accept an explicit host / port that agrees (case-insensitive host, integer port)", () => {
      const env = {
        REDIS_URL: "redis://LocalHost:16379",
        REDIS_HOST: "localhost",
        REDIS_PORT: "016379",
      };
      const r = show({ env });
      expect(r.rc).toBe(0);
      expect(logOf(r)).toBe("LocalHost|16379");
    });
  });
});
