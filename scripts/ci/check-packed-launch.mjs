#!/usr/bin/env node
// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check

/**
 * Helpers of scripts/ci/check-packed-launch.sh (INV-PUBLISHED-PACKAGE-LAUNCH-002).
 *
 *   lock <project> <tarballs>     every @reftrixmcp/* entry of package-lock.json (nested ones included) resolves
 *                                 from file: with the sha512 integrity of the packed tarball of that name
 *   ondisk <project> <tarballs>   starting from node_modules/@reftrixmcp/mcp-server, follow the @reftrixmcp/*
 *                                 dependencies the way Node finds a bare specifier (nearest ancestor node_modules,
 *                                 no `exports` involved); the distinct realpaths must be exactly as many as the
 *                                 tarballs and package.json + main of each must be byte-identical to the tarball's
 *   prisma-dir <project>          print the node_modules directory that holds @prisma/client
 *   prisma-init <project>         print the resolved version + integrity of @prisma/client (evidence line)
 *   rpc <bin> <version> <ms>      start the server, send `initialize`, `tools/list` and a `tools/call` of system.health
 *                                 (reaches the database); require no error, the version, and JSON-RPC only on stdout
 *                                 for the calls and for a quiet window afterwards (PACKED_LAUNCH_QUIET_MS, default 3000)
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const [cmd, ...args] = process.argv.slice(2);
const bad = (m) => {
  console.log(`FAIL ${m}`);
  process.exit(1);
};
const sha = (buf, algo = "sha256") => createHash(algo).update(buf).digest();
const tarOut = (tgz, entry) => {
  const r = spawnSync("tar", ["-xzOf", tgz, entry], { maxBuffer: 1 << 28 });
  return r.status === 0 ? r.stdout : undefined;
};

/** name -> { tgz, sha512 b64 } for the packed tarballs */
function tarballs(dir) {
  const m = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".tgz"))) {
    const tgz = join(dir, f);
    const mf = JSON.parse(String(tarOut(tgz, "package/package.json")));
    m.set(mf.name, {
      tgz,
      integrity: `sha512-${sha(readFileSync(tgz), "sha512").toString("base64")}`,
    });
  }
  return m;
}

if (cmd === "lock") {
  const lock = JSON.parse(readFileSync(join(args[0], "package-lock.json"), "utf-8"));
  const tb = tarballs(args[1]);
  let n = 0;
  for (const [key, e] of Object.entries(lock.packages ?? {})) {
    const m = /node_modules\/(@reftrixmcp\/[^/]+)$/.exec(key);
    if (!m) continue;
    n++;
    const t = tb.get(m[1]);
    if (!t) bad(`lock: ${key} has no packed tarball`);
    if (!String(e.resolved).startsWith("file:"))
      bad(`lock: ${key} resolved from ${e.resolved}, not file:`);
    if (e.integrity !== t.integrity)
      bad(`lock: ${key} integrity is not the sha512 of the packed tarball`);
  }
  if (n < tb.size) bad(`lock: ${n} @reftrixmcp entries for ${tb.size} tarballs`);
  console.log(`lock ok entries=${n}`);
} else if (cmd === "ondisk") {
  const tb = tarballs(args[1]);
  const start = realpathSync(join(args[0], "node_modules/@reftrixmcp/mcp-server"));
  const find = (from, name) => {
    for (let d = from; ; d = dirname(d)) {
      const c = join(d, "node_modules", name);
      if (existsSync(join(c, "package.json"))) return realpathSync(c);
      if (dirname(d) === d) return undefined;
    }
  };
  const seen = new Set();
  const todo = [start];
  while (todo.length > 0) {
    const dir = /** @type {string} */ (todo.pop());
    if (seen.has(dir)) continue;
    seen.add(dir);
    const mf = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    for (const dep of Object.keys(mf.dependencies ?? {}).filter((d) =>
      d.startsWith("@reftrixmcp/")
    )) {
      const r = find(dir, dep);
      if (!r) bad(`on-disk: ${dep} (needed by ${mf.name}) is not installed`);
      else todo.push(r);
    }
  }
  if (seen.size !== tb.size) bad(`on-disk: realpaths=${seen.size} expected=${tb.size}`);
  for (const dir of seen) {
    const mf = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    const t = tb.get(mf.name);
    if (!t) bad(`on-disk: ${mf.name} is not one of the tarballs`);
    const main = String(mf.main ?? "index.js").replace(/^\.\//, "");
    for (const rel of ["package.json", main]) {
      const want = tarOut(t.tgz, `package/${rel}`);
      if (!want || !sha(want).equals(sha(readFileSync(join(dir, rel)))))
        bad(`on-disk: ${mf.name} ${rel} differs from the tarball`);
    }
  }
  console.log(`ondisk ok realpaths=${seen.size}`);
} else if (cmd === "prisma-dir") {
  // the node_modules directory that holds @prisma/client, resolved from @reftrixmcp/database (kept layout-independent)
  const db = realpathSync(join(args[0], "node_modules/@reftrixmcp/database/package.json"));
  const pj = realpathSync(createRequire(db).resolve("@prisma/client/package.json"));
  console.log(dirname(dirname(dirname(pj))));
} else if (cmd === "prisma-init") {
  const e = JSON.parse(readFileSync(join(args[0], "package-lock.json"), "utf-8")).packages?.[
    "node_modules/@prisma/client"
  ];
  if (!e) bad("prisma-init: @prisma/client is not in the lockfile");
  console.log(
    `prisma-init: rebuild @prisma/client@${e.version} integrity=${String(e.integrity).slice(0, 24)}`
  );
} else if (cmd === "rpc") {
  const [bin, version, ms] = args;
  const quietMs = Number(process.env.PACKED_LAUNCH_QUIET_MS ?? 3000);
  const child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
  let buf = "";
  let stage = "initialize";
  const send = (o) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
  const done = (ok, m) => {
    clearTimeout(timer);
    child.kill("SIGKILL");
    console.log(ok ? `rpc ok version=${version} quiet=${quietMs}ms` : `FAIL rpc: ${m}`);
    process.exit(ok ? 0 : 1);
  };
  const timer = setTimeout(() => done(false, `no ${stage} answer within ${ms} ms`), Number(ms));
  let errTail = "";
  child.stderr.on("data", (d) => {
    errTail = (errTail + String(d)).slice(-600);
  });
  child.on("exit", (c) =>
    done(false, `server exited (${c}) during ${stage}; stderr tail: ${JSON.stringify(errTail)}`)
  );
  // initialize -> tools/list -> tools/call system.health (reaches the database) -> a quiet window in which
  // stdout must still carry JSON-RPC only
  const onReply = (msg) => {
    if (msg.error)
      return done(false, `${stage} returned an error: ${JSON.stringify(msg.error).slice(0, 200)}`);
    if (stage === "initialize" && msg.id === 1) {
      const v = msg.result?.serverInfo?.version;
      if (v !== version) return done(false, `serverInfo.version ${v} != ${version}`);
      send({ method: "notifications/initialized" });
      stage = "tools/list";
      send({ id: 2, method: "tools/list", params: {} });
    } else if (stage === "tools/list" && msg.id === 2) {
      const names = (msg.result?.tools ?? []).map((t) => t.name);
      if (!names.includes("system.health")) return done(false, "tools/list has no system.health");
      stage = "tools/call system.health";
      send({ id: 3, method: "tools/call", params: { name: "system.health", arguments: {} } });
    } else if (stage === "tools/call system.health" && msg.id === 3) {
      if (!msg.result || msg.result.isError === true)
        return done(false, `system.health failed: ${JSON.stringify(msg.result).slice(0, 200)}`);
      stage = "quiet window";
      clearTimeout(timer);
      setTimeout(() => done(true, ""), quietMs);
    }
  };
  child.stdout.on("data", (d) => {
    buf += String(d);
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return done(
          false,
          `stdout carries a line that is not JSON-RPC (${stage}): ${JSON.stringify(line.slice(0, 120))}`
        );
      }
      if (msg?.jsonrpc !== "2.0")
        return done(false, `stdout carries JSON that is not JSON-RPC (${stage})`);
      onReply(msg);
    }
  });
  send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "packed-launch", version: "0" },
    },
  });
} else {
  bad(`unknown command ${cmd}`);
}
