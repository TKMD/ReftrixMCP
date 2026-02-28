// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Light Response Controller
 *
 * MCPツールのレスポンスを軽量化し、トークン使用量を98.7%削減
 * (150,000トークン → 2,000トークン)
 *
 * 機能:
 * - デフォルトでlight response（summary相当）を返却
 * - include_*オプションで詳細データを明示的に要求可能
 * - ツール別のフィールド除外/配列制限設定
 * - 後方互換性の維持（summary: falseで従来動作）
 * - RESP-12: ユーザー指定のlimit値を配列制限に優先適用
 *
 * @module middleware/light-response-controller
 */

/**
 * Light Response設定オプション（snake_case正式形式）
 */
export interface LightResponseOptions {
  /** サマリーモード（デフォルト: true） */
  summary?: boolean;
  /** HTMLを含める（明示的に要求） */
  include_html?: boolean;
  /** スクリーンショットを含める（明示的に要求） */
  include_screenshot?: boolean;
  /** 生のCSSを含める（明示的に要求） */
  include_rawCss?: boolean;
  /** 外部CSSコンテンツを含める（明示的に要求） */
  include_external_css?: boolean;
  /** ユーザー指定の配列制限値（RESP-12: 動的配列制限） */
  limit?: number;
}

/**
 * Light Response適用結果（警告を含む）
 *
 * RESP-14: ユーザー指定limitがMAX_ARRAY_LIMITを超えた場合の警告
 */
export interface LightResponseResult<T> {
  /** 変換後のレスポンス */
  response: T;
  /** 警告メッセージ（limit超過時など） */
  warnings?: string[];
}

/**
 * 配列制限に関する警告
 */
export interface ArrayLimitWarning {
  /** 警告タイプ */
  type: 'LIMIT_EXCEEDED';
  /** ユーザーが指定した値 */
  requestedLimit: number;
  /** 実際に適用された値 */
  appliedLimit: number;
  /** 警告メッセージ */
  message: string;
}

/**
 * SEC: ネストオプションの許可リスト
 * セキュリティのため、任意のネストキーからの抽出を防止
 * page.analyze, layout.ingest等で使用されるネストオプションのみ許可
 */
const ALLOWED_NESTED_OPTION_KEYS = [
  'options',        // 共通ネスト
  'layoutOptions',  // page.analyze
  'motionOptions',  // page.analyze
  'qualityOptions', // page.analyze
] as const;

/**
 * ネストオブジェクトからbooleanフィールドを抽出するヘルパー
 *
 * @param obj - ネストオブジェクト
 * @param snakeKey - snake_caseキー（正式形式）
 * @param camelKey - camelCaseキー（レガシー互換）
 * @returns 抽出されたboolean値、または undefined
 */
function extractBooleanFromNested(
  obj: Record<string, unknown> | null | undefined,
  snakeKey: string,
  camelKey: string
): boolean | undefined {
  if (typeof obj !== 'object' || obj === null) {
    return undefined;
  }
  // snake_case優先
  if (typeof obj[snakeKey] === 'boolean') {
    return obj[snakeKey] as boolean;
  }
  // camelCaseフォールバック
  if (typeof obj[camelKey] === 'boolean') {
    return obj[camelKey] as boolean;
  }
  return undefined;
}

/**
 * MCPツール引数からLightResponseOptionsを抽出
 *
 * snake_case (include_html) を正式形式とし、
 * camelCase (includeHtml) はレガシー互換としてマッピング
 *
 * 対応するネスト構造:
 * - args.include_html (トップレベル)
 * - args.options.include_html (共通ネスト)
 * - args.layoutOptions.include_html (page.analyze)
 * - args.motionOptions.* (page.analyze)
 * - args.qualityOptions.* (page.analyze)
 *
 * @param args - MCPツール引数
 * @returns 正規化されたLightResponseOptions
 */
export function extractLightResponseOptions(
  args: Record<string, unknown>
): LightResponseOptions {
  const options: LightResponseOptions = {};

  // summary: snake_case (summary) - 直接対応
  if (typeof args.summary === 'boolean') {
    options.summary = args.summary;
  }

  // === include_html ===
  // 1. トップレベル（最優先）
  if (typeof args.include_html === 'boolean') {
    options.include_html = args.include_html;
  } else if (typeof args.includeHtml === 'boolean') {
    options.include_html = args.includeHtml;
  }

  // 2. ネストオプションからの抽出（トップレベル未設定時のみ）
  if (options.include_html === undefined) {
    for (const nestedKey of ALLOWED_NESTED_OPTION_KEYS) {
      const nestedObj = args[nestedKey] as Record<string, unknown> | undefined;
      const value = extractBooleanFromNested(nestedObj, 'include_html', 'includeHtml');
      if (value !== undefined) {
        options.include_html = value;
        break; // 最初に見つかった値を採用
      }
    }
  }

  // === include_screenshot ===
  // 1. トップレベル（最優先）
  if (typeof args.include_screenshot === 'boolean') {
    options.include_screenshot = args.include_screenshot;
  } else if (typeof args.includeScreenshot === 'boolean') {
    options.include_screenshot = args.includeScreenshot;
  }

  // 2. ネストオプションからの抽出（トップレベル未設定時のみ）
  if (options.include_screenshot === undefined) {
    for (const nestedKey of ALLOWED_NESTED_OPTION_KEYS) {
      const nestedObj = args[nestedKey] as Record<string, unknown> | undefined;
      const value = extractBooleanFromNested(nestedObj, 'include_screenshot', 'includeScreenshot');
      if (value !== undefined) {
        options.include_screenshot = value;
        break;
      }
    }
  }

  // === include_rawCss ===
  // 1. トップレベル
  if (typeof args.include_rawCss === 'boolean') {
    options.include_rawCss = args.include_rawCss;
  } else if (typeof args.includeRawCss === 'boolean') {
    options.include_rawCss = args.includeRawCss;
  }

  // 2. ネストオプションからの抽出（トップレベル未設定時のみ）
  if (options.include_rawCss === undefined) {
    for (const nestedKey of ALLOWED_NESTED_OPTION_KEYS) {
      const nestedObj = args[nestedKey] as Record<string, unknown> | undefined;
      const value = extractBooleanFromNested(nestedObj, 'include_rawCss', 'includeRawCss');
      if (value !== undefined) {
        options.include_rawCss = value;
        break;
      }
    }
  }

  // verbose=trueの場合はrawCssを含める（motion.detectの互換性）
  if (typeof args.verbose === 'boolean' && args.verbose) {
    options.include_rawCss = true;
  }

  // === include_external_css ===
  // 1. トップレベル
  if (typeof args.include_external_css === 'boolean') {
    options.include_external_css = args.include_external_css;
  } else if (typeof args.includeExternalCss === 'boolean') {
    options.include_external_css = args.includeExternalCss;
  }

  // 2. ネストオプションからの抽出（トップレベル未設定時のみ）
  if (options.include_external_css === undefined) {
    for (const nestedKey of ALLOWED_NESTED_OPTION_KEYS) {
      const nestedObj = args[nestedKey] as Record<string, unknown> | undefined;
      const value = extractBooleanFromNested(nestedObj, 'include_external_css', 'includeExternalCss');
      if (value !== undefined) {
        options.include_external_css = value;
        break;
      }
    }
  }

  // === limit ===
  // 1. トップレベル（最優先）
  if (typeof args.limit === 'number' && args.limit > 0) {
    options.limit = args.limit;
  }

  // 2. ネストオプションからの抽出（トップレベル未設定時のみ）
  if (options.limit === undefined) {
    for (const nestedKey of ALLOWED_NESTED_OPTION_KEYS) {
      const nestedObj = args[nestedKey] as Record<string, unknown> | undefined;
      if (typeof nestedObj === 'object' && nestedObj !== null) {
        if (typeof nestedObj.limit === 'number' && nestedObj.limit > 0) {
          options.limit = nestedObj.limit;
          break;
        }
      }
    }
  }

  return options;
}

/**
 * ツール別フィールド設定
 */
export interface ToolFieldConfig {
  /** 除外するフィールド（summary: true時） */
  excludeFields: string[];
  /** 配列フィールドの最大アイテム数 */
  arrayLimits: Record<string, number>;
  /** ネストされたフィールドの設定 */
  nestedConfigs?: Record<string, ToolFieldConfig>;
}

/**
 * コントローラー設定
 */
export interface LightResponseControllerOptions {
  /** デフォルトの配列最大アイテム数 */
  maxArrayItems?: number;
  /** デフォルトで除外するフィールド */
  excludeFields?: string[];
}

/**
 * SEC: 絶対上限値（DoS防止）
 * この値を超えるlimitは自動的にこの値に制限され、警告が発生する
 */
export const MAX_ARRAY_LIMIT = 1000;

/**
 * デフォルト設定
 */
export const DEFAULT_LIGHT_RESPONSE_CONFIG: Required<LightResponseControllerOptions> = {
  maxArrayItems: 10,
  excludeFields: [
    'html',
    'screenshot',
    'rawCss',
    'raw_css',
    'html_snippet',
    'css_snippet',
    'external_css_content',
  ],
};

/**
 * ツール別のフィールド設定
 */
export const TOOL_FIELD_CONFIGS: Record<string, ToolFieldConfig> = {
  'layout.ingest': {
    excludeFields: ['html', 'screenshot', 'external_css_content', 'css_content', 'html_snippet', 'css_snippet'],
    arrayLimits: {
      sections: 10,
    },
    nestedConfigs: {
      sections: {
        excludeFields: ['html', 'css', 'html_snippet', 'css_snippet'],
        arrayLimits: {},
      },
    },
  },
  'layout.search': {
    excludeFields: ['html', 'html_snippet', 'css_snippet'],
    arrayLimits: {
      results: 10,
    },
  },
  'layout.inspect': {
    excludeFields: ['html', 'rawStyles'],
    arrayLimits: {
      sections: 10,
      grids: 5,
    },
  },
  'quality.evaluate': {
    excludeFields: [],
    arrayLimits: {
      recommendations: 3,
      contextualRecommendations: 3,
      violations: 5,
      'patternAnalysis.similarSections': 3,
      'patternAnalysis.similarMotions': 3,
      'patternAnalysis.benchmarksUsed': 3,
      'axeAccessibility.violations': 5,
      'clicheDetection.patterns': 3,
    },
    nestedConfigs: {
      patternAnalysis: {
        excludeFields: [],
        arrayLimits: {
          similarSections: 3,
          similarMotions: 3,
          benchmarksUsed: 3,
        },
      },
      axeAccessibility: {
        excludeFields: [],
        arrayLimits: {
          violations: 5,
        },
      },
      clicheDetection: {
        excludeFields: [],
        arrayLimits: {
          patterns: 3,
        },
      },
    },
  },
  'motion.detect': {
    excludeFields: ['rawCss', 'raw_css'],
    arrayLimits: {
      patterns: 20,
      warnings: 5,
      'js_animations.cdpAnimations': 10,
      'js_animations.webAnimations': 10,
    },
  },
  'motion.search': {
    excludeFields: ['rawCss'],
    arrayLimits: {
      results: 10,
    },
  },
  'page.analyze': {
    excludeFields: ['html', 'screenshot'],
    arrayLimits: {
      'layout.sections': 10,
      'motion.patterns': 20,
      'quality.recommendations': 5,
    },
    nestedConfigs: {
      layout: {
        excludeFields: ['html', 'screenshot'],
        arrayLimits: {
          sections: 10,
        },
      },
      motion: {
        excludeFields: ['rawCss'],
        arrayLimits: {
          patterns: 20,
        },
      },
      quality: {
        excludeFields: [],
        arrayLimits: {
          recommendations: 5,
        },
      },
    },
  },
};

/**
 * Light Response Controller
 *
 * MCPツールのレスポンスを軽量化するコントローラー
 */
export class LightResponseController {
  private readonly config: Required<LightResponseControllerOptions>;
  /** 現在の変換処理で発生した警告（apply()ごとにリセット） */
  private currentWarnings: ArrayLimitWarning[] = [];

  /**
   * コンストラクタ
   *
   * @param options - コントローラー設定
   * @param logger - ロガーインスタンス（省略時はデフォルトロガー）
   */
  constructor(options: LightResponseControllerOptions = {}) {
    this.config = {
      ...DEFAULT_LIGHT_RESPONSE_CONFIG,
      ...options,
    };
  }

  /**
   * レスポンスにlight response変換を適用
   *
   * @param toolName - MCPツール名
   * @param response - 元のレスポンスオブジェクト
   * @param options - light responseオプション
   * @returns 変換後のレスポンス
   */
  apply<T>(
    toolName: string,
    response: T,
    options: LightResponseOptions = {}
  ): T {
    // 警告をリセット
    this.currentWarnings = [];

    // null/undefinedはそのまま返す
    if (response === null || response === undefined) {
      return response;
    }

    // デフォルトでsummary: true
    const summary = options.summary ?? true;

    // summary: falseの場合は元のレスポンスをそのまま返す
    if (!summary) {
      return response;
    }

    // エラーレスポンスは変換しない
    if (this.isErrorResponse(response)) {
      return response;
    }

    // RESP-14: ユーザー指定limitがMAX_ARRAY_LIMITを超えている場合は警告を追加
    if (options.limit !== undefined && options.limit > MAX_ARRAY_LIMIT) {
      this.currentWarnings.push({
        type: 'LIMIT_EXCEEDED',
        requestedLimit: options.limit,
        appliedLimit: MAX_ARRAY_LIMIT,
        message: `Requested limit (${options.limit}) exceeds maximum allowed (${MAX_ARRAY_LIMIT}). Applied limit: ${MAX_ARRAY_LIMIT}`,
      });
    }

    // ツール別設定を取得
    const toolConfig = TOOL_FIELD_CONFIGS[toolName] || {
      excludeFields: this.config.excludeFields,
      arrayLimits: {},
    };

    // レスポンスを変換
    return this.transformResponse(response, toolConfig, options);
  }

  /**
   * レスポンスにlight response変換を適用し、警告も返す
   *
   * RESP-14: ユーザー指定limitとMAX_ARRAY_LIMITの競合時に警告を返す
   *
   * @param toolName - MCPツール名
   * @param response - 元のレスポンスオブジェクト
   * @param options - light responseオプション
   * @returns 変換後のレスポンスと警告
   */
  applyWithWarnings<T>(
    toolName: string,
    response: T,
    options: LightResponseOptions = {}
  ): LightResponseResult<T> {
    const transformedResponse = this.apply(toolName, response, options);
    const result: LightResponseResult<T> = {
      response: transformedResponse,
    };
    if (this.currentWarnings.length > 0) {
      result.warnings = this.currentWarnings.map(w => w.message);
    }
    return result;
  }

  /**
   * 現在の変換処理で発生した警告を取得
   *
   * @returns 警告配列（apply()呼び出し後に取得可能）
   */
  getWarnings(): ArrayLimitWarning[] {
    return [...this.currentWarnings];
  }

  /**
   * エラーレスポンスかどうかを判定
   */
  private isErrorResponse(response: unknown): boolean {
    if (typeof response !== 'object' || response === null) {
      return false;
    }
    const resp = response as Record<string, unknown>;
    return resp.success === false;
  }

  /**
   * レスポンスを変換
   */
  private transformResponse<T>(
    response: T,
    config: ToolFieldConfig,
    options: LightResponseOptions
  ): T {
    if (typeof response !== 'object' || response === null) {
      return response;
    }

    const result = { ...response } as Record<string, unknown>;

    // dataフィールドがある場合はその中を変換
    if ('data' in result && typeof result.data === 'object' && result.data !== null) {
      result.data = this.transformData(
        result.data as Record<string, unknown>,
        config,
        options
      );
    }

    return result as T;
  }

  /**
   * 配列制限値を決定する
   *
   * RESP-12: ユーザー指定のlimitを優先し、フォールバックとしてツール設定→デフォルト値を使用
   * RESP-14 (L-01): 絶対上限値を設定（DoS防止）
   *
   * @param fieldKey - フィールド名
   * @param config - ツール別設定
   * @param options - ユーザー指定オプション
   * @returns 適用する制限値
   */
  private getArrayLimit(
    fieldKey: string,
    config: ToolFieldConfig,
    options: LightResponseOptions
  ): number {
    // RESP-12: ユーザー指定のlimitを最優先（ただし絶対上限を超えない）
    if (options.limit !== undefined && options.limit > 0) {
      return Math.min(options.limit, MAX_ARRAY_LIMIT);
    }

    // フォールバック: ツール固有の設定 → デフォルト値
    return config.arrayLimits[fieldKey] || this.config.maxArrayItems;
  }

  /**
   * データオブジェクトを変換
   */
  private transformData(
    data: Record<string, unknown>,
    config: ToolFieldConfig,
    options: LightResponseOptions
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      // include_*オプションで明示的に含める場合はスキップしない
      if (this.shouldIncludeField(key, config.excludeFields, options)) {
        // ネストされた設定がある場合
        if (config.nestedConfigs && config.nestedConfigs[key]) {
          const nestedConfig = config.nestedConfigs[key];
          if (Array.isArray(value)) {
            // 配列の場合は各要素を変換して制限を適用
            const limit = this.getArrayLimit(key, config, options);
            result[key] = value.slice(0, limit).map((item) => {
              if (typeof item === 'object' && item !== null) {
                return this.transformData(
                  item as Record<string, unknown>,
                  nestedConfig,
                  options
                );
              }
              return item;
            });
          } else if (typeof value === 'object' && value !== null) {
            result[key] = this.transformData(
              value as Record<string, unknown>,
              nestedConfig,
              options
            );
          } else {
            result[key] = value;
          }
        }
        // 配列の場合は制限を適用
        else if (Array.isArray(value)) {
          const limit = this.getArrayLimit(key, config, options);
          result[key] = value.slice(0, limit);
        }
        // オブジェクトの場合は再帰的に処理（ネスト設定がない場合）
        else if (typeof value === 'object' && value !== null) {
          result[key] = this.transformNestedObject(
            value as Record<string, unknown>,
            key,
            config,
            options
          );
        }
        // その他はそのまま
        else {
          result[key] = value;
        }
      }
    }

    return result;
  }

  /**
   * ネストされたオブジェクトを変換
   */
  private transformNestedObject(
    obj: Record<string, unknown>,
    parentKey: string,
    config: ToolFieldConfig,
    options: LightResponseOptions
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const fullKey = `${parentKey}.${key}`;

      // 配列制限のチェック
      if (Array.isArray(value)) {
        // RESP-12: ユーザー指定のlimitを優先（ただし絶対上限を超えない）
        let limit: number;
        if (options.limit !== undefined && options.limit > 0) {
          limit = Math.min(options.limit, MAX_ARRAY_LIMIT);
        } else {
          limit = config.arrayLimits[fullKey] ||
            config.arrayLimits[key] ||
            this.config.maxArrayItems;
        }
        result[key] = value.slice(0, limit);
      }
      // オブジェクトの場合は再帰処理（深さ制限あり）
      else if (typeof value === 'object' && value !== null) {
        // 簡易的なコピー（深いネストは制限）
        result[key] = value;
      }
      // その他はそのまま
      else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * フィールドを含めるべきかどうかを判定
   */
  private shouldIncludeField(
    fieldName: string,
    excludeFields: string[],
    options: LightResponseOptions
  ): boolean {
    // include_*オプションで明示的に要求された場合
    const includeOptionKey = `include_${fieldName}` as keyof LightResponseOptions;
    if (options[includeOptionKey] === true) {
      return true;
    }

    // 除外リストに含まれている場合は除外
    if (excludeFields.includes(fieldName)) {
      return false;
    }

    // それ以外は含める
    return true;
  }
}

/**
 * デフォルトのコントローラーインスタンス
 */
export const lightResponseController = new LightResponseController();

/**
 * Light Response適用のヘルパー関数
 *
 * @param toolName - MCPツール名
 * @param response - 元のレスポンス
 * @param options - オプション
 * @returns 変換後のレスポンス
 */
export function applyLightResponse<T>(
  toolName: string,
  response: T,
  options: LightResponseOptions = {}
): T {
  return lightResponseController.apply(toolName, response, options);
}

/**
 * Light Response適用のヘルパー関数（警告付き）
 *
 * RESP-14: ユーザー指定limitとMAX_ARRAY_LIMITの競合時に警告を返す
 *
 * @param toolName - MCPツール名
 * @param response - 元のレスポンス
 * @param options - オプション
 * @returns 変換後のレスポンスと警告
 */
export function applyLightResponseWithWarnings<T>(
  toolName: string,
  response: T,
  options: LightResponseOptions = {}
): LightResponseResult<T> {
  return lightResponseController.applyWithWarnings(toolName, response, options);
}
