// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-CROP-NO-WRITE-001 — no code path creates a crop (H, gdpr-delete).
 *
 * Context / 背景:
 *   Crop generation (Phase 5 section/part crops, the backfill script) was removed
 *   (2026-10-26). Existing (legacy) crops stay until `data.delete`
 *   (INV-CROP-RETENTION-001), so the cascade must stay while no code may create a
 *   new crop.
 *
 * Invariant / 不変条件 (source scan, deterministic, NO testcontainer):
 *   Scan scope: `apps/mcp-server/src/**` + `apps/mcp-server/scripts/**` (code only;
 *   comments are stripped, SELECT / read filters are not writes).
 *   - (a) 0 non-NULL writes to `crop_storage_path` / `cropStoragePath` (quoted SQL
 *     identifier, Prisma plain / quoted / computed / shorthand key, member assignment). Assigning
 *     NULL is allowed (a bulk-clear operator script is legitimate); a positive
 *     fixture proves the scanner accepts it.
 *   - (b) 0 reads of `CROP_PERSISTENCE_ENABLED` (the flag no longer exists).
 *   - (c) 0 save* / cut* / persist* crop exports from the crop helper.
 *   - (d) `scripts/backfill-crops.ts` does not exist.
 *   - (e) the `data.delete` crop-dir cascade is still wired (`buildSafeCropDir`).
 *
 * P0 standing regression. CI-failing executable invariant. `.skip()` / `.todo()`
 * are prohibited.
 *
 * @see apps/mcp-server/src/services/part/crop-persistence.helper.ts
 * @see apps/mcp-server/src/services/gdpr-deletion.service.ts (crop-dir cascade)
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { assertInvName } from "../_setup/inv-assert";

const MCP_SERVER_ROOT = path.resolve(__dirname, "../../../../");
const SCAN_ROOTS = [path.join(MCP_SERVER_ROOT, "src"), path.join(MCP_SERVER_ROOT, "scripts")];
const CODE_EXT = /\.(ts|mts|cts|js|mjs|cjs)$/;

function listCodeFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listCodeFiles(full));
    else if (CODE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Remove comments while keeping string / template literal contents (SQL lives in
 * template literals, so it must stay scannable).
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
    } else if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Find non-NULL writes to the crop path column in comment-stripped source.
 * Returns human-readable violation snippets.
 */
export function findCropWriteViolations(rawSource: string): string[] {
  const code = stripComments(rawSource);
  const violations: string[] = [];

  // SQL assignment: `crop_storage_path = <value>` inside a SET clause (after the last
  // SET and before any later WHERE). NULL is allowed; SELECT / WHERE comparisons are
  // not assignments.
  // The identifier may be double-quoted (`SET "crop_storage_path" = $1`, also inside an escaped string `\"crop_storage_path\"`).
  const sqlAssign = /\bcrop_storage_path\\*"?\s*=(?!=)\s*([^\s,;)]+)/gi;
  for (const m of code.matchAll(sqlAssign)) {
    const before = code.slice(Math.max(0, m.index - 600), m.index);
    const lastSet = before.search(/\bSET\b(?![\s\S]*\bSET\b)/i);
    const lastWhere = before.search(/\bWHERE\b(?![\s\S]*\bWHERE\b)/i);
    const inSetClause = lastSet !== -1 && lastSet > lastWhere;
    if (inSetClause && !/^NULL\b/i.test(m[1] ?? "")) {
      violations.push(`SQL non-NULL assignment: ${m[0]}`);
    }
  }

  // SQL INSERT that names the column.
  const sqlInsert = /\bINSERT\s+INTO\b[^;`']*\bcrop_storage_path\b/gi;
  for (const m of code.matchAll(sqlInsert)) violations.push(`SQL INSERT: ${m[0].slice(0, 80)}`);

  // Prisma write data: `cropStoragePath: <expr>`. `true` / `false` (select), `{...}`
  // (where filters such as `{ not: null }`), `null` and type annotations (`string`)
  // are not non-NULL writes.
  const prismaWrite =
    /\bcropStoragePath\s*:\s*(?!true\b|false\b|null\b|string\b|unknown\b|\{)([^\s,}]+)/g;
  for (const m of code.matchAll(prismaWrite)) violations.push(`Prisma write data: ${m[0]}`);

  // Other spellings of the same write: quoted key `{ "cropStoragePath": p }`,
  // computed key `{ ["cropStoragePath"]: p }`, shorthand `{ cropStoragePath }`
  // (destructuring `const { cropStoragePath } = row` is a read and is skipped),
  // and member / index assignment `x.cropStoragePath = v`, `x["cropStoragePath"] = v`.
  const otherForms: Array<[string, RegExp]> = [
    [
      "Prisma write data (quoted / computed key)",
      /["'`]cropStoragePath["'`]\s*\]?\s*:\s*(?!true\b|false\b|null\b|string\b|unknown\b|\{)[^\s,}]+/g,
    ],
    ["Prisma write data (shorthand)", /[{,]\s*cropStoragePath\s*(?=[,}])(?![^{}]*\}\s*=(?![=>]))/g],
    [
      "member assignment",
      /\.cropStoragePath\s*=(?![=>])\s*(?!null\b)[^\s;]+|\[\s*["'`]cropStoragePath["'`]\s*\]\s*=(?![=>])\s*(?!null\b)[^\s;]+/g,
    ],
  ];
  for (const [label, re] of otherForms) {
    for (const m of code.matchAll(re)) violations.push(`${label}: ${m[0].trim()}`);
  }

  return violations;
}

const SCANNED = SCAN_ROOTS.flatMap(listCodeFiles).map((file) => ({
  file,
  rel: path.relative(MCP_SERVER_ROOT, file),
  code: stripComments(fs.readFileSync(file, "utf8")),
  raw: fs.readFileSync(file, "utf8"),
}));

describe("INV-CROP-NO-WRITE-001: no code path creates a crop (generation ended, cascade stays)", () => {
  beforeEach(() => {
    assertInvName(expect.getState().currentTestName ?? "", "INV-CROP-NO-WRITE-001");
  });

  it("INV-CROP-NO-WRITE-001: scan covers src and scripts (non-empty, includes both roots)", () => {
    expect(SCANNED.length).toBeGreaterThan(100);
    expect(SCANNED.some((f) => f.rel.startsWith("scripts/"))).toBe(true);
    expect(SCANNED.some((f) => f.rel.startsWith("src/workers/phases/"))).toBe(true);
  });

  it("INV-CROP-NO-WRITE-001: (a) 0 non-NULL writes to crop_storage_path / cropStoragePath in src + scripts", () => {
    const hits = SCANNED.flatMap((f) =>
      findCropWriteViolations(f.raw).map((v) => `${f.rel}: ${v}`)
    );
    expect(hits, `crop writes must not exist:\n${hits.join("\n")}`).toEqual([]);
  });

  it("INV-CROP-NO-WRITE-001: (a) scanner fixture — flags non-NULL writes, accepts NULL assignment, ignores SELECT / WHERE / comments", () => {
    // flagged
    expect(
      findCropWriteViolations("UPDATE section_embeddings SET crop_storage_path = $1 WHERE id = $2")
    ).toHaveLength(1);
    expect(
      findCropWriteViolations(
        "UPDATE t SET vision_embedding = $1, crop_storage_path = $2 WHERE id = $3"
      )
    ).toHaveLength(1);
    expect(
      findCropWriteViolations(
        "INSERT INTO section_embeddings (id, crop_storage_path) VALUES ($1,$2)"
      )
    ).toHaveLength(1);
    expect(
      findCropWriteViolations("prisma.x.update({ data: { cropStoragePath: p } })")
    ).toHaveLength(1);
    // flagged: other spellings (quoted identifier, shorthand, quoted / computed key, member assignment)
    expect(
      findCropWriteViolations(
        'UPDATE section_embeddings SET "crop_storage_path" = $1 WHERE id = $2'
      )
    ).toHaveLength(1);
    expect(
      findCropWriteViolations(String.raw`const q = "UPDATE t SET \"crop_storage_path\" = $1";`)
    ).toHaveLength(1);
    expect(findCropWriteViolations("prisma.x.update({ data: { cropStoragePath } })")).toHaveLength(
      1
    );
    expect(
      findCropWriteViolations('prisma.x.update({ data: { "cropStoragePath": p } })')
    ).toHaveLength(1);
    expect(
      findCropWriteViolations('prisma.x.update({ data: { ["cropStoragePath"]: p } })')
    ).toHaveLength(1);
    expect(findCropWriteViolations("row.cropStoragePath = p;")).toHaveLength(1);
    expect(findCropWriteViolations('row["cropStoragePath"] = p;')).toHaveLength(1);
    // allowed: NULL assignment (positive fixture)
    expect(
      findCropWriteViolations(
        'UPDATE section_embeddings SET "crop_storage_path" = NULL WHERE id = $1'
      )
    ).toEqual([]);
    expect(findCropWriteViolations("row.cropStoragePath = null;")).toEqual([]);
    expect(findCropWriteViolations("const { cropStoragePath } = row;")).toEqual([]);
    expect(findCropWriteViolations('where: { "cropStoragePath": { not: null } }')).toEqual([]);
    expect(
      findCropWriteViolations(
        "UPDATE section_embeddings SET crop_storage_path = NULL WHERE web_page_id = $1"
      )
    ).toEqual([]);
    expect(findCropWriteViolations("prisma.x.update({ data: { cropStoragePath: null } })")).toEqual(
      []
    );
    // allowed: reads / filters / comments
    expect(findCropWriteViolations("SELECT crop_storage_path FROM section_embeddings")).toEqual([]);
    expect(findCropWriteViolations("SELECT 1 FROM t WHERE crop_storage_path IS NOT NULL")).toEqual(
      []
    );
    expect(findCropWriteViolations("UPDATE t SET a = 1 WHERE crop_storage_path = $1")).toEqual([]);
    expect(findCropWriteViolations("select: { cropStoragePath: true }")).toEqual([]);
    expect(findCropWriteViolations("type Row = { cropStoragePath: string | null }")).toEqual([]);
    expect(findCropWriteViolations("where: { cropStoragePath: { not: null } }")).toEqual([]);
    expect(
      findCropWriteViolations("// SET crop_storage_path = $1\n/* cropStoragePath: p */")
    ).toEqual([]);
  });

  it("INV-CROP-NO-WRITE-001: (b) 0 reads of CROP_PERSISTENCE_ENABLED in src + scripts", () => {
    const hits = SCANNED.filter((f) => /CROP_PERSISTENCE_ENABLED/.test(f.code)).map((f) => f.rel);
    expect(
      hits,
      `CROP_PERSISTENCE_ENABLED must not be referenced in code: ${hits.join(", ")}`
    ).toEqual([]);
  });

  it("INV-CROP-NO-WRITE-001: (c) the crop helper exports no save* / cut* / persist* functions", async () => {
    const helperSrc = SCANNED.find((f) => f.rel === "src/services/part/crop-persistence.helper.ts");
    expect(helperSrc, "crop-persistence.helper.ts must exist (cascade path builder)").toBeDefined();
    const exported = [
      ...(helperSrc as { code: string }).code.matchAll(
        /\bexport\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g
      ),
    ].map((m) => m[1] as string);
    expect(
      exported.filter((n) => /^(save|cut|persist)/i.test(n) || /Persistence(Enabled)?$/.test(n))
    ).toEqual([]);
    const mod = await import("../../../../src/services/part/crop-persistence.helper");
    expect(
      Object.keys(mod).filter((n) => /^(save|cut|persist|isCropPersistence)/i.test(n))
    ).toEqual([]);
  });

  it("INV-CROP-NO-WRITE-001: (d) scripts/backfill-crops.ts does not exist and no crop-backfill entrypoint is referenced", () => {
    expect(fs.existsSync(path.join(MCP_SERVER_ROOT, "scripts/backfill-crops.ts"))).toBe(false);
    const hits = SCANNED.filter((f) => /backfill-crops/.test(f.code)).map((f) => f.rel);
    expect(hits).toEqual([]);
    const pkg = fs.readFileSync(path.join(MCP_SERVER_ROOT, "package.json"), "utf8");
    expect(/backfill-crops|crop:backfill/.test(pkg)).toBe(false);
  });

  it("INV-CROP-NO-WRITE-001: (e) the data.delete crop-dir cascade stays wired (buildSafeCropDir in gdpr-deletion.service.ts)", () => {
    const gdpr = SCANNED.find((f) => f.rel === "src/services/gdpr-deletion.service.ts");
    expect(gdpr, "gdpr-deletion.service.ts must exist").toBeDefined();
    const code = (gdpr as { code: string }).code;
    expect(/\bbuildSafeCropDir\b/.test(code)).toBe(true);
    expect(/\bfs\.rm\b|\brm\(/.test(code)).toBe(true);
  });
});
