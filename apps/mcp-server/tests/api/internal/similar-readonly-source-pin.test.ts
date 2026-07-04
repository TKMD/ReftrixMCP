// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `INV-WEBUI-SIMILAR-READONLY-SELECT-001` — mcp-server-side SELECT-only + zero-ML source-pin
 * (WebUI v1 W2 human-value rework, UB-5 / FIND-IO-V0-M-01).
 *
 * Why this lives on the mcp-server side (closes the webui-grep gap):
 *   The existing `INV-WEBUI-READONLY-NEGATIVE-001` boundary test (`apps/webui/tests/security/
 *   readonly-layer-boundary.test.ts`) greps only the **webui src tree** and only for
 *   `prisma.<verb>` shapes — it does NOT scan `apps/mcp-server` and does NOT detect a raw
 *   `$queryRawUnsafe` SQL string. `getSimilarDesigns` introduces the read-only service's FIRST
 *   `$queryRawUnsafe`, so its SELECT-only + self-exclusion + zero-ML properties are pinned here
 *   by AST/source-grep of the actual service file.
 *
 * Pins (against `apps/mcp-server/src/api/internal/page-detail.service.ts`):
 *   (a) the `getSimilarDesigns` raw SQL contains NO write verb
 *       (INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER/CREATE) and NO stacked-query semicolon.
 *   (b) the `web_page_id != ` self-exclusion clause is present.
 *   (c) the service imports `@reftrixmcp/ml` ZERO times (the internal read process never boots ML,
 *       ADR-0042 layer boundary).
 *   (d) the whole service file uses ZERO Prisma write verbs.
 *
 * Mutation proof (non-vacuous green): each gate is paired with a negative fixture string that
 * MUST trip the same regex — injecting a `DELETE` / removing the self-exclusion / adding an
 * `@reftrixmcp/ml` import would turn the corresponding gate RED. The fixtures are asserted to
 * trip the gates so the gates cannot be silently weakened to vacuous truths.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVICE_PATH = join(
  __dirname,
  "..",
  "..",
  "..",
  "src",
  "api",
  "internal",
  "page-detail.service.ts"
);
const SERVICE_SRC = readFileSync(SERVICE_PATH, "utf8");

/**
 * Extract the body of the `getSimilarDesigns` async function (from its `export async function`
 * declaration to the matching closing brace via brace-depth counting). Used to scope the SQL
 * gates to ONLY the similar-designs method (not the whole file).
 */
function extractSimilarDesignsBody(src: string): string {
  const marker = "export async function getSimilarDesigns";
  const start = src.indexOf(marker);
  expect(start, "getSimilarDesigns must exist in page-detail.service.ts").toBeGreaterThanOrEqual(0);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("could not find end of getSimilarDesigns body");
}

const SIMILAR_BODY = extractSimilarDesignsBody(SERVICE_SRC);

/**
 * Extract the SQL template literal (the backtick block that contains the `SELECT` keyword) from a
 * function body. Iterating over every backtick block — rather than the first one — avoids matching
 * an unrelated `` `;` `` that may appear inside an inline code-comment.
 */
function extractSqlLiteral(body: string): string | null {
  const re = /`([\s\S]*?)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (/\bSELECT\b/i.test(m[1])) return m[1];
  }
  return null;
}

/** Write-verb regex (case-insensitive, word-boundary) for raw SQL keywords. */
const SQL_WRITE_VERB_RE = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE)\b/i;

/** Prisma client write-verb regex (the existing READONLY-NEGATIVE-001 shape). */
const PRISMA_WRITE_VERB_RE =
  /prisma\.\w+\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/;

describe("INV-WEBUI-SIMILAR-READONLY-SELECT-001 (mcp-server source-pin, UB-5)", () => {
  it("(a) getSimilarDesigns raw SQL contains no write verb and no stacked-query semicolon", () => {
    // The raw SQL is SELECT-only. We scope to the method body so the file's other doc-comments
    // (which may mention these words in prose) cannot false-positive.
    expect(SQL_WRITE_VERB_RE.test(SIMILAR_BODY)).toBe(false);

    // No stacked-query semicolon: the SQL must be a single statement. The only `;` allowed in the
    // body are JS statement terminators outside the SQL template literal; assert the SQL string
    // itself (the backtick block that contains the SELECT) has no inner `;`.
    const sqlLiteral = extractSqlLiteral(SIMILAR_BODY);
    expect(sqlLiteral, "getSimilarDesigns must contain a SQL template literal").not.toBeNull();
    expect(sqlLiteral!.includes(";")).toBe(false);

    // Mutation proof: an injected DELETE / a stacked `;` MUST trip the gates (non-vacuous).
    const tampered = `${sqlLiteral}; DELETE FROM web_pages`;
    expect(SQL_WRITE_VERB_RE.test(tampered)).toBe(true);
    expect(tampered.includes(";")).toBe(true);
  });

  it("(b) the self-exclusion clause (web_page_id != $1) is present", () => {
    expect(SIMILAR_BODY).toMatch(/web_page_id\s*!=\s*\$1/);

    // Mutation proof: removing the self-exclusion clause would make this regex fail.
    const withoutSelfExclusion = SIMILAR_BODY.replace(/dn\.web_page_id\s*!=\s*\$1::uuid/g, "");
    expect(/web_page_id\s*!=\s*\$1/.test(withoutSelfExclusion)).toBe(false);
  });

  it("(c) the service imports @reftrixmcp/ml zero times (zero-ML, ADR-0042 layer boundary)", () => {
    // No `@reftrixmcp/ml` import anywhere in the read-only service file.
    expect(SERVICE_SRC.includes("@reftrixmcp/ml")).toBe(false);

    // Mutation proof: an injected ML import would be detected.
    const tampered = `import { x } from "@reftrixmcp/ml";\n${SERVICE_SRC}`;
    expect(tampered.includes("@reftrixmcp/ml")).toBe(true);
  });

  it("(d) the whole service file uses zero Prisma write verbs", () => {
    expect(PRISMA_WRITE_VERB_RE.test(SERVICE_SRC)).toBe(false);

    // Mutation proof: an injected prisma write verb would be detected.
    const tampered = `${SERVICE_SRC}\nawait prisma.webPage.delete({ where: { id } });`;
    expect(PRISMA_WRITE_VERB_RE.test(tampered)).toBe(true);
  });

  it("getSimilarDesigns binds parameters only ($1/$2), no user-input string interpolation", () => {
    // Positive: the bound placeholders are used.
    expect(SIMILAR_BODY).toContain("$1::uuid");
    expect(SIMILAR_BODY).toMatch(/\$2/);
    // Negative: no JS-side vector string reconstruction (`[${...}]`) leaks the source embedding
    // into the SQL string (UB-1: single SQL self-referential subquery, no JS round-trip).
    expect(/\[\$\{/.test(SIMILAR_BODY)).toBe(false);
  });
});
