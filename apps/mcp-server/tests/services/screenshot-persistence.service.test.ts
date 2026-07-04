// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for ScreenshotPersistenceService
 * ScreenshotPersistenceService ユニットテスト
 *
 * カバー内容 / Coverage:
 * - saveScreenshot: 正常系、Path Traversal 防御、ディレクトリ自動作成、DB 更新ロールバック
 * - getScreenshotPath: 存在時、NULL 時、DB の stale 値クリア、Path Traversal 防御
 * - deleteScreenshot: ファイル削除 + DB 更新、存在しないファイル時の冪等性
 * - エラーハンドリング: 無効入力、DB エラー、FS エラー
 *
 * 注 / Note: TTL cron (cleanupExpired) は PR-SS-B で構造撤去済。non-emit 契約は
 * gdpr-delete standing (INV-DATA-DELETE-002-B) が担保する。
 * TTL cron (cleanupExpired) was structurally removed by PR-SS-B; the non-emit
 * contract is owned by the gdpr-delete standing test (INV-DATA-DELETE-002-B).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  clearResolvedRootCache,
  createScreenshotPersistenceService,
  type IScreenshotPersistencePrismaClient,
  resolveDefaultScreenshotRoot,
  resolvePhase5Dir,
  resolveScreenshotRoot,
  resolveScreenshotRootRaw,
  validateScreenshotPath,
} from "../../src/services/screenshot-persistence.service";

// =====================================================
// Test fixtures / テストフィクスチャ
// =====================================================

// UUID v7: version nibble = 7, variant nibble = 8/9/a/b (RFC 4122 strict)
// UUID v7: バージョンニブル = 7、バリアントニブル = 8/9/a/b（RFC 4122 厳格）
const VALID_UUID_A = "01234567-89ab-7def-8123-456789abcdef";
const VALID_UUID_B = "fedcba98-7654-7210-bedc-ba9876543210";
const MINI_PNG_BUFFER = Buffer.from([
  // 1x1 transparent PNG (88 bytes)
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

interface MockPrismaCall {
  webPageUpdate: ReturnType<typeof vi.fn>;
  webPageUpdateMany: ReturnType<typeof vi.fn>;
  webPageFindUnique: ReturnType<typeof vi.fn>;
}

function createMockPrisma(): IScreenshotPersistencePrismaClient & MockPrismaCall {
  const webPageUpdate = vi.fn().mockResolvedValue({ id: VALID_UUID_A });
  const webPageUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
  const webPageFindUnique = vi.fn().mockResolvedValue(null);
  return {
    webPage: {
      update: webPageUpdate as never,
      updateMany: webPageUpdateMany as never,
      findUnique: webPageFindUnique as never,
    },
    webPageUpdate,
    webPageUpdateMany,
    webPageFindUnique,
  };
}

async function makeSandbox(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-sspersist-test-"));
}

async function rmSandbox(sandbox: string): Promise<void> {
  await fs.rm(sandbox, { recursive: true, force: true });
}

// =====================================================
// Tests
// =====================================================

describe("resolveScreenshotRoot / resolvePhase5Dir", () => {
  const ORIG_ROOT = process.env.REFTRIX_SCREENSHOT_ROOT;

  beforeEach(() => {
    clearResolvedRootCache();
  });

  afterEach(() => {
    clearResolvedRootCache();
    if (ORIG_ROOT === undefined) {
      delete process.env.REFTRIX_SCREENSHOT_ROOT;
    } else {
      process.env.REFTRIX_SCREENSHOT_ROOT = ORIG_ROOT;
    }
  });

  it("env 未設定時は XDG default (`$XDG_DATA_HOME or $HOME/.local/share` 配下) を返す / returns the XDG default when env is unset", async () => {
    delete process.env.REFTRIX_SCREENSHOT_ROOT;
    // PR-SS-A D-1: default は /tmp ではなく XDG data dir (永続)。実ディレクトリが
    // 存在する場合 realpath が symlink を解決しうるため両形を許容する。
    // PR-SS-A D-1: the default is a persistent XDG data dir (not /tmp). If the
    // directory exists, realpath may resolve symlinks — accept both forms.
    const expectedResolved = path.resolve(resolveDefaultScreenshotRoot());
    const expectedReal = await fs.realpath(expectedResolved).catch(() => expectedResolved);
    const got = await resolveScreenshotRoot();
    expect([expectedResolved, expectedReal]).toContain(got);
    expect(got.endsWith(path.join("reftrix", "screenshots"))).toBe(true);
    const phase5 = await resolvePhase5Dir();
    expect(phase5.endsWith(path.join("reftrix", "screenshots", "phase5"))).toBe(true);
  });

  it("resolveDefaultScreenshotRoot: XDG_DATA_HOME (絶対パス) を尊重し、相対パスは無視する / honors absolute XDG_DATA_HOME and ignores relative values", () => {
    const ORIG_XDG = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = path.join(os.tmpdir(), "xdg-test-data");
      expect(resolveDefaultScreenshotRoot()).toBe(
        path.join(os.tmpdir(), "xdg-test-data", "reftrix", "screenshots")
      );
      // XDG spec: 相対パスの XDG_DATA_HOME は無効として無視 → $HOME fallback
      // XDG spec: a relative XDG_DATA_HOME is invalid and ignored → $HOME fallback.
      process.env.XDG_DATA_HOME = "relative/data";
      expect(resolveDefaultScreenshotRoot()).toBe(
        path.join(os.homedir(), ".local", "share", "reftrix", "screenshots")
      );
      delete process.env.XDG_DATA_HOME;
      expect(resolveDefaultScreenshotRoot()).toBe(
        path.join(os.homedir(), ".local", "share", "reftrix", "screenshots")
      );
    } finally {
      if (ORIG_XDG === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = ORIG_XDG;
      }
    }
  });

  it("resolveScreenshotRootRaw (SSOT): env override > XDG default の優先順位 / env override takes precedence over the XDG default", () => {
    process.env.REFTRIX_SCREENSHOT_ROOT = "/custom/ssot-raw-root";
    expect(resolveScreenshotRootRaw()).toBe("/custom/ssot-raw-root");
    delete process.env.REFTRIX_SCREENSHOT_ROOT;
    expect(resolveScreenshotRootRaw()).toBe(resolveDefaultScreenshotRoot());
  });

  it("env 設定時はそれを resolve して返す / resolves env override", async () => {
    // 存在しないカスタムパス（realpath は ENOENT で fallback → path.resolve のまま）
    // Nonexistent custom path (realpath ENOENT → falls back to path.resolve)
    process.env.REFTRIX_SCREENSHOT_ROOT = "/custom/root-does-not-exist";
    clearResolvedRootCache();
    expect(await resolveScreenshotRoot()).toBe(path.resolve("/custom/root-does-not-exist"));
    expect(await resolvePhase5Dir()).toBe(path.resolve("/custom/root-does-not-exist", "phase5"));
  });

  it("symlink を正規化する / normalizes symlinks via realpath", async () => {
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-symlink-test-"));
    try {
      const realDir = path.join(tmpBase, "real");
      const linkDir = path.join(tmpBase, "link");
      await fs.mkdir(realDir, { recursive: true });
      await fs.symlink(realDir, linkDir);

      process.env.REFTRIX_SCREENSHOT_ROOT = linkDir;
      clearResolvedRootCache();
      const resolved = await resolveScreenshotRoot();
      const realResolved = await fs.realpath(realDir);
      expect(resolved).toBe(realResolved);
    } finally {
      await fs.rm(tmpBase, { recursive: true, force: true });
    }
  });
});

describe("ScreenshotPersistenceService.saveScreenshot", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    process.env.REFTRIX_SCREENSHOT_ROOT = sandbox;
    clearResolvedRootCache();
  });

  afterEach(async () => {
    delete process.env.REFTRIX_SCREENSHOT_ROOT;
    delete process.env.SCREENSHOT_MAX_BYTES;
    clearResolvedRootCache();
    await rmSandbox(sandbox);
  });

  it("正常系: screenshot を書き込み、DB を更新する / writes file and updates DB", async () => {
    const mock = createMockPrisma();
    const service = createScreenshotPersistenceService({ prisma: mock });

    const destPath = await service.saveScreenshot(VALID_UUID_A, MINI_PNG_BUFFER);

    expect(destPath).toBe(path.resolve(sandbox, "phase5", `${VALID_UUID_A}.png`));
    const written = await fs.readFile(destPath);
    expect(written.equals(MINI_PNG_BUFFER)).toBe(true);

    expect(mock.webPageUpdate).toHaveBeenCalledTimes(1);
    expect(mock.webPageUpdate).toHaveBeenCalledWith({
      where: { id: VALID_UUID_A },
      data: { screenshotStoragePath: destPath },
    });
  });

  it("ディレクトリを自動作成する（再帰 mkdir） / creates phase5/ directory recursively", async () => {
    const mock = createMockPrisma();
    const service = createScreenshotPersistenceService({ prisma: mock });

    await service.saveScreenshot(VALID_UUID_A, MINI_PNG_BUFFER);

    const stat = await fs.stat(path.join(sandbox, "phase5"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("ファイルパーミッションは 0o600 / file mode is 0o600", async () => {
    const mock = createMockPrisma();
    const service = createScreenshotPersistenceService({ prisma: mock });

    const destPath = await service.saveScreenshot(VALID_UUID_A, MINI_PNG_BUFFER);
    const stat = await fs.stat(destPath);
    // mode の下位 9bit のみ比較
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("Path Traversal: 不正 UUID を拒否する / rejects path traversal attempts", async () => {
    const mock = createMockPrisma();
    const service = createScreenshotPersistenceService({ prisma: mock });

    await expect(service.saveScreenshot("../../etc/passwd", MINI_PNG_BUFFER)).rejects.toThrow(
      /valid UUID/
    );
    await expect(service.saveScreenshot("", MINI_PNG_BUFFER)).rejects.toThrow(/non-empty string/);
    await expect(service.saveScreenshot("foo\x00bar", MINI_PNG_BUFFER)).rejects.toThrow(
      /valid UUID/
    );
    expect(mock.webPageUpdate).not.toHaveBeenCalled();
  });

  it("空バッファを拒否する / rejects empty buffer", async () => {
    const mock = createMockPrisma();
    const service = createScreenshotPersistenceService({ prisma: mock });

    await expect(service.saveScreenshot(VALID_UUID_A, Buffer.alloc(0))).rejects.toThrow(
      /non-empty Buffer/
    );
    expect(mock.webPageUpdate).not.toHaveBeenCalled();
  });

  it("DB 更新失敗時はファイルをロールバックし throw する / rolls back file on DB failure", async () => {
    const mock = createMockPrisma();
    mock.webPageUpdate.mockRejectedValueOnce(new Error("DB down"));
    const service = createScreenshotPersistenceService({ prisma: mock });

    await expect(service.saveScreenshot(VALID_UUID_A, MINI_PNG_BUFFER)).rejects.toThrow(
      /DB update failed/
    );

    const destPath = path.resolve(sandbox, "phase5", `${VALID_UUID_A}.png`);
    await expect(fs.access(destPath)).rejects.toThrow();
  });

  it("Atomic rename: 同一 webPageId への再保存で上書きされる / overwrites on re-save (last-write-wins)", async () => {
    const mock = createMockPrisma();
    const service = createScreenshotPersistenceService({ prisma: mock });
    const buffer2 = Buffer.concat([MINI_PNG_BUFFER, Buffer.from([0x42])]);

    await service.saveScreenshot(VALID_UUID_A, MINI_PNG_BUFFER);
    await service.saveScreenshot(VALID_UUID_A, buffer2);

    const destPath = path.resolve(sandbox, "phase5", `${VALID_UUID_A}.png`);
    const written = await fs.readFile(destPath);
    expect(written.equals(buffer2)).toBe(true);
  });
});

describe("ScreenshotPersistenceService.getScreenshotPath", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    process.env.REFTRIX_SCREENSHOT_ROOT = sandbox;
    clearResolvedRootCache();
  });

  afterEach(async () => {
    delete process.env.REFTRIX_SCREENSHOT_ROOT;
    delete process.env.SCREENSHOT_MAX_BYTES;
    clearResolvedRootCache();
    await rmSandbox(sandbox);
  });

  it("DB に path が無い場合は null を返す / returns null when DB path is null", async () => {
    const mock = createMockPrisma();
    mock.webPageFindUnique.mockResolvedValueOnce({ screenshotStoragePath: null });
    const service = createScreenshotPersistenceService({ prisma: mock });

    const result = await service.getScreenshotPath(VALID_UUID_A);
    expect(result).toBeNull();
  });

  it("DB に path があり、ファイルも存在する場合は絶対パスを返す / returns absolute path when both exist", async () => {
    const mock = createMockPrisma();
    const service = createScreenshotPersistenceService({ prisma: mock });
    const destPath = await service.saveScreenshot(VALID_UUID_A, MINI_PNG_BUFFER);

    mock.webPageFindUnique.mockResolvedValueOnce({ screenshotStoragePath: destPath });
    const result = await service.getScreenshotPath(VALID_UUID_A);
    expect(result).toBe(destPath);
  });

  it("DB に path があるがファイルが消失していれば DB を NULL 化し null を返す / nulls out stale DB path", async () => {
    const mock = createMockPrisma();
    const missingPath = path.resolve(sandbox, "phase5", `${VALID_UUID_A}.png`);
    mock.webPageFindUnique.mockResolvedValueOnce({ screenshotStoragePath: missingPath });
    const service = createScreenshotPersistenceService({ prisma: mock });

    const result = await service.getScreenshotPath(VALID_UUID_A);
    expect(result).toBeNull();
    expect(mock.webPageUpdate).toHaveBeenCalledWith({
      where: { id: VALID_UUID_A },
      data: { screenshotStoragePath: null },
    });
  });

  it("DB path が phase5 ディレクトリの外を指していれば null を返す / rejects out-of-root path", async () => {
    const mock = createMockPrisma();
    mock.webPageFindUnique.mockResolvedValueOnce({
      screenshotStoragePath: "/etc/passwd",
    });
    const service = createScreenshotPersistenceService({ prisma: mock });

    const result = await service.getScreenshotPath(VALID_UUID_A);
    expect(result).toBeNull();
    // 範囲外のパスは DB 更新せずに無視
    expect(mock.webPageUpdate).not.toHaveBeenCalled();
  });
});

describe("ScreenshotPersistenceService.deleteScreenshot", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    process.env.REFTRIX_SCREENSHOT_ROOT = sandbox;
    clearResolvedRootCache();
  });

  afterEach(async () => {
    delete process.env.REFTRIX_SCREENSHOT_ROOT;
    delete process.env.SCREENSHOT_MAX_BYTES;
    clearResolvedRootCache();
    await rmSandbox(sandbox);
  });

  it("正常系: ファイル削除 + DB NULL 化 / removes file and nulls DB column", async () => {
    const mock = createMockPrisma();
    const service = createScreenshotPersistenceService({ prisma: mock });
    const destPath = await service.saveScreenshot(VALID_UUID_A, MINI_PNG_BUFFER);
    mock.webPageUpdate.mockClear();

    await service.deleteScreenshot(VALID_UUID_A);

    await expect(fs.access(destPath)).rejects.toThrow();
    expect(mock.webPageUpdate).toHaveBeenCalledWith({
      where: { id: VALID_UUID_A },
      data: { screenshotStoragePath: null },
    });
  });

  it("存在しないファイルに対して冪等（throw しない） / idempotent on missing file", async () => {
    const mock = createMockPrisma();
    const service = createScreenshotPersistenceService({ prisma: mock });

    await expect(service.deleteScreenshot(VALID_UUID_A)).resolves.toBeUndefined();
    expect(mock.webPageUpdate).toHaveBeenCalledWith({
      where: { id: VALID_UUID_A },
      data: { screenshotStoragePath: null },
    });
  });

  it("不正 UUID を拒否する / rejects invalid UUID", async () => {
    const mock = createMockPrisma();
    const service = createScreenshotPersistenceService({ prisma: mock });

    await expect(service.deleteScreenshot("not-a-uuid")).rejects.toThrow(/valid UUID/);
    expect(mock.webPageUpdate).not.toHaveBeenCalled();
  });

  it("DB P2025 (行なし) を throw せずに warn 吸収する / swallows P2025", async () => {
    const mock = createMockPrisma();
    const service = createScreenshotPersistenceService({ prisma: mock });

    // まず正常系で保存（DB update 1 回目は成功）
    // Save first (DB update succeeds on first call)
    await service.saveScreenshot(VALID_UUID_A, MINI_PNG_BUFFER);

    // 次の deleteScreenshot 内の update のみ P2025 にする
    // Make only the next update (inside deleteScreenshot) throw P2025
    const p2025: Error & { code?: string } = new Error("Record not found");
    p2025.code = "P2025";
    mock.webPageUpdate.mockRejectedValueOnce(p2025);

    await expect(service.deleteScreenshot(VALID_UUID_A)).resolves.toBeUndefined();
  });
});

// =====================================================
// SEC hardening tests (v0.4.0 audit fixes)
// SEC hardening テスト（v0.4.0 監査修正）
// =====================================================

describe("ScreenshotPersistenceService SEC hardening", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    process.env.REFTRIX_SCREENSHOT_ROOT = sandbox;
    clearResolvedRootCache();
  });

  afterEach(async () => {
    delete process.env.REFTRIX_SCREENSHOT_ROOT;
    delete process.env.SCREENSHOT_MAX_BYTES;
    clearResolvedRootCache();
    await rmSandbox(sandbox);
  });

  // --- SEC M2: saveScreenshot size cap ---
  describe("saveScreenshot size cap", () => {
    it("sourceBuffer が上限を超えた場合は拒否する / rejects oversized buffer", async () => {
      const mock = createMockPrisma();
      // 100 バイト上限に設定 / cap at 100 bytes
      process.env.SCREENSHOT_MAX_BYTES = "100";
      const service = createScreenshotPersistenceService({ prisma: mock });

      const oversized = Buffer.alloc(200, 0x42);
      await expect(service.saveScreenshot(VALID_UUID_A, oversized)).rejects.toThrow(
        /exceeds max size/
      );
      expect(mock.webPageUpdate).not.toHaveBeenCalled();
    });

    it("上限内は正常に保存する / accepts buffer within cap", async () => {
      const mock = createMockPrisma();
      process.env.SCREENSHOT_MAX_BYTES = "1000";
      const service = createScreenshotPersistenceService({ prisma: mock });

      const ok = Buffer.alloc(500, 0x42);
      await expect(service.saveScreenshot(VALID_UUID_A, ok)).resolves.toBeTruthy();
    });

    it("SCREENSHOT_MAX_BYTES 未設定時はデフォルト 50MB / defaults to 50MB when unset", async () => {
      const mock = createMockPrisma();
      delete process.env.SCREENSHOT_MAX_BYTES;
      const service = createScreenshotPersistenceService({ prisma: mock });
      // 小さいバッファは通る / small buffer passes
      await expect(service.saveScreenshot(VALID_UUID_A, MINI_PNG_BUFFER)).resolves.toBeTruthy();
    });
  });

  // --- SEC L2: Strict UUID v4/v7 regex ---
  describe("strict UUID v4/v7 regex", () => {
    it("UUID v7 を受け入れる / accepts UUID v7", async () => {
      const mock = createMockPrisma();
      const service = createScreenshotPersistenceService({ prisma: mock });
      await expect(
        service.saveScreenshot("01934567-89ab-7def-8123-456789abcdef", MINI_PNG_BUFFER)
      ).resolves.toBeTruthy();
    });

    it("UUID v4 を受け入れる / accepts UUID v4", async () => {
      const mock = createMockPrisma();
      const service = createScreenshotPersistenceService({ prisma: mock });
      await expect(
        service.saveScreenshot("01934567-89ab-4def-8123-456789abcdef", MINI_PNG_BUFFER)
      ).resolves.toBeTruthy();
    });

    it("version nibble != 4/7 は拒否する / rejects non-v4/v7 version", async () => {
      const mock = createMockPrisma();
      const service = createScreenshotPersistenceService({ prisma: mock });
      // version=3 (v3)
      await expect(
        service.saveScreenshot("01234567-89ab-3def-8123-456789abcdef", MINI_PNG_BUFFER)
      ).rejects.toThrow(/valid UUID/);
      // version=c (old loose regex accepted, strict rejects)
      await expect(
        service.saveScreenshot("01234567-89ab-cdef-8123-456789abcdef", MINI_PNG_BUFFER)
      ).rejects.toThrow(/valid UUID/);
    });

    it("variant nibble != 8/9/a/b は拒否する / rejects non-RFC4122 variant", async () => {
      const mock = createMockPrisma();
      const service = createScreenshotPersistenceService({ prisma: mock });
      // variant=c (invalid — should be 8/9/a/b)
      await expect(
        service.saveScreenshot("01234567-89ab-7def-c123-456789abcdef", MINI_PNG_BUFFER)
      ).rejects.toThrow(/valid UUID/);
    });
  });

  // --- SEC L3: Symlink attack defense ---
  describe("symlink attack defense", () => {
    it("ルートが symlink の場合 realpath で正規化される / realpath canonicalizes symlink root", async () => {
      const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-real-"));
      const linkRoot = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-link-")), "lnk");
      await fs.symlink(realRoot, linkRoot);

      try {
        process.env.REFTRIX_SCREENSHOT_ROOT = linkRoot;
        clearResolvedRootCache();
        const mock = createMockPrisma();
        const service = createScreenshotPersistenceService({ prisma: mock });

        const dest = await service.saveScreenshot(VALID_UUID_A, MINI_PNG_BUFFER);
        const realDest = await fs.realpath(dest);
        // realpath 経由で realRoot 配下に解決される
        // Destination resolves under realRoot via realpath
        expect(realDest.startsWith(await fs.realpath(realRoot))).toBe(true);
      } finally {
        await fs.rm(realRoot, { recursive: true, force: true });
        await fs.rm(path.dirname(linkRoot), { recursive: true, force: true });
      }
    });
  });

  // =====================================================
  // validateScreenshotPath (SEC H-1 / L-1 / v0.4.0 PR4 audit)
  // =====================================================
  describe("validateScreenshotPath (SEC H-1 / L-1)", () => {
    let testRoot: string;

    beforeEach(async () => {
      testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-validate-"));
      process.env.REFTRIX_SCREENSHOT_ROOT = testRoot;
      clearResolvedRootCache();
      // Pre-create phase5 dir with a sample file
      const phase5Dir = await resolvePhase5Dir();
      await fs.mkdir(phase5Dir, { recursive: true, mode: 0o700 });
    });

    afterEach(async () => {
      await fs.rm(testRoot, { recursive: true, force: true });
      delete process.env.REFTRIX_SCREENSHOT_ROOT;
      clearResolvedRootCache();
    });

    it("should accept a valid file inside phase5 directory", async () => {
      const phase5Dir = await resolvePhase5Dir();
      const validPath = path.join(phase5Dir, `${VALID_UUID_A}.png`);
      await fs.writeFile(validPath, MINI_PNG_BUFFER, { mode: 0o600 });

      const result = await validateScreenshotPath(validPath);
      expect(result).not.toBeNull();
      expect(result).toContain(".png");
    });

    it("should reject path traversal via ..", async () => {
      const phase5Dir = await resolvePhase5Dir();
      const maliciousPath = path.join(phase5Dir, "..", "..", "etc", "passwd.png");

      const result = await validateScreenshotPath(maliciousPath);
      expect(result).toBeNull();
    });

    it("should reject absolute paths outside phase5 directory", async () => {
      const result = await validateScreenshotPath("/etc/passwd.png");
      expect(result).toBeNull();
    });

    it("should reject paths with null byte injection", async () => {
      const phase5Dir = await resolvePhase5Dir();
      const maliciousPath = path.join(phase5Dir, `${VALID_UUID_A}.png\0/etc/passwd`);

      const result = await validateScreenshotPath(maliciousPath);
      expect(result).toBeNull();
    });

    it("should reject non-existent files (TOCTOU defense)", async () => {
      const phase5Dir = await resolvePhase5Dir();
      const missingPath = path.join(phase5Dir, `${VALID_UUID_B}.png`);

      const result = await validateScreenshotPath(missingPath);
      expect(result).toBeNull();
    });

    it("should reject empty / non-string input", async () => {
      expect(await validateScreenshotPath("")).toBeNull();
      // @ts-expect-error — intentionally passing non-string
      expect(await validateScreenshotPath(undefined)).toBeNull();
    });

    it("should reject symlinks pointing outside phase5 directory", async () => {
      const phase5Dir = await resolvePhase5Dir();
      const outsideFile = path.join(testRoot, "outside.png");
      await fs.writeFile(outsideFile, MINI_PNG_BUFFER, { mode: 0o600 });

      const linkPath = path.join(phase5Dir, `${VALID_UUID_A}.png`);
      await fs.symlink(outsideFile, linkPath);

      const result = await validateScreenshotPath(linkPath);
      // realpath resolves to outsideFile which is outside phase5Dir → reject
      expect(result).toBeNull();
    });

    it("should reject directories (only regular files accepted)", async () => {
      const phase5Dir = await resolvePhase5Dir();
      const subDir = path.join(phase5Dir, `${VALID_UUID_A}.png`);
      await fs.mkdir(subDir, { recursive: true });

      const result = await validateScreenshotPath(subDir);
      expect(result).toBeNull();
    });
  });
});
