// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Routed `curl` shim for scripts/ci tests that call the GitHub API or a release download.
 * `installRoutedCurl(h)` replaces the harness `curl` on PATH. A route is keyed by URL and by
 * caller: "auth" (a curl config on stdin carries an Authorization header), "anon", or "any".
 * Route body starting with `@file:` serves that local file. Unknown URL: exit 99 (logged).
 * The shim logs "curl AUTH|ANON <url>" to calls.log and raw argv to argv.log; it never
 * records the stdin config, so a token can only reach argv.log if a script put it in argv.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "./npm-shim-harness";

const ROUTED_CURL = `#!/usr/bin/env bash
echo "curl $*" >> "$SHIM_DIR/argv.log"
out=""; fmt=""; url=""; cfg=""; fail=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    -K) cfg="$2"; shift 2 ;;
    -H|--max-time|--proto|--proto-redir) shift 2 ;;
    --fail) fail=1; shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
mode=ANON
if [ "$cfg" = "-" ] && cat | grep -q 'Authorization'; then mode=AUTH; fi
echo "curl $mode $url" >> "$SHIM_DIR/calls.log"
key=$(printf %s "$url" | tr -c 'A-Za-z0-9' _)
f="$SHIM_DIR/route/$key.$mode"
[ -f "$f" ] || f="$SHIM_DIR/route/$key.ANY"
[ -f "$f" ] || { echo "UNEXPECTED $mode $url" >> "$SHIM_DIR/calls.log"; exit 99; }
code=$(head -n 1 "$f")
body=$(tail -n +2 "$f")
if [ "$fail" -eq 1 ] && [ "$code" -ge 400 ]; then exit 22; fi
if [ -n "$out" ]; then
  case "$body" in
    @file:*) cp "\${body#@file:}" "$out" ;;
    *) printf '%s' "$body" > "$out" ;;
  esac
fi
[ -n "$fmt" ] && printf '%s' "$code"
exit 0
`;

export function installRoutedCurl(h: Harness): void {
  mkdirSync(join(h.dir, "route"), { recursive: true });
  writeFileSync(join(h.bin, "curl"), ROUTED_CURL);
  chmodSync(join(h.bin, "curl"), 0o755);
}

export type RouteMode = "auth" | "anon" | "any";

export function setRoute(
  h: Harness,
  url: string,
  mode: RouteMode,
  code: number,
  body: string
): void {
  const key = url.replace(/[^A-Za-z0-9]/g, "_");
  writeFileSync(join(h.dir, "route", `${key}.${mode.toUpperCase()}`), `${code}\n${body}`);
}
