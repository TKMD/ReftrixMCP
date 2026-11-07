// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESIGN_VERIFY_ERROR_CODES,
  MAX_CANDIDATE_TOTAL_BYTES,
  MAX_DATA_URI_BYTES,
  designVerifyReproductionHandler,
  designVerifyReproductionToolDefinition,
  longestDataUri,
  resetDesignVerifyReproductionDepsFactory,
  setDesignVerifyReproductionDepsFactory,
  verifyReproductionInputSchema,
} from "../../../src/tools/design/verify-reproduction.tool";
import type { VerifyDeps } from "../../../src/services/design/reproduction-verify.service";

const ID = "11111111-1111-4111-8111-111111111111";
const ok = { pattern_id: ID, candidate: { html: "<h1>x</h1>" } };

afterEach(() => resetDesignVerifyReproductionDepsFactory());

describe("input schema", () => {
  it("accepts a minimal input and fills option defaults", () => {
    const p = verifyReproductionInputSchema.parse({
      ...ok,
      options: {},
    });
    expect(p.options).toEqual({
      max_diffs: 20,
      include_diff_image: false,
      mask_images: true,
      ignore_text: false,
    });
  });
  it("accepts ignore_text booleans and rejects non-booleans (VR-M-03)", () => {
    expect(
      verifyReproductionInputSchema.parse({ ...ok, options: { ignore_text: true } }).options
        ?.ignore_text
    ).toBe(true);
    for (const bad of ["true", 1, null, "yes"]) {
      expect(
        verifyReproductionInputSchema.safeParse({ ...ok, options: { ignore_text: bad } }).success
      ).toBe(false);
    }
  });
  it("declares ignore_text in the JSON Schema, default false", () => {
    const props = designVerifyReproductionToolDefinition.inputSchema.properties.options.properties;
    expect(props.ignore_text).toMatchObject({ type: "boolean", default: false });
    expect(designVerifyReproductionToolDefinition.description).toContain("ignore_text");
  });
  it("is strict at every level", () => {
    expect(verifyReproductionInputSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(
      verifyReproductionInputSchema.safeParse({ ...ok, candidate: { html: "x", js: "y" } }).success
    ).toBe(false);
    expect(verifyReproductionInputSchema.safeParse({ ...ok, options: { nope: 1 } }).success).toBe(
      false
    );
  });
  it("rejects bad UUID, empty html and out-of-range max_diffs", () => {
    expect(verifyReproductionInputSchema.safeParse({ ...ok, pattern_id: "nope" }).success).toBe(
      false
    );
    expect(
      verifyReproductionInputSchema.safeParse({ ...ok, candidate: { html: "" } }).success
    ).toBe(false);
    expect(
      verifyReproductionInputSchema.safeParse({ ...ok, options: { max_diffs: 51 } }).success
    ).toBe(false);
    expect(
      verifyReproductionInputSchema.safeParse({ ...ok, options: { max_diffs: 0 } }).success
    ).toBe(false);
  });
  it("caps html + css at 2 MiB in total (bytes)", () => {
    const half = "a".repeat(MAX_CANDIDATE_TOTAL_BYTES / 2 + 1);
    expect(
      verifyReproductionInputSchema.safeParse({ ...ok, candidate: { html: half, css: half } })
        .success
    ).toBe(false);
    expect(
      verifyReproductionInputSchema.safeParse({
        ...ok,
        candidate: { html: "a".repeat(1000), css: "b".repeat(1000) },
      }).success
    ).toBe(true);
  });
  it("counts multi-byte characters as bytes", () => {
    const html = "あ".repeat(Math.floor(MAX_CANDIDATE_TOTAL_BYTES / 3) + 10); // 3 bytes each
    expect(verifyReproductionInputSchema.safeParse({ ...ok, candidate: { html } }).success).toBe(
      false
    );
  });
  it("caps each data: URI at 1 MiB", () => {
    const big = `<img src="data:image/png;base64,${"A".repeat(MAX_DATA_URI_BYTES)}">`;
    expect(
      verifyReproductionInputSchema.safeParse({ ...ok, candidate: { html: big } }).success
    ).toBe(false);
    const css = `body{background:url(data:image/png;base64,${"A".repeat(MAX_DATA_URI_BYTES)})}`;
    expect(
      verifyReproductionInputSchema.safeParse({ ...ok, candidate: { html: "x", css } }).success
    ).toBe(false);
    const small = `<img src="data:image/png;base64,${"A".repeat(1000)}">`;
    expect(
      verifyReproductionInputSchema.safeParse({ ...ok, candidate: { html: small } }).success
    ).toBe(true);
  });
  it("longestDataUri finds the longest one", () => {
    expect(longestDataUri("a data:x,12 b data:y,1234567 c")).toBe("data:y,1234567".length);
    expect(longestDataUri("none")).toBe(0);
  });
});

describe("handler", () => {
  it("returns INVALID_INPUT for bad input without echoing the candidate", async () => {
    const r = await designVerifyReproductionHandler({
      pattern_id: "x",
      candidate: { html: "SECRET-MARKUP" },
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain(DESIGN_VERIFY_ERROR_CODES.INVALID_INPUT);
    expect(JSON.stringify(r)).not.toContain("SECRET-MARKUP");
  });
  it("returns SERVICE_UNAVAILABLE without a DI factory", async () => {
    const r = await designVerifyReproductionHandler(ok);
    expect(r.success === false && r.error).toContain(DESIGN_VERIFY_ERROR_CODES.SERVICE_UNAVAILABLE);
  });
  it("maps a missing section to NOT_FOUND", async () => {
    setDesignVerifyReproductionDepsFactory(
      () => ({ loadSection: vi.fn(async () => null) }) as unknown as VerifyDeps
    );
    const r = await designVerifyReproductionHandler(ok);
    expect(r.success === false && r.error).toContain(DESIGN_VERIFY_ERROR_CODES.NOT_FOUND);
  });
  it("sanitizes internal errors (no table / column names reach the client)", async () => {
    setDesignVerifyReproductionDepsFactory(
      () =>
        ({
          loadSection: vi.fn(async () => {
            throw Object.assign(new Error('relation "section_patterns" column "layout_info"'), {
              code: "P2010",
            });
          }),
        }) as unknown as VerifyDeps
    );
    const r = await designVerifyReproductionHandler(ok);
    expect(r.success).toBe(false);
    const text = JSON.stringify(r);
    expect(text).not.toContain("section_patterns");
    expect(text).not.toContain("layout_info");
    expect(text).toContain(DESIGN_VERIFY_ERROR_CODES.RENDER_FAILED);
  });
});

describe("tool definition", () => {
  it("advertises the same contract as the Zod schema", () => {
    const d = designVerifyReproductionToolDefinition;
    expect(d.name).toBe("design.verify_reproduction");
    expect(d.inputSchema.required).toEqual(["pattern_id", "candidate"]);
    expect(d.inputSchema.additionalProperties).toBe(false);
    expect(d.inputSchema.properties.options.properties.max_diffs.maximum).toBe(50);
    expect(d.annotations.readOnlyHint).toBe(true);
    expect(d.annotations.openWorldHint).toBe(false);
  });
});
