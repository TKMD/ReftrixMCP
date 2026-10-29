// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PATH-shim harness for scripts/ci/*.sh that talk to the npm registry.
 *
 * `curl`, `npm`, `sleep` and `date` are replaced by bash shims placed first on PATH, so a
 * script run never touches the network and never really sleeps. The shims keep a fake
 * clock (`sleep N` advances it, `date +%s` reads it) and an ordered call log.
 *
 * Version-document responses are scripted per run with `setVersionDoc([...])` (every
 * version-document URL) or per URL with `setSequence(url, [...])`; entries:
 *   "404" / "503"    HTTP status with an empty body
 *   "timeout"        curl exit 28
 *   "200:<version>"  HTTP 200 with {"version":"<version>"}
 *   "200@<name>"     HTTP 200 with the body registered by setBody(name, ...)
 * The attestation route (lowercase %2f) answers 404 unless a per-URL sequence is set.
 * `npm publish` and the existence form of `npm view` are scripted too (see the setters).
 * The last entry repeats once the list is exhausted. Any URL the shim does not know
 * exits 99 (and is logged), so an unexpected network call fails the run.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLOCK_START = 1_800_000_000;

const CURL_SHIM = `#!/usr/bin/env bash
# curl shim: scripted registry responses, no network
echo "curl $*" >> "$SHIM_DIR/argv.log"
out=""; fmt=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    --max-time|--proto|--retry) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "curl $url" >> "$SHIM_DIR/calls.log"
body=""; code="000"; rc=0; key=""
case "$url" in
  https://registry.modelcontextprotocol.io/v0.1/servers/*/versions/*) key="seq/$(printf %s "$url" | tr -c 'A-Za-z0-9' _)" ;;
  https://registry.npmjs.org/-/npm/v1/attestations/*%2f*@*) key="seq/$(printf %s "$url" | tr -c 'A-Za-z0-9' _)" ;;
  https://registry.npmjs.org/*/-/*) echo "UNEXPECTED $url" >> "$SHIM_DIR/calls.log"; exit 99 ;;
  https://registry.npmjs.org/*%2F*/[0-9]*)
    key="seq/$(printf %s "$url" | tr -c 'A-Za-z0-9' _)"
    [ -f "$SHIM_DIR/$key.seq" ] || key="versiondoc" ;;
  https://registry.npmjs.org/*%2F*)
    if [ -f "$SHIM_DIR/packument.json" ]; then code=200; body=$(cat "$SHIM_DIR/packument.json"); else code=404; fi ;;
  *) echo "UNEXPECTED $url" >> "$SHIM_DIR/calls.log"; exit 99 ;;
esac
if [ -n "$key" ]; then
  code=404
  if [ -f "$SHIM_DIR/$key.seq" ]; then
    n=$(cat "$SHIM_DIR/$key.n" 2>/dev/null || echo 0)
    total=$(wc -l < "$SHIM_DIR/$key.seq")
    idx=$((n + 1)); [ "$idx" -gt "$total" ] && idx="$total"
    entry=$(sed -n "\${idx}p" "$SHIM_DIR/$key.seq")
    echo $((n + 1)) > "$SHIM_DIR/$key.n"
    case "$entry" in
      timeout) rc=28 ;;
      200:*) code=200; body="{\\"version\\":\\"\${entry#200:}\\"}" ;;
      200@*)
        [ -f "$SHIM_DIR/bodies/\${entry#200@}" ] || { echo "UNREGISTERED BODY $entry" >> "$SHIM_DIR/calls.log"; exit 99; }
        code=200; body=$(cat "$SHIM_DIR/bodies/\${entry#200@}") ;;
      *) code="$entry" ;;
    esac
  fi
fi
[ -n "$out" ] && printf '%s' "$body" > "$out" || { [ "$rc" -eq 0 ] && printf '%s' "$body"; }
[ "$rc" -eq 0 ] && [ -n "$fmt" ] && printf '%s' "$code"
exit "$rc"
`;

const NPM_SHIM = `#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$SHIM_DIR/calls.log"
if [ "$1" = "publish" ]; then
  # publish.rules: one "<tarball substring>|<rc>|<stderr body name>|<clock advance, s>" per line;
  # default rc 0
  if [ -f "$SHIM_DIR/publish.rules" ]; then
    while IFS='|' read -r match rc errname adv; do
      case "$2" in *"$match"*)
        [ -n "$errname" ] && cat "$SHIM_DIR/bodies/$errname" >&2
        [ -n "$adv" ] && echo $(($(cat "$SHIM_DIR/clock") + adv)) > "$SHIM_DIR/clock"
        exit "$rc" ;; esac
    done < "$SHIM_DIR/publish.rules"
  fi
  exit 0
fi
case " $* " in
  *" --prefer-online "*) ;;
  *) if [ "$1" = "view" ] && [ -f "$SHIM_DIR/published.list" ]; then
       grep -qxF "\${2%@*}" "$SHIM_DIR/published.list"; exit $?
     fi ;;
esac
if [ "$1" = "view" ] && [ -f "$SHIM_DIR/npm-view.out" ]; then cat "$SHIM_DIR/npm-view.out"; exit 0; fi
exit 1
`;

const SLEEP_SHIM = `#!/usr/bin/env bash
echo "$1" >> "$SHIM_DIR/sleeps.log"
now=$(cat "$SHIM_DIR/clock"); echo $((now + \${1%%.*})) > "$SHIM_DIR/clock"
`;

const DATE_SHIM = `#!/usr/bin/env bash
if [ "$1" = "+%s" ]; then cat "$SHIM_DIR/clock"; exit 0; fi
exec /bin/date "$@"
`;

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Harness {
  dir: string;
  /** shim directory placed first on PATH */
  bin: string;
  setVersionDoc(seq: string[]): void;
  /** per-URL response sequence (same entries as setVersionDoc, plus "200@<body name>") */
  setSequence(url: string, seq: string[]): void;
  setBody(name: string, content: string): void;
  /**
   * `npm publish <tarball>` (and `pnpm publish`): first rule whose substring is in the tarball
   * path wins; default rc 0. `advance` moves the fake clock by that many seconds (a slow publish).
   */
  setPublishRules(
    rules: Array<{ match: string; rc: number; stderr?: string; advance?: number }>
  ): void;
  /** `npm view <name>@<ver> version` (no --prefer-online) exits 0 only for these names */
  setPublished(names: string[]): void;
  setPackumentTime(version: string, iso: string): void;
  setNpmViewOutput(out: string): void;
  writeFile(name: string, content: string): string;
  clock(): number;
  calls(): string[];
  /** full argv of each curl call, "curl <flags...> <url>" */
  argv(): string[];
  sleeps(): number[];
  run(script: string, args: string[], env?: Record<string, string>, cwd?: string): RunResult;
  cleanup(): void;
}

export function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "npm-shim-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, "seq"));
  mkdirSync(join(dir, "bodies"));
  const shims: Array<[string, string]> = [
    ["curl", CURL_SHIM],
    ["npm", NPM_SHIM],
    ["pnpm", NPM_SHIM],
    ["sleep", SLEEP_SHIM],
    ["date", DATE_SHIM],
  ];
  for (const [name, body] of shims) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(dir, "clock"), `${CLOCK_START}\n`);
  writeFileSync(join(dir, "calls.log"), "");
  writeFileSync(join(dir, "argv.log"), "");
  writeFileSync(join(dir, "sleeps.log"), "");
  const read = (f: string): string[] =>
    readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean);
  return {
    dir,
    bin,
    setSequence(url, seq) {
      const key = `seq/${url.replace(/[^A-Za-z0-9]/g, "_")}`;
      writeFileSync(join(dir, `${key}.seq`), `${seq.join("\n")}\n`);
      rmSync(join(dir, `${key}.n`), { force: true });
    },
    setBody(name, content) {
      writeFileSync(join(dir, "bodies", name), content);
    },
    setPublishRules(rules) {
      rules.forEach((r, i) => {
        if (r.stderr !== undefined)
          writeFileSync(join(dir, "bodies", `publish-err-${i}`), r.stderr);
      });
      writeFileSync(
        join(dir, "publish.rules"),
        rules
          .map(
            (r, i) =>
              `${r.match}|${r.rc}|${r.stderr !== undefined ? `publish-err-${i}` : ""}|${r.advance ?? ""}`
          )
          .join("\n") + "\n"
      );
    },
    setPublished(names) {
      writeFileSync(join(dir, "published.list"), `${names.join("\n")}\n`);
    },
    setVersionDoc(seq) {
      writeFileSync(join(dir, "versiondoc.seq"), `${seq.join("\n")}\n`);
      rmSync(join(dir, "versiondoc.n"), { force: true });
    },
    setPackumentTime(version, iso) {
      writeFileSync(join(dir, "packument.json"), JSON.stringify({ time: { [version]: iso } }));
    },
    setNpmViewOutput(out) {
      writeFileSync(join(dir, "npm-view.out"), out);
    },
    writeFile(name, content) {
      const p = join(dir, name);
      writeFileSync(p, content);
      return p;
    },
    clock: () => Number(readFileSync(join(dir, "clock"), "utf-8").trim()),
    calls: () => read("calls.log"),
    argv: () => read("argv.log"),
    sleeps: () => read("sleeps.log").map(Number),
    run(script, args, env = {}, cwd) {
      const r = spawnSync("bash", [script, ...args], {
        encoding: "utf-8",
        timeout: 30_000,
        cwd,
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          SHIM_DIR: dir,
          LC_ALL: "C",
          HOME: dir,
          // blackhole: a probe that bypasses the shim cannot reach a real proxy or host
          https_proxy: "http://127.0.0.1:9",
          HTTPS_PROXY: "http://127.0.0.1:9",
          ALL_PROXY: "http://127.0.0.1:9",
          ...env,
        },
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Version document with a dist.integrity derived from a sha512 hex digest. */
export function versionDocBody(version: string, sha512Hex: string): string {
  const integrity = `sha512-${Buffer.from(sha512Hex, "hex").toString("base64")}`;
  return JSON.stringify({ version, dist: { integrity } });
}

export interface AttestationOptions {
  /** one subject digest, or several (the attestation lists all of them) */
  sha512Hex: string | string[];
  repository?: string;
  path?: string;
  commit?: string | string[];
  /** false: only the npm publish attestation; a number: that many SLSA provenance entries */
  slsa?: boolean | number;
  /** replaces the base64-decoded DSSE payload text of the SLSA entry (parser rows) */
  rawPayload?: string;
}

export const GOOD_REPOSITORY = "https://github.com/TKMD/ReftrixMCP";
export const GOOD_WORKFLOW_PATH = ".github/workflows/publish.yml";
export const GOOD_COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const GOOD_SHA512 = "ab".repeat(64);

/** Body shaped like the npm attestations endpoint (publish entry + SLSA v1 entry). */
export function attestationBody(o: AttestationOptions): string {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [o.sha512Hex]
      .flat()
      .map((sha512) => ({ name: "pkg:npm/example@0.6.1", digest: { sha512 } })),
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: o.repository ?? GOOD_REPOSITORY,
            path: o.path ?? GOOD_WORKFLOW_PATH,
          },
        },
        resolvedDependencies: [o.commit ?? GOOD_COMMIT]
          .flat()
          .map((gitCommit) => ({ digest: { gitCommit } })),
      },
    },
  };
  const payload = Buffer.from(o.rawPayload ?? JSON.stringify(statement)).toString("base64");
  // the publish entry carries its own statement too (no buildDefinition), as on the live registry
  const publishStatement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [o.sha512Hex]
      .flat()
      .map((sha512) => ({ name: "pkg:npm/example@0.6.1", digest: { sha512 } })),
    predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
    predicate: { name: "@example/pkg", version: "0.6.1", registry: "https://registry.npmjs.org" },
  };
  const entries: unknown[] = [
    {
      predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
      bundle: {
        dsseEnvelope: { payload: Buffer.from(JSON.stringify(publishStatement)).toString("base64") },
      },
    },
  ];
  const slsaEntries = o.slsa === false ? 0 : typeof o.slsa === "number" ? o.slsa : 1;
  for (let i = 0; i < slsaEntries; i++) {
    entries.push({
      predicateType: "https://slsa.dev/provenance/v1",
      bundle: { dsseEnvelope: { payload } },
    });
  }
  return JSON.stringify({ attestations: entries });
}
