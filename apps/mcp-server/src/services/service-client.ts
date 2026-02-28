// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP Server - Service Client
 * ReftrixバックエンドAPIへの接続クライアント
 *
 * WebDesign専用のAPIクライアント:
 * - /api/studio/projects: プロジェクト管理
 * - /api/studio/palettes: パレット管理
 *
 * 耐障害性機能:
 * - タイムアウト: デフォルト30秒
 * - リトライ: 最大3回、指数バックオフ（100ms, 200ms, 400ms）
 * - リトライ対象: ネットワークエラー、5xx系エラー
 * - リトライ非対象: 4xx系クライアントエラー
 */

import { logger, isDevelopment } from '../utils/logger';

/**
 * API Base URL (環境変数から取得、デフォルトはポート24000)
 */
export const API_BASE_URL =
  process.env.REFTRIX_API_URL || 'http://localhost:24000/api/v1';

/**
 * ServiceClientエラーコード
 */
export enum ServiceClientErrorCode {
  /** リクエストタイムアウト */
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  /** 最大リトライ回数超過 */
  MAX_RETRIES_EXCEEDED = 'MAX_RETRIES_EXCEEDED',
  /** ネットワークエラー */
  NETWORK_ERROR = 'NETWORK_ERROR',
  /** サーバーエラー (5xx) */
  SERVER_ERROR = 'SERVER_ERROR',
  /** クライアントエラー (4xx) */
  CLIENT_ERROR = 'CLIENT_ERROR',
  /** 認証エラー (401) */
  UNAUTHORIZED = 'UNAUTHORIZED',
}

/**
 * ServiceClientエラークラス
 */
export class ServiceClientError extends Error {
  public readonly code: ServiceClientErrorCode;
  public readonly statusCode: number | undefined;
  public readonly retryCount: number | undefined;
  public readonly originalCause: Error | undefined;

  constructor(
    code: ServiceClientErrorCode,
    message: string,
    options?: { statusCode?: number | undefined; retryCount?: number | undefined; cause?: Error | undefined }
  ) {
    super(message);
    this.name = 'ServiceClientError';
    this.code = code;
    this.statusCode = options?.statusCode;
    this.retryCount = options?.retryCount;
    this.originalCause = options?.cause;
  }
}

/**
 * ServiceClientオプション
 */
export interface ServiceClientOptions {
  /** タイムアウト時間（ミリ秒）。デフォルト: 30000ms (30秒) */
  timeout?: number;
  /** 最大リトライ回数。デフォルト: 3回 */
  maxRetries?: number;
  /** 初回リトライ遅延（ミリ秒）。デフォルト: 100ms */
  retryDelay?: number;
}

/**
 * デフォルトオプション
 */
const DEFAULT_OPTIONS: Required<ServiceClientOptions> = {
  timeout: 30000,
  maxRetries: 3,
  retryDelay: 100,
};

/**
 * プロジェクトのブランド設定情報の型定義
 */
export interface ProjectBrandSettingInfo {
  id: string;
  brandId: string | null;
  paletteId: string | null;
}

/**
 * プロジェクト詳細の型定義（Web API レスポンス形式）
 * [Phase 1] ProjectPageInfo, pages フィールド削除
 */
export interface ProjectResponse {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  brandSetting: ProjectBrandSettingInfo | null;
}

/**
 * プロジェクト一覧取得パラメータの型定義
 */
export interface ProjectListParams {
  status?: 'draft' | 'in_progress' | 'review' | 'completed' | 'archived' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
  sortBy?: 'createdAt' | 'updatedAt' | 'name' | undefined;
  sortOrder?: 'asc' | 'desc' | undefined;
}

/**
 * プロジェクト一覧レスポンスの型定義
 */
export interface ProjectListResponse {
  projects: ProjectResponse[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * カラートークンの型定義
 */
export interface ColorToken {
  id: string;
  name: string;
  hex: string;
  oklchL: number;
  oklchC: number;
  oklchH: number;
  role: 'primary' | 'secondary' | 'accent' | 'neutral' | 'semantic';
  semanticMeaning: string | null;
  sortOrder: number;
}

/**
 * パレット詳細レスポンスの型定義
 */
export interface PaletteResponse {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  mode: 'light' | 'dark';
  isDefault: boolean;
  tokens: ColorToken[];
  createdAt: string;
  updatedAt: string;
}

/**
 * リトライ対象のエラーかどうかを判定
 * @param error - 発生したエラー
 * @param statusCode - HTTPステータスコード
 * @returns リトライすべきかどうか
 */
function isRetryableError(error: Error | null, statusCode?: number): boolean {
  // ネットワークエラーはリトライ対象
  if (error && !statusCode) {
    return true;
  }

  // 5xx系サーバーエラーはリトライ対象
  if (statusCode && statusCode >= 500 && statusCode < 600) {
    return true;
  }

  // 4xx系クライアントエラーはリトライ非対象
  return false;
}

/**
 * 指数バックオフ遅延を計算
 * @param retryCount - 現在のリトライ回数（0始まり）
 * @param baseDelay - 基本遅延時間（ミリ秒）
 * @returns 遅延時間（ミリ秒）
 */
function calculateBackoffDelay(retryCount: number, baseDelay: number): number {
  // 2^retryCount * baseDelay: 100ms, 200ms, 400ms, ...
  return Math.pow(2, retryCount) * baseDelay;
}

/**
 * 指定時間待機
 * @param ms - 待機時間（ミリ秒）
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reftrix Service Client
 * バックエンドAPIとの通信を担当（WebDesign専用）
 *
 * 耐障害性機能:
 * - タイムアウト: デフォルト30秒（操作別に設定可能）
 * - リトライ: 最大3回、指数バックオフ（100ms, 200ms, 400ms）
 */
export class ServiceClient {
  private readonly baseUrl: string;
  private readonly options: Required<ServiceClientOptions>;

  constructor(baseUrl: string = API_BASE_URL, options: ServiceClientOptions = {}) {
    this.baseUrl = baseUrl;
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
  }

  /**
   * 現在のオプション設定を取得
   */
  getOptions(): Required<ServiceClientOptions> {
    return { ...this.options };
  }

  /**
   * タイムアウト付きfetchを実行
   * @param url - リクエストURL
   * @param init - fetchオプション
   * @param timeout - タイムアウト時間（ミリ秒）
   * @returns fetchレスポンス
   */
  private async fetchWithTimeout(
    url: string,
    init: globalThis.RequestInit,
    timeout: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ServiceClientError(
          ServiceClientErrorCode.TIMEOUT_ERROR,
          `Request timeout after ${timeout}ms`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * リトライ付きfetchを実行
   * @param url - リクエストURL
   * @param init - fetchオプション
   * @param operationName - 操作名（ログ用）
   * @returns fetchレスポンス
   */
  private async fetchWithRetry(
    url: string,
    init: globalThis.RequestInit,
    operationName: string
  ): Promise<Response> {
    let lastError: Error | null = null;
    let lastStatusCode: number | undefined;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const delay = calculateBackoffDelay(attempt - 1, this.options.retryDelay);
          if (isDevelopment()) {
            logger.info(`[ServiceClient] Retrying ${operationName} (attempt ${attempt}/${this.options.maxRetries}) after ${delay}ms`);
          }
          await sleep(delay);
        }

        const response = await this.fetchWithTimeout(url, init, this.options.timeout);

        // 成功（2xx）の場合
        if (response.ok) {
          return response;
        }

        // 404は特別処理（リトライしない、呼び出し元で処理）
        if (response.status === 404) {
          return response;
        }

        // 4xx系クライアントエラーはリトライしない
        if (response.status >= 400 && response.status < 500) {
          return response;
        }

        // 5xx系サーバーエラーはリトライ対象
        lastStatusCode = response.status;
        lastError = new Error(`Server error: ${response.status}`);

        if (isDevelopment()) {
          logger.warn(`[ServiceClient] ${operationName} failed with status ${response.status}`, {
            attempt,
            maxRetries: this.options.maxRetries,
          });
        }
      } catch (error) {
        if (error instanceof ServiceClientError) {
          // タイムアウトエラーはそのまま再スロー
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));

        if (isDevelopment()) {
          logger.warn(`[ServiceClient] ${operationName} failed with error: ${lastError.message}`, {
            attempt,
            maxRetries: this.options.maxRetries,
          });
        }

        // リトライ対象でない場合は即座に失敗
        if (!isRetryableError(lastError, undefined)) {
          throw new ServiceClientError(
            ServiceClientErrorCode.NETWORK_ERROR,
            lastError.message,
            { cause: lastError }
          );
        }
      }
    }

    // 最大リトライ回数を超えた
    // exactOptionalPropertyTypes対応: undefinedを含む可能性のある値を条件付きで追加
    const errorOptions: { statusCode?: number; retryCount?: number; cause?: Error } = {
      retryCount: this.options.maxRetries,
    };
    if (lastStatusCode !== undefined) {
      errorOptions.statusCode = lastStatusCode;
    }
    if (lastError !== null) {
      errorOptions.cause = lastError;
    }
    throw new ServiceClientError(
      ServiceClientErrorCode.MAX_RETRIES_EXCEEDED,
      `${operationName} failed after ${this.options.maxRetries} retries: ${lastError?.message ?? 'Unknown error'}`,
      errorOptions
    );
  }

  /**
   * プロジェクト取得API呼び出し
   *
   * Web API: GET /api/studio/projects/:id
   * レスポンス: { data: { id, name, slug, description, status, createdAt, updatedAt, pages, brandSetting } }
   *
   * Note: Studio APIは /api/studio/ パスを使用（/api/v1/ ではない）
   */
  async getProject(id: string): Promise<ProjectResponse | null> {
    if (isDevelopment()) {
      logger.info('[ServiceClient] Calling getProject API', { id });
    }

    // Studio APIは /api/studio/ パスを使用（baseUrlの/v1を除外）
    const studioBaseUrl = this.baseUrl.replace('/api/v1', '/api');
    const url = `${studioBaseUrl}/studio/projects/${id}`;

    const response = await this.fetchWithRetry(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      'getProject'
    );

    if (response.status === 404) {
      if (isDevelopment()) {
        logger.warn('[ServiceClient] Project not found', { id });
      }
      return null;
    }

    if (response.status === 401) {
      if (isDevelopment()) {
        logger.warn('[ServiceClient] Unauthorized', { id });
      }
      throw new ServiceClientError(
        ServiceClientErrorCode.UNAUTHORIZED,
        'UNAUTHORIZED - Authentication required',
        { statusCode: 401 }
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      if (isDevelopment()) {
        logger.error('[ServiceClient] Get Project API error', {
          status: response.status,
          error: errorText,
        });
      }
      throw new ServiceClientError(
        ServiceClientErrorCode.CLIENT_ERROR,
        `Get Project API error: ${response.status} - ${errorText}`,
        { statusCode: response.status }
      );
    }

    const json = await response.json();

    if (isDevelopment()) {
      logger.info('[ServiceClient] Get Project response', {
        hasData: !!json.data,
        id: json.data?.id,
        name: json.data?.name,
      });
    }

    // Web API レスポンス形式: { data: {...} }
    const data = json.data || json;

    return {
      id: data.id,
      name: data.name,
      slug: data.slug,
      description: data.description,
      status: data.status,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      brandSetting: data.brandSetting ?? null,
    };
  }

  /**
   * プロジェクト一覧取得API呼び出し
   *
   * Web API: GET /api/studio/projects
   * クエリパラメータ: status, limit, offset, sortBy, sortOrder
   * レスポンス: { data: { projects: [...], total, limit, offset } }
   *
   * Note: Studio APIは /api/studio/ パスを使用（/api/v1/ ではない）
   */
  async listProjects(params: ProjectListParams = {}): Promise<ProjectListResponse> {
    if (isDevelopment()) {
      logger.info('[ServiceClient] Calling listProjects API', { params });
    }

    // クエリパラメータを構築
    const queryParams = new URLSearchParams();
    if (params.status) queryParams.set('status', params.status);
    if (params.limit !== undefined) queryParams.set('limit', String(params.limit));
    if (params.offset !== undefined) queryParams.set('offset', String(params.offset));
    if (params.sortBy) queryParams.set('sortBy', params.sortBy);
    if (params.sortOrder) queryParams.set('sortOrder', params.sortOrder);

    const queryString = queryParams.toString();
    // Studio APIは /api/studio/ パスを使用（baseUrlの/v1を除外）
    const studioBaseUrl = this.baseUrl.replace('/api/v1', '/api');
    const url = `${studioBaseUrl}/studio/projects${queryString ? `?${queryString}` : ''}`;

    const response = await this.fetchWithRetry(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      'listProjects'
    );

    if (response.status === 401) {
      if (isDevelopment()) {
        logger.warn('[ServiceClient] Unauthorized');
      }
      throw new ServiceClientError(
        ServiceClientErrorCode.UNAUTHORIZED,
        'UNAUTHORIZED - Authentication required',
        { statusCode: 401 }
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      if (isDevelopment()) {
        logger.error('[ServiceClient] List Projects API error', {
          status: response.status,
          error: errorText,
        });
      }
      throw new ServiceClientError(
        ServiceClientErrorCode.CLIENT_ERROR,
        `List Projects API error: ${response.status} - ${errorText}`,
        { statusCode: response.status }
      );
    }

    const json = await response.json();

    if (isDevelopment()) {
      logger.info('[ServiceClient] List Projects response', {
        hasData: !!json.data,
        count: json.data?.projects?.length ?? 0,
        total: json.data?.total,
      });
    }

    // Web API レスポンス形式: { data: { projects, total, limit, offset } }
    // 注意: 一覧APIは pages 配列ではなく pagesCount を返す
    const data = json.data || json;

    return {
      projects: (data.projects ?? []).map((project: Record<string, unknown>) => ({
        id: project.id as string,
        name: project.name as string,
        slug: project.slug as string,
        description: project.description as string | null,
        status: project.status as string,
        createdAt: project.createdAt as string,
        updatedAt: project.updatedAt as string,
        // 一覧APIは pagesCount を返すが、詳細APIと互換性を保つため空配列を設定
        pages: [],
        brandSetting: null,
      })),
      total: data.total ?? 0,
      limit: data.limit ?? params.limit ?? 10,
      offset: data.offset ?? params.offset ?? 0,
    };
  }

  /**
   * パレット取得API呼び出し
   *
   * Web API: GET /api/studio/palettes/:id
   * レスポンス: { data: { id, name, slug, description, mode, isDefault, tokens, createdAt, updatedAt } }
   *
   * Note: Studio APIは /api/studio/ パスを使用（/api/v1/ ではない）
   */
  async getPalette(id: string): Promise<PaletteResponse | null> {
    if (isDevelopment()) {
      logger.info('[ServiceClient] Calling getPalette API', { id });
    }

    // Studio APIは /api/studio/ パスを使用（baseUrlの/v1を除外）
    const studioBaseUrl = this.baseUrl.replace('/api/v1', '/api');
    const url = `${studioBaseUrl}/studio/palettes/${id}`;

    const response = await this.fetchWithRetry(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json' },
      },
      'getPalette'
    );

    if (response.status === 404) {
      if (isDevelopment()) {
        logger.warn('[ServiceClient] Palette not found', { id });
      }
      return null;
    }

    if (response.status === 401) {
      if (isDevelopment()) {
        logger.warn('[ServiceClient] Unauthorized', { id });
      }
      throw new ServiceClientError(
        ServiceClientErrorCode.UNAUTHORIZED,
        'UNAUTHORIZED - Authentication required',
        { statusCode: 401 }
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      if (isDevelopment()) {
        logger.error('[ServiceClient] Get Palette API error', {
          status: response.status,
          error: errorText,
        });
      }
      throw new ServiceClientError(
        ServiceClientErrorCode.CLIENT_ERROR,
        `Get Palette API error: ${response.status} - ${errorText}`,
        { statusCode: response.status }
      );
    }

    const json = await response.json();

    if (isDevelopment()) {
      logger.info('[ServiceClient] Get Palette response', {
        hasData: !!json.data,
        id: json.data?.id,
        name: json.data?.name,
        tokenCount: json.data?.tokens?.length ?? 0,
      });
    }

    // Web API レスポンス形式: { data: {...} }
    const data = json.data || json;

    return {
      id: data.id,
      name: data.name,
      slug: data.slug,
      description: data.description,
      mode: data.mode,
      isDefault: data.isDefault,
      tokens: (data.tokens ?? []).map((token: ColorToken) => ({
        id: token.id,
        name: token.name,
        hex: token.hex,
        oklchL: token.oklchL,
        oklchC: token.oklchC,
        oklchH: token.oklchH,
        role: token.role,
        semanticMeaning: token.semanticMeaning,
        sortOrder: token.sortOrder,
      })),
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }
}

/**
 * デフォルトのServiceClientインスタンス
 */
export const serviceClient = new ServiceClient();
