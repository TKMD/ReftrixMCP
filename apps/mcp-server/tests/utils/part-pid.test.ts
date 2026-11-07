// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * part-pid のユニットテスト（VR-M-01）/ Unit tests for the part pid helpers (VR-M-01)
 */
import { describe, expect, it } from "vitest";
import {
  PART_PID_ATTR,
  duplicatePartPids,
  readPartPid,
  stripPartPids,
} from "../../src/utils/part-pid";

describe("stripPartPids", () => {
  it("removes every pid attribute and restores the unnumbered serialization", () => {
    const numbered = `<div ${PART_PID_ATTR}="0" class="a"><button ${PART_PID_ATTR}="12">Go</button></div>`;
    expect(stripPartPids(numbered)).toBe(`<div class="a"><button>Go</button></div>`);
  });

  it("returns the same string when there is no pid", () => {
    const html = `<p class="x">hello</p>`;
    expect(stripPartPids(html)).toBe(html);
  });

  it("removes an attribute cut by snippet truncation (no closing quote)", () => {
    expect(stripPartPids(`<p>a</p><div ${PART_PID_ATTR}="12<!-- truncated -->`)).not.toContain(
      PART_PID_ATTR
    );
    expect(stripPartPids(`<div ${PART_PID_ATTR}="12`)).toBe("<div");
  });

  it("leaves non-numeric values written by the page alone", () => {
    const html = `<p ${PART_PID_ATTR}="abc">x</p>`;
    expect(stripPartPids(html)).toBe(html);
  });

  it("removes the attribute regardless of case", () => {
    expect(stripPartPids(`<p DATA-REFTRIX-PID="3">x</p>`)).toBe(`<p>x</p>`);
  });
});

describe("readPartPid", () => {
  const el = (v: string | null): { getAttribute: () => string | null } => ({
    getAttribute: () => v,
  });

  it("accepts non-negative integers up to 7 digits", () => {
    expect(readPartPid(el("0"))).toBe(0);
    expect(readPartPid(el("1234567"))).toBe(1234567);
  });

  it("rejects missing, negative, non-integer and oversized values", () => {
    for (const v of [null, "", "-1", "1.5", "1e3", "12345678", " 1", "abc"]) {
      expect(readPartPid(el(v))).toBeNull();
    }
  });
});

describe("duplicatePartPids", () => {
  it("returns pids that occur more than once", () => {
    const html = `<a ${PART_PID_ATTR}="1"></a><b ${PART_PID_ATTR}="2"></b><i ${PART_PID_ATTR}="1"></i>`;
    expect([...duplicatePartPids(html)]).toEqual([1]);
    expect(duplicatePartPids("<p>x</p>").size).toBe(0);
  });
});
