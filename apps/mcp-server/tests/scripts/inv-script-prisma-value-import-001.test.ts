// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * INV-SCRIPT-PRISMA-VALUE-IMPORT-001
 *
 * `@reftrixmcp/database` は `PrismaClient` を型としてだけ再 export する
 * (`export type { PrismaClient }`)。そこから import して `new PrismaClient()` すると、実行時に
 * "PrismaClient is not a constructor" で必ず落ちる (2026-11-08 に
 * `expire-screenshots-past-retention.ts` で発覚。dry-run も含めて CLI が一度も動かなかった)。
 * `new PrismaClient()` する script は実行時の値を `@prisma/client` から import すること。
 *
 * `@reftrixmcp/database` re-exports `PrismaClient` as a type only. A script that imports it from there
 * and calls `new PrismaClient()` always fails at runtime ("PrismaClient is not a constructor"),
 * which made the retention operator CLI unusable. Scripts that construct a client must import the
 * runtime value from `@prisma/client`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { listTsFiles } from "../regression/standing/_setup/source-sweep";

const SCRIPTS_DIR = path.resolve(__dirname, "../../scripts");
const DATABASE_INDEX = path.resolve(__dirname, "../../../../packages/database/src/client.ts");

/** value import of PrismaClient from @reftrixmcp/database (`import type { … }` never matches: the regex needs `import {`) */
const VALUE_IMPORT_FROM_DATABASE = /import\s*\{([^}]*)\}\s*from\s*["']@reftrixmcp\/database["']/g;

function importsPrismaClientValueFromDatabase(text: string): boolean {
  for (const m of text.matchAll(VALUE_IMPORT_FROM_DATABASE)) {
    const names = m[1]!.split(",").map((n) => n.trim());
    if (names.some((n) => n === "PrismaClient" || n.startsWith("PrismaClient as "))) return true;
  }
  return false;
}

describe("INV-SCRIPT-PRISMA-VALUE-IMPORT-001", () => {
  it("INV-SCRIPT-PRISMA-VALUE-IMPORT-001: @reftrixmcp/database still exports PrismaClient as a type only (the premise of this check)", () => {
    const text = fs.readFileSync(DATABASE_INDEX, "utf8");
    expect(text).toMatch(/export\s+type\s*\{\s*PrismaClient\s*\}/);
  });

  it("INV-SCRIPT-PRISMA-VALUE-IMPORT-001: no script that calls `new PrismaClient()` imports PrismaClient as a value from @reftrixmcp/database", () => {
    const scripts = listTsFiles(SCRIPTS_DIR);
    expect(scripts.length).toBeGreaterThan(0);
    const offenders = scripts
      .filter((file) => {
        const text = fs.readFileSync(file, "utf8");
        return /new\s+PrismaClient\s*\(/.test(text) && importsPrismaClientValueFromDatabase(text);
      })
      .map((file) => path.relative(SCRIPTS_DIR, file));
    expect(offenders, "import the runtime PrismaClient from @prisma/client").toEqual([]);
  });

  it("INV-SCRIPT-PRISMA-VALUE-IMPORT-001: the matcher flags the broken form and accepts the type-only form", () => {
    expect(
      importsPrismaClientValueFromDatabase('import { PrismaClient } from "@reftrixmcp/database";')
    ).toBe(true);
    expect(
      importsPrismaClientValueFromDatabase(
        'import { prisma, PrismaClient } from "@reftrixmcp/database";'
      )
    ).toBe(true);
    expect(
      importsPrismaClientValueFromDatabase(
        'import type { PrismaClient } from "@reftrixmcp/database";'
      )
    ).toBe(false);
    expect(
      importsPrismaClientValueFromDatabase('import { PrismaClient } from "@prisma/client";')
    ).toBe(false);
  });
});
