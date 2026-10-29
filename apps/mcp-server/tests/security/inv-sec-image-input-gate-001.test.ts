// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-SEC-IMAGE-INPUT-GATE-001 — 画像入力の許可形式 gate（層 2、入口 P1 / P2）
 * INV-SEC-IMAGE-INPUT-GATE-001 — image input format allowlist gate (layer 2, entries P1 / P2)
 *
 * 命題: allowlist 外の入力は、wrapper の default export（sharp）を一度も呼ばずに拒否される。
 * spy = 0 は INV-SEC-SHARP-SVG-BLOCK-001 (d)（sharp の取得が wrapper 経由）を前提とする。
 * Proposition: input outside the allowlist is rejected without ever calling the wrapper's
 * default export (sharp). "spy = 0" relies on INV-SEC-SHARP-SVG-BLOCK-001 (d).
 *
 * (a) P1 base64  (b) P1 URL  (c) removed (internal API P1' classifier; API removed)  (d)(d') P2  (e) CWE-209 message
 * (f) unit: detectRasterFormat / allowlist sets / head-decode limit  (g) AST (P1, P2, P3)
 * (h) P3 buffer snapshot (P3a / P3b / P3c + helper)  (i) P2 data URI normalization
 * (j) lives in a separate file (webui accept)  (k) pinned snapshot caps
 *
 * @see ADR-0049 / INV-SEC-SHARP-SVG-BLOCK-001
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { Node, Project, SyntaxKind } from "ts-morph";
import type { Block, FunctionDeclaration, SourceFile, Statement } from "ts-morph";

const { sharpSpy, snapshotBuffers } = vi.hoisted(() => ({
  sharpSpy: vi.fn(),
  snapshotBuffers: [] as Buffer[],
}));

// spy = wrapper の default export の passthrough / passthrough spy on the wrapper's default export
vi.mock("../../src/utils/sharp-safe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/sharp-safe")>();
  const real = actual.default as unknown as (...args: unknown[]) => unknown;
  const spied = Object.assign((...args: unknown[]): unknown => {
    sharpSpy(...args);
    return real(...args);
  }, actual.default);
  return { ...actual, default: spied };
});

// spy = passthrough that records the snapshots, so sharp's argument is compared by reference
vi.mock("../../src/utils/image-format-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/image-format-gate")>();
  const wrapped = async (
    ...args: Parameters<typeof actual.readRasterFileSnapshot>
  ): Promise<Buffer> => {
    const buf = await actual.readRasterFileSnapshot(...args);
    snapshotBuffers.push(buf);
    return buf;
  };
  return { ...actual, readRasterFileSnapshot: wrapped };
});

import sharp from "../../src/utils/sharp-safe";
import {
  DESIGN_SEARCH_ERROR_CODES,
  designSearchByImageHandler,
  resetDesignSearchDINOv2ServiceFactory,
  resetDesignSearchEmbeddingServiceFactory,
  resetDesignSearchPrismaClientFactory,
  setDesignSearchDINOv2ServiceFactory,
  setDesignSearchEmbeddingServiceFactory,
  setDesignSearchPrismaClientFactory,
} from "../../src/tools/design/search-by-image.tool";
import {
  layoutInspectHandler,
  resetLayoutInspectServiceFactory,
  setLayoutInspectServiceFactory,
} from "../../src/tools/layout/inspect/inspect.tool";
import { screenshotInputSchema } from "../../src/tools/layout/inspect/inspect.schemas";
import { ImageOptimizer } from "../../src/services/vision/image-optimizer";
import { FrameLoaderError, LIMITS } from "../../src/services/motion/types";
import { FrameImageAnalyzerAdapter } from "../../src/services/motion/frame-image-analyzer.adapter";
import { FrameImageAnalysisService } from "../../src/services/motion/frame-image-analysis.service";
import { FrameLoader } from "../../src/services/motion/infrastructure/frame-loader";
import { FrameAnalyzerService } from "../../src/services/page/frame-analyzer.service";
import { videoOptionsSchema } from "../../src/tools/motion/detect.schemas";
import { motionOptionsSchema } from "../../src/tools/page/input.schemas";
import { zodObjectShape, zodUnwrap } from "../utils/support/zod-introspect";
import { logger } from "../../src/utils/logger";
import { invalidateCache } from "../../src/services/search-cache.service";
import {
  createMockDINOv2Service,
  createMockEmbeddingService,
  createMockPrismaClient,
  VALID_BASE64_PNG,
} from "../tools/design/_helpers/design-search-mocks";

type GateModule = typeof import("../../src/utils/image-format-gate");

const MCP_ROOT = path.resolve(__dirname, "../..");
const GATE_SRC = "src/utils/image-format-gate.ts";
const loadGate = (): Promise<GateModule> => import("../../src/utils/image-format-gate");

const SVG_PLAIN = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#f00"/></svg>'
);
const SVG_B64 = SVG_PLAIN.toString("base64");
/** 末尾に空白を足した SVG の base64（最低 minChars 文字、常に有効）/ SVG padded with whitespace, valid base64 */
function svgBase64AtLeast(minChars: number): string {
  const padBytes = Math.max(0, Math.ceil((minChars * 3) / 4) - SVG_PLAIN.length + 3);
  return Buffer.concat([SVG_PLAIN, Buffer.from(" ".repeat(padBytes))]).toString("base64");
}
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** libvips 経路用: raster magic を前置した polyglot / polyglot with a raster magic prefix */
const POLYGLOT_B64 = Buffer.concat([PNG_MAGIC, SVG_PLAIN]).toString("base64");
const UNSUPPORTED = DESIGN_SEARCH_ERROR_CODES as Record<string, string>;
const FIXED_SANITIZED = new Set([
  "Database operation failed",
  "Network request failed",
  "Operation timed out",
  "Input validation failed",
  "Resource not found",
  "Service is temporarily unavailable",
  "An internal error occurred",
]);

/** 1 KiB を超える PNG（P2 の到達条件）/ a PNG above 1 KiB (P2 reach condition) */
let bigPngB64 = "";

beforeAll(async () => {
  const buf = await sharp({
    create: {
      width: 96,
      height: 96,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
      noise: { type: "gaussian", mean: 128, sigma: 60 },
    },
  })
    .png()
    .toBuffer();
  expect(buf.length).toBeGreaterThan(1024);
  bigPngB64 = buf.toString("base64");
});

const tmpDirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inv-gate-p3-"));
  tmpDirs.push(dir);
  return dir;
}

/** fixture 生成の後に spy を初期化 / reset spies after fixture creation */
function resetSpies(): void {
  sharpSpy.mockClear();
  snapshotBuffers.length = 0;
}

beforeEach(() => {
  resetSpies(); // fixture 生成の後に初期化 / reset after fixture creation
  invalidateCache();
  setDesignSearchDINOv2ServiceFactory(() => createMockDINOv2Service());
  setDesignSearchEmbeddingServiceFactory(() => createMockEmbeddingService());
  setDesignSearchPrismaClientFactory(() => createMockPrismaClient([]));
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetDesignSearchDINOv2ServiceFactory();
  resetDesignSearchEmbeddingServiceFactory();
  resetDesignSearchPrismaClientFactory();
  resetLayoutInspectServiceFactory();
});

function stubFetch(contentType: string, body: Buffer): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": contentType } }))
  );
}

/** "CODE: message" を分解 / split "CODE: message" */
function splitError(error: string | undefined): { code: string; message: string } {
  const i = (error ?? "").indexOf(":");
  return { code: (error ?? "").slice(0, i), message: (error ?? "").slice(i + 1).trim() };
}

describe("INV-SEC-IMAGE-INPUT-GATE-001", () => {
  describe("(a) P1 base64: non-raster is rejected before sharp", () => {
    it.each([
      ["data URI prefixed SVG", `data:image/png;base64,${SVG_B64}`],
      ["raw base64 SVG", SVG_B64],
    ])("%s", async (_name, image) => {
      const gate = await loadGate();
      const res = await designSearchByImageHandler({ image });
      const { code, message } = splitError(res.error);
      expect(res.success).toBe(false);
      expect(code).toBe(UNSUPPORTED["UNSUPPORTED_IMAGE_FORMAT"]);
      expect(code).toBe("UNSUPPORTED_IMAGE_FORMAT");
      expect(message).toBe(gate.UNSUPPORTED_IMAGE_FORMAT_MESSAGE);
      expect(sharpSpy).toHaveBeenCalledTimes(0);
    });

    it("positive control: a PNG reaches sharp", async () => {
      await designSearchByImageHandler({ image: VALID_BASE64_PNG });
      expect(sharpSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("(b) P1 URL: the body is judged, not the content-type", () => {
    it.each(["image/png", "image/svg+xml"])("content-type %s + SVG body", async (ct) => {
      const gate = await loadGate();
      stubFetch(ct, SVG_PLAIN);
      const res = await designSearchByImageHandler({ image: "https://example.com/a.png" });
      const { code, message } = splitError(res.error);
      expect(res.success).toBe(false);
      expect(code).toBe("UNSUPPORTED_IMAGE_FORMAT");
      expect(message).toBe(gate.UNSUPPORTED_IMAGE_FORMAT_MESSAGE);
      expect(sharpSpy).toHaveBeenCalledTimes(0);
    });

    it("positive control: image/png + PNG body reaches sharp", async () => {
      stubFetch("image/png", Buffer.from(VALID_BASE64_PNG, "base64"));
      await designSearchByImageHandler({ image: "https://example.com/a.png" });
      expect(sharpSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("(d) P2 layout.inspect: gate runs before the optimizer and the vision service", () => {
    const input = (base64: string): Record<string, unknown> => ({
      screenshot: { base64, mimeType: "image/png" },
      options: { visionOptions: { visionForceCpu: true, visionImageMaxSize: 1024 } },
    });

    it("SVG -> VALIDATION_ERROR with the SSOT message; optimizer and service not called", async () => {
      const gate = await loadGate();
      const analyzeScreenshot = vi.fn();
      const optimize = vi.spyOn(ImageOptimizer.prototype, "optimizeForCPU");
      setLayoutInspectServiceFactory(() => ({ analyzeScreenshot }));
      const res = await layoutInspectHandler(input(SVG_B64));
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("VALIDATION_ERROR");
      expect(res.error?.message).toBe(gate.UNSUPPORTED_IMAGE_FORMAT_MESSAGE);
      expect(optimize).not.toHaveBeenCalled();
      expect(analyzeScreenshot).not.toHaveBeenCalled();
      expect(sharpSpy).toHaveBeenCalledTimes(0);
    });

    it("positive control: a PNG above visionImageMaxSize reaches the optimizer", async () => {
      const optimize = vi.spyOn(ImageOptimizer.prototype, "optimizeForCPU");
      setLayoutInspectServiceFactory(() => ({
        analyzeScreenshot: vi.fn().mockResolvedValue({ success: true, features: [] }),
      }));
      await layoutInspectHandler(input(bigPngB64));
      expect(optimize).toHaveBeenCalled();
    });
  });

  describe("(d') P2 without a vision service: SVG is a validation error, not unavailable", () => {
    it("SVG -> VALIDATION_ERROR (SSOT message)", async () => {
      const gate = await loadGate();
      const res = await layoutInspectHandler({ screenshot: { base64: svgBase64AtLeast(120) } });
      expect(res.error?.code).toBe("VALIDATION_ERROR");
      expect(res.error?.message).toBe(gate.UNSUPPORTED_IMAGE_FORMAT_MESSAGE);
    });

    it("positive control: a PNG reaches the service lookup", async () => {
      const res = await layoutInspectHandler({ screenshot: { base64: bigPngB64 } });
      expect(res.error?.code).toBe("SERVICE_UNAVAILABLE");
    });
  });

  describe("(e) CWE-209: the rejection text is a fixed constant", () => {
    it("gate path text === the SSOT constant and leaks no loader / format detail", async () => {
      const gate = await loadGate();
      const res = await designSearchByImageHandler({ image: SVG_B64 });
      const { message } = splitError(res.error);
      expect(message).toBe(gate.UNSUPPORTED_IMAGE_FORMAT_MESSAGE);
      expect(message.length).toBeGreaterThan(0);
      // 補助 / auxiliary: denylist
      expect(message).not.toMatch(/rsvg|librsvg|svg|magick|vips|sharp|\/|http/i);
    });

    it("libvips path (raster magic + SVG polyglot) is a sanitizeErrorMessage fixed sentence", async () => {
      const res = await designSearchByImageHandler({ image: POLYGLOT_B64 });
      const { code, message } = splitError(res.error);
      expect(res.success).toBe(false);
      expect(code).toBe("IMAGE_DECODE_FAILED");
      expect(FIXED_SANITIZED.has(message)).toBe(true);
    });
  });

  describe("(f) unit: detectRasterFormat / allowlist sets / head-decode limit", () => {
    const riff = (kind: string): Buffer =>
      Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from(kind)]);

    it.each([
      ["png", PNG_MAGIC],
      ["jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
      ["webp", riff("WEBP")],
    ])("minimal magic of %s", async (format, head) => {
      expect((await loadGate()).detectRasterFormat(head)).toBe(format);
    });

    it.each([
      ["RIFF + WAVE", riff("WAVE")],
      ["RIFF only (< 8 bytes)", Buffer.from("RIFF")],
      ["first 7 bytes of the PNG magic", PNG_MAGIC.subarray(0, 7)],
      ["FF D8 only (2 bytes)", Buffer.from([0xff, 0xd8])],
      ["JPEG magic at offset 1", Buffer.from([0x00, 0xff, 0xd8, 0xff, 0xe0])],
      ["plain SVG", SVG_PLAIN],
      ["BOM + SVG", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), SVG_PLAIN])],
      ["whitespace + SVG", Buffer.concat([Buffer.from("  \n"), SVG_PLAIN])],
    ])("boundary negative: %s -> null", async (_name, head) => {
      expect((await loadGate()).detectRasterFormat(head)).toBeNull();
    });

    it("PNG magic + SVG body is judged png (layer 1 is the backstop)", async () => {
      const buf = Buffer.concat([PNG_MAGIC, SVG_PLAIN]);
      expect((await loadGate()).detectRasterFormat(buf)).toBe("png");
    });

    it("allowlist sets are pinned to their sources (Zod enum / LIMITS.ALLOWED_EXTENSIONS)", async () => {
      const gate = await loadGate();
      const zodSet = screenshotInputSchema.shape.mimeType
        .removeDefault()
        .options.map((m) => m.replace("image/", ""));
      expect([...gate.P2_RASTER_ALLOW].sort()).toEqual([...zodSet].sort());
      const frameSet = new Set(
        LIMITS.ALLOWED_EXTENSIONS.map((e) => e.replace(".", "").replace("jpg", "jpeg"))
      );
      expect([...gate.FRAME_RASTER_ALLOW].sort()).toEqual([...frameSet].sort());
      expect([...gate.P1_RASTER_ALLOW].sort()).toEqual(["jpeg", "png", "webp"]);
    });

    it("assertAllowedRaster throws UnsupportedImageFormatError carrying the SSOT message", async () => {
      const gate = await loadGate();
      const act = (): void => gate.assertAllowedRaster(SVG_PLAIN, gate.P1_RASTER_ALLOW);
      expect(act).toThrow(gate.UnsupportedImageFormatError);
      expect(act).toThrow(gate.UNSUPPORTED_IMAGE_FORMAT_MESSAGE);
      expect(() => gate.assertAllowedRaster(PNG_MAGIC, gate.FRAME_RASTER_ALLOW)).not.toThrow();
      expect(() => gate.assertAllowedRaster(riff("WEBP"), gate.FRAME_RASTER_ALLOW)).toThrow(
        gate.UnsupportedImageFormatError
      );
    });

    it("K = 4096: a header preceded by whitespace within K is found; beyond K it fails closed", async () => {
      const gate = await loadGate();
      const png = Buffer.concat([PNG_MAGIC, Buffer.alloc(16)]).toString("base64");
      expect(gate.SCREENSHOT_HEAD_DECODE_LIMIT_CHARS).toBe(4096);
      expect(gate.rejectNonRasterScreenshot(" ".repeat(4000) + png)).toBeNull();
      expect(gate.rejectNonRasterScreenshot(" ".repeat(5000) + png)).not.toBeNull();
    });

    it("normalizeScreenshotBase64 strips any base64 data URI label, case-insensitively", async () => {
      const { normalizeScreenshotBase64: norm } = await loadGate();
      expect(norm(`data:image/svg+xml;base64,${VALID_BASE64_PNG}`)).toBe(VALID_BASE64_PNG);
      expect(norm(`DATA:IMAGE/PNG;BASE64,${VALID_BASE64_PNG}`)).toBe(VALID_BASE64_PNG);
      expect(norm(VALID_BASE64_PNG)).toBe(VALID_BASE64_PNG);
    });
  });

  describe("(g) AST: the gate is the first, unconditional statement at each entry", () => {
    let project: Project;
    beforeAll(() => {
      project = new Project({ skipAddingFilesFromTsConfig: true });
    });
    const load = (rel: string): SourceFile => project.addSourceFileAtPath(path.join(MCP_ROOT, rel));
    const callee = (n: Node | undefined): string | undefined =>
      n && Node.isCallExpression(n) ? n.getExpression().getText() : undefined;

    it("P1: preprocessImageForDINOv2 starts with a bare assertAllowedRaster(...) statement", () => {
      const fn = load("src/tools/design/search-by-image.tool.ts").getFunction(
        "preprocessImageForDINOv2"
      ) as FunctionDeclaration | undefined;
      expect(fn).toBeDefined(); // locator-guard
      const body = fn?.getBody() as Block;
      const first = body.getStatements()[0];
      expect(first?.getKind()).toBe(SyntaxKind.ExpressionStatement);
      expect(callee((first as import("ts-morph").ExpressionStatement).getExpression())).toBe(
        "assertAllowedRaster"
      );
      const sharpCall = body
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .find((c) => c.getExpression().getText() === "sharp");
      expect(sharpCall).toBeDefined();
      expect(first?.getEnd()).toBeLessThanOrEqual(sharpCall?.getStart() ?? 0);
    });

    it("P2: layoutInspectHandler screenshot branch starts with `const x = rejectNonRasterScreenshot(...); if (x) return`", () => {
      const fn = load("src/tools/layout/inspect/inspect.tool.ts").getFunction(
        "layoutInspectHandler"
      );
      const branch = fn
        ?.getDescendantsOfKind(SyntaxKind.IfStatement)
        .find((s) => s.getExpression().getText() === "validated.screenshot");
      expect(branch).toBeDefined(); // locator-guard
      const stmts = (branch?.getThenStatement() as Block).getStatements();
      const decl = stmts[0]?.asKind(SyntaxKind.VariableStatement)?.getDeclarations()[0];
      expect(callee(decl?.getInitializer())).toBe("rejectNonRasterScreenshot");
      const guard = stmts[1]?.asKind(SyntaxKind.IfStatement);
      expect(guard?.getExpression().getText()).toBe(decl?.getName());
      expect(guard?.getThenStatement().getKind()).toBe(SyntaxKind.ReturnStatement);
      const later = branch
        ?.getDescendantsOfKind(SyntaxKind.Identifier)
        .filter((i) =>
          ["optimizeForCPU", "analyzeScreenshot", "serviceFactoryDI"].includes(i.getText())
        );
      expect(later?.length).toBeGreaterThan(0);
      for (const id of later ?? []) expect(guard?.getEnd()).toBeLessThanOrEqual(id.getStart());
    });

    // ---- P3: buffer snapshot sites ----
    const SNAP = "readRasterFileSnapshot";
    const ADAPTER = "src/services/motion/frame-image-analyzer.adapter.ts";
    const LOADER = "src/services/motion/infrastructure/frame-loader.ts";
    const ANALYZER = "src/services/page/frame-analyzer.service.ts";
    const locate = (rel: string, name: string): Node | undefined => {
      const [owner, method] = name.split(".");
      const sf = load(rel);
      return method ? sf.getClass(owner!)?.getMethod(method) : sf.getFunction(owner!);
    };
    // [file, function, path params, cap argument, sharp( calls, in a top-level try]
    const sinks: [string, string, string[], string, number, boolean][] = [
      [
        ADAPTER,
        "FrameImageAnalyzerAdapter.loadFrameAsRawPixels",
        ["framePath"],
        "FRAME_CAPTURE_SNAPSHOT_MAX_BYTES",
        1,
        false,
      ],
      [LOADER, "FrameLoader.getFrameMetadata", ["filePath"], "this.maxFileSize", 1, true],
      [LOADER, "FrameLoader.loadFrame", ["filePath"], "this.maxFileSize", 2, true],
      [
        ANALYZER,
        "compareImages",
        ["imagePath1", "imagePath2"],
        "VIDEO_FRAME_SNAPSHOT_MAX_BYTES",
        2,
        false,
      ],
    ];

    it.each(sinks)(
      "%s %s: `const x = await readRasterFileSnapshot(...)` first; sharp decodes only snapshots",
      (rel, name, paths, cap, sharpCalls, viaTry) => {
        const fn = locate(rel, name) as (Node & { getBody(): Block }) | undefined;
        expect(fn).toBeDefined(); // locator-guard
        let stmts: Statement[] = fn!.getBody().getStatements();
        if (viaTry) {
          const tries = stmts.filter((st) => st.getKind() === SyntaxKind.TryStatement);
          expect(tries).toHaveLength(1);
          stmts = tries[0]!.asKindOrThrow(SyntaxKind.TryStatement).getTryBlock().getStatements();
        }
        const names = paths.map((p, i) => {
          const d = stmts[i]?.asKind(SyntaxKind.VariableStatement)?.getDeclarations()[0];
          const c = d?.getInitializer()?.asKind(SyntaxKind.AwaitExpression)?.getExpression();
          const call = c?.asKind(SyntaxKind.CallExpression);
          expect(call?.getExpression().getText()).toBe(SNAP);
          expect(call?.getArguments().map((a) => a.getText())).toEqual([
            p,
            "FRAME_RASTER_ALLOW",
            cap,
          ]);
          return d!.getName();
        });
        const calls = fn!.getDescendantsOfKind(SyntaxKind.CallExpression);
        const sharpArgs = calls
          .filter((c) => c.getExpression().getText() === "sharp")
          .map((c) => c.getArguments()[0]?.getText() ?? "");
        expect(sharpArgs).toHaveLength(sharpCalls);
        for (const a of sharpArgs) expect(names).toContain(a); // never a path
        for (const all of calls.filter((c) => c.getExpression().getText() === "Promise.all")) {
          expect(all.getText()).not.toContain(SNAP); // sequential
        }
        if (viaTry) {
          const catchText =
            fn!.getDescendantsOfKind(SyntaxKind.CatchClause).at(-1)?.getText() ?? "";
          expect(catchText.indexOf("FrameSnapshotError")).toBeGreaterThanOrEqual(0);
          expect(catchText.indexOf("FrameSnapshotError")).toBeLessThan(
            catchText.indexOf('"LOAD_FAILED"')
          );
        }
      }
    );

    it("mapSnapshotError: exhaustive switch over every reason with a never branch", async () => {
      const gate = await loadGate();
      const sw = load(LOADER)
        .getFunction("mapSnapshotError")
        ?.getDescendantsOfKind(SyntaxKind.SwitchStatement)[0];
      expect(sw).toBeDefined(); // locator-guard
      const cases = sw?.getClauses().filter((c) => c.getKind() === SyntaxKind.CaseClause) ?? [];
      const labels = cases.map((c) =>
        c.asKindOrThrow(SyntaxKind.CaseClause).getExpression().getText()
      );
      expect(new Set(labels)).toEqual(new Set(gate.FRAME_SNAPSHOT_REASONS.map((r) => `"${r}"`)));
      expect(sw?.getClauses().at(-1)?.getText()).toMatch(/\bnever\b/);
    });

    it("the gate module is a pure function module (no sharp import)", () => {
      const text = fs.readFileSync(path.join(MCP_ROOT, GATE_SRC), "utf8");
      expect(text).not.toMatch(/from\s+["']sharp|sharp-safe/);
      expect(text).not.toMatch(/utils\/logger|console\./); // callers log
    });
  });

  describe("(i) P2 data URI normalization is shared by the gate and the later stage", () => {
    const run = async (
      shot: string
    ): Promise<{
      analyze: ReturnType<typeof vi.fn>;
      res: Awaited<ReturnType<typeof layoutInspectHandler>>;
    }> => {
      const analyze = vi.fn().mockResolvedValue({ success: true, features: [] });
      setLayoutInspectServiceFactory(() => ({ analyzeScreenshot: analyze }));
      const res = await layoutInspectHandler({
        screenshot: { base64: shot, mimeType: "image/png" },
        options: { visionOptions: { visionForceCpu: true, visionImageMaxSize: 10_000_000 } },
      });
      return { analyze, res };
    };

    it.each(["data:image/png;base64,", "data:image/svg+xml;base64,", "DATA:IMAGE/PNG;BASE64,"])(
      "%s<PNG> passes the gate and the prefix never reaches the service",
      async (prefix) => {
        const { analyze } = await run(prefix + bigPngB64);
        expect(analyze).toHaveBeenCalledTimes(1);
        expect((analyze.mock.calls[0]?.[0] as { base64: string }).base64).toBe(bigPngB64);
      }
    );

    it("data:image/png;base64,<SVG> is rejected with the SSOT message", async () => {
      const gate = await loadGate();
      const { analyze, res } = await run(`data:image/png;base64,${svgBase64AtLeast(120)}`);
      expect(res.success).toBe(false);
      expect(res.error?.code).toBe("VALIDATION_ERROR");
      expect(res.error?.message).toBe(gate.UNSUPPORTED_IMAGE_FORMAT_MESSAGE);
      expect(analyze).not.toHaveBeenCalled();
    });
  });

  // ---- (h) P3 buffer snapshot / (k) pinned caps ----

  const frameName = (i: number): string => `frame-${String(i).padStart(4, "0")}.png`;
  const solid = (r: number, g: number, b: number): Promise<Buffer> =>
    sharp({ create: { width: 16, height: 16, channels: 3, background: { r, g, b } } })
      .png()
      .toBuffer();
  const asErr = (p: Promise<unknown>): Promise<Record<string, string>> =>
    p.catch((e: unknown) => e) as Promise<Record<string, string>>;

  async function writePngFrames(dir: string): Promise<void> {
    fs.writeFileSync(path.join(dir, frameName(1)), await solid(255, 0, 0));
    fs.writeFileSync(path.join(dir, frameName(2)), await solid(0, 0, 255));
  }

  /** NODE_ENV は development ではない（本番相当）/ production-like */
  function spyWarn(): MockInstance {
    expect(process.env["NODE_ENV"]).not.toBe("development");
    return vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  }
  const warned = (w: MockInstance, message: string): unknown[][] =>
    w.mock.calls.filter((c: unknown[]) => c[0] === message);
  const leaks = (w: MockInstance): string => JSON.stringify(w.mock.calls);
  /** sharp の第 1 引数は全て snapshot と同一参照 / every sharp argument is a snapshot (same reference) */
  function expectSharpFedBySnapshots(calls: number): void {
    expect(sharpSpy).toHaveBeenCalledTimes(calls);
    for (const c of sharpSpy.mock.calls) expect(snapshotBuffers.some((b) => b === c[0])).toBe(true);
  }

  describe("(h) readRasterFileSnapshot (helper)", () => {
    /** 偽 handle / fake handle */
    function fake(size: number, reads: Buffer[]): { close: MockInstance; open: MockInstance } {
      const queue = [...reads];
      const close = vi.fn(async () => undefined);
      const read = vi.fn(async (buf: Buffer, off: number, len: number) => {
        const chunk = queue.shift();
        const n = chunk ? Math.min(chunk.length, len) : 0;
        if (chunk) chunk.copy(buf, off, 0, n);
        if (chunk && n < chunk.length) queue.unshift(chunk.subarray(n));
        return { bytesRead: n, buffer: buf };
      });
      const stat = vi.fn(async () => ({ isFile: (): boolean => true, size }));
      const handle = { stat, read, close } as never;
      return { close, open: vi.spyOn(fs.promises, "open").mockResolvedValueOnce(handle) };
    }
    const snap = async (file: string, max = 1 << 20): Promise<Buffer> => {
      const gate = await loadGate();
      return gate.readRasterFileSnapshot(file, gate.FRAME_RASTER_ALLOW, max);
    };

    it("opens once with O_RDONLY|O_NONBLOCK|O_NOCTTY and returns the file bytes", async () => {
      const file = path.join(makeDir(), frameName(1));
      fs.writeFileSync(file, await solid(1, 2, 3));
      const open = vi.spyOn(fs.promises, "open");
      expect((await snap(file)).equals(fs.readFileSync(file))).toBe(true);
      const { O_RDONLY, O_NONBLOCK, O_NOCTTY } = fs.constants;
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith(file, O_RDONLY | O_NONBLOCK | O_NOCTTY);
    });

    it("a file that grew after fstat is file_too_large (the cap does not move)", async () => {
      const png = await solid(5, 5, 5);
      const f = fake(png.length - 1, [png]);
      expect((await asErr(snap("/virtual/a.png")))["reason"]).toBe("file_too_large");
      expect(f.close).toHaveBeenCalledTimes(1);
    });

    it.each([0, 5])("reads to EOF from one fd, short reads joined (size + %i)", async (extra) => {
      const png = await solid(6, 6, 6);
      fake(png.length + extra, [png.subarray(0, 9), png.subarray(9)]);
      expect((await snap("/virtual/a.png")).equals(png)).toBe(true);
    });
  });

  describe("(h) P3a loadFrameAsRawPixels", () => {
    const analyze = async (dir: string): Promise<number> =>
      (await new FrameImageAnalyzerAdapter().analyze(dir, { sampleInterval: 1 })).metadata
        .analyzedPairs;

    it("positive control: sharp receives the snapshot Buffer (same reference) for each frame", async () => {
      const dir = makeDir();
      await writePngFrames(dir);
      resetSpies();
      expect(await analyze(dir)).toBe(1);
      expectSharpFedBySnapshots(2);
    });

    const bothFrames = (make: (file: string) => void) => (dir: string) =>
      [1, 2].forEach((i) => make(path.join(dir, frameName(i))));
    const cases: [string, (dir: string) => void | Promise<void>, string][] = [
      [
        "SVG under a frame name",
        bothFrames((f) => fs.writeFileSync(f, SVG_PLAIN)),
        "unsupported_image_format",
      ],
      ["broken symlink", bothFrames((f) => fs.symlinkSync(`${f}.gone`, f)), "open_failed"],
      [
        "FIFO (mkfifo must work: no skip)",
        bothFrames((f) => execFileSync("mkfifo", [f])),
        "not_a_regular_file",
      ],
      ["/dev/zero link", bothFrames((f) => fs.symlinkSync("/dev/zero", f)), "not_a_regular_file"],
      [
        "sparse file one byte over FRAME_CAPTURE_SNAPSHOT_MAX_BYTES",
        async (dir) => {
          const { FRAME_CAPTURE_SNAPSHOT_MAX_BYTES: cap } = await loadGate();
          bothFrames((f) => (fs.closeSync(fs.openSync(f, "w")), fs.truncateSync(f, cap + 1)))(dir);
        },
        "file_too_large",
      ],
    ];

    it.each(cases)(
      "%s: pair skipped, sharp never called, one warn with basename + reason",
      async (_n, setup, reason) => {
        const dir = makeDir();
        await setup(dir);
        resetSpies();
        const warn = spyWarn();
        expect(await analyze(dir)).toBe(0);
        expect(sharpSpy).toHaveBeenCalledTimes(0);
        const hits = warned(warn, "[FrameImageAnalyzerAdapter] Frame pair skipped");
        expect(hits).toHaveLength(1);
        expect(hits[0]?.[1]).toEqual({ frame1: frameName(1), frame2: frameName(2), reason });
        expect(leaks(warn)).not.toContain(dir);
      },
      15_000
    );
  });

  describe("(h) P3b FrameLoader getFrameMetadata / loadFrame", () => {
    const loader = (dir: string): FrameLoader => new FrameLoader({ allowedDirectories: [dir] });

    it.each(["loadFrame", "getFrameMetadata"] as const)(
      "%s: SVG under a .png name is UNSUPPORTED_FORMAT",
      async (method) => {
        const gate = await loadGate();
        const dir = makeDir();
        const file = path.join(dir, frameName(1));
        fs.writeFileSync(file, SVG_PLAIN);
        resetSpies();
        const err = (await loader(dir)
          [method](file)
          .catch((e: unknown) => e)) as FrameLoaderError;
        expect(err).toBeInstanceOf(FrameLoaderError);
        expect([err.code, err.message]).toEqual([
          "UNSUPPORTED_FORMAT",
          gate.UNSUPPORTED_IMAGE_FORMAT_MESSAGE,
        ]);
        expect(JSON.stringify(err.toJSON())).not.toContain(dir);
        expect(sharpSpy).toHaveBeenCalledTimes(0);
      }
    );

    it.each([
      ["loadFrame", 2],
      ["getFrameMetadata", 1],
    ] as const)(
      "%s positive control: sharp gets the snapshot reference; fileSize === snapshot length",
      async (method, calls) => {
        const dir = makeDir();
        const file = path.join(dir, frameName(1));
        fs.writeFileSync(file, await solid(1, 1, 1));
        resetSpies();
        const res = await loader(dir)[method](file);
        expect(snapshotBuffers).toHaveLength(1);
        expectSharpFedBySnapshots(calls);
        expect(("metadata" in res ? res.metadata : res).fileSize).toBe(snapshotBuffers[0]?.length);
      }
    );

    it.each([
      ["ENOENT", "FILE_NOT_FOUND"],
      ["EACCES", "PERMISSION_DENIED"],
      ["EMFILE", "LOAD_FAILED"],
    ])("open_failed %s maps to %s with a fixed message", async (errno, code) => {
      const dir = makeDir();
      const file = path.join(dir, frameName(1));
      fs.writeFileSync(file, await solid(4, 4, 4));
      const failure = Object.assign(new Error(`${errno}: open '${file}'`), { code: errno });
      vi.spyOn(fs.promises, "open").mockRejectedValueOnce(failure);
      const err = (await loader(dir)
        .loadFrame(file)
        .catch((e: unknown) => e)) as FrameLoaderError;
      expect(err.code).toBe(code);
      expect(JSON.stringify(err.toJSON())).not.toMatch(new RegExp(`${dir}|${errno}`));
    });

    it("the per-frame catch warns in every environment with basename + reason only", async () => {
      const dir = makeDir();
      const [a, bad, c] = [1, 2, 3].map((i) => path.join(dir, frameName(i)));
      fs.writeFileSync(a!, await solid(10, 0, 0));
      fs.writeFileSync(bad!, SVG_PLAIN);
      fs.writeFileSync(c!, await solid(0, 10, 0));
      resetSpies();
      const warn = spyWarn();
      const service = new FrameImageAnalysisService();
      await service.analyze({
        framePaths: [a!, bad!, c!],
        analysisOptions: { diffAnalysis: false, layoutShift: false },
      });
      await service.dispose();
      const hits = warned(warn, "[FrameImageAnalysisService] Frame skipped");
      expect(hits).toHaveLength(1);
      expect(hits[0]?.[1]).toEqual({ frame: frameName(2), reason: "UNSUPPORTED_FORMAT" });
      expect(leaks(warn)).not.toContain(dir);
    });
  });

  describe("(h) P3c compareImages", () => {
    const motion = (dir: string, n = 2): Promise<unknown> =>
      new FrameAnalyzerService().analyzeMotion({
        frames: Array.from({ length: n }, (_v, index) => ({
          index,
          timestampMs: index * 100,
          imagePath: path.join(dir, frameName(index + 1)),
          sizeBytes: 0,
        })),
        totalFrames: n,
        fps: 10,
        durationMs: n * 100,
        outputDir: dir,
        processingTimeMs: 0,
      });

    it("positive control: sharp gets the snapshot references", async () => {
      const dir = makeDir();
      await writePngFrames(dir);
      resetSpies();
      await motion(dir);
      expectSharpFedBySnapshots(2);
    });

    it("an SVG in the pair rejects the comparison before sharp is reached", async () => {
      const gate = await loadGate();
      const dir = makeDir();
      fs.writeFileSync(path.join(dir, frameName(1)), await solid(1, 2, 3));
      fs.writeFileSync(path.join(dir, frameName(2)), SVG_PLAIN);
      resetSpies();
      const err = await asErr(motion(dir));
      expect(err).toBeInstanceOf(gate.FrameSnapshotError);
      expect(err["reason"]).toBe("unsupported_image_format");
      expect(err["message"]).not.toContain(dir);
      expect(sharpSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe("(k) pinned snapshot caps (formula, values, Zod bounds, ffmpeg rgb24, NaN)", () => {
    /** Zod の optional / default を外す / unwrap optional / default */
    function inner(schema: unknown): { shape: Record<string, unknown> } {
      return { shape: zodObjectShape(zodUnwrap(schema)) };
    }
    const viewportMax = (videoOptions: unknown): number[] => {
      const dims = inner(inner(videoOptions).shape["viewport"]).shape as Record<
        string,
        { maxValue: number }
      >;
      return [dims["width"]?.maxValue ?? Number.NaN, dims["height"]?.maxValue ?? Number.NaN];
    };

    it("(1)(3) formula constants, derived values, literal values and the measured worst cases", async () => {
      const g = await loadGate();
      expect(g.FRAME_VIEWPORT_MAX).toEqual({ width: 4096, height: 4096 });
      expect([g.VIDEO_FRAME_BYTES_PER_PIXEL, g.FRAME_CAPTURE_BYTES_PER_PIXEL]).toEqual([3, 4]);
      expect([
        g.deriveRasterSnapshotMaxBytes(1, 1, 1),
        g.deriveRasterSnapshotMaxBytes(10, 10, 3),
      ]).toEqual([4099, 4410]);
      const { width: w, height: h } = g.FRAME_VIEWPORT_MAX;
      expect(g.VIDEO_FRAME_SNAPSHOT_MAX_BYTES).toBe(
        g.deriveRasterSnapshotMaxBytes(w, h, g.VIDEO_FRAME_BYTES_PER_PIXEL)
      );
      expect(g.FRAME_CAPTURE_SNAPSHOT_MAX_BYTES).toBe(
        g.deriveRasterSnapshotMaxBytes(w, h, g.FRAME_CAPTURE_BYTES_PER_PIXEL)
      );
      expect([g.VIDEO_FRAME_SNAPSHOT_MAX_BYTES, g.FRAME_CAPTURE_SNAPSHOT_MAX_BYTES]).toEqual([
        50_843_198, 67_788_186,
      ]);
      expect(50_498_687).toBeLessThanOrEqual(g.VIDEO_FRAME_SNAPSHOT_MAX_BYTES); // rgb24 worst case
      expect(67_330_199).toBeLessThanOrEqual(g.FRAME_CAPTURE_SNAPSHOT_MAX_BYTES); // RGBA worst case
    });

    it("(2) the Zod viewport maxima of motion.detect and page.analyze do not exceed FRAME_VIEWPORT_MAX", async () => {
      const { FRAME_VIEWPORT_MAX: max } = await loadGate();
      const detect = viewportMax(videoOptionsSchema);
      const page = viewportMax(inner(motionOptionsSchema).shape["video_options"]);
      for (const [w, h] of [detect, page]) {
        expect(Number.isFinite(w) && Number.isFinite(h)).toBe(true); // locator-guard
        expect([w, h].map((v) => v <= max.width)).toEqual([true, true]);
      }
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 2 ** 53])(
      "(4) %s is refused by the derivation and by the helper",
      async (bad) => {
        const g = await loadGate();
        for (const args of [
          [bad, 4096, 3],
          [4096, bad, 3],
          [4096, 4096, bad],
          [2 ** 30, 2 ** 30, 8], // 結果が safe integer でない / result is not a safe integer
        ] as const) {
          expect(() => g.deriveRasterSnapshotMaxBytes(...args)).toThrow(TypeError);
        }
        const open = vi.spyOn(fs.promises, "open");
        await expect(
          g.readRasterFileSnapshot("/virtual/a.png", g.FRAME_RASTER_ALLOW, bad)
        ).rejects.toThrow(TypeError);
        expect(open).not.toHaveBeenCalled(); // 上限なしで読む側に倒れない / never falls back to reading uncapped
      }
    );

    it("(5) extractWithFfmpeg adds -pix_fmt rgb24 right before the output pattern", () => {
      const fn = new Project({ skipAddingFilesFromTsConfig: true })
        .addSourceFileAtPath(path.join(MCP_ROOT, "src/services/page/frame-analyzer.service.ts"))
        .getFunction("extractWithFfmpeg");
      expect(fn).toBeDefined(); // locator-guard
      const pushes = (fn?.getDescendantsOfKind(SyntaxKind.CallExpression) ?? [])
        .filter((c) => c.getExpression().getText() === "args.push")
        .map((c) => c.getArguments().map((a) => a.getText()));
      const at = pushes.findIndex((a) => a[0] === '"-pix_fmt"' && a[1] === '"rgb24"');
      expect(at).toBeGreaterThanOrEqual(0);
      expect(pushes[at + 1]).toEqual(["outputPattern"]);
    });
  });
});
