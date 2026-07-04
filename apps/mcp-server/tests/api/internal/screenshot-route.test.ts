// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Internal screenshot serve-route invariants (WebUI v1 W2 rework — ADR-0042 Amendment 3).
 *
 * Pins (all CI-failing, non-vacuous — each negative fixture genuinely fails if the
 * contract is violated):
 * - INV-WEBUI-SCREENSHOT-001 (H, CWE-22): path-traversal / invalid param (`../`, `%2e%2e`,
 *   absolute, null-byte, non-UUID) → 400/404, never serves a foreign file. The serve path
 *   routes ONLY through the screenshot-persistence SSOT (no 2nd resolver).
 * - INV-WEBUI-SCREENSHOT-002 (H): unknown/missing webPageId or stale DB path → 404
 *   STATUS-ONLY, NO JSON body (image route NOT corrupted by the shared 500-JSON middleware).
 * - INV-WEBUI-SCREENSHOT-003 (M): success → `Content-Type image/png` +
 *   `X-Content-Type-Options nosniff` + `Content-Length` (24006-origin stage of the two-stage pin).
 * - INV-WEBUI-SCREENSHOT-005 (H): the serve service is read-only — AST/grep gate, 0 Prisma
 *   write verbs in `page-detail.service.ts` incl. `getScreenshotStream`.
 * - INV-WEBUI-SCREENSHOT-008 (H, CWE-22, UB-1): a symlink at `<phase5Dir>/<uuid>.png` pointing
 *   OUTSIDE the allowlist resolves through `validateScreenshotPath` (realpath+isFile SSOT) to
 *   null → 404. This MUST genuinely fail if the serve path skips `validateScreenshotPath`. Plus
 *   AST source-pin: 0 raw `screenshot_storage_path` → fs/createReadStream callsites.
 *
 * Test strategy (real-resolver, non-vacuous): the Prisma client is mocked (so the DB row's
 * `screenshotStoragePath` is controlled), but `REFTRIX_SCREENSHOT_ROOT` is pointed at a REAL
 * temp dir and the REAL path-resolution chain (`getScreenshotPath` + `validateScreenshotPath`)
 * runs against REAL files / symlinks. The symlink → 404 case is therefore CI-satisfiable
 * against the actual running resolver, and would PASS-as-served (fail the test) if the serve
 * path bypassed `validateScreenshotPath`.
 *
 * 内部 screenshot 配信ルートの不変条件 (W2 リワーク — ADR-0042 Amendment 3)。各 negative fixture
 * は契約違反時に実際に fail する non-vacuous テスト。Prisma のみ mock し、path 解決チェーン
 * (`getScreenshotPath` + `validateScreenshotPath`) は実ファイル / symlink に対して実行する。
 * symlink → 404 は実 resolver に対して CI-satisfiable で、`validateScreenshotPath` を bypass すると
 * (= 配信されてしまう) 本テストが fail する。
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock only the DB row (screenshotStoragePath). The path-resolution chain is REAL.
vi.mock("@reftrixmcp/database", () => ({
  prisma: {
    webPage: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({ id: "x" }) },
  },
}));

vi.mock("../../../src/api/internal/dashboard.service", () => ({
  getDashboardStats: vi.fn(),
  getRecentPages: vi.fn(),
}));

// page-detail.service.ts is NOT mocked — getScreenshotStream runs the real SSOT chain.
vi.mock("../../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  isDevelopment: () => false,
}));

import { prisma } from "@reftrixmcp/database";
import { createInternalApiApp } from "../../../src/api/internal/server";

const mockedFindUnique = prisma.webPage.findUnique as ReturnType<typeof vi.fn>;
const mockedUpdate = prisma.webPage.update as ReturnType<typeof vi.fn>;

const VALID_ID = "0190b6f0-1234-7abc-89ab-0123456789ab";

/** PNG signature + minimal body so the served bytes are recognisably an image. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

let tmpRoot: string;
let phase5Dir: string;
let outsideRoot: string;
let prevEnv: string | undefined;

beforeAll(() => {
  // Real screenshot root → the real resolver builds <root>/phase5/<uuid>.png against this dir.
  tmpRoot = mkdtempSync(join(tmpdir(), "reftrix-screenshot-route-test-"));
  phase5Dir = join(tmpRoot, "phase5");
  mkdirSync(phase5Dir, { recursive: true, mode: 0o700 });
  // A file OUTSIDE the allowlist that a symlink can target (out-of-root escape).
  outsideRoot = mkdtempSync(join(tmpdir(), "reftrix-screenshot-outside-"));
  writeFileSync(join(outsideRoot, "secret.txt"), "OUT-OF-ROOT-SECRET");
  prevEnv = process.env.REFTRIX_SCREENSHOT_ROOT;
  process.env.REFTRIX_SCREENSHOT_ROOT = tmpRoot;
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.REFTRIX_SCREENSHOT_ROOT;
  else process.env.REFTRIX_SCREENSHOT_ROOT = prevEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedUpdate.mockResolvedValue({ id: "x" });
});

function listenOnEphemeral(app: ReturnType<typeof createInternalApiApp>): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

interface RawResponse {
  status: number;
  contentType: string | null;
  nosniff: string | null;
  contentLength: string | null;
  bodyText: string;
  bodyBytes: Buffer;
}

async function rawGet(server: Server, path: string): Promise<RawResponse> {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    nosniff: res.headers.get("x-content-type-options"),
    contentLength: res.headers.get("content-length"),
    bodyText: buf.toString("utf8"),
    bodyBytes: buf,
  };
}

/** Write a real screenshot file into phase5Dir for the given id (the happy path). */
function writeRealScreenshot(id: string): void {
  writeFileSync(join(phase5Dir, `${id}.png`), PNG_BYTES, { mode: 0o600 });
}

describe("INV-WEBUI-SCREENSHOT-001 — path traversal / invalid param reject (H, CWE-22)", () => {
  it.each([
    ["dot-dot traversal", "/internal/pages/..%2f..%2fetc%2fpasswd/screenshot"],
    ["raw dot-dot", "/internal/pages/../../etc/passwd/screenshot"],
    ["encoded dot-dot %2e", "/internal/pages/%2e%2e%2f%2e%2e%2fpasswd/screenshot"],
    ["absolute path", "/internal/pages/%2fetc%2fhostname/screenshot"],
    ["null byte", "/internal/pages/0190b6f0-1234-7abc-89ab-0123456789ab%00.png/screenshot"],
    ["plain non-UUID", "/internal/pages/not-a-uuid/screenshot"],
    ["sql-ish", "/internal/pages/1%20OR%201=1/screenshot"],
  ])("rejects %s with 400/404 and never serves a foreign file", async (_label, path) => {
    // No DB row would be set for any malformed id; ensure the SSOT never returns an outside file.
    mockedFindUnique.mockResolvedValue(null);
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(server, path);
      expect([400, 404]).toContain(res.status);
      // Never serve image bytes for a traversal attempt.
      expect(res.contentType).not.toBe("image/png");
      // Never leak the targeted foreign file content.
      expect(res.bodyText).not.toContain("root:");
      expect(res.bodyText).not.toContain("OUT-OF-ROOT-SECRET");
    } finally {
      server.close();
    }
  });

  it("a valid-UUID request whose DB path points OUTSIDE the allowlist → 404 (SSOT null)", async () => {
    // getScreenshotPath rejects an out-of-allowlist DB value (startsWith fails) → null → 404.
    mockedFindUnique.mockResolvedValue({
      screenshotStoragePath: join(outsideRoot, "secret.txt"),
    });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(server, `/internal/pages/${VALID_ID}/screenshot`);
      expect(res.status).toBe(404);
      expect(res.bodyText).not.toContain("OUT-OF-ROOT-SECRET");
    } finally {
      server.close();
    }
  });
});

describe("INV-WEBUI-SCREENSHOT-002 — 404 status-only, NO JSON body (H)", () => {
  it("missing DB row (null) → 404 with an empty body (NOT application/json)", async () => {
    mockedFindUnique.mockResolvedValue(null);
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(server, `/internal/pages/${VALID_ID}/screenshot`);
      expect(res.status).toBe(404);
      expect(res.bodyText).toBe("");
      expect(res.contentType ?? "").not.toContain("application/json");
    } finally {
      server.close();
    }
  });

  it("stale DB path (file deleted) → 404 status-only, no JSON body, no 500", async () => {
    // DB row references a file that does NOT exist in phase5Dir → getScreenshotPath null → 404.
    mockedFindUnique.mockResolvedValue({
      screenshotStoragePath: join(phase5Dir, `${VALID_ID}.png`),
    });
    // (no writeRealScreenshot → file is absent)
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(server, `/internal/pages/${VALID_ID}/screenshot`);
      expect(res.status).toBe(404);
      expect(res.bodyText).toBe("");
      expect(res.contentType ?? "").not.toContain("application/json");
    } finally {
      server.close();
    }
  });

  it("invalid param → 400 status-only, no JSON body (not the shared 500-JSON path)", async () => {
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(server, "/internal/pages/not-a-uuid/screenshot");
      expect(res.status).toBe(400);
      expect(res.bodyText).toBe("");
      expect(res.contentType ?? "").not.toContain("application/json");
    } finally {
      server.close();
    }
  });
});

describe("INV-WEBUI-SCREENSHOT-003 — success content-type + nosniff + content-length (M)", () => {
  it("serves image/png + nosniff + Content-Length for a real persisted screenshot", async () => {
    writeRealScreenshot(VALID_ID);
    mockedFindUnique.mockResolvedValue({
      screenshotStoragePath: join(phase5Dir, `${VALID_ID}.png`),
    });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(server, `/internal/pages/${VALID_ID}/screenshot`);
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("image/png");
      expect(res.nosniff).toBe("nosniff");
      expect(res.contentLength).toBe(String(PNG_BYTES.length));
      // Real image bytes streamed through (PNG signature intact).
      expect(res.bodyBytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    } finally {
      server.close();
      rmSync(join(phase5Dir, `${VALID_ID}.png`), { force: true });
    }
  });
});

describe("INV-WEBUI-SCREENSHOT-008 — UB-1 symlink escape → 404 (H, CWE-22, real resolver)", () => {
  it("a symlink <phase5Dir>/<uuid>.png → out-of-root file resolves to null → 404 (validateScreenshotPath realpath)", async () => {
    const linkPath = join(phase5Dir, `${VALID_ID}.png`);
    rmSync(linkPath, { force: true });
    // The escape: symlink inside phase5Dir whose realpath is OUTSIDE the allowlist.
    symlinkSync(join(outsideRoot, "secret.txt"), linkPath);
    // The DB path is the (in-allowlist) symlink itself: getScreenshotPath's startsWith + fs.access
    // PASS the symlink path (access follows the link), so ONLY validateScreenshotPath's realpath
    // re-check can reject it. This is the genuine UB-1 gate.
    mockedFindUnique.mockResolvedValue({ screenshotStoragePath: linkPath });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(server, `/internal/pages/${VALID_ID}/screenshot`);
      // If the serve path skipped validateScreenshotPath, createReadStream would follow the
      // symlink and serve OUT-OF-ROOT-SECRET with 200 — this assertion would then FAIL.
      expect(res.status).toBe(404);
      expect(res.bodyText).not.toContain("OUT-OF-ROOT-SECRET");
      expect(res.contentType).not.toBe("image/png");
    } finally {
      server.close();
      rmSync(linkPath, { force: true });
    }
  });

  it("an in-allowlist symlink to an in-root real file IS served (200) — proves the 404 above is symlink-escape-specific, not symlink-blanket", async () => {
    // Control: a symlink that stays INSIDE the allowlist should still serve, confirming the
    // 404 above is caused by the escape (realpath outside root), not by symlinks per se.
    const realTarget = join(phase5Dir, "real-target.png");
    writeFileSync(realTarget, PNG_BYTES, { mode: 0o600 });
    const linkPath = join(phase5Dir, `${VALID_ID}.png`);
    rmSync(linkPath, { force: true });
    symlinkSync(realTarget, linkPath);
    mockedFindUnique.mockResolvedValue({ screenshotStoragePath: linkPath });
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(server, `/internal/pages/${VALID_ID}/screenshot`);
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("image/png");
    } finally {
      server.close();
      rmSync(linkPath, { force: true });
      rmSync(realTarget, { force: true });
    }
  });
});

describe("INV-WEBUI-SCREENSHOT-005 / 008 — read-only + SSOT-only source pin (H, AST/grep)", () => {
  const serviceSrc = readFileSync(
    join(__dirname, "..", "..", "..", "src", "api", "internal", "page-detail.service.ts"),
    "utf8"
  );

  it("page-detail.service.ts has 0 Prisma write verbs (read-only, incl. getScreenshotStream)", () => {
    const WRITE_VERB_RE =
      /prisma\.\w+\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/g;
    const RAW_EXECUTE_WRITE_RE =
      /\$executeRaw(?:Unsafe)?\s*(?:`|\()[\s\S]{0,80}?(?:INSERT|UPDATE|DELETE|UPSERT)/i;
    expect(serviceSrc.match(WRITE_VERB_RE) ?? []).toEqual([]);
    expect(RAW_EXECUTE_WRITE_RE.test(serviceSrc)).toBe(false);
  });

  it("the serve path resolves ONLY via the screenshot-persistence SSOT (getScreenshotPath + validateScreenshotPath)", () => {
    // Positive: both SSOT entry points are referenced on the serve path.
    expect(serviceSrc).toMatch(/getScreenshotPath\s*\(/);
    expect(serviceSrc).toMatch(/validateScreenshotPath\s*\(/);
  });

  it("0 raw screenshot_storage_path / screenshotStoragePath → fs/createReadStream callsites (source-pin)", () => {
    // No raw DB column value may flow directly into a filesystem read in this file.
    const RAW_PATH_TO_FS_RE =
      /createReadStream\s*\(\s*[^)]*(?:screenshot_storage_path|screenshotStoragePath)/;
    expect(RAW_PATH_TO_FS_RE.test(serviceSrc)).toBe(false);
    // createReadStream must only be fed the validated `safePath` local, not a raw row value.
    expect(serviceSrc).toMatch(/createReadStream\s*\(\s*safePath\s*\)/);
  });
});
