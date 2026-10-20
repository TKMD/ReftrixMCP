// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-SEC-SHARP-SVG-BLOCK-001 — process 全体の SVG loader block（層 1）
 * INV-SEC-SHARP-SVG-BLOCK-001 — process-wide SVG loader block (layer 1)
 *
 * (a)   wrapper 経由の native sharp で 4 変形（plain / prolog+padding / svgz / BOM）の
 *       metadata() と resize→raw が reject される。block の綴りの正しさを担う load-bearing の leg
 *       Through the wrapper, metadata() and resize→raw reject 4 SVG variants (load-bearing leg).
 * (a')  raster 拡張子（frame-0001.png）の SVG file が reject される
 *       An SVG file named with a raster extension is rejected.
 * (a'') stream 入力が reject される。出力を読み切る段を pipeline の末尾に置く
 *       （読まないと壊れた入力でも resolve する）
 *       Stream input is rejected; the pipeline ends in a stage that consumes the output
 *       (without it, even broken input resolves).
 * (b)   positive control: PNG / JPEG / WebP は decode できる（過剰な block の検出）
 *       Positive control: PNG / JPEG / WebP still decode (detects over-blocking).
 * (c)   非空虚化: 別 process の素の sharp（wrapper 非経由）で、(a)(a')(a'') の各 fixture について
 *       (a) が assert する全操作（metadata / resize→raw / 読み切る stream）が成功し、format が svg。
 *       block と無関係に librsvg が描画に失敗する fixture では (c) が RED になる
 *       Non-vacuity: on bare sharp in a child process, every operation (a) asserts succeeds on
 *       every fixture and the format is svg.
 * (d)   AST: "sharp" の取得は wrapper の 1 件のみ（ElementAccess を含め unblock 0 件、
 *       wrapper の block 対象 literal 集合 = 4 要素、wrapper specifier は解決先 file で判定）。
 *       走査 root の guard は tree 別（monorepo は 4 root 必須。OSS tree は apps/cli/src の不在を
 *       許容し、apps/mcp-server/scripts は一部（現在 3 file、.ts は 2）のみ同期され不在も許容）。
 *       skip / skipIf / env は使わない。
 *       `tests/**` は意図的に範囲外: (c) 自身と既存 test が素の sharp を使う（SVG は decode しない）
 *       AST: the wrapper's single import is the only sharp acquisition; tree-aware root guard
 *       discriminated by a T1 marker; `tests/**` is intentionally out of scope.
 * (e)   block が worker thread に及ぶことを検証する（worker 側で wrapper が評価されることではない）
 *       Proves the block reaches worker threads, not that the wrapper is evaluated there.
 *
 * mutation（DoD）: wrapper の `VipsForeignLoadSvg` を存在しない名前に変える →
 *   (a)(a')(a'')(e) と (d) の literal 集合が RED、(c) と (d) の取得経路が GREEN。
 * Mutation (DoD): misspelling `VipsForeignLoadSvg` turns (a)(a')(a'')(e) and the (d) literal-set
 *   sub-leg RED while (c) and the (d) acquisition sub-legs stay GREEN.
 *
 * in-process の leg は「SVG が unblocked であること」を前提にしない（非空虚化は subprocess のみ）。
 * In-process legs never assume SVG is unblocked; non-vacuity is established in a subprocess only.
 *
 * @see ADR-0049 / INV-SEC-IMAGE-INPUT-GATE-001
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
import type { SourceFile } from "ts-morph";

type SharpModule = typeof import("sharp");

const MCP_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(MCP_ROOT, "../..");
const WRAPPER_PATH = path.join(MCP_ROOT, "src/utils/sharp-safe.ts");
const SHARP_ANCHOR = path.join(MCP_ROOT, "package.json");
const SUBPROCESS_TIMEOUT_MS = 20_000;
const BLOCKED_OPERATIONS = [
  "VipsForeignLoadMagick",
  "VipsForeignLoadMagick7",
  "VipsForeignLoadPdf",
  "VipsForeignLoadSvg",
];

/** wrapper を評価して default export を返す（未作成なら leg ごとに RED）/ Loads the wrapper. */
async function loadWrapper(): Promise<SharpModule> {
  const mod = (await import(WRAPPER_PATH)) as { default: SharpModule };
  return mod.default;
}

const SVG_PLAIN = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#f00"/></svg>'
);
const SVG_VARIANTS: Record<string, Buffer> = {
  plain: SVG_PLAIN,
  prologPadded: Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="UTF-8"?>\n' + " ".repeat(512)),
    SVG_PLAIN,
  ]),
  svgz: zlib.gzipSync(SVG_PLAIN),
  bom: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), SVG_PLAIN]),
};

/** stream の出力を最後まで読む段 / A sink stage that consumes the whole output. */
async function drain(src: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of src) {
    // 読み捨てる / discard
  }
}

let tmpDir = "";
let svgAsPngPath = "";

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-sec-svg-"));
  svgAsPngPath = path.join(tmpDir, "frame-0001.png");
  fs.writeFileSync(svgAsPngPath, SVG_PLAIN);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (c) subprocess（素の sharp）/ bare sharp in a child process
// ---------------------------------------------------------------------------

interface BareOutcome {
  format: string;
  metadata: boolean;
  raw: boolean;
  stream: boolean;
}

const ALL_OPS_SUCCEED: BareOutcome = { format: "svg", metadata: true, raw: true, stream: true };

function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VIPS_"))
  ) as NodeJS.ProcessEnv;
}

/**
 * (a)(a')(a'') と同じ 3 操作を素の sharp で実行する。sharp の解決基点は mcp-server に固定する。
 * Runs the three operations on bare sharp; sharp is resolved from the mcp-server package.
 */
function bareOutcomeOf(kind: "base64" | "file", value: string): BareOutcome {
  const script = `
    const fs = require("node:fs");
    const { createRequire } = require("node:module");
    const { Readable } = require("node:stream");
    const { pipeline } = require("node:stream/promises");
    const [anchor, kind, value] = process.argv.slice(1);
    const sharp = createRequire(anchor)("sharp");
    const src = kind === "base64" ? Buffer.from(value, "base64") : value;
    const open = () => (kind === "base64" ? Readable.from([src]) : fs.createReadStream(src));
    const drain = async (s) => { for await (const _ of s) {} };
    const out = { format: "", metadata: false, raw: false, stream: false };
    (async () => {
      try { out.format = String((await sharp(src).metadata()).format); out.metadata = true; } catch {}
      try { await sharp(src).resize(2, 2).raw().toBuffer(); out.raw = true; } catch {}
      try { await pipeline(open(), sharp().resize(2, 2).raw(), drain); out.stream = true; } catch {}
      process.stdout.write(JSON.stringify(out));
    })();
  `;
  const stdout = execFileSync(process.execPath, ["-e", script, SHARP_ANCHOR, kind, value], {
    cwd: MCP_ROOT,
    env: cleanEnv(),
    timeout: SUBPROCESS_TIMEOUT_MS,
    encoding: "utf8",
  });
  return JSON.parse(stdout) as BareOutcome;
}

describe("INV-SEC-SHARP-SVG-BLOCK-001", () => {
  describe("(c) non-vacuity: every operation (a) asserts succeeds on bare sharp", () => {
    it.each(Object.keys(SVG_VARIANTS))("(a) / (a'') fixture %s", (name) => {
      const buf = SVG_VARIANTS[name] as Buffer;
      expect(bareOutcomeOf("base64", buf.toString("base64"))).toEqual(ALL_OPS_SUCCEED);
    });

    it("(a') fixture: SVG file named frame-0001.png", () => {
      expect(bareOutcomeOf("file", svgAsPngPath)).toEqual(ALL_OPS_SUCCEED);
    });
  });

  describe("(a) buffer input is rejected through the wrapper", () => {
    it.each(Object.keys(SVG_VARIANTS))("%s", async (name) => {
      const sharp = await loadWrapper();
      const buf = SVG_VARIANTS[name] as Buffer;
      await expect(sharp(buf).metadata()).rejects.toThrow();
      await expect(sharp(buf).resize(2, 2).raw().toBuffer()).rejects.toThrow();
    });
  });

  it("(a') file input with a raster extension is rejected", async () => {
    const sharp = await loadWrapper();
    await expect(sharp(svgAsPngPath).metadata()).rejects.toThrow();
    await expect(sharp(svgAsPngPath).resize(2, 2).raw().toBuffer()).rejects.toThrow();
  });

  it("(a'') stream input is rejected (output consumed to the end)", async () => {
    const sharp = await loadWrapper();
    await expect(
      pipeline(Readable.from([SVG_PLAIN]), sharp().resize(2, 2).raw(), drain)
    ).rejects.toThrow();
  });

  describe("(b) positive control: rasters still decode through the wrapper", () => {
    it.each(["png", "jpeg", "webp"] as const)("%s", async (format) => {
      const sharp = await loadWrapper();
      const buf = await sharp({
        create: { width: 4, height: 4, channels: 3, background: "#0f0" },
      })
        .toFormat(format)
        .toBuffer();
      expect((await sharp(buf).metadata()).format).toBe(format);
      await expect(sharp(buf).resize(2, 2).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
    });
  });

  it("(e) the block reaches worker threads", async () => {
    await loadWrapper();
    const workerSource = `
      const { parentPort, workerData } = require("node:worker_threads");
      const { createRequire } = require("node:module");
      const sharp = createRequire(workerData.anchor)("sharp");
      sharp(Buffer.from(workerData.svg, "base64")).metadata()
        .then(() => parentPort.postMessage("decoded"))
        .catch(() => parentPort.postMessage("rejected"));
    `;
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { anchor: SHARP_ANCHOR, svg: SVG_PLAIN.toString("base64") },
    });
    try {
      const result = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker timeout")), SUBPROCESS_TIMEOUT_MS);
        worker.once("message", (message: string) => {
          clearTimeout(timer);
          resolve(message);
        });
        worker.once("error", reject);
      });
      expect(result).toBe("rejected");
    } finally {
      await worker.terminate();
    }
  });
});

// ---------------------------------------------------------------------------
// (d) AST
// ---------------------------------------------------------------------------

type TreeKind = "monorepo" | "oss";
type RootName = "mcpSrc" | "mcpScripts" | "packagesSrc" | "cliSrc";

const SCAN_ROOTS: Record<RootName, { dir: string; glob: string }> = {
  mcpSrc: { dir: "apps/mcp-server/src", glob: "apps/mcp-server/src/**/*.ts" },
  mcpScripts: { dir: "apps/mcp-server/scripts", glob: "apps/mcp-server/scripts/**/*.ts" },
  packagesSrc: { dir: "packages", glob: "packages/*/src/**/*.ts" },
  cliSrc: { dir: "apps/cli/src", glob: "apps/cli/src/**/*.ts" },
};

/**
 * root ごとに存在と走査 file 数 ≥ 1 を要求する集合（tree 別）。
 * OSS tree では apps/cli/src は同期されない。apps/mcp-server/scripts は .ossfilter で一部
 * （現在 3 file、.ts は 2）のみ同期され、不在も許容する。同期される .ts のうち
 * generate-sharp-parity-baseline.ts は wrapper 経由で sharp を取得し、存在すれば走査される。
 * Roots that must exist with ≥ 1 scanned file, per tree kind.
 */
const REQUIRED_ROOTS: Record<TreeKind, readonly RootName[]> = {
  monorepo: ["mcpSrc", "mcpScripts", "packagesSrc", "cliSrc"],
  oss: ["mcpSrc", "packagesSrc"],
};

/**
 */
const TREE_MARKER = "project docs";
const OSSFILTER_MARKER_RULE = "- **/project docs";

function detectTree(repoRoot: string): TreeKind {
  return fs.existsSync(path.join(repoRoot, TREE_MARKER)) ? "monorepo" : "oss";
}

function rootGuardViolations(tree: TreeKind, counts: Record<RootName, number>): RootName[] {
  return REQUIRED_ROOTS[tree].filter((root) => counts[root] < 1);
}

interface SharpAcquisition {
  file: string;
  kind: string;
}

function isSharpSpecifier(node: Node | undefined): boolean {
  return (
    node !== undefined &&
    (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) &&
    node.getLiteralValue() === "sharp"
  );
}

function collectSharpAcquisitions(sf: SourceFile): SharpAcquisition[] {
  const file = path.relative(REPO_ROOT, sf.getFilePath());
  const found: SharpAcquisition[] = [];
  for (const decl of sf.getImportDeclarations()) {
    if (decl.getModuleSpecifierValue() !== "sharp" || decl.isTypeOnly()) continue;
    // inline type 指定子のみ（`import { type Sharp } from "sharp"`）は取得ではない
    const named = decl.getNamedImports();
    const inlineTypeOnly =
      decl.getDefaultImport() === undefined &&
      decl.getNamespaceImport() === undefined &&
      named.length > 0 &&
      named.every((n) => n.isTypeOnly());
    if (!inlineTypeOnly) found.push({ file, kind: "import" });
  }
  for (const decl of sf.getExportDeclarations()) {
    if (decl.getModuleSpecifierValue() === "sharp" && !decl.isTypeOnly()) {
      found.push({ file, kind: "export-from" });
    }
  }
  for (const eq of sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const ref = eq.getModuleReference();
    if (Node.isExternalModuleReference(ref) && isSharpSpecifier(ref.getExpression())) {
      found.push({ file, kind: "import-equals" });
    }
  }
  // dynamic import / require / createRequire(...) 由来の関数呼出し（callee を問わない）
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (isSharpSpecifier(call.getArguments()[0])) {
      found.push({ file, kind: `call:${call.getExpression().getText()}` });
    }
  }
  return found;
}

function unblockAccesses(sf: SourceFile): string[] {
  const viaProperty = sf
    .getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
    .filter((pa) => pa.getName() === "unblock");
  const viaElement = sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression).filter((ea) => {
    const arg = ea.getArgumentExpression();
    return (
      arg !== undefined &&
      (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) &&
      arg.getLiteralValue() === "unblock"
    );
  });
  return [...viaProperty, ...viaElement].map(
    (n) => `${path.relative(REPO_ROOT, sf.getFilePath())}:${n.getStartLineNumber()}`
  );
}

describe("(d) AST: sharp is acquired only through the wrapper", () => {
  const tree = detectTree(REPO_ROOT);
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      allowJs: false,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  });
  const counts: Record<RootName, number> = { mcpSrc: 0, mcpScripts: 0, packagesSrc: 0, cliSrc: 0 };

  beforeAll(() => {
    for (const [name, root] of Object.entries(SCAN_ROOTS) as [
      RootName,
      typeof SCAN_ROOTS.mcpSrc,
    ][]) {
      if (!fs.existsSync(path.join(REPO_ROOT, root.dir))) continue;
      counts[name] = project.addSourceFilesAtPaths(path.join(REPO_ROOT, root.glob)).length;
    }
  });

  it("tree marker is a file that .ossfilter keeps out of the OSS tree", () => {
    if (tree === "monorepo") {
      const rules = fs.readFileSync(path.join(REPO_ROOT, ".ossfilter"), "utf8").split("\n");
      expect(rules.map((line) => line.trim())).toContain(OSSFILTER_MARKER_RULE);
    } else {
      // OSS tree: marker が無いことが判別の根拠そのもの / marker absence is the discriminator
      expect(fs.existsSync(path.join(REPO_ROOT, TREE_MARKER))).toBe(false);
    }
  });

  it("root guard: every root required for this tree is present and scanned", () => {
    expect(rootGuardViolations(tree, counts)).toEqual([]);
    expect(project.getSourceFile(WRAPPER_PATH)).toBeDefined();
  });

  it("root guard is not vacuous: a monorepo tree missing a root is rejected", () => {
    const full: Record<RootName, number> = { mcpSrc: 1, mcpScripts: 1, packagesSrc: 1, cliSrc: 1 };
    expect(rootGuardViolations("monorepo", { ...full, cliSrc: 0 })).toEqual(["cliSrc"]);
    expect(rootGuardViolations("oss", { ...full, cliSrc: 0, mcpScripts: 0 })).toEqual([]);
    expect(rootGuardViolations("oss", { ...full, packagesSrc: 0 })).toEqual(["packagesSrc"]);
  });

  it("the only sharp acquisition is the wrapper's single import", () => {
    const all = project.getSourceFiles().flatMap(collectSharpAcquisitions);
    expect(all).toEqual([{ file: path.relative(REPO_ROOT, WRAPPER_PATH), kind: "import" }]);
  });

  it('the wrapper is a leaf (imports exactly ["sharp"])', () => {
    const wrapper = project.getSourceFileOrThrow(WRAPPER_PATH);
    expect(wrapper.getImportDeclarations().map((d) => d.getModuleSpecifierValue())).toEqual([
      "sharp",
    ]);
  });

  it("wrapper specifiers are judged by the resolved file", () => {
    const decls = project
      .getSourceFiles()
      .flatMap((sf) => [...sf.getImportDeclarations(), ...sf.getExportDeclarations()]);
    const resolvedToWrapper = decls.filter(
      (d) => d.getModuleSpecifierSourceFile()?.getFilePath() === WRAPPER_PATH
    );
    expect(resolvedToWrapper.length).toBeGreaterThan(0);
    // 末尾 segment が sharp-safe の specifier は、`./sharp-safe` を含めすべて wrapper に解決される
    const namedLikeWrapper = decls.filter((d) => {
      const spec = d.getModuleSpecifierValue();
      return spec !== undefined && /(^|\/)sharp-safe(\.[cm]?[jt]s)?$/.test(spec);
    });
    expect(
      namedLikeWrapper
        .filter((d) => d.getModuleSpecifierSourceFile()?.getFilePath() !== WRAPPER_PATH)
        .map((d) => `${d.getSourceFile().getFilePath()}: ${d.getModuleSpecifierValue()}`)
    ).toEqual([]);
  });

  it("no unblock access exists (property access or element access)", () => {
    expect(project.getSourceFiles().flatMap(unblockAccesses)).toEqual([]);
  });

  it("the wrapper blocks exactly the four loader classes (S-c)", () => {
    const wrapper = project.getSourceFileOrThrow(WRAPPER_PATH);
    const blockCalls = wrapper
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((c) => c.getExpression().getText() === "sharp.block");
    expect(blockCalls).toHaveLength(1);
    const literals = blockCalls[0]!
      .getDescendantsOfKind(SyntaxKind.StringLiteral)
      .map((l) => l.getLiteralValue());
    expect([...literals].sort()).toEqual(BLOCKED_OPERATIONS);
  });
});
