// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Turbo no-cache pin for INV-REGSYNC-ATTEST-010 — the append-only check reads a root file and git
 * history, neither of which is in the turbo hash of this package, so a cached PASS could be
 * replayed after the attestation changed. The three tasks that run this package's tests
 * must therefore never be cached.
 *
 * @module tests/scripts/inv-regsync-turbo-nocache.test
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const turbo = JSON.parse(
  readFileSync(join(resolve(__dirname, "../../../.."), "turbo.json"), "utf-8")
);

describe("turbo no-cache pin (protects INV-REGSYNC-ATTEST-010)", () => {
  it.each(["test", "test:unit", "test:coverage"])(
    "disables the turbo cache for @reftrixmcp/mcp-server#%s",
    (task) => {
      expect(turbo.tasks[`@reftrixmcp/mcp-server#${task}`]?.cache).toBe(false);
    }
  );
});
