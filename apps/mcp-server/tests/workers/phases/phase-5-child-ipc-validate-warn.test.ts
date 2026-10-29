// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5 child IPC validators — what the rejection warning names.
 *
 * A message the schema rejects is dropped by the parent, and when the child still exits 0 the run
 * is recorded as an IPC race ("exited cleanly but no result"). The warning is the only place that
 * tells a schema rejection apart from a real race, so it must name the schema that rejected.
 * It carries the schema name, the first issue code and the first issue path, and nothing else. The
 * issue message is left out: zod 3 puts the received enum value and the unrecognized key names in
 * it, both come from the peer and have no length limit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  validateChildMessage,
  validateParentMessage,
} from "../../../src/workers/phases/phase-5-child-ipc";

const SECRET = "SECRET-VALUE-4f2a9c";
const LONG_KEY = `LONG-KEY-7d1e3b-${"k".repeat(600)}`;
const VALID_UUID = "0192b3c4-d5e6-4f70-8a9b-0c1d2e3f4a5b";

describe("phase-5-child-ipc validators: rejection warning", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const logged = (): string => warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");

  it("names childToParentSchema when a child message has an unknown key, without the value", () => {
    const body = { type: "heartbeat", rssMb: 1, rssDeltaMb: 0, phase: "p", evil: SECRET };
    expect(validateChildMessage(body)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged()).toContain("childToParentSchema");
    expect(logged()).not.toContain(SECRET);
  });

  it("names childToParentSchema when a child field has the wrong type, without the value", () => {
    const body = { type: "heartbeat", rssMb: SECRET, rssDeltaMb: 0, phase: "p" };
    expect(validateChildMessage(body)).toBeNull();
    expect(logged()).toContain("childToParentSchema");
    expect(logged()).not.toContain(SECRET);
  });

  it("names parentToChildSchema when a parent message has an unknown key, without the value", () => {
    const body = { type: "shutdown", evil: SECRET };
    expect(validateParentMessage(body)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged()).toContain("parentToChildSchema");
    expect(logged()).not.toContain(SECRET);
  });

  it("does not log the received enum value when a parent subPhase is not in the enum", () => {
    const body = {
      type: "init-text",
      webPageId: VALID_UUID,
      url: "https://example.com",
      sectionIdMapping: null,
      motionIdMapping: null,
      jsIdMapping: null,
      bgIds: null,
      scrollVisionIdMapping: null,
      layoutResultJson: null,
      motionResultJson: null,
      jsAnimationsJson: null,
      scrollVisionResultJson: null,
      subPhase: SECRET,
    };
    expect(validateParentMessage(body)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain(SECRET);
    expect(logged()).toContain("parentToChildSchema");
    expect(logged()).toContain("invalid_value");
    expect(logged()).toContain("subPhase");
  });

  it("does not log the key name when a child message has a long unrecognized key", () => {
    const body = { type: "heartbeat", rssMb: 1, rssDeltaMb: 0, phase: "p", [LONG_KEY]: 1 };
    expect(validateChildMessage(body)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged()).not.toContain("LONG-KEY-7d1e3b");
    expect(logged().length).toBeLessThan(300);
    expect(logged()).toContain("childToParentSchema");
    expect(logged()).toContain("unrecognized_keys");
  });
});
