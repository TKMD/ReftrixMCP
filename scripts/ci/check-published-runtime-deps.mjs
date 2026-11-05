#!/usr/bin/env node
// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only
// @ts-check

/**
 * INV-PUBLISHED-RUNTIME-DEPS-001 (src mode). Every runtime import of a published package
 * (scripts/publish-targets.sh) must be declared in that package's own manifest:
 *   (a) static import / require / import-equals / value export-from -> dependencies
 *   (b) import(), require.resolve, createRequire().resolve -> dependencies | optionalDependencies | peerDependencies
 *   (c) no borrowing: each package is judged on its own manifest
 *   (d) root devDependencies.playwright == mcp-server dependencies.playwright, one exact x.y.z
 * Anything that cannot be scanned (parse error, non-literal specifier, untraceable createRequire result,
 * empty set) fails; nothing is skipped. The package set is read from <root>/scripts/publish-targets.sh;
 * the AST comes from the `ts` export of the declared ts-morph, never from a regular expression.
 *
 * Usage: node scripts/ci/check-published-runtime-deps.mjs --src [--root DIR] [--only PKG]...
 *        node scripts/ci/check-published-runtime-deps.mjs --tarballs DIR --expect-count N (the dist JS of packed tarballs)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";

/**
 * Generated, vendored code in a tarball that legitimately reads `module.require` as a value (the wasm-bindgen glue
 * of the Prisma query engine hands it to the engine). One entry per file and per reason, with the reason written
 * down; adding to this table is itself an audited change. src mode has no allowance.
 */
const VENDORED_ALLOWANCES = new Map([
  [
    "dist/generated/prisma/query_engine_bg.js",
    {
      reasons: new Set(["module-require-untraceable"]),
      why: "Prisma wasm-bindgen glue: returns module.require to the engine",
    },
  ],
]);
const MCP_SERVER = "apps/mcp-server";
const MODULE_NAMES = new Set(["node:module", "module"]);
const lines = [];
let failed = false;
const fail = (line) => {
  failed = true;
  lines.push(line);
};
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return undefined;
  }
};

/**
 * Read PUBLISH_PACKAGES from publish-targets.sh without running a shell. Every non-blank,
 * non-comment line must be one of the forms below; any other line (`+=`, an indexed
 * assignment, `declare`, `source`, a multi-line array, a heredoc, a conditional other than
 * the sourced-not-executed guard, ...), an array element other than "literal" or
 * "${NAME[@]}", an undefined reference or a missing PUBLISH_PACKAGES yields [] and the caller
 * reports UNSCANNABLE. A file that bash could read differently is therefore never half-read.
 *   NAME=("literal" "${OTHER[@]}" ...)      one-line array assignment
 *   NAME="literal"                          scalar assignment
 *   name() { ... }                          one-line function definition without assignments
 *   if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then / echo "..." >&2 / exit 1 / fi   guard block
 */
function readTargets(root) {
  const file = join(root, "scripts/publish-targets.sh");
  if (!existsSync(file)) return [];
  const NAME = "[A-Z][A-Z0-9_]*";
  const arrayRe = new RegExp(`^(${NAME})=\\((.*)\\)$`);
  const scalarRe = new RegExp(`^${NAME}="[^"$\`\\\\]*"$`);
  const funcRe = /^[a-z_][a-z0-9_]*\(\) \{ (.*) \}$/;
  const assignmentRe = /[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=(?!~)/;
  const guardOpen = 'if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then';
  const arrays = new Map();
  let inGuard = false;
  for (const raw of readFileSync(file, "utf-8").split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (inGuard) {
      if (line === "fi") inGuard = false;
      else if (!(line === "exit 1" || /^echo "[^"`]*" >&2$/.test(line))) return [];
      continue;
    }
    if (line === guardOpen) {
      inGuard = true;
      continue;
    }
    if (scalarRe.test(line)) continue;
    const fn = funcRe.exec(line);
    if (fn) {
      if (
        assignmentRe.test(fn[1]) ||
        /\b(source|eval|declare|export|readonly)\b|(^|;)\s*\./.test(fn[1])
      ) {
        return [];
      }
      continue;
    }
    const m = arrayRe.exec(line);
    if (!m) return [];
    const items = [];
    for (const tok of m[2].trim().split(/\s+/).filter(Boolean)) {
      const ref = /^"\$\{([A-Z][A-Z0-9_]*)\[@\]\}"$/.exec(tok);
      const lit = /^"([^"$`\\]*)"$/.exec(tok);
      if (ref) {
        if (!arrays.has(ref[1])) return [];
        items.push(...arrays.get(ref[1]));
      } else if (lit) {
        items.push(lit[1]);
      } else {
        return [];
      }
    }
    arrays.set(m[1], items);
  }
  if (inGuard) return [];
  return arrays.get("PUBLISH_PACKAGES") ?? [];
}

/**
 * Collect scannable files under dir. src: ts/mts/cts/tsx without *.d.ts and src/generated/** (build output,
 * present or not by environment); any js/mjs/cjs/jsx file or symlink is reported in `odd`, never skipped.
 * dist: js/cjs/mjs.
 */
function walk(dir, base, out, odd, kind) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isSymbolicLink()) odd.push(rel);
    else if (e.isDirectory()) {
      if (e.name !== "node_modules" && !(kind === "src" && rel === "generated"))
        walk(join(dir, e.name), rel, out, odd, kind);
    } else if (kind === "src") {
      if (/\.(ts|mts|cts|tsx)$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) out.push(rel);
      else if (/\.(js|mjs|cjs|jsx)$/.test(e.name)) odd.push(rel);
    } else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(rel);
  }
}

const pkgOf = (spec) =>
  spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");
const isStr = (n) =>
  n !== undefined && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
const isId = (n, text) => ts.isIdentifier(n) && n.text === text;
const unwrap = (e) =>
  e &&
  (ts.isParenthesizedExpression(e) ||
    ts.isAwaitExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e))
    ? unwrap(e.expression)
    : e;
/** n is the callee of a call. */
const calleeOf = (n) => ts.isCallExpression(n.parent) && n.parent.expression === n;
/** n.resolve(...) is called. */
const resolveCallOf = (n) =>
  ts.isPropertyAccessExpression(n.parent) &&
  n.parent.expression === n &&
  n.parent.name.text === "resolve" &&
  calleeOf(n.parent);
const isConstDecl = (d) =>
  ts.isVariableDeclarationList(d.parent) && (d.parent.flags & ts.NodeFlags.Const) !== 0;

/** One file: use(rule, spec, node) for a counted specifier, bad(reason, node) for what cannot be analysed. */
function scanFile(sf, use, bad) {
  const modNames = new Set(); // bound to the node:module object
  const crNames = new Set(); // bound to createRequire (judged by the imported name, not the local one)
  const reqNames = new Set(); // const r = createRequire(u)

  const isModuleExpr = (x) => {
    const e = unwrap(x);
    if (ts.isIdentifier(e)) return modNames.has(e.text);
    if (!ts.isCallExpression(e) || !isStr(e.arguments[0]) || !MODULE_NAMES.has(e.arguments[0].text))
      return false;
    return isId(e.expression, "require") || e.expression.kind === ts.SyntaxKind.ImportKeyword;
  };
  const isCR = (x) => {
    const e = unwrap(x);
    if (ts.isIdentifier(e)) return crNames.has(e.text);
    return (
      ts.isPropertyAccessExpression(e) &&
      e.name.text === "createRequire" &&
      isModuleExpr(e.expression)
    );
  };
  const isReq = (e) =>
    (ts.isIdentifier(e) && (e.text === "require" || reqNames.has(e.text))) ||
    (ts.isCallExpression(e) && isCR(e.expression));

  const collect = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      isStr(node.moduleSpecifier) &&
      MODULE_NAMES.has(node.moduleSpecifier.text) &&
      node.importClause &&
      !node.importClause.isTypeOnly
    ) {
      const { name, namedBindings: nb } = node.importClause;
      if (name) modNames.add(name.text);
      if (nb && ts.isNamespaceImport(nb)) modNames.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements)
          if (!el.isTypeOnly && (el.propertyName ?? el.name).text === "createRequire")
            crNames.add(el.name.text);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const x = node.moduleReference.expression;
      if (isStr(x) && MODULE_NAMES.has(x.text)) modNames.add(node.name.text);
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      if (isModuleExpr(init)) {
        if (ts.isIdentifier(node.name)) modNames.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const el of node.name.elements) {
            const key = el.propertyName ?? el.name;
            if (
              !el.dotDotDotToken &&
              ts.isIdentifier(el.name) &&
              ts.isIdentifier(key) &&
              key.text === "createRequire"
            )
              crNames.add(el.name.text);
          }
        }
      } else if (isCR(init) && ts.isIdentifier(node.name)) crNames.add(node.name.text);
      else if (
        ts.isCallExpression(init) &&
        isCR(init.expression) &&
        ts.isIdentifier(node.name) &&
        isConstDecl(node)
      )
        reqNames.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);

  /** The identifier is a declaration or property name, not a use. */
  const isNamePos = (n) => n.parent.name === n || n.parent.propertyName === n;
  const literalCall = (call, rule) =>
    isStr(call.arguments[0])
      ? use(rule, call.arguments[0].text, call)
      : bad("non-literal-specifier", call);
  const typeOnlyClause = (named, wholeTypeOnly, hasDefault) =>
    wholeTypeOnly ||
    (!hasDefault &&
      named &&
      named.elements.length > 0 &&
      named.elements.every((el) => el.isTypeOnly));

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && isStr(node.moduleSpecifier)) {
      const c = node.importClause;
      const nb = c?.namedBindings;
      if (
        !c ||
        !typeOnlyClause(nb && ts.isNamedImports(nb) ? nb : undefined, c.isTypeOnly, !!c.name)
      )
        use("a", node.moduleSpecifier.text, node);
    } else if (ts.isExportDeclaration(node) && isStr(node.moduleSpecifier)) {
      const ec = node.exportClause;
      if (!typeOnlyClause(ec && ts.isNamedExports(ec) ? ec : undefined, node.isTypeOnly, false))
        use("a", node.moduleSpecifier.text, node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      !node.isTypeOnly
    ) {
      const x = node.moduleReference.expression;
      if (isStr(x)) use("a", x.text, node);
      else bad("non-literal-specifier", node);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) literalCall(node, "b");
      else if (isReq(callee))
        literalCall(node, "a"); // require(), r(), createRequire(u)()
      else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "resolve" &&
        isReq(callee.expression)
      )
        literalCall(node, "b");
      else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "require" &&
        isId(callee.expression, "module")
      )
        literalCall(node, "a");
      else if (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === "resolve" &&
        ts.isMetaProperty(callee.expression)
      )
        literalCall(node, "b"); // import.meta.resolve("y")
      else if (isCR(callee)) {
        // createRequire(u): the result may be bound to a const, called, or .resolve-called, nothing else
        const p = node.parent;
        if (
          !(
            (ts.isVariableDeclaration(p) &&
              p.initializer === node &&
              ts.isIdentifier(p.name) &&
              isConstDecl(p)) ||
            calleeOf(node) ||
            resolveCallOf(node)
          )
        )
          bad("createrequire-result-untraceable", node);
      }
    } else if (ts.isIdentifier(node) && !isNamePos(node)) {
      if (reqNames.has(node.text) && !calleeOf(node) && !resolveCallOf(node))
        bad("createrequire-result-untraceable", node);
      const initOf = ts.isVariableDeclaration(node.parent) && node.parent.initializer === node;
      if (crNames.has(node.text) && !calleeOf(node) && !initOf)
        bad("createrequire-alias-untraceable", node);
      if (node.text === "createRequire" && !crNames.has(node.text))
        bad("createrequire-unrecognized", node);
      // `require` may be called, .resolve-called, tested with typeof or compared as require.main; any other read escapes the scan
      if (
        node.text === "require" &&
        !calleeOf(node) &&
        !resolveCallOf(node) &&
        !ts.isTypeOfExpression(node.parent) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name.text === "main")
      )
        bad("require-read-as-value", node);
    } else if (ts.isPropertyAccessExpression(node)) {
      const initOf = ts.isVariableDeclaration(node.parent) && node.parent.initializer === node;
      if (
        node.name.text === "createRequire" &&
        !(isModuleExpr(node.expression) && (calleeOf(node) || initOf))
      )
        bad("createrequire-unrecognized", node);
      if (node.name.text === "require" && isId(node.expression, "module") && !calleeOf(node))
        bad("module-require-untraceable", node);
      if (ts.isMetaProperty(node.expression) && node.name.text === "resolve" && !calleeOf(node))
        bad("import-meta-resolve-untraceable", node);
    } else if (ts.isElementAccessExpression(node)) {
      const k = node.argumentExpression;
      if (isStr(k) && ["createRequire", "require", "resolve"].includes(k.text))
        bad("element-access-untraceable", node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Scan one package: `entries` are files {abs, shown}; `subpathsFor(abs)` gives the # imports that apply. */
function scanUnit(label, manifest, entries, subpathsFor, kind) {
  const keys = (f) => Object.keys(manifest[f] ?? {});
  const deps = new Set(keys("dependencies"));
  const rest = new Set([...deps, ...keys("optionalDependencies"), ...keys("peerDependencies")]);
  const seen = new Map();
  for (const { abs, shown } of entries) {
    const sf = ts.createSourceFile(
      abs,
      readFileSync(abs, "utf-8"),
      ts.ScriptTarget.Latest,
      true,
      kind === "dist" ? ts.ScriptKind.JS : abs.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const at = (pos) => `${shown}:${sf.getLineAndCharacterOfPosition(pos).line + 1}`;
    const diag = sf.parseDiagnostics?.[0];
    if (diag) {
      fail(`UNSCANNABLE pkg=${label} reason=parse-error file=${at(diag.start ?? 0)}`);
      continue;
    }
    const use = (rule, spec, node) => {
      const name = pkgOf(spec);
      if (
        /^[./]/.test(spec) ||
        spec.startsWith("node:") ||
        builtinModules.includes(name) ||
        name === manifest.name
      )
        return;
      if (spec.startsWith("#")) {
        if (!subpathsFor(abs).has(spec))
          fail(
            `UNSCANNABLE pkg=${label} reason=undefined-subpath-import file=${at(node.getStart(sf))}`
          );
        return;
      }
      seen.set(name, (seen.get(name) ?? 0) + 1);
      if (!(rule === "a" ? deps : rest).has(name))
        fail(`VIOLATION rule=${rule} pkg=${label} specifier=${name} file=${at(node.getStart(sf))}`);
    };
    const allowed = kind === "dist" ? VENDORED_ALLOWANCES.get(shown) : undefined;
    scanFile(sf, use, (reason, node) => {
      const line = `pkg=${label} reason=${reason} file=${at(node.getStart(sf))}`;
      if (allowed?.reasons.has(reason)) lines.push(`ALLOWED ${line} why="${allowed.why}"`);
      else fail(`UNSCANNABLE ${line}`);
    });
  }
  return seen;
}

function checkPackage(root, pkgDir) {
  const manifest = readJson(join(root, pkgDir, "package.json"));
  if (!manifest) {
    fail(`UNSCANNABLE pkg=${pkgDir} reason=manifest-unreadable file=package.json:1`);
    return new Map();
  }
  const srcDir = join(root, pkgDir, "src");
  const files = [];
  const odd = [];
  if (existsSync(srcDir)) walk(srcDir, "", files, odd, "src");
  files.sort();
  lines.push(`SCANNED pkg=${pkgDir} files=${files.length}`);
  if (files.length === 0) fail(`UNSCANNABLE pkg=${pkgDir} reason=no-scanned-file file=src:0`);
  for (const rel of odd)
    fail(`UNSCANNABLE pkg=${pkgDir} reason=unscanned-file-kind file=src/${rel}:1`);
  const subpaths = new Set(Object.keys(manifest.imports ?? {}));
  return scanUnit(
    pkgDir,
    manifest,
    files.map((rel) => ({ abs: join(srcDir, rel), shown: `src/${rel}` })),
    () => subpaths,
    "src"
  );
}

/** The tarball entries must stay under package/ and be plain files or directories (checked before extraction). */
function entriesSafe(tgzPath) {
  const names = spawnSync("tar", ["-tzf", tgzPath], { encoding: "utf-8" });
  const long = spawnSync("tar", ["-tvzf", tgzPath], { encoding: "utf-8" });
  if (names.status !== 0 || long.status !== 0) return false;
  const n = names.stdout.split("\n").filter(Boolean);
  const t = long.stdout.split("\n").filter(Boolean);
  if (n.length === 0 || n.length !== t.length) return false;
  return n.every(
    (name, i) =>
      name.startsWith("package/") && !name.split("/").includes("..") && !/^[lh]/.test(t[i])
  );
}

function checkTarball(tgzPath, work) {
  const base = basename(tgzPath);
  if (!entriesSafe(tgzPath)) {
    fail(`UNSCANNABLE tgz=${base} reason=unsafe-archive-entry file=${base}:0`);
    return;
  }
  const dest = mkdtempSync(join(work, "x-"));
  const x = spawnSync("tar", ["-xzf", tgzPath, "-C", dest, "--no-same-owner"], {
    encoding: "utf-8",
  });
  const pkgRoot = join(dest, "package");
  const manifest = x.status === 0 ? readJson(join(pkgRoot, "package.json")) : undefined;
  if (!manifest) {
    fail(`UNSCANNABLE tgz=${base} reason=manifest-unreadable file=package.json:1`);
    return;
  }
  const label = manifest.name ?? base;
  const files = [];
  const odd = [];
  if (existsSync(join(pkgRoot, "dist"))) walk(join(pkgRoot, "dist"), "", files, odd, "dist");
  files.sort();
  lines.push(`SCANNED tgz=${base} pkg=${label} files=${files.length}`);
  if (files.length === 0) fail(`UNSCANNABLE pkg=${label} reason=no-scanned-file file=dist:0`);
  for (const rel of odd)
    fail(`UNSCANNABLE pkg=${label} reason=unsafe-archive-entry file=dist/${rel}:0`);
  // # imports: the nearest package.json at or above the file (inside the package) decides
  const nearest = (abs) => {
    for (let d = dirname(abs); d.startsWith(pkgRoot); d = dirname(d)) {
      const m = readJson(join(d, "package.json"));
      if (m) return new Set(Object.keys(m.imports ?? {}));
    }
    return new Set();
  };
  const seen = scanUnit(
    label,
    manifest,
    files.map((rel) => ({ abs: join(pkgRoot, "dist", rel), shown: `dist/${rel}` })),
    nearest,
    "dist"
  );
  if (/(^|\/)mcp-server$/.test(label) && !(seen.get("playwright") > 0))
    fail(`UNSCANNABLE pkg=${label} reason=positive-control file=dist:0`);
}

function runTarballs(dir, expected) {
  const tgzs = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".tgz"))
        .sort()
    : [];
  lines.push(`TARBALLS count=${tgzs.length} expected=${expected}`);
  if (tgzs.length === 0) fail("UNSCANNABLE reason=no-tarball file=:0");
  if (tgzs.length !== expected) fail("UNSCANNABLE reason=tarball-count-mismatch file=:0");
  const work = mkdtempSync(join(tmpdir(), "rtdeps-tgz-"));
  try {
    for (const f of tgzs) checkTarball(join(dir, f), work);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const only = [];
  let src = false;
  let tarballs;
  let expected;
  let known = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--src") src = true;
    else if (argv[i] === "--root" && argv[i + 1]) root = resolve(argv[++i]);
    else if (argv[i] === "--only" && argv[i + 1]) only.push(argv[++i]);
    else if (argv[i] === "--tarballs" && argv[i + 1]) tarballs = resolve(argv[++i]);
    else if (argv[i] === "--expect-count" && argv[i + 1]) expected = Number(argv[++i]);
    else known = false;
  }
  const tarMode = tarballs !== undefined;
  const okArgs = tarMode
    ? !src && only.length === 0 && Number.isInteger(expected) && expected >= 1
    : src && expected === undefined;
  if (!known || !okArgs) {
    console.error(
      "usage: check-published-runtime-deps.mjs --src [--root DIR] [--only PKG]... | --tarballs DIR --expect-count N"
    );
    return 2;
  }
  if (tarMode) {
    runTarballs(tarballs, expected);
    console.log([...lines, failed ? "RESULT FAIL" : "RESULT PASS"].join("\n"));
    return failed ? 1 : 0;
  }
  const all = readTargets(root);
  if (all.length === 0)
    fail(
      "UNSCANNABLE reason=publish-targets-empty-or-unreadable file=scripts/publish-targets.sh:0"
    );
  for (const o of only)
    if (!all.includes(o))
      fail(
        `UNSCANNABLE pkg=${o} reason=only-not-in-publish-targets file=scripts/publish-targets.sh:0`
      );
  const targets = only.length > 0 ? all.filter((p) => only.includes(p)) : all;
  for (const pkg of targets) {
    const seen = checkPackage(root, pkg);
    if (pkg === MCP_SERVER && !(seen.get("playwright") > 0))
      fail(`UNSCANNABLE pkg=${pkg} reason=positive-control file=src:0`);
  }
  if (targets.includes(MCP_SERVER)) {
    const rootDev = readJson(join(root, "package.json"))?.devDependencies?.playwright;
    const mcpDep = readJson(join(root, MCP_SERVER, "package.json"))?.dependencies?.playwright;
    if (!(typeof rootDev === "string" && /^\d+\.\d+\.\d+$/.test(rootDev) && rootDev === mcpDep)) {
      fail(
        `VIOLATION rule=d pkg=${MCP_SERVER} specifier=playwright root=${rootDev} mcp-server=${mcpDep} file=package.json:1`
      );
    }
  }
  console.log([...lines, failed ? "RESULT FAIL" : "RESULT PASS"].join("\n"));
  return failed ? 1 : 0;
}

process.exitCode = main();
