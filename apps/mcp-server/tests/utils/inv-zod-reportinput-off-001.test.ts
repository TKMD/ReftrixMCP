// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression domain: none (zod 4 bump contract; CWE-209)
 *
 * INV-ZOD-REPORTINPUT-OFF-001: zod 4's `reportInput` option puts the received input on every issue
 * (`issue.input`). The tool layer sends issues to clients, so the option must stay off: no object
 * literal under apps/mcp-server/src or packages/<pkg>/src has a `reportInput` property, whether it
 * is passed to `parse` / `safeParse` (per call), to `z.config(...)`, or built elsewhere and handed
 * over (an object literal with the key is rejected wherever it is). A local variable that happens
 * to be called `reportInput` is not an option and is not reported.
 *
 *  (a) positive controls: the per-call, global-config, shorthand and string-key forms are detected
 *  (b) negative control: a plain identifier named `reportInput` (generate.tool.ts) is not detected
 *  (c) the scan sees the source trees (not vacuous) and finds 0 in them
 *  (d) text leg: the string `reportInput` occurs in exactly one source file (generate.tool.ts), so a
 *      computed key (`{ ["reportInput"]: true }`) or an assignment (`opts.reportInput = true`), which
 *      the object literal scan does not see, cannot appear without failing here
 */
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, it, expect } from "vitest";

import { walkTsFiles } from "./support/zod-scan-common";

const SRC_ROOT = path.resolve(__dirname, "../../src");
const PACKAGES_ROOT = path.resolve(__dirname, "../../../../packages");
const SCAN_ROOTS = [
  SRC_ROOT,
  ...fs
    .readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PACKAGES_ROOT, d.name, "src")))
    .map((d) => path.join(PACKAGES_ROOT, d.name, "src")),
];

/** Positions of every object literal property whose name is `reportInput`. */
function reportInputKeys(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        const name = p.name;
        const keyText =
          name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : "";
        if (keyText === "reportInput") {
          found.push(`${fileName}:${sf.getLineAndCharacterOfPosition(p.getStart()).line + 1}`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("INV-ZOD-REPORTINPUT-OFF-001", () => {
  describe("(a) positive controls: every way to switch the option on is detected", () => {
    it.each([
      ["per call", "schema.parse(data, { reportInput: true });"],
      ["per call safeParse", "schema.safeParse(data, { reportInput: flag });"],
      ["global config", "z.config({ reportInput: true });"],
      ["shorthand", "const reportInput = true; z.config({ reportInput });"],
      ["string key", 'schema.parse(data, { "reportInput": true });'],
      ["built elsewhere", "const opts = { reportInput: true }; schema.parse(data, opts);"],
    ])("%s", (_name, code) => {
      expect(reportInputKeys("fixture.ts", code)).toHaveLength(1);
    });
  });

  it("(b) negative control: a plain identifier called reportInput is not an option", () => {
    const code = "const reportInput = buildInput();\nfoo(reportInput);\nconst x = reportInput.y;";
    expect(reportInputKeys("fixture.ts", code)).toEqual([]);
    const generate = fs.readFileSync(path.join(SRC_ROOT, "tools/report/generate.tool.ts"), "utf8");
    expect(generate).toContain("reportInput");
    expect(reportInputKeys("generate.tool.ts", generate)).toEqual([]);
  });

  it("(c) the scan covers apps/mcp-server/src and every packages/<pkg>/src, and finds none", () => {
    const files = SCAN_ROOTS.flatMap((root) => walkTsFiles(root));
    expect(SCAN_ROOTS.length).toBeGreaterThanOrEqual(5);
    expect(files.length).toBeGreaterThan(500);
    const found = files.flatMap((f) => reportInputKeys(f, fs.readFileSync(f, "utf8")));
    expect(found).toEqual([]);
  });
});

/** Files (relative to their scan root) whose text mentions `reportInput` at all. */
function filesMentioningReportInput(files: Array<{ name: string; text: string }>): string[] {
  return files.filter((f) => f.text.includes("reportInput")).map((f) => f.name);
}

describe("INV-ZOD-REPORTINPUT-OFF-001 (d) text leg", () => {
  it("positive control: computed keys and assignments are caught by the text, not by the literal scan", () => {
    const forms = [
      'schema.parse(data, { ["reportInput"]: true });',
      "opts.reportInput = true;",
      'opts["reportInput"] = true;',
    ];
    for (const code of forms) {
      expect(reportInputKeys("fixture.ts", code)).toEqual([]);
      expect(filesMentioningReportInput([{ name: "fixture.ts", text: code }])).toEqual([
        "fixture.ts",
      ]);
    }
  });

  it("only generate.tool.ts mentions reportInput in the source trees", () => {
    const files = SCAN_ROOTS.flatMap((root) =>
      walkTsFiles(root).map((f) => ({
        name: path.relative(path.resolve(root, ".."), f),
        text: fs.readFileSync(f, "utf8"),
      }))
    );
    expect(files.length).toBeGreaterThan(500);
    expect(filesMentioningReportInput(files).map((n) => n.split(path.sep).join("/"))).toEqual([
      "src/tools/report/generate.tool.ts",
    ]);
  });
});
