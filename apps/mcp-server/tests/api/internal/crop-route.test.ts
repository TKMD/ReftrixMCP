// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Internal crop serve-route invariants (WebUI v1 W6 Issue A PR-4a — ADR-0042 Amendment 12).
 *
 * The crop route `GET /internal/pages/:webPageId/crops/:kind/:entityId` is a structural
 * clone of the W2 screenshot route (`handlePageScreenshot`): binary-safe, route-local
 * status-only error path (NOT the shared JSON `errorMiddleware`), realpath-chained.
 *
 * Pins (all CI-failing, non-vacuous — each negative fixture genuinely fails if the
 * contract is violated):
 * - INV-CROP-SERVE-PII-REDACTION-001 (R6/OQ-4): a high-PII section/part has NO
 *   `crop_storage_path` (DB-first NULL) → 404; a missing / escaped path → 404. The
 *   high-PII crop is NEVER served (serve-time PII redaction = double absence: no crop
 *   on disk + no DB pointer).
 * - INV-CROP-PATH-TRAVERSAL-001 (serve-route surface, F-H-01, CWE-22): a symlink at
 *   `<cropRoot>/<webPageId>/<kind>-<entityId>.png` pointing OUTSIDE the allowlist
 *   resolves through `validateCropPath` (realpath+isFile SSOT) to null → 404. This
 *   MUST genuinely fail if the serve path skips `validateCropPath`.
 * - Binary-safe parity (F-M-04, SEC-M-01): success → `Content-Type image/png` +
 *   `X-Content-Type-Options nosniff` + `Content-Length`; all error outcomes are
 *   status-only (no JSON body — the image route is never corrupted by the shared
 *   500-JSON middleware); invalid param → 400; the route is NOT asyncRoute-wrapped.
 *
 * Test strategy (real-resolver, non-vacuous): the Prisma raw queries are mocked (so
 * the DB row's `crop_storage_path` is controlled), but `REFTRIX_SCREENSHOT_ROOT` is
 * pointed at a REAL temp dir and the REAL crop path-resolution chain
 * (`validateCropPath` → screenshot SSOT realpath core) runs against REAL files /
 * symlinks. The symlink → 404 case is CI-satisfiable against the actual running
 * resolver and would PASS-as-served (fail the test) if the serve path bypassed
 * `validateCropPath`.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock the page-detail prisma binding used by getCropStream's DB-first lookup.
// `getCropStream` runs the REAL crop path-resolution chain (validateCropPath).
const mockedCropQuery = vi.fn();
vi.mock("@reftrixmcp/database", () => ({
  prisma: {
    webPage: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({ id: "x" }) },
    $queryRawUnsafe: (...args: unknown[]) => mockedCropQuery(...args),
  },
}));

vi.mock("../../../src/api/internal/dashboard.service", () => ({
  getDashboardStats: vi.fn(),
  getRecentPages: vi.fn(),
}));

vi.mock("../../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  isDevelopment: () => false,
}));

import { createInternalApiApp } from "../../../src/api/internal/server";
import { clearResolvedRootCache } from "../../../src/services/screenshot-persistence.service";

const VALID_PAGE = "0190b6f0-1234-7abc-89ab-0123456789ab";
const VALID_ENTITY = "0190b6f0-aaaa-7bbb-8ccc-0123456789ab";

/** PNG signature + minimal body so the served bytes are recognisably an image. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
]);

let tmpRoot: string;
let cropRoot: string;
let perPageDir: string;
let outsideRoot: string;
let prevEnv: string | undefined;

beforeAll(() => {
  // Real screenshot root → the crop root is <root>/crops/<webPageId>/.
  tmpRoot = mkdtempSync(join(tmpdir(), "reftrix-crop-route-test-"));
  cropRoot = join(tmpRoot, "crops");
  perPageDir = join(cropRoot, VALID_PAGE);
  mkdirSync(perPageDir, { recursive: true, mode: 0o700 });
  // A file OUTSIDE the allowlist that a symlink can target (out-of-root escape).
  outsideRoot = mkdtempSync(join(tmpdir(), "reftrix-crop-outside-"));
  writeFileSync(join(outsideRoot, "secret.txt"), "OUT-OF-ROOT-SECRET");
  prevEnv = process.env.REFTRIX_SCREENSHOT_ROOT;
  process.env.REFTRIX_SCREENSHOT_ROOT = tmpRoot;
  clearResolvedRootCache();
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.REFTRIX_SCREENSHOT_ROOT;
  else process.env.REFTRIX_SCREENSHOT_ROOT = prevEnv;
  clearResolvedRootCache();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
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

/** Mock the DB-first crop_storage_path lookup to return `path` (or null). */
function mockCropPath(cropStoragePath: string | null): void {
  mockedCropQuery.mockResolvedValue(
    cropStoragePath === null ? [] : [{ crop_storage_path: cropStoragePath }]
  );
}

/** Write a real crop PNG file into the per-page crop dir for the given kind/entity. */
function writeRealCrop(kind: string, entityId: string): string {
  const p = join(perPageDir, `${kind}-${entityId}.png`);
  writeFileSync(p, PNG_BYTES, { mode: 0o600 });
  return p;
}

describe("INV-CROP-SERVE-PII-REDACTION-001 — high-PII / missing crop → 404, never served (W6 PR-4a)", () => {
  it("a high-PII section/part with NO crop_storage_path (DB-first NULL) → 404 status-only", async () => {
    // Serve-time PII redaction: high-PII rows have NO crop_storage_path → DB-first null → 404.
    mockCropPath(null);
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(
        server,
        `/internal/pages/${VALID_PAGE}/crops/section/${VALID_ENTITY}`
      );
      expect(res.status).toBe(404);
      expect(res.bodyText).toBe("");
      expect(res.contentType ?? "").not.toContain("application/json");
    } finally {
      server.close();
    }
  });

  it("a stale DB crop path (file deleted) → 404 status-only, no JSON body, no 500", async () => {
    // DB references a crop file that does NOT exist on disk → validateCropPath null → 404.
    mockCropPath(join(perPageDir, `section-${VALID_ENTITY}.png`));
    // (no writeRealCrop → file absent)
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(
        server,
        `/internal/pages/${VALID_PAGE}/crops/section/${VALID_ENTITY}`
      );
      expect(res.status).toBe(404);
      expect(res.bodyText).toBe("");
      expect(res.contentType ?? "").not.toContain("application/json");
    } finally {
      server.close();
    }
  });

  it("a valid-UUID request whose DB crop path points OUTSIDE the allowlist → 404 (SSOT null)", async () => {
    mockCropPath(join(outsideRoot, "secret.txt"));
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(server, `/internal/pages/${VALID_PAGE}/crops/part/${VALID_ENTITY}`);
      expect(res.status).toBe(404);
      expect(res.bodyText).not.toContain("OUT-OF-ROOT-SECRET");
    } finally {
      server.close();
    }
  });
});

describe("INV-CROP-PATH-TRAVERSAL-001 — serve-route surface: param reject + symlink-escape → 404 (H, CWE-22)", () => {
  it.each([
    ["dot-dot traversal", `/internal/pages/..%2f..%2fetc%2fpasswd/crops/section/${VALID_ENTITY}`],
    ["non-UUID page", `/internal/pages/not-a-uuid/crops/section/${VALID_ENTITY}`],
    ["non-UUID entity", `/internal/pages/${VALID_PAGE}/crops/section/not-a-uuid`],
    ["bad kind enum", `/internal/pages/${VALID_PAGE}/crops/evil/${VALID_ENTITY}`],
    ["null byte entity", `/internal/pages/${VALID_PAGE}/crops/section/${VALID_ENTITY}%00.png`],
  ])(
    "rejects %s with 400/404 status-only and never serves a foreign file",
    async (_label, path) => {
      mockCropPath(null);
      const server = await listenOnEphemeral(createInternalApiApp());
      try {
        const res = await rawGet(server, path);
        expect([400, 404]).toContain(res.status);
        expect(res.contentType).not.toBe("image/png");
        expect(res.bodyText).not.toContain("root:");
        expect(res.bodyText).not.toContain("OUT-OF-ROOT-SECRET");
        // Invalid param path is status-only (NOT the shared JSON 500/400 middleware).
        expect(res.contentType ?? "").not.toContain("application/json");
      } finally {
        server.close();
      }
    }
  );

  it("a symlink <cropDir>/<kind>-<uuid>.png → out-of-root file resolves to null → 404 (validateCropPath realpath)", async () => {
    const linkPath = join(perPageDir, `section-${VALID_ENTITY}.png`);
    rmSync(linkPath, { force: true });
    symlinkSync(join(outsideRoot, "secret.txt"), linkPath);
    // The DB path is the (in-allowlist) symlink itself; only validateCropPath's realpath
    // re-check can reject it (this is the genuine F-H-01 gate).
    mockCropPath(linkPath);
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(
        server,
        `/internal/pages/${VALID_PAGE}/crops/section/${VALID_ENTITY}`
      );
      // If the serve path skipped validateCropPath, createReadStream would follow the
      // symlink and serve OUT-OF-ROOT-SECRET with 200 — this assertion would then FAIL.
      expect(res.status).toBe(404);
      expect(res.bodyText).not.toContain("OUT-OF-ROOT-SECRET");
      expect(res.contentType).not.toBe("image/png");
    } finally {
      server.close();
      rmSync(linkPath, { force: true });
    }
  });

  it("an in-allowlist symlink to an in-root real file IS served (200) — proves the 404 is escape-specific", async () => {
    const realTarget = join(perPageDir, "real-target.png");
    writeFileSync(realTarget, PNG_BYTES, { mode: 0o600 });
    const linkPath = join(perPageDir, `section-${VALID_ENTITY}.png`);
    rmSync(linkPath, { force: true });
    symlinkSync(realTarget, linkPath);
    mockCropPath(linkPath);
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(
        server,
        `/internal/pages/${VALID_PAGE}/crops/section/${VALID_ENTITY}`
      );
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("image/png");
    } finally {
      server.close();
      rmSync(linkPath, { force: true });
      rmSync(realTarget, { force: true });
    }
  });
});

describe("INV-CROP-SERVE-PII-REDACTION-001 — success binary parity: image/png + nosniff + content-length (F-M-04)", () => {
  it("serves image/png + nosniff + Content-Length for a real persisted crop", async () => {
    const cropFile = writeRealCrop("part", VALID_ENTITY);
    mockCropPath(cropFile);
    const server = await listenOnEphemeral(createInternalApiApp());
    try {
      const res = await rawGet(server, `/internal/pages/${VALID_PAGE}/crops/part/${VALID_ENTITY}`);
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("image/png");
      expect(res.nosniff).toBe("nosniff");
      expect(res.contentLength).toBe(String(PNG_BYTES.length));
      expect(res.bodyBytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    } finally {
      server.close();
      rmSync(cropFile, { force: true });
    }
  });
});
