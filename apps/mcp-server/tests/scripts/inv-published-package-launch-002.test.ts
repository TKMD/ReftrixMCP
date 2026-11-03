// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-PUBLISHED-PACKAGE-LAUNCH-002 and INV-INFRA-PACKED-INSTALL-HARDENING-001 (shim, no network)
 *
 * scripts/ci/check-packed-launch.sh installs the packed tarballs in the hoisted layout (linked is out of scope) and starts the packed
 * mcp-server. This test drives it with a fake `npm` that unpacks the real tarballs, so every branch is
 * exercised without touching a registry: argv and environment of install / rebuild / launch, the single
 * `npm rebuild @prisma/client --foreground-scripts` path with its preconditions and postconditions, the
 * lockfile and on-disk checks against the tarballs, and the JSON-RPC launch.
 *
 * @module tests/scripts/inv-published-package-launch-002.test
 */
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
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/** 認証情報付きの DB URL を部品から組み立てる (secret scan に生の literal を残さない) / Build a credentialed DB URL from parts */
function dbUrl(password: string): string {
  const u = new URL("postgresql://127.0.0.1:1/db");
  u.username = "u";
  u.password = password;
  return u.href;
}

const REPO_ROOT = resolve(__dirname, "../../../..");
const SCRIPT = join(REPO_ROOT, "scripts/ci/check-packed-launch.sh");
const VERSION = "9.9.9-test.0";
const PKGS = ["core", "database", "ml", "webdesign-core", "mcp-server"];

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "packed-launch-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const put = (root: string, rel: string, body: string, mode?: number): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
  if (mode) chmodSync(join(root, rel), mode);
};

/** A fake mcp-server whose bin answers `initialize`; `mode` in the shim dir changes how it misbehaves. */
const FAKE_SERVER = `#!/usr/bin/env node
const fs = require("node:fs");
const v = require("../package.json").version;
const mode = fs.existsSync(process.env.SHIM_MODE_FILE || "/nonexistent") ? fs.readFileSync(process.env.SHIM_MODE_FILE, "utf8").trim() : "";
if (process.env.SHIM_LOG) fs.appendFileSync(process.env.SHIM_LOG, "LAUNCH_ENV " + Object.keys(process.env).sort().join(",") + "\\n");
if (mode === "hang") setTimeout(() => {}, 60000);
if (mode === "pollute") console.log("hello from the server");
let pending = "";
const reply = (id, result) => console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
process.stdin.on("data", (d) => {
  if (mode === "hang") return;
  pending += String(d);
  for (let i = pending.indexOf("\\n"); i >= 0; i = pending.indexOf("\\n")) {
    const m = JSON.parse(pending.slice(0, i));
    pending = pending.slice(i + 1);
    if (m.method === "initialize") reply(m.id, { serverInfo: { name: "reftrix", version: mode === "badversion" ? "0.0.0" : v } });
    else if (m.method === "tools/list") reply(m.id, { tools: mode === "nohealth" ? [{ name: "other" }] : [{ name: "system.health" }] });
    else if (m.method === "tools/call") {
      if (mode === "toolerror") console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: "db down" } }));
      else reply(m.id, mode === "toolisError" ? { isError: true, content: [] } : { content: [{ type: "text", text: "ok" }] });
      if (mode === "latenoise") setTimeout(() => console.log("late line that is not json-rpc"), 300);
    }
  }
});
`;

function packFixture(): string {
  const out = tmp();
  for (const p of PKGS) {
    const w = tmp();
    const name = `@reftrixmcp/${p}`;
    put(
      w,
      "package/package.json",
      JSON.stringify({
        name,
        version: VERSION,
        main: "dist/index.js",
        bin: p === "mcp-server" ? { "reftrix-mcp": "./dist/index.js" } : undefined,
        dependencies:
          p === "mcp-server"
            ? Object.fromEntries(
                PKGS.filter((x) => x !== "mcp-server").map((x) => [`@reftrixmcp/${x}`, VERSION])
              )
            : p === "webdesign-core"
              ? { "@reftrixmcp/core": VERSION }
              : {},
      })
    );
    put(
      w,
      "package/dist/index.js",
      p === "mcp-server" ? FAKE_SERVER : `module.exports = "${p}";\n`,
      0o755
    );
    expect(
      spawnSync("tar", ["-czf", join(out, `reftrixmcp-${p}-${VERSION}.tgz`), "-C", w, "package"])
        .status
    ).toBe(0);
  }
  return out;
}

/** The fake npm: records argv / env, unpacks the tarballs, writes package-lock.json, then misbehaves per mode. */
const SHIM_NPM = `#!/usr/bin/env bash
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
MODE="$(cat "$HERE/mode" 2>/dev/null || true)"
echo "ARGV $*" >> "$SHIM_LOG"
echo "ENV $(env | cut -d= -f1 | sort | tr '\\n' ',')" >> "$SHIM_LOG"
echo "NPMRC $(cat .npmrc 2>/dev/null | tr '\\n' ';')" >> "$SHIM_LOG"
echo "USERCONFIG_SIZE $(wc -c < "$npm_config_userconfig")" >> "$SHIM_LOG"
echo "GLOBALCONFIG $npm_config_globalconfig" >> "$SHIM_LOG"
case "$1" in
install)
  shift
  for a in "$@"; do case "$a" in *.tgz)
    name="$(tar -xzOf "$a" package/package.json | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).name')"
    mkdir -p "node_modules/$name"; tar -xzf "$a" -C "node_modules/$name" --strip-components=1
    sum="sha512-$(openssl dgst -sha512 -binary "$a" | base64 -w0)"
    res="file:$a"; [ "$MODE" = lock-mismatch ] && [ "$name" = "@reftrixmcp/ml" ] && res="https://registry.npmjs.org/x.tgz"
    [ "$MODE" = lock-integrity ] && [ "$name" = "@reftrixmcp/ml" ] && sum="sha512-AAAA"
    printf '%s\\t%s\\t%s\\n' "$name" "$res" "$sum" >> .lock.tsv ;; esac; done
  node -e 'const fs=require("fs");const p={};for(const l of fs.readFileSync(".lock.tsv","utf8").trim().split("\\n")){const[n,r,i]=l.split("\\t");p["node_modules/"+n]={version:"${VERSION}",resolved:r,integrity:i};}p["node_modules/@prisma/client"]={version:"6.19.2",resolved:"https://registry.npmjs.org/@prisma/client/-/client-6.19.2.tgz",integrity:"sha512-PRISMAINTEGRITYPLACEHOLDER0123456789"};fs.writeFileSync("package-lock.json",JSON.stringify({lockfileVersion:3,packages:p}))'
  mkdir -p node_modules/@prisma/client node_modules/.bin; echo '{"name":"@prisma/client","version":"6.19.2"}' > node_modules/@prisma/client/package.json; echo 'module.exports={}' > node_modules/@prisma/client/index.js
  ln -sf ../@reftrixmcp/mcp-server/dist/index.js node_modules/.bin/reftrix-mcp
  [ "$MODE" = prisma-present ] && mkdir -p node_modules/prisma
  [ "$MODE" = tampered ] && echo "// changed" >> node_modules/@reftrixmcp/core/dist/index.js
  [ "$MODE" = six ] && mkdir -p node_modules/@reftrixmcp/webdesign-core/node_modules/@reftrixmcp && cp -r node_modules/@reftrixmcp/core node_modules/@reftrixmcp/webdesign-core/node_modules/@reftrixmcp/core
  [ "$MODE" = cache-install ] || true
  mkdir -p "$npm_config_cache/_cacache"; echo x >> "$npm_config_cache/_cacache/entry-$$"
  ;;
rebuild)
  [ "$MODE" = rebuild-cache ] && echo y > "$npm_config_cache/_cacache/new-entry-$$"
  [ "$MODE" = rebuild-generate ] && echo "Running prisma generate for @prisma/client"
  if [ "$MODE" != rebuild-noop ]; then mkdir -p node_modules/.prisma/client; echo 'module.exports={}' > node_modules/.prisma/client/default.js; fi
  ;;
esac
`;

interface Run {
  rc: number;
  out: string;
  log: string[];
}
function launch(
  mode = "",
  opts: {
    cwd?: string;
    tmpRoot?: string;
    extraPathDir?: string;
    timeoutMs?: string;
    dbUrl?: string;
  } = {}
): Run {
  const tarballs = packFixture();
  const shim = tmp();
  put(shim, "npm", SHIM_NPM, 0o755);
  writeFileSync(join(shim, "mode"), mode);
  const log = join(tmp(), "shim.log");
  writeFileSync(log, "");
  const nodeBin = join(shim, "bin");
  mkdirSync(nodeBin);
  symlinkSync(process.execPath, join(nodeBin, "node"));
  if (opts.extraPathDir === "prisma") put(nodeBin, "prisma", "#!/bin/sh\n", 0o755);
  const r = spawnSync("bash", [SCRIPT, tarballs, VERSION], {
    encoding: "utf-8",
    cwd: opts.cwd ?? tmp(),
    env: {
      PATH: `${nodeBin}:${shim}:/usr/bin:/bin`,
      HOME: tmp(),
      SHIM_LOG: log,
      PACKED_LAUNCH_PASSTHROUGH: `SHIM_LOG SHIM_MODE_FILE PACKED_LAUNCH_QUIET_MS${opts.passthrough ? ` ${opts.passthrough}` : ""}`,
      ...(opts.beforeDays ? { PACKED_LAUNCH_BEFORE_DAYS: opts.beforeDays } : {}),
      PACKED_LAUNCH_QUIET_MS: "1000",
      SHIM_MODE_FILE: join(shim, "mode"),
      PACKED_LAUNCH_TMP_ROOT: opts.tmpRoot ?? tmp(),
      PACKED_LAUNCH_DATABASE_URL: opts.dbUrl === undefined ? dbUrl("p") : opts.dbUrl,
      PACKED_LAUNCH_RPC_TIMEOUT_MS: opts.timeoutMs ?? "5000",
      NODE_AUTH_TOKEN: "secret-token",
      NPM_TOKEN: "secret-token",
      GITHUB_TOKEN: "secret-token",
      NODE_PATH: "/nonexistent",
      npm_config_ignore_scripts: "false",
      PRISMA_SKIP_POSTINSTALL_GENERATE: "1",
      PRISMA_GENERATE_IN_POSTINSTALL: "1",
    },
  });
  return {
    rc: r.status ?? -1,
    out: `${r.stdout}${r.stderr}`,
    log: readFileSync(log, "utf-8").split("\n").filter(Boolean),
  };
}
const lines = (r: Run, p: string): string[] => r.log.filter((l) => l.startsWith(p));

describe("INV-PUBLISHED-PACKAGE-LAUNCH-002: the packed install starts the packed server", () => {
  it("passes in the hoisted layout, runs npm without npx, and starts the server from node_modules/.bin", () => {
    const r = launch();
    expect(r.out).toContain("RESULT PASS");
    expect(r.rc).toBe(0);
    expect(r.out).toMatch(/layout=hoisted/);
    expect(r.out).not.toMatch(/layout=linked/);
    expect(lines(r, "LAUNCH_ENV")).toHaveLength(1);
    expect(readFileSync(SCRIPT, "utf-8")).not.toMatch(/\bnpx\b/);
  });
  it("fails when system.health returns a JSON-RPC error, an isError result, or is not listed", () => {
    for (const mode of ["toolerror", "toolisError", "nohealth"]) {
      const r = launch(mode);
      expect(r.rc, mode).not.toBe(0);
      expect(r.out, mode).toContain("FAIL rpc");
    }
  });
  it("fails when a non-JSON-RPC line appears on stdout after the tool call (quiet window)", () => {
    const r = launch("latenoise");
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("not JSON-RPC");
  });
  it("fails on a version the server does not report", () => {
    expect(launch("badversion").rc).not.toBe(0);
  });
  it("fails on non-JSON-RPC output on stdout", () => {
    const r = launch("pollute");
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/stdout/i);
  });
  it("fails on a server that never answers", () => {
    expect(launch("hang", { timeoutMs: "1500" }).rc).not.toBe(0);
  });
  it("fails when a package resolves from a registry URL instead of file:", () => {
    expect(launch("lock-mismatch").rc).not.toBe(0);
  });
  it("fails when the lockfile integrity is not the tarball's sha512", () => {
    expect(launch("lock-integrity").rc).not.toBe(0);
  });
  it("fails when the lockfile says file: but the file on disk is not the tarball's (R-41)", () => {
    const r = launch("tampered");
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/on-disk/i);
  });
  it("fails when the transitive @reftrixmcp realpaths are not exactly 5", () => {
    const r = launch("six");
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/realpaths=6/);
  });
  it("refuses a temp dir inside a git work tree", () => {
    const repo = tmp();
    expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);
    const inside = join(repo, "scratch");
    mkdirSync(inside);
    const r = launch("", { cwd: repo, tmpRoot: inside });
    expect(r.rc).not.toBe(0);
    expect(r.log.filter((l) => l.startsWith("ARGV"))).toHaveLength(0);
  });
});

describe("INV-INFRA-PACKED-INSTALL-HARDENING-001: install, rebuild and launch are fenced", () => {
  it("install argv has --ignore-scripts and --before=<now-14d>; the temp .npmrc never carries ignore-scripts", () => {
    const r = launch();
    const installs = lines(r, "ARGV install");
    expect(installs).toHaveLength(1);
    for (const l of installs) {
      expect(l).toContain("--ignore-scripts");
      const m = /--before=(\S+)/.exec(l);
      expect(m).not.toBeNull();
      const age = (Date.now() - Date.parse(m![1])) / 86400000;
      expect(age).toBeGreaterThan(13.9);
      expect(age).toBeLessThan(14.1);
    }
    for (const l of lines(r, "NPMRC")) expect(l).not.toMatch(/ignore-scripts/);
  });
  it("the three child processes share one env set without tokens or Prisma / NODE_PATH variables", () => {
    const r = launch();
    const sets = lines(r, "ENV ").map((l) => l.slice(4).split(",").filter(Boolean));
    expect(sets).toHaveLength(2); // install + rebuild
    for (const s of sets) {
      for (const bad of [
        "NODE_AUTH_TOKEN",
        "NPM_TOKEN",
        "GITHUB_TOKEN",
        "NODE_PATH",
        "npm_config_ignore_scripts",
        "PRISMA_SKIP_POSTINSTALL_GENERATE",
        "PRISMA_GENERATE_IN_POSTINSTALL",
      ]) {
        expect(s).not.toContain(bad);
      }
      expect(s).toEqual(sets[0]);
    }
    const launched = lines(r, "LAUNCH_ENV")[0].slice(11).split(",").filter(Boolean);
    expect(launched.filter((x) => !sets[0].includes(x)).sort()).toEqual([
      "DATABASE_URL",
      "NODE_ENV",
      "PLAYWRIGHT_BROWSERS_PATH",
    ]);
    for (const l of lines(r, "USERCONFIG_SIZE")) expect(l).toBe("USERCONFIG_SIZE 0");
    for (const l of lines(r, "GLOBALCONFIG")) expect(l).toBe("GLOBALCONFIG /dev/null");
  });
  it("rebuilds exactly @prisma/client with --foreground-scripts, once, and prints the evidence line", () => {
    const r = launch();
    const rebuilds = lines(r, "ARGV rebuild");
    expect(rebuilds).toEqual(["ARGV rebuild @prisma/client --foreground-scripts"]);
    expect(r.out).toMatch(
      /prisma-init: rebuild @prisma\/client@6\.19\.2 integrity=sha512-PRISMAINTEGRIT/
    );
  });
  it("does not rebuild when a prisma CLI is in node_modules or on the child PATH", () => {
    const a = launch("prisma-present");
    expect(a.rc).not.toBe(0);
    expect(lines(a, "ARGV rebuild")).toHaveLength(0);
    const b = launch("", { extraPathDir: "prisma" });
    expect(b.rc).not.toBe(0);
    expect(lines(b, "ARGV rebuild")).toHaveLength(0);
  });
  it("fails when rebuild produced no .prisma/client/default.js", () => {
    expect(launch("rebuild-noop").rc).not.toBe(0);
  });
  it("fails when rebuild ran prisma generate or engine downloads", () => {
    expect(launch("rebuild-generate").rc).not.toBe(0);
  });
  it("fails when rebuild added an entry to the npm cache", () => {
    expect(launch("rebuild-cache").rc).not.toBe(0);
  });
  it("keeps the sandbox for the script itself: the install lives outside the repository", () => {
    const r = launch();
    expect(r.out).not.toContain(REPO_ROOT);
    expect(existsSync(SCRIPT)).toBe(true);
  });

  it("refuses to run without a reachable database url (a server without one is not the contract)", () => {
    const r = launch("", { dbUrl: "" });
    expect(r.rc).not.toBe(0);
    expect(r.out).toContain("PACKED_LAUNCH_DATABASE_URL");
  });

  it("PACKED_LAUNCH_BEFORE_DAYS sets the --before window (default 14) and the failure names it", () => {
    const r = launch("", { beforeDays: "3" });
    expect(r.rc).toBe(0);
    const m = /--before=(\S+)/.exec(lines(r, "ARGV install")[0]);
    const age = (Date.now() - Date.parse(m![1])) / 86400000;
    expect(age).toBeGreaterThan(2.9);
    expect(age).toBeLessThan(3.1);
    for (const bad of ["0", "x", "-1", "1.5"]) {
      const f = launch("", { beforeDays: bad });
      expect(f.rc, bad).not.toBe(0);
      expect(f.out, bad).toContain("PACKED_LAUNCH_BEFORE_DAYS");
    }
  });

  it("PACKED_LAUNCH_PASSTHROUGH accepts plain names and refuses secret-like, npm config and malformed names", () => {
    expect(launch("", { passthrough: "PLAIN_NAME" }).rc).toBe(0);
    for (const bad of [
      "NPM_TOKEN",
      "my_secret",
      "DB_PASSWORD",
      "GH_AUTH",
      "NPM_CONFIG_REGISTRY",
      "npm_config_cache",
      "1BAD",
      "A-B",
    ]) {
      const r = launch("", { passthrough: bad });
      expect(r.rc, bad).not.toBe(0);
      expect(r.out, bad).toContain("PACKED_LAUNCH_PASSTHROUGH");
    }
  });

  it("the database url reaches the server through the environment and never an argv", () => {
    const secret = "supersecret";
    const url = dbUrl(secret);
    const r = launch("", { dbUrl: url });
    expect(r.rc).toBe(0);
    expect(r.log.join("\n")).not.toContain(secret);
    expect(r.out).not.toContain(secret);
    expect(lines(r, "LAUNCH_ENV")[0]).toContain("DATABASE_URL");
  });
});
