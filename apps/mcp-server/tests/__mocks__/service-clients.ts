// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 共通モックファクトリ
 * mcp-server テスト用のモックファクトリとテストデータ
 *
 * 目的:
 * - テストコードの重複削減
 * - 一貫したモックデータの提供
 * - 保守性の向上
 */
import { vi, type Mock } from 'vitest';
import type { SearchParams, SearchResult, SvgAsset, IngestResult, ProjectResponse } from '../../src/services/service-client';

// ============================================================================
// 型定義
// ============================================================================

/**
 * cachedServiceClientのモック型
 */
export interface MockCachedServiceClient {
  search: Mock<(params: SearchParams) => Promise<SearchResult>>;
  getSvg: Mock<(id: string) => Promise<SvgAsset | null>>;
  getStats: Mock;
}

/**
 * serviceClientのモック型
 */
export interface MockServiceClient {
  search: Mock<(params: SearchParams) => Promise<SearchResult>>;
  getSvg: Mock<(id: string) => Promise<SvgAsset | null>>;
  ingestSvg: Mock;
  transformToReact: Mock;
  transformOptimize: Mock;
  transformRecolor: Mock;
  transformNormalize: Mock;
  getProject: Mock<(id: string) => Promise<ProjectResponse | null>>;
  listProjects: Mock;
  getPalette: Mock;
  bulkIngest: Mock;
  enqueueVisionAnalysis: Mock;
  searchSvg: Mock;
}

/**
 * loggerのモック型
 */
export interface MockLogger {
  info: Mock;
  warn: Mock;
  error: Mock;
  debug: Mock;
}

// ============================================================================
// デフォルトテストデータ
// ============================================================================

/**
 * テスト用UUID
 * UUIDv7形式のテスト用ID
 */
export const TEST_UUIDS = {
  svgAsset1: '01939abc-def0-7000-8000-000000000001',
  svgAsset2: '01939abc-def0-7000-8000-000000000002',
  project: '01939abc-def0-7000-8000-000000000003',
  license: '01939abc-def0-7000-8000-000000000004',
  category: '01939abc-def0-7000-8000-000000000005',
} as const;

/**
 * テスト用SVGコンテンツ
 */
export const VALID_SVG_CONTENT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <path fill="#3B82F6" d="M12 2L2 7l10 5 10-5-10-5z"/>
  <path fill="#1D4ED8" d="M2 17l10 5 10-5"/>
</svg>`;

/**
 * シンプルなテスト用SVGコンテンツ
 */
export const SIMPLE_SVG_CONTENT = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>';

// ============================================================================
// モックファクトリ関数
// ============================================================================

/**
 * cachedServiceClientのモックを作成
 *
 * @returns cachedServiceClientのモックオブジェクト
 */
export function createMockCachedServiceClient(): MockCachedServiceClient {
  return {
    search: vi.fn(),
    getSvg: vi.fn(),
    getStats: vi.fn(),
  };
}

/**
 * serviceClientのモックを作成
 *
 * @returns serviceClientのモックオブジェクト
 */
export function createMockServiceClient(): MockServiceClient {
  return {
    search: vi.fn(),
    getSvg: vi.fn(),
    ingestSvg: vi.fn(),
    transformToReact: vi.fn(),
    transformOptimize: vi.fn(),
    transformRecolor: vi.fn(),
    transformNormalize: vi.fn(),
    getProject: vi.fn(),
    listProjects: vi.fn(),
    getPalette: vi.fn(),
    bulkIngest: vi.fn(),
    enqueueVisionAnalysis: vi.fn(),
    searchSvg: vi.fn(),
  };
}

/**
 * loggerのモックを作成
 *
 * @returns loggerのモックオブジェクト
 */
export function createMockLogger(): MockLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * Loggerクラスのモックを作成
 * createLoggerやLoggerクラスをモックする際に使用
 */
export function createMockLoggerClass(): { new (): MockLogger } {
  const MockLoggerClass = class {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  };
  return MockLoggerClass as unknown as { new (): MockLogger };
}

// ============================================================================
// テストデータファクトリ
// ============================================================================

/**
 * SVGアセットのモックデータを作成
 *
 * @param overrides - 上書きするプロパティ
 * @returns SVGアセットのモックデータ
 */
export function createMockSvgAsset(overrides: Partial<SvgAsset> = {}): SvgAsset {
  return {
    id: TEST_UUIDS.svgAsset1,
    name: 'Blue Star Icon',
    slug: 'blue-star-icon',
    description: 'A blue star icon for UI design',
    svg_raw: VALID_SVG_CONTENT,
    svg_optimized: '<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5z"/></svg>',
    style: 'flat',
    purpose: 'icon',
    viewbox: '0 0 24 24',
    width: 24,
    height: 24,
    file_size: 256,
    colors: ['#3B82F6', '#1D4ED8'],
    tags: [
      { id: 't1', name: 'star', name_ja: '星' },
      { id: 't2', name: 'blue', name_ja: '青' },
    ],
    license: {
      id: TEST_UUIDS.license,
      spdx_id: 'MIT',
      name: 'MIT License',
      commercial_use: true,
      modification: true,
      attribution_required: true,
      attribution_template: 'Copyright (c) {year} {author}',
    },
    category: {
      id: TEST_UUIDS.category,
      name: 'Icon',
      name_ja: 'アイコン',
      slug: 'icon',
      path: '/inorganic/icon',
      type: 'inorganic',
    },
    source_url: 'https://example.com/icons/star.svg',
    source_name: 'Example Icons',
    created_at: '2025-11-29T10:00:00.000Z',
    updated_at: '2025-11-29T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * 検索結果アイテムのモックデータを作成
 *
 * @param overrides - 上書きするプロパティ
 * @returns 検索結果アイテムのモックデータ
 */
export function createMockSearchResultItem(overrides: Partial<{
  id: string;
  name: string;
  slug: string;
  similarity: number;
  thumbnail_url: string;
  style: string;
  purpose: string;
  tags: string[];
  license: {
    spdx_id: string;
    commercial_use: boolean;
    attribution_required: boolean;
  };
}> = {}) {
  return {
    id: TEST_UUIDS.svgAsset1,
    name: 'Blue Star Icon',
    slug: 'blue-star-icon',
    similarity: 0.95,
    thumbnail_url: `/api/v1/svg/${TEST_UUIDS.svgAsset1}/thumbnail`,
    style: 'flat',
    purpose: 'icon',
    tags: ['star', 'blue', 'icon'],
    license: {
      spdx_id: 'MIT',
      commercial_use: true,
      attribution_required: true,
    },
    ...overrides,
  };
}

/**
 * 検索結果のモックデータを作成
 *
 * @param overrides - 上書きするプロパティ
 * @returns 検索結果のモックデータ
 */
export function createMockSearchResult(overrides: Partial<{
  items: ReturnType<typeof createMockSearchResultItem>[];
  total: number;
  limit: number;
  offset: number;
}> = {}): SearchResult {
  return {
    items: [createMockSearchResultItem()],
    total: 1,
    limit: 10,
    offset: 0,
    ...overrides,
  };
}

/**
 * 空の検索結果のモックデータを作成
 *
 * @returns 空の検索結果
 */
export function createEmptySearchResult(): SearchResult {
  return {
    items: [],
    total: 0,
    limit: 10,
    offset: 0,
  };
}

/**
 * プロジェクトのモックデータを作成
 *
 * @param overrides - 上書きするプロパティ
 * @returns プロジェクトのモックデータ
 */
export function createMockProject(overrides: Partial<ProjectResponse> = {}): ProjectResponse {
  return {
    id: TEST_UUIDS.project,
    name: 'Test Project',
    slug: 'test-project',
    description: 'A test project for unit tests',
    status: 'in_progress',
    createdAt: '2025-11-29T10:00:00.000Z',
    updatedAt: '2025-11-29T10:00:00.000Z',
    pages: [],
    brandSetting: null,
    ...overrides,
  };
}

/**
 * SVG登録結果のモックデータを作成
 *
 * @param overrides - 上書きするプロパティ
 * @returns SVG登録結果のモックデータ
 */
export function createMockIngestResult(overrides: Partial<IngestResult> = {}): IngestResult {
  return {
    id: TEST_UUIDS.svgAsset1,
    name: 'Test Icon',
    slug: 'test-icon',
    svg_optimized: '<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5z"/></svg>',
    original_size: 256,
    optimized_size: 180,
    reduction_percent: 29.7,
    colors_extracted: ['#3B82F6', '#1D4ED8'],
    created_at: '2025-11-29T10:00:00.000Z',
    ...overrides,
  };
}

// ============================================================================
// vi.mock用のモジュールファクトリ
// ============================================================================

/**
 * cachedServiceClientモジュールのモックを取得
 * vi.mockの戻り値として使用
 *
 * @param mockClient - カスタムモッククライアント（オプション）
 * @returns vi.mockに渡すファクトリオブジェクト
 */
export function getCachedServiceClientMockModule(mockClient?: Partial<MockCachedServiceClient>) {
  const client = mockClient ?? createMockCachedServiceClient();
  return {
    cachedServiceClient: {
      search: client.search ?? vi.fn(),
      getSvg: client.getSvg ?? vi.fn(),
      getStats: client.getStats ?? vi.fn(),
    },
  };
}

/**
 * serviceClientモジュールのモックを取得
 * vi.mockの戻り値として使用
 *
 * @param mockClient - カスタムモッククライアント（オプション）
 * @returns vi.mockに渡すファクトリオブジェクト
 */
export function getServiceClientMockModule(mockClient?: Partial<MockServiceClient>) {
  const client = mockClient ?? createMockServiceClient();
  return {
    serviceClient: {
      search: client.search ?? vi.fn(),
      getSvg: client.getSvg ?? vi.fn(),
      ingestSvg: client.ingestSvg ?? vi.fn(),
      transformToReact: client.transformToReact ?? vi.fn(),
      transformOptimize: client.transformOptimize ?? vi.fn(),
      transformRecolor: client.transformRecolor ?? vi.fn(),
      transformNormalize: client.transformNormalize ?? vi.fn(),
      getProject: client.getProject ?? vi.fn(),
      listProjects: client.listProjects ?? vi.fn(),
      getPalette: client.getPalette ?? vi.fn(),
      bulkIngest: client.bulkIngest ?? vi.fn(),
      enqueueVisionAnalysis: client.enqueueVisionAnalysis ?? vi.fn(),
      searchSvg: client.searchSvg ?? vi.fn(),
    },
    API_BASE_URL: 'http://localhost:24000/api/v1',
    ServiceClient: vi.fn(),
  };
}

/**
 * loggerモジュールのモックを取得
 * vi.mockの戻り値として使用
 *
 * @param mockLogger - カスタムモックロガー（オプション）
 * @returns vi.mockに渡すファクトリオブジェクト
 */
export function getLoggerMockModule(mockLogger?: Partial<MockLogger>) {
  const logger = mockLogger ?? createMockLogger();
  const MockLoggerClass = createMockLoggerClass();
  return {
    logger: {
      info: logger.info ?? vi.fn(),
      warn: logger.warn ?? vi.fn(),
      error: logger.error ?? vi.fn(),
      debug: logger.debug ?? vi.fn(),
    },
    createLogger: vi.fn(() => logger),
    Logger: MockLoggerClass,
    isDevelopment: vi.fn().mockReturnValue(false),
  };
}

// ============================================================================
// ヘルパー関数
// ============================================================================

/**
 * モックをリセット
 * beforeEachで使用してすべてのモックをクリア
 *
 * @param mocks - リセットするモックの配列
 */
export function resetMocks(...mocks: Mock[]): void {
  mocks.forEach((mock) => mock.mockReset());
}

/**
 * 検索モックを設定
 *
 * @param mock - cachedServiceClient.searchのモック
 * @param result - 返す検索結果
 */
export function setupSearchMock(
  mock: Mock<(params: SearchParams) => Promise<SearchResult>>,
  result: SearchResult
): void {
  mock.mockResolvedValueOnce(result);
}

/**
 * getSvgモックを設定
 *
 * @param mock - cachedServiceClient.getSvgのモック
 * @param result - 返すSVGアセット（nullの場合は見つからない）
 */
export function setupGetSvgMock(
  mock: Mock<(id: string) => Promise<SvgAsset | null>>,
  result: SvgAsset | null
): void {
  mock.mockResolvedValueOnce(result);
}

/**
 * エラーモックを設定
 *
 * @param mock - モック関数
 * @param error - スローするエラー
 */
export function setupErrorMock(
  mock: Mock,
  error: Error
): void {
  mock.mockRejectedValueOnce(error);
}
