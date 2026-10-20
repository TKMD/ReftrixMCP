// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * design.search_by_image の共有 test harness（fixture と DI mock factory）
 * Shared test harness for design.search_by_image (fixtures and DI mock factories).
 *
 * search-by-image.tool.test.ts から抽出し、入力 gate の INV と共有する。
 * Extracted from search-by-image.tool.test.ts to be shared with the input-gate invariant.
 */

import { vi } from "vitest";
import type {
  IDesignSearchDINOv2Service,
  IDesignSearchEmbeddingService,
  IDesignSearchPrismaClient,
} from "../../../../src/tools/design/search-by-image.tool";

/** 1x1 赤ピクセルのPNG画像（Base64） */
export const VALID_BASE64_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

/** テスト用768次元のembeddingベクトル */
export const MOCK_VISION_EMBEDDING = Array.from({ length: 768 }, (_, i) => Math.sin(i) * 0.01);
export const MOCK_TEXT_EMBEDDING = Array.from({ length: 768 }, (_, i) => Math.cos(i) * 0.01);

export function createMockDINOv2Service(
  overrides: Partial<IDesignSearchDINOv2Service> = {}
): IDesignSearchDINOv2Service {
  return {
    initialized: true,
    initialize: vi.fn().mockResolvedValue(undefined),
    generateEmbedding: vi.fn().mockResolvedValue(MOCK_VISION_EMBEDDING),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function createMockEmbeddingService(
  overrides: Partial<IDesignSearchEmbeddingService> = {}
): IDesignSearchEmbeddingService {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(MOCK_TEXT_EMBEDDING),
    ...overrides,
  };
}

export function createMockPrismaClient(queryResults: unknown[] = []): IDesignSearchPrismaClient {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue(queryResults),
  };
}
