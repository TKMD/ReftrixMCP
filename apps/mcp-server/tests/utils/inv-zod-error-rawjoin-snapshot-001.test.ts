// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: none (zod error contract; not one of the 4 standing domains)
 *
 * INV-ZOD-ERROR-RAWJOIN-SNAPSHOT-001 (4b):
 *  (1) the set of client-reaching places that join zod default messages is fixed (AST scan);
 *  (1b) the set of places that read one issue by index (`.errors[0]` / `.issues[0]` / `.at()`) and
 *       its message is fixed too (TDA-B1-02 / TPA-B1-04);
 *  (2) the default zod messages those places would put on the wire are snapshotted on zod 3.x.
 *      After the zod 4 bump, differences are allowed only for rows declared as BREAKING;
 *  (3) input echo through the raw-joined default message is a closed set (SEC-B1-02): it may only
 *      shrink, never spread to a new case.
 */
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import {
  CLIENT_REACHING_MESSAGE_JOIN_SITES,
  FORMAT_ZOD_ERROR_CALLERS,
  NOT_CLIENT_REACHING_MESSAGE_JOIN_SITES,
  NOT_CLIENT_REACHING_SITE_COUNTS,
} from "./support/zod-client-reaching";
import {
  scanFirstIssueSites,
  scanFormatZodErrorCallers,
  scanMessageJoinSites,
} from "./support/zod-message-join-scan";
import { ECHO_SENTINEL, RECORD_ECHO_CASES, ZOD_ERROR_CASES } from "./support/zod-error-cases";
import { allowedDifference } from "./support/zod-golden-allowlist";
import {
  RAWJOIN_GOLDEN_PATH,
  buildRawJoinSnapshot,
  rawJoin,
  readGolden,
  writeGolden,
  assertGoldenUpdateAllowed,
} from "./support/zod-error-golden";

const PKG_ROOT = path.resolve(__dirname, "../..");

describe("INV-ZOD-ERROR-RAWJOIN-SNAPSHOT-001 (4b) fixed AST set", () => {
  it("message-join sites in src are exactly the audited client-reaching set plus the audited excluded set", () => {
    const counts: Record<string, number> = {};
    for (const s of scanMessageJoinSites(PKG_ROOT, "src"))
      counts[s.file] = (counts[s.file] ?? 0) + 1;

    const expected: Record<string, number> = { ...CLIENT_REACHING_MESSAGE_JOIN_SITES };
    for (const f of Object.keys(NOT_CLIENT_REACHING_MESSAGE_JOIN_SITES)) {
      expected[f] = NOT_CLIENT_REACHING_SITE_COUNTS[f] ?? 1;
    }

    expect(counts).toEqual(expected);
  });

  it("client-reaching set has 25 call sites in 24 files", () => {
    const files = Object.keys(CLIENT_REACHING_MESSAGE_JOIN_SITES);
    expect(files).toHaveLength(24);
    expect(Object.values(CLIENT_REACHING_MESSAGE_JOIN_SITES).reduce((a, b) => a + b, 0)).toBe(25);
  });

  it("formatZodError is called from exactly the 5 audited tools", () => {
    const callers = scanFormatZodErrorCallers(PKG_ROOT, "src");
    expect(callers).toEqual([...FORMAT_ZOD_ERROR_CALLERS].sort());
  });
});

/**
 * Places that read one issue by index and then its default message: file -> kind -> count.
 * client-reaching: only style-get-palette.ts (the message goes into the error text returned to the client).
 */
export const FIRST_ISSUE_SITES: Readonly<
  Record<string, { clientReaching: boolean; read: number; message: number }>
> = {
  "src/tools/style-get-palette.ts": { clientReaching: true, read: 1, message: 1 },
  "src/workers/phases/embedding-backfill-fork-orchestrator.ts": {
    clientReaching: false, // log line for an invalid IPC child message (code and path only, SEC-C1B2R-L-01)
    read: 1,
    message: 0,
  },
  "src/workers/phases/phase-5-child-ipc.ts": {
    clientReaching: false, // console.warn for invalid IPC messages (code and path only, no message)
    read: 2,
    message: 0,
  },
};

describe("INV-ZOD-ERROR-RAWJOIN-SNAPSHOT-001 (1b) fixed set of first-issue reads", () => {
  const sites = scanFirstIssueSites(PKG_ROOT, "src");

  it("index / at() reads of a zod issue list and their message reads are exactly the audited set", () => {
    const actual: Record<string, { read: number; message: number }> = {};
    for (const s of sites) {
      const row = (actual[s.file] ??= { read: 0, message: 0 });
      if (s.kind === "first-issue-read") row.read += 1;
      else row.message += 1;
    }
    const expected: Record<string, { read: number; message: number }> = {};
    for (const [f, v] of Object.entries(FIRST_ISSUE_SITES))
      expected[f] = { read: v.read, message: v.message };
    expect(actual).toEqual(expected);
  });

  it("style-get-palette.ts reads the first issue at :152 and its message at :159 (client-reaching)", () => {
    const palette = sites
      .filter((s) => s.file === "src/tools/style-get-palette.ts")
      .map((s) => `${s.kind}@${s.line}`);
    expect(palette).toEqual(["first-issue-read@152", "first-issue-message@159"]);
  });

  it("totals: 5 site rows in 3 files, 1 file client-reaching", () => {
    expect(sites).toHaveLength(5);
    expect(Object.keys(FIRST_ISSUE_SITES)).toHaveLength(3);
    expect(Object.values(FIRST_ISSUE_SITES).filter((v) => v.clientReaching)).toHaveLength(1);
  });
});

/**
 * Known raw-join input echoes (case id -> reason). The set is empty: every raw-join site goes
 * through formatIssueLine / formatIssueMessage, which return a fixed text for unrecognized_keys
 * (INV-ZOD-ISSUE-PATH-JOIN-001 (d)) and a redacted path for record keys. It must stay empty.
 */
export const KNOWN_RAWJOIN_ECHO_GAPS: Readonly<Record<string, string>> = {};
const ECHO_CASES = [...ZOD_ERROR_CASES, ...RECORD_ECHO_CASES];

describe("INV-ZOD-ERROR-RAWJOIN-SNAPSHOT-001 (3) raw-join input echo is a closed set", () => {
  const echoing = ECHO_CASES.filter((c) => {
    const err = c.run();
    return rawJoin(err.issues).includes(ECHO_SENTINEL);
  }).map((c) => c.id);

  for (const c of ECHO_CASES.filter((x) => x.carriesSentinel)) {
    it(`sentinel is echoed only for pinned known gaps: ${c.id}`, () => {
      expect(echoing.includes(c.id)).toBe(c.id in KNOWN_RAWJOIN_ECHO_GAPS);
    });
  }

  it("cases without the sentinel never produce it", () => {
    expect(echoing.filter((id) => !ECHO_CASES.find((c) => c.id === id)?.carriesSentinel)).toEqual(
      []
    );
  });

  it("the echoing set equals the pinned set (nothing spread, nothing stale)", () => {
    expect([...echoing].sort()).toEqual(Object.keys(KNOWN_RAWJOIN_ECHO_GAPS).sort());
  });
});

describe("INV-ZOD-ERROR-RAWJOIN-SNAPSHOT-001 (4b) default message snapshot (zod 3.x)", () => {
  if (process.env["GOLDEN_UPDATE"] === "1") {
    it("writes the snapshot", () => {
      assertGoldenUpdateAllowed();
      writeGolden(RAWJOIN_GOLDEN_PATH, buildRawJoinSnapshot());
    });
    return;
  }
  const snapshot = readGolden(RAWJOIN_GOLDEN_PATH);
  const current = buildRawJoinSnapshot();
  for (const id of Object.keys(current)) {
    it(`raw joined message equals snapshot: ${id}`, () => {
      // after the zod 4 bump only rows whose scope includes 4b may differ (any kind: the default text moves)
      if (allowedDifference(id, "4b")) return;
      expect(current[id]).toEqual(snapshot[id]);
    });
  }
  it("snapshot covers the same cases", () => {
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(current).sort());
  });
});
