// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * license-closure-eval.mjs — evaluator behind check-published-license-closure.sh
 * (INV-INFRA-LICENSE-GATE-CLOSURE-001). Reads `pnpm licenses list --prod --json` on stdin.
 *
 *   --name <pkg name>  --manifest <package.json>  --allow "<SPDX;SPDX;...>"
 *
 * Prints one line `<name>: inspected=N reviewed=M declared=K`, then one line per failure.
 * Exit 0 when it passes, 1 when it fails (including an empty closure), 2 on bad input.
 * The caller runs this once per published package; the union of the 5 closures covers the
 * published closure. Only `dependencies` are a positive control (`optionalDependencies` may be
 * absent from an install tree). No dependencies: node built-ins only.
 */
import { readFileSync } from "node:fs";

/**
 * Packages whose license is outside the allowlist and was reviewed individually. A match needs
 * the name AND the exact license, so a different license on the same name still fails.
 *   - @img/sharp-libvips-*: libvips binaries (LGPL-3.0-or-later), dynamically linked by sharp
 *     through N-API; recorded in THIRDPARTY_LICENSES.md.
 *   - the two @csstools packages: MIT-0 (MIT without the notice requirement).
 */
const REVIEWED = [
  { match: (n) => n.startsWith("@img/sharp-libvips-"), license: "LGPL-3.0-or-later" },
  { match: (n) => n === "@csstools/color-helpers", license: "MIT-0" },
  { match: (n) => n === "@csstools/css-syntax-patches-for-csstree", license: "MIT-0" },
];

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function bad(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
}

const name = arg("--name");
const manifestPath = arg("--manifest");
const allowArg = arg("--allow");
if (!name || !manifestPath || !allowArg) bad("usage: --name --manifest --allow");
const allow = new Set(allowArg.split(";").filter(Boolean));
if (allow.size === 0) bad("empty allowlist");

/** SPDX expression: ID | ( expr ) | expr AND expr | expr OR expr. Unknown shapes evaluate to false. */
function satisfies(expr) {
  const tokens = expr.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const parseOr = () => {
    let v = parseAnd();
    while (tokens[i] === "OR") {
      i++;
      const r = parseAnd();
      v = v || r;
    }
    return v;
  };
  const parseAnd = () => {
    let v = parseAtom();
    while (tokens[i] === "AND") {
      i++;
      const r = parseAtom();
      v = v && r;
    }
    return v;
  };
  const parseAtom = () => {
    const t = tokens[i++];
    if (t === undefined) return false;
    if (t === "(") {
      const v = parseOr();
      if (tokens[i] === ")") i++;
      else return false;
      return v;
    }
    return allow.has(t);
  };
  if (tokens.length === 0) return false;
  const v = parseOr();
  return i === tokens.length ? v : false;
}

let listing;
try {
  listing = JSON.parse(readFileSync(0, "utf8"));
} catch {
  console.error(`FAIL ${name}: the closure listing is not valid JSON`);
  process.exit(1);
}
if (listing === null || typeof listing !== "object" || Array.isArray(listing)) {
  console.error(`FAIL ${name}: the closure listing has an unexpected shape`);
  process.exit(1);
}

const failures = [];
const seenNames = new Set();
let inspected = 0;
let reviewed = 0;
for (const entries of Object.values(listing)) {
  if (!Array.isArray(entries)) {
    failures.push("the closure listing has an unexpected shape");
    continue;
  }
  for (const e of entries) {
    const versions = Array.isArray(e?.versions) && e.versions.length > 0 ? e.versions : ["?"];
    const pkg = typeof e?.name === "string" ? e.name : "";
    const license = typeof e?.license === "string" ? e.license : "";
    seenNames.add(pkg);
    inspected += versions.length;
    if (satisfies(license)) continue;
    if (REVIEWED.some((r) => r.match(pkg) && r.license === license)) {
      reviewed += versions.length;
      continue;
    }
    failures.push(
      `${pkg || "(no name)"}: license "${license || "(none)"}" is outside the allowlist`
    );
  }
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const declared = Object.entries(manifest.dependencies ?? {})
  .filter(([, range]) => typeof range === "string" && !range.startsWith("workspace:"))
  .map(([dep]) => dep);

console.log(`${name}: inspected=${inspected} reviewed=${reviewed} declared=${declared.length}`);

if (inspected === 0) failures.push("the closure is empty (inspected=0); the gate checked nothing");
for (const dep of declared) {
  if (!seenNames.has(dep)) failures.push(`declared dependency ${dep} is missing from the closure`);
}

if (failures.length > 0) {
  for (const f of failures) console.error(`FAIL ${name}: ${f}`);
  process.exit(1);
}
