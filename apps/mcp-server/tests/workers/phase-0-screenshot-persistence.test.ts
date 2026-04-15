// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 0 × ScreenshotPersistenceService 統合テスト
 * Phase 0 × ScreenshotPersistenceService integration tests
 *
 * カバー内容 / Coverage:
 * - Phase 0 完了後に screenshot が永続化パス `<root>/phase5/<webPageId>.png` に
 *   保存されていること
 * - state.screenshotPngPath が永続化パスを指していること
 * - DB 更新が actualWebPageId (Phase 0.5 の upsert 結果) で行われること
 * - screenshot が無い場合は永続化ロジックを呼び出さないこと
 * - 永続化失敗時は Graceful Degradation（throw しない）
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Browser } from "playwright";

import { processIngestPhase } from "../../src/workers/phases/phase-0-ingest";
import type { PipelineState, PhaseContext } from "../../src/workers/phases/types";
import { createScreenshotPersistenceService } from "../../src/services/screenshot-persistence.service";

// =====================================================
// Fixtures / フィクスチャ
// =====================================================

// UUID v7: version nibble = 7, variant nibble = 8/9/a/b (RFC 4122 strict)
// UUID v7: バージョンニブル = 7、バリアントニブル = 8/9/a/b（RFC 4122 厳格）
const REQUESTED_ID = "01234567-89ab-7def-8123-456789abcdef";
const ACTUAL_ID = "fedcba98-7654-7210-bedc-ba9876543210";
const TARGET_URL = "https://example.com/page";
const MINI_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lPAAAAABJRU5ErkJggg==";

function createPipelineState(): PipelineState {
  return {
    actualWebPageId: REQUESTED_ID,
    completedPhases: [],
    failedPhases: [],
    results: {},
    layoutResultForNarrative: null,
    sectionSaveResult: null,
    motionSaveResult: null,
    jsSaveResult: null,
    bgSaveResult: null,
    motionResultForEmbedding: null,
    jsAnimationsForEmbedding: null,
    scrollVisionSaveResult: null,
    scrollVisionResultForEmbedding: null,
    scrollVisionCapturesForDeferred: null,
    html: null,
    screenshotBase64: undefined,
    narrativePreDisabled: false,
    visionPreDisabled: false,
    memoryAborted: false,
  };
}

function createPhaseContext(): PhaseContext {
  return {
    job: {
      updateProgress: vi.fn().mockResolvedValue(undefined),
      log: vi.fn().mockResolvedValue(undefined),
    } as never,
    options: {},
    url: TARGET_URL,
    webPageId: REQUESTED_ID,
    effectiveToken: "test-token",
    effectiveLockDuration: 30_000,
    statusTracker: {
      startPhase: vi.fn(),
      completePhase: vi.fn(),
    } as never,
  };
}

function createMockBrowser(): Browser {
  return { isConnected: () => true } as Browser;
}

interface MockIngestAdapter {
  ingest: ReturnType<typeof vi.fn>;
  getSharedBrowser: ReturnType<typeof vi.fn>;
}

function createMockAdapter(args: { screenshot: string | undefined }): MockIngestAdapter {
  return {
    ingest: vi.fn().mockResolvedValue({
      success: true,
      html: "<html><head><title>T</title></head><body>content</body></html>",
      screenshots: args.screenshot ? [{ data: args.screenshot }] : undefined,
    }),
    getSharedBrowser: vi.fn().mockResolvedValue(createMockBrowser()),
  };
}

function createMockPrisma() {
  return {
    webPage: {
      upsert: vi.fn().mockResolvedValue({ id: ACTUAL_ID }),
      update: vi.fn().mockResolvedValue({ id: ACTUAL_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
}

// =====================================================
// Tests
// =====================================================

describe("Phase 0 × ScreenshotPersistenceService integration", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "reftrix-phase0-test-"));
    process.env.REFTRIX_SCREENSHOT_ROOT = sandbox;
  });

  afterEach(async () => {
    delete process.env.REFTRIX_SCREENSHOT_ROOT;
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it("screenshot あり: 永続化パスに保存され、state が更新される / persists screenshot and updates state", async () => {
    const state = createPipelineState();
    const ctx = createPhaseContext();
    const mockPrisma = createMockPrisma();
    const mockAdapter = createMockAdapter({ screenshot: MINI_PNG_BASE64 });
    const service = createScreenshotPersistenceService({ prisma: mockPrisma });

    await processIngestPhase(state, ctx, {
      pageIngestAdapter: mockAdapter as never,
      prisma: mockPrisma as never,
      screenshotPersistenceService: service,
    });

    const expectedPath = path.resolve(sandbox, "phase5", `${ACTUAL_ID}.png`);

    // 1. ファイルが永続化パスに存在
    await fs.access(expectedPath);

    // 2. state.screenshotPngPath が永続化パスを指す
    expect(state.screenshotPngPath).toBe(expectedPath);

    // 3. state.actualWebPageId は Phase 0.5 の upsert 結果
    expect(state.actualWebPageId).toBe(ACTUAL_ID);

    // 4. DB 更新が actualWebPageId 経由で行われた（requested ID ではなく）
    expect(mockPrisma.webPage.update).toHaveBeenCalledWith({
      where: { id: ACTUAL_ID },
      data: { screenshotStoragePath: expectedPath },
    });
  });

  it("screenshot なし: 永続化を呼ばない / skips persistence when screenshot absent", async () => {
    const state = createPipelineState();
    const ctx = createPhaseContext();
    const mockPrisma = createMockPrisma();
    const mockAdapter = createMockAdapter({ screenshot: undefined });
    const service = createScreenshotPersistenceService({ prisma: mockPrisma });
    const saveSpy = vi.spyOn(service, "saveScreenshot");

    await processIngestPhase(state, ctx, {
      pageIngestAdapter: mockAdapter as never,
      prisma: mockPrisma as never,
      screenshotPersistenceService: service,
    });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(state.screenshotPngPath).toBeUndefined();
  });

  it("永続化失敗時は Graceful Degradation（throw しない、他フェーズは続行） / graceful degradation", async () => {
    const state = createPipelineState();
    const ctx = createPhaseContext();
    const mockPrisma = createMockPrisma();
    const mockAdapter = createMockAdapter({ screenshot: MINI_PNG_BASE64 });

    // saveScreenshot が必ず失敗するスタブを作る
    const service = {
      saveScreenshot: vi.fn().mockRejectedValue(new Error("disk full")),
      getScreenshotPath: vi.fn(),
      deleteScreenshot: vi.fn(),
      cleanupExpired: vi.fn(),
    };

    await expect(
      processIngestPhase(state, ctx, {
        pageIngestAdapter: mockAdapter as never,
        prisma: mockPrisma as never,
        screenshotPersistenceService: service,
      })
    ).resolves.toBeDefined();

    // state.screenshotPngPath は設定されない
    expect(state.screenshotPngPath).toBeUndefined();
    // state.html は保持される（他フェーズは続行可能）
    expect(state.html).toContain("<title>T</title>");
  });

  it("DB 保存スキップ時 (saveToDb: false) でも永続化が requested ID で実行される / uses requested ID when Phase 0.5 skipped", async () => {
    const state = createPipelineState();
    const ctx = createPhaseContext();
    // saveToDb: false で Phase 0.5 スキップ
    ctx.options = { layoutOptions: { saveToDb: false } } as never;
    const mockPrisma = createMockPrisma();
    const mockAdapter = createMockAdapter({ screenshot: MINI_PNG_BASE64 });
    const service = createScreenshotPersistenceService({ prisma: mockPrisma });

    await processIngestPhase(state, ctx, {
      pageIngestAdapter: mockAdapter as never,
      prisma: mockPrisma as never,
      screenshotPersistenceService: service,
    });

    // actualWebPageId は初期値 (REQUESTED_ID) のまま
    expect(state.actualWebPageId).toBe(REQUESTED_ID);

    const expectedPath = path.resolve(sandbox, "phase5", `${REQUESTED_ID}.png`);
    expect(state.screenshotPngPath).toBe(expectedPath);
    await fs.access(expectedPath);
  });
});
