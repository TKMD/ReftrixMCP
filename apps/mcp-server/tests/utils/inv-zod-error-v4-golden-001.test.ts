// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: none (zod error contract; not one of the 4 standing domains)
 *
 * INV-ZOD-ERROR-V4-GOLDEN-001 (TPA-L-2, TPA-PRER-L-2): the converted output (4a) and the raw-joined
 * default text (4b) of every case, the record key cases included, taken on the installed zod 4 and
 * compared with no allowlist. The zod 3 goldens stay as the BREAKING evidence; these pin what the
 * client actually sees now, so a later zod 4 release that rewords a default message, or a new
 * zod 4 issue code (`invalid_key`), shows up here instead of passing through an allowlist row.
 * Regenerate only deliberately, on zod 4: GOLDEN_UPDATE=1 pnpm vitest run tests/utils/inv-zod-error-v4-golden-001.test.ts
 */
import { describe, it, expect, afterEach } from "vitest";

import { setErrorMessageLocale } from "../../src/utils/error-messages";

import { ECHO_SENTINEL } from "./support/zod-error-cases";
import {
  MAPPING_V4_GOLDEN_PATH,
  RAWJOIN_V4_GOLDEN_PATH,
  V4_GOLDEN_ZOD_VERSION,
  V4_GOLDEN_CASES,
  assertV4GoldenUpdateAllowed,
  buildMappingGolden,
  buildRawJoinSnapshot,
  readGolden,
  writeGolden,
} from "./support/zod-error-golden";
import { installedZodMajor, installedZodVersion } from "./support/zod-golden-allowlist";

afterEach(() => {
  setErrorMessageLocale("en");
});

describe("INV-ZOD-ERROR-V4-GOLDEN-001", () => {
  if (process.env["GOLDEN_UPDATE"] === "1") {
    it("writes the v4 goldens", () => {
      assertV4GoldenUpdateAllowed();
      writeGolden(MAPPING_V4_GOLDEN_PATH, buildMappingGolden(V4_GOLDEN_CASES));
      writeGolden(RAWJOIN_V4_GOLDEN_PATH, buildRawJoinSnapshot(V4_GOLDEN_CASES));
    });
    return;
  }

  it("runs on zod 4", () => {
    expect(installedZodMajor()).toBe(4);
  });

  it(`the goldens were taken on the installed zod version (${V4_GOLDEN_ZOD_VERSION})`, () => {
    expect(installedZodVersion()).toBe(V4_GOLDEN_ZOD_VERSION);
  });

  const mapping = readGolden(MAPPING_V4_GOLDEN_PATH);
  const rawjoin = readGolden(RAWJOIN_V4_GOLDEN_PATH);
  const ids = V4_GOLDEN_CASES.map((c) => c.id).sort();

  it("both goldens cover every case and nothing else", () => {
    expect(Object.keys(mapping).sort()).toEqual(ids);
    expect(Object.keys(rawjoin).sort()).toEqual(ids);
  });

  const currentMapping = buildMappingGolden(V4_GOLDEN_CASES);
  const currentRawjoin = buildRawJoinSnapshot(V4_GOLDEN_CASES);
  for (const id of ids) {
    it(`converted output equals the v4 golden: ${id}`, () => {
      expect(currentMapping[id]).toEqual(mapping[id]);
    });
    it(`raw joined text equals the v4 golden: ${id}`, () => {
      expect(currentRawjoin[id]).toEqual(rawjoin[id]);
    });
  }

  it("the record key cases are pinned, invalid_key included, and carry no key", () => {
    const keyCase = V4_GOLDEN_CASES.find((c) => c.id === "record-string-max-bad-key-sentinel");
    expect(keyCase?.run().issues.map((i) => i.code)).toEqual(["invalid_key"]);
    for (const golden of [mapping, rawjoin]) {
      expect(JSON.stringify(golden["record-string-max-bad-key-sentinel"])).not.toContain(
        ECHO_SENTINEL
      );
    }
  });
});
