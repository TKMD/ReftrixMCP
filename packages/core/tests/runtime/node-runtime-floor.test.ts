// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
  NODE_ENGINES_RANGE,
  NODE_RUNTIME_FLOOR_TABLE,
  evaluateBrotliFixMarker,
  evaluateNodeRuntime,
  evaluateNodeVersion,
  evaluateUndiciVersion,
  parseSemver,
} from "../../src/runtime/node-runtime-floor";

const ok = { ok: true };
const run = (node: unknown, undici: unknown, marker: unknown = 1, releaseName: unknown = "node") =>
  evaluateNodeRuntime({ node, undici, brotliBlockSwitchMarker: marker, releaseName });

describe("node-runtime-floor (pure functions)", () => {
  it.each([
    ["22.23.4", [22, 23, 4]],
    ["26.12.10", [26, 12, 10]],
  ])("parseSemver accepts %s", (v, t) => expect(parseSemver(v)).toEqual(t));

  it.each([
    "v22.23.4",
    "22.23",
    "22.23.4-rc.1",
    "22.23.4+b",
    "022.1.1",
    "1.2.99999999999999999999",
    "",
    22,
    undefined,
  ])("parseSemver rejects %s", (v) => expect(parseSemver(v)).toBeNull());

  it("engines range is derived from the frozen table", () => {
    expect(NODE_ENGINES_RANGE).toBe("^22.23.4 || ^24.22.1 || ^26.12.1");
    expect(Object.isFrozen(NODE_RUNTIME_FLOOR_TABLE)).toBe(true);
  });

  it.each([
    ["22.23.4", "6.29.1", ok],
    ["24.22.1", "7.30.1", ok],
    ["26.13.0", "8.12.2", ok],
    ["22.23.3", "6.29.1", { ok: false, reason: "node-below-floor" }],
    ["23.0.0", "6.29.1", { ok: false, reason: "node-series-unsupported" }],
    ["22.23.4", "6.29.0", { ok: false, reason: "undici-below-floor" }],
    ["22.23.4", undefined, { ok: false, reason: "undici-version-unparsable" }],
    ["x", "6.29.1", { ok: false, reason: "node-version-unparsable" }],
  ])("evaluateNodeRuntime(%s, %s)", (node, undici, expected) =>
    expect(run(node, undici)).toEqual(expected)
  );

  it("requires the Brotli fix marker and the node release name", () => {
    expect(
      evaluateNodeRuntime({
        node: "22.23.4",
        undici: "6.29.1",
        brotliBlockSwitchMarker: undefined,
        releaseName: "node",
      })
    ).toEqual({
      ok: false,
      reason: "brotli-fix-marker-missing",
    });
    expect(run("22.23.4", "6.29.1", 1, "io.js")).toEqual({
      ok: false,
      reason: "release-name-not-node",
    });
  });

  it("split functions agree with the composition", () => {
    expect(evaluateNodeVersion("22.23.4")).toEqual(ok);
    expect(evaluateUndiciVersion(22, "6.29.1")).toEqual(ok);
    expect(evaluateUndiciVersion(21, "6.29.1")).toEqual({
      ok: false,
      reason: "node-series-unsupported",
    });
    expect(evaluateBrotliFixMarker(0)).toEqual(ok);
  });
});
