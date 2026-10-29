// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-REGSYNC-GATE-002 (publish.yml `verify` rows) and RS1BII-L12.
 *
 * The step that validates the tag also requires `github.ref` to equal `refs/tags/<tag>`
 * (`release.tag_name` / `inputs.tag`), and both checkouts use `github.sha`; the version step calls scripts/ci/check-release-versions.sh instead of
 * an inline loop. Because tag == ref, `github.sha` is the tag commit, so the provenance
 * comparison base of the `publish` job (TAG_COMMIT_SHA) is the tag commit.
 *
 * @module tests/scripts/publish-verify-gates.test
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../../../..");
interface Step {
  name?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, string>;
  uses?: string;
}
const workflow = load(readFileSync(join(REPO_ROOT, ".github/workflows/publish.yml"), "utf-8")) as {
  jobs: Record<string, { steps: Step[] }>;
};
const verifySteps = workflow.jobs.verify.steps;
const stepByName = (needle: string): Step =>
  verifySteps.find((s) => s.name?.includes(needle)) as Step;
const validate = stepByName("Validate tag input");
const versions = stepByName("Version-consistency check");

const runValidate = (tag: string, ref: string): number => {
  const dir = mkdtempSync(join(tmpdir(), "verify-"));
  try {
    const f = join(dir, "step.sh");
    writeFileSync(f, `set -eo pipefail\n${validate.run}`);
    return (
      spawnSync("bash", [f], { env: { PATH: process.env.PATH, RAW_TAG: tag, REF: ref } }).status ??
      -1
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("INV-REGSYNC-GATE-002: publish.yml verify gates", () => {
  it("reads github.ref in the validate step and compares it with refs/tags/<tag>", () => {
    expect(validate.env?.REF).toBe("${{ github.ref }}");
    expect(validate.run).toContain('[ "$REF" != "refs/tags/$TAG" ]');
    expect(validate.run).not.toMatch(/REF_NAME|ref_name/);
    expect(validate.env?.RAW_TAG).toBe("${{ github.event.release.tag_name || inputs.tag }}");
  });
  it.each([
    ["release: tag ref", "v1.2.3", "refs/tags/v1.2.3", 0],
    ["dispatch from the tag ref", "v1.2.3", "refs/tags/v1.2.3", 0],
    ["same-named branch is rejected", "v1.2.3", "refs/heads/v1.2.3", 1],
    ["dispatch from main", "v1.2.3", "refs/heads/main", 1],
    ["other tag", "v1.2.3", "refs/tags/v1.2.2", 1],
    ["invalid tag format is still rejected", "v1.2", "refs/tags/v1.2", 1],
  ])("validate step: %s", (_n, tag, ref, rc) => {
    expect(runValidate(tag, ref)).toBe(rc);
  });
  it("the version step calls check-release-versions.sh and has no inline version loop", () => {
    expect(versions.run).toContain('scripts/ci/check-release-versions.sh . "$RAW_TAG"');
    expect(versions.run).not.toMatch(/PKG_VER|require\('\.\/\$pkg\/package\.json'\)\.version/);
  });
  it("validates the tag before checkout, and checks out github.sha", () => {
    const iValidate = verifySteps.indexOf(validate);
    const iCheckout = verifySteps.findIndex((s) => s.uses?.startsWith("actions/checkout"));
    expect(iValidate).toBeGreaterThan(-1);
    expect(iValidate).toBeLessThan(iCheckout);
    expect(verifySteps[iCheckout].with?.ref).toBe("${{ github.sha }}");
  });
});

describe("RS1BII-L12: provenance comparison base is the tag commit", () => {
  const publishSteps = workflow.jobs.publish.steps;
  it("the publish job compares provenance against github.sha", () => {
    const tiers = publishSteps.find((s) => s.run?.includes("PUBLISH_TIER1")) as Step;
    expect(tiers.env?.TAG_COMMIT_SHA).toBe("${{ github.sha }}");
    expect(tiers.run).toContain("check-npm-provenance.sh");
  });
  it("every checkout in verify and publish uses github.sha", () => {
    const all = [...verifySteps, ...publishSteps].filter((s) =>
      s.uses?.startsWith("actions/checkout")
    );
    expect(all).toHaveLength(2);
    for (const co of all) expect(co.with?.ref).toBe("${{ github.sha }}");
  });
  it("only the verify github.ref == refs/tags/<tag> assert ties github.sha to that tag", () => {
    // without it, a dispatch from another ref would make github.sha a non-tag commit
    expect(validate.run).toContain('[ "$REF" != "refs/tags/$TAG" ]');
  });
});
