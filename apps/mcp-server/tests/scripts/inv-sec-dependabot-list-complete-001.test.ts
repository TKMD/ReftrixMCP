// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-SEC-DEPENDABOT-LIST-COMPLETE-001
 *
 * `jq -e -f scripts/oss-sync-dependabot-complete.jq <input.json>` を唯一の式として読み込み、
 * 欠番 G = {1..max} \ unique(listed) の全てが個別 probe で 410 (withdrawn) のときだけ rc 0 になることを確かめる。
 * Loads the single jq expression file (never a copy); jq missing FAILS (no skip).
 *
 * @module tests/scripts/inv-sec-dependabot-list-complete-001
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// RED verification swaps the expression via env; the real run always uses the repo file.
const JQ_FILE =
  process.env["DEPENDABOT_JQ_UNDER_TEST"] ??
  join(resolve(__dirname, "../../../.."), "scripts/oss-sync-dependabot-complete.jq");

const range = (a: number, b: number): number[] =>
  Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
const gone = (...n: number[]): Array<{ number: number; status: number }> =>
  n.map((number) => ({ number, status: 410 }));
const input = (
  max: number,
  listed: unknown[],
  probes: unknown[] = [],
  max_rc = 0,
  prev_max = 0
): unknown => ({
  max,
  prev_max,
  max_rc,
  listed,
  probes,
});

let tmp = "";
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "dependabot-complete-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function run(data: unknown): { status: number | null; stdout: string } {
  const p = join(tmp, `in-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
  const r = spawnSync("jq", ["-e", "-f", JQ_FILE, p], { encoding: "utf8" });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout.trim() };
}

describe("INV-SEC-DEPENDABOT-LIST-COMPLETE-001", () => {
  it("should have jq available (fails, never skips, when missing)", () => {
    const r = spawnSync("jq", ["--version"], { encoding: "utf8" });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
  });

  it.each<[string, unknown]>([
    ["complete list, no gaps", input(5, range(1, 5))],
    ["duplicate listed numbers are tolerated", input(3, [1, 2, 2, 3, 3])],
    ["gaps that are all 410 (withdrawn)", input(5, [1, 3, 5], gone(2, 4))],
    ["max 0 with empty list", input(0, [])],
    ["exactly 100 withdrawn gaps", input(101, [1], gone(...range(2, 101)))],
    ["prev_max floor: dropped tail 4,5 all 410", input(3, [1, 2, 3], gone(4, 5), 0, 5)],
  ])("should exit 0: %s", (_n, data) => {
    const r = run(data);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("true");
  });

  it.each<[string, unknown]>([
    ["empty list with max 5 (empty-page hole)", input(5, [])],
    [
      "gap probe returns 200 (alert missing from list)",
      input(3, [1, 3], [{ number: 2, status: 200 }]),
    ],
    ["gap probe returns 404", input(3, [1, 3], [{ number: 2, status: 404 }])],
    ["gap not probed", input(5, [1, 3, 5], gone(2))],
    ["probe outside G", input(3, [1, 2, 3], gone(2))],
    ["duplicate probe", input(3, [1, 3], gone(2, 2))],
    ["101 gaps all 410", input(102, [1], gone(...range(2, 102)))],
    ["empty list with max 3, all 410 (only rule iii)", input(3, [], gone(1, 2, 3))],
    [
      "prev_max floor: dropped number 4 returns 200",
      input(3, [1, 2, 3], [...gone(5), { number: 4, status: 200 }], 0, 5),
    ],
    ["max 0, prev_max 2, empty list, all 410", input(0, [], gone(1, 2), 0, 2)],
    ["max query rc != 0", input(3, [1, 2, 3], [], 1)],
    ["listed number greater than max", input(2, [1, 2, 3])],
    ["listed 0 hides a gap (only the >= 1 check)", input(2, [0, 1], gone(2))],
    ["stale max, tail neither listed nor probed (floor)", input(3, [1, 2, 3], [], 0, 5)],
  ])("should exit 1: %s", (_n, data) => {
    const r = run(data);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("false");
  });

  it.each<[string, unknown]>([
    ["not JSON", "{not json"],
    ["missing fields", { max: 1 }],
    ["max is a string", { ...(input(1, [1]) as object), max: "1" }],
    ["listed entry is not a positive integer", input(1, [0])],
    ["listed entry is null", input(1, [1, null])],
    ["max is not an integer", input(1.5, [1], gone(2))],
    ["prev_max is missing", { ...(input(1, [1]) as object), prev_max: undefined }],
    ["probe without status", input(2, [1], [{ number: 2 }])],
  ])("should exit non-zero on malformed input: %s", (_n, data) => {
    expect(run(data).status).not.toBe(0);
  });
});
