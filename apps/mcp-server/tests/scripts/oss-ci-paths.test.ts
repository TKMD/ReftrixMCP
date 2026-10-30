// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-REGSYNC-OSSSYNC-008 (OSS leg) — every repo path a workflow `run:` block or a
 * scripts/ci/*.sh file refers to exists in the main tree of the OSS output.
 *
 * In the private repository the OSS output is computed with the same rsync filters
 * scripts/prepare-oss.sh uses (.ossfilter, then its --include list), as a dry run. In the
 * OSS repository itself (no prepare-oss.sh) the checkout is the output.
 *
 * @module tests/scripts/oss-ci-paths.test
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { ossOutput } from "./support/oss-output";

const REPO_ROOT = resolve(__dirname, "../../../..");
const PREPARE = join(REPO_ROOT, "scripts/prepare-oss.sh");
// a repo path with an extension, written out in full
const REF = /\bscripts\/[A-Za-z0-9_./-]*[A-Za-z0-9_]\.[A-Za-z0-9]{1,8}\b/g;
// Reference-form rule for scripts/ci/*.sh: `dirname` (and `realpath` / `readlink`) appear only on
// the `SCRIPT_DIR=` definition line, and a sibling is named through $SCRIPT_DIR. One form is
// enough to scan for; a rule replaces the list of spellings, which missed `realpath`.
const SIBLING = /\$\{?SCRIPT_DIR\}?\/([A-Za-z0-9_./-]*[A-Za-z0-9_])/g;
const PATH_TOOL = /\b(dirname|realpath|readlink)\b/;
/** lines of a scripts/ci script that break the rule (comments are not code) */
function referenceFormViolations(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => !/^\s*#/.test(l) && PATH_TOOL.test(l) && !/^SCRIPT_DIR=/.test(l));
}
// The one path a script names that is deliberately absent from both trees: the 403 classifier
// fixture. Without a fixture taken from a source that writes nothing, the classifier stays
// disabled and every 403 fails (the 403 rows of the wait script tests). Remove this entry the
// moment the file exists; the test below asserts it is absent in both trees.
const ABSENT_BY_DESIGN = "scripts/ci/fixtures/npm-403-republish.txt";

/** Workflow files that reach the OSS output (prepare-oss.sh --include list; the OSS repo itself otherwise). */
function syncedWorkflows(): string[] {
  const dir = ".github/workflows";
  if (!existsSync(PREPARE)) {
    return readdirSync(join(REPO_ROOT, dir))
      .filter((n) => n.endsWith(".yml"))
      .map((n) => `${dir}/${n}`);
  }
  const src = readFileSync(PREPARE, "utf-8");
  return [...src.matchAll(/--include='\/(\.github\/workflows\/[^'/]+\.yml)'/g)].map((m) => m[1]);
}

function referencedPaths(): Map<string, string> {
  const refs = new Map<string, string>();
  const add = (text: string, from: string): void => {
    for (const m of text.matchAll(REF)) refs.set(m[0], from);
  };
  for (const file of syncedWorkflows()) {
    const wf = load(readFileSync(join(REPO_ROOT, file), "utf-8")) as {
      jobs: Record<string, { steps: Array<{ run?: string }> }>;
    };
    for (const job of Object.values(wf.jobs)) for (const st of job.steps) add(st.run ?? "", file);
  }
  const dir = join(REPO_ROOT, "scripts/ci");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sh"))) {
    const text = readFileSync(join(dir, f), "utf-8");
    add(text, `scripts/ci/${f}`);
    for (const m of text.matchAll(SIBLING))
      refs.set(posix.normalize(`scripts/ci/${m[1]}`), `scripts/ci/${f}`);
  }
  return refs;
}

describe("INV-REGSYNC-OSSSYNC-008: OSS leg", () => {
  it("reads both synced workflows and finds the paths they depend on", () => {
    expect(syncedWorkflows()).toEqual(
      expect.arrayContaining([".github/workflows/ci.yml", ".github/workflows/publish.yml"])
    );
    const refs = [...referencedPaths().keys()];
    expect(refs).toContain("scripts/ci/wait-for-npm-version.sh");
    expect(refs).toContain("scripts/ci/check-npm-provenance.sh");
    expect(refs).toContain("scripts/publish-targets.sh");
    expect(refs).toContain(ABSENT_BY_DESIGN);
  });
  it("has every referenced path in the OSS output", () => {
    const inOutput = ossOutput();
    const missing = [...referencedPaths()]
      .filter(([p]) => p !== ABSENT_BY_DESIGN && !inOutput(p))
      .map(([p, from]) => `${p} (from ${from})`);
    expect(missing).toEqual([]);
  });
  it("keeps the one by-design absent path absent in the tree and in the OSS output", () => {
    expect(existsSync(join(REPO_ROOT, ABSENT_BY_DESIGN))).toBe(false);
    expect(ossOutput()(ABSENT_BY_DESIGN)).toBe(false);
  });
  it("has the scripts/ci files themselves in the OSS output", () => {
    const inOutput = ossOutput();
    const files = readdirSync(join(REPO_ROOT, "scripts/ci")).filter((n) => n.endsWith(".sh"));
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) expect(inOutput(`scripts/ci/${f}`), f).toBe(true);
  });
  it("keeps dirname / realpath / readlink to the SCRIPT_DIR= line in scripts/ci", () => {
    const dir = join(REPO_ROOT, "scripts/ci");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".sh"))) {
      const text = readFileSync(join(dir, f), "utf-8");
      expect(referenceFormViolations(text), f).toEqual([]);
      if (/\$\{?SCRIPT_DIR\b/.test(text)) {
        expect(text, `${f} defines SCRIPT_DIR on its own line`).toMatch(/^SCRIPT_DIR=/m);
      }
    }
  });
  it("flags the spellings the rule exists for", () => {
    for (const bad of [
      'x="$(dirname "$0")/wait.sh"',
      'x="$(realpath "${BASH_SOURCE[0]}")"',
      'cd "$(dirname "${BASH_SOURCE[0]}")" && ./wait.sh',
      'x="$(readlink -f "$0")"',
    ]) {
      expect(referenceFormViolations(bad), bad).toEqual([bad]);
    }
    expect(
      referenceFormViolations('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"')
    ).toEqual([]);
    expect(referenceFormViolations('x="$SCRIPT_DIR/wait.sh"')).toEqual([]);
  });
});
