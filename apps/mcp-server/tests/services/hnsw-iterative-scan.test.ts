// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * pgvector HNSW iterative scan ユニットテスト
 * enableHnswIterativeScan() の SET 実行、モックによる検証、Graceful Degradation を検証。
 *
 * pgvector HNSW iterative scan unit tests
 * Verifies SET execution, mock-based validation, and graceful degradation.
 *
 * @module tests/services/hnsw-iterative-scan.test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// =====================================================
// globalThis 状態リセットヘルパー / globalThis state reset helper
// =====================================================

/**
 * globalForPrisma の hnswIterativeScanInitialized フラグをリセットする。
 * enableHnswIterativeScan() は冪等ガードに globalThis を使用するため、
 * 各テストで独立した状態を保証する。
 *
 * Resets the hnswIterativeScanInitialized flag on globalForPrisma.
 * enableHnswIterativeScan() uses globalThis for idempotency guard,
 * so each test needs independent state.
 */
function resetHnswInitializedFlag(): void {
  const g = globalThis as unknown as {
    hnswIterativeScanInitialized: boolean | undefined;
  };
  g.hnswIterativeScanInitialized = undefined;
}

// =====================================================
// Prisma モック / Prisma mock
// =====================================================

function createMockPrismaClient(): {
  $executeRawUnsafe: ReturnType<typeof vi.fn>;
} {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(undefined),
  };
}

// =====================================================
// テスト / Tests
// =====================================================

describe("enableHnswIterativeScan", () => {
  beforeEach(() => {
    resetHnswInitializedFlag();
    vi.restoreAllMocks();
  });

  it("should execute LOAD 'vector' and SET hnsw.iterative_scan", async () => {
    // Arrange
    const mockClient = createMockPrismaClient();
    resetHnswInitializedFlag();

    // 動的インポートでモジュールキャッシュを回避
    // Dynamic import to avoid module cache
    const { enableHnswIterativeScan } = await import("@reftrixmcp/database/client");

    // Act
    await enableHnswIterativeScan(
      mockClient as unknown as import("@reftrixmcp/database/client").PrismaClient
    );

    // Assert
    expect(mockClient.$executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(mockClient.$executeRawUnsafe).toHaveBeenNthCalledWith(1, "LOAD 'vector'");
    expect(mockClient.$executeRawUnsafe).toHaveBeenNthCalledWith(
      2,
      "SET hnsw.iterative_scan = 'relaxed_order'"
    );
  });

  it("should set globalThis flag after successful execution", async () => {
    // Arrange
    const mockClient = createMockPrismaClient();
    resetHnswInitializedFlag();

    const { enableHnswIterativeScan } = await import("@reftrixmcp/database/client");

    // Act
    await enableHnswIterativeScan(
      mockClient as unknown as import("@reftrixmcp/database/client").PrismaClient
    );

    // Assert — globalThis フラグが true に設定されていることを確認
    const g = globalThis as unknown as {
      hnswIterativeScanInitialized: boolean | undefined;
    };
    expect(g.hnswIterativeScanInitialized).toBe(true);
  });

  it("should skip execution when already initialized (idempotent)", async () => {
    // Arrange — フラグを事前に true に設定
    const g = globalThis as unknown as {
      hnswIterativeScanInitialized: boolean | undefined;
    };
    g.hnswIterativeScanInitialized = true;

    const mockClient = createMockPrismaClient();

    const { enableHnswIterativeScan } = await import("@reftrixmcp/database/client");

    // Act
    await enableHnswIterativeScan(
      mockClient as unknown as import("@reftrixmcp/database/client").PrismaClient
    );

    // Assert — $executeRawUnsafe が呼ばれないこと（冪等ガード）
    expect(mockClient.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("should not throw on LOAD failure (graceful degradation)", async () => {
    // Arrange
    const mockClient = createMockPrismaClient();
    mockClient.$executeRawUnsafe.mockRejectedValueOnce(
      new Error("LOAD failed: extension not available")
    );
    resetHnswInitializedFlag();

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { enableHnswIterativeScan } = await import("@reftrixmcp/database/client");

    // Act & Assert — 例外を投げないこと
    await expect(
      enableHnswIterativeScan(
        mockClient as unknown as import("@reftrixmcp/database/client").PrismaClient
      )
    ).resolves.toBeUndefined();

    // Assert — console.warn が呼ばれること
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[database] HNSW iterative scan not available:"),
      expect.stringContaining("LOAD failed")
    );

    consoleSpy.mockRestore();
  });

  it("should not throw on SET failure (graceful degradation)", async () => {
    // Arrange
    const mockClient = createMockPrismaClient();
    // LOAD は成功、SET で失敗
    mockClient.$executeRawUnsafe
      .mockResolvedValueOnce(undefined) // LOAD 'vector' 成功
      .mockRejectedValueOnce(new Error("SET failed: unrecognized configuration parameter"));
    resetHnswInitializedFlag();

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { enableHnswIterativeScan } = await import("@reftrixmcp/database/client");

    // Act & Assert — 例外を投げないこと
    await expect(
      enableHnswIterativeScan(
        mockClient as unknown as import("@reftrixmcp/database/client").PrismaClient
      )
    ).resolves.toBeUndefined();

    // Assert — console.warn が呼ばれること
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[database] HNSW iterative scan not available:"),
      expect.stringContaining("SET failed")
    );

    consoleSpy.mockRestore();
  });

  it("should not set globalThis flag on failure", async () => {
    // Arrange
    const mockClient = createMockPrismaClient();
    mockClient.$executeRawUnsafe.mockRejectedValueOnce(new Error("Connection refused"));
    resetHnswInitializedFlag();

    vi.spyOn(console, "warn").mockImplementation(() => {});

    const { enableHnswIterativeScan } = await import("@reftrixmcp/database/client");

    // Act
    await enableHnswIterativeScan(
      mockClient as unknown as import("@reftrixmcp/database/client").PrismaClient
    );

    // Assert — フラグが設定されていないこと（失敗時は冪等ガードが働かない）
    const g = globalThis as unknown as {
      hnswIterativeScanInitialized: boolean | undefined;
    };
    expect(g.hnswIterativeScanInitialized).not.toBe(true);

    vi.mocked(console.warn).mockRestore();
  });

  it("should handle non-Error thrown values gracefully", async () => {
    // Arrange
    const mockClient = createMockPrismaClient();
    mockClient.$executeRawUnsafe.mockRejectedValueOnce("string error");
    resetHnswInitializedFlag();

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { enableHnswIterativeScan } = await import("@reftrixmcp/database/client");

    // Act & Assert — 例外を投げないこと
    await expect(
      enableHnswIterativeScan(
        mockClient as unknown as import("@reftrixmcp/database/client").PrismaClient
      )
    ).resolves.toBeUndefined();

    // Assert — String(error) で変換されること
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[database] HNSW iterative scan not available:"),
      "string error"
    );

    consoleSpy.mockRestore();
  });
});
