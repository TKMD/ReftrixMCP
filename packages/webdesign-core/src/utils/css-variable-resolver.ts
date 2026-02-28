// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSS Variable Resolver
 *
 * CSS変数（カスタムプロパティ）を解決し、実際の値に変換するユーティリティ
 *
 * 機能:
 * - :root / html / body から CSS変数定義を収集
 * - var(--property) を実際の値に置換
 * - フォールバック値 (var(--color, #fff)) のサポート
 * - ネストされた変数の解決 (var(--a) -> var(--b) -> #fff)
 * - 循環参照の検出と防止
 *
 * @module @reftrix/webdesign-core/utils/css-variable-resolver
 */

import * as cheerio from 'cheerio';

// =====================================================
// 型定義
// =====================================================

/**
 * CSS変数の定義情報
 */
export interface CssVariableDefinition {
  /** 変数名（--で始まる） */
  name: string;
  /** 変数の値 */
  value: string;
  /** 定義元セレクタ（:root, html, body等） */
  source: string;
}

/**
 * CSS変数解決結果
 */
export interface CssVariableResolutionResult {
  /** 解決が成功したか */
  success: boolean;
  /** 解決後の値（成功時） */
  resolvedValue?: string;
  /** 元の値 */
  originalValue: string;
  /** 使用されたフォールバック値 */
  fallbackUsed?: boolean;
  /** エラーメッセージ（失敗時） */
  error?: string;
}

/**
 * CSS変数マップ
 */
export type CssVariableMap = Map<string, string>;

/**
 * CSS変数解決オプション
 */
export interface CssVariableResolverOptions {
  /** 最大ネスト解決深度（デフォルト: 10） */
  maxDepth?: number;
  /** 未定義変数のフォールバック戦略（デフォルト: 'fallback'） */
  undefinedStrategy?: 'fallback' | 'keep' | 'remove';
  /** HTMLからの変数抽出を有効化（デフォルト: true） */
  extractFromHtml?: boolean;
}

// =====================================================
// 定数
// =====================================================

/** 最大ネスト解決深度（循環参照防止） */
const DEFAULT_MAX_DEPTH = 10;

/** CSS変数参照パターン: var(--name) または var(--name, fallback) */
const CSS_VAR_PATTERN = /var\s*\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\s*\)/gi;

/** CSS変数定義パターン: --name: value */
const CSS_VAR_DEFINITION_PATTERN = /(--[\w-]+)\s*:\s*([^;}\n]+)/g;

/** CSS変数を含む可能性のあるセレクタ */
const ROOT_SELECTORS = [':root', 'html', 'body', '[data-theme]', '.dark', '.light'];

// =====================================================
// ヘルパー関数
// =====================================================

/**
 * 値がCSS変数参照を含むかチェック
 *
 * @param value - チェック対象の値
 * @returns CSS変数参照を含む場合true
 */
export function containsCssVariable(value: string): boolean {
  return /var\s*\(\s*--[\w-]+/i.test(value);
}

/**
 * CSS変数名を抽出
 *
 * @param value - 抽出元の値
 * @returns CSS変数名の配列
 */
export function extractCssVariableNames(value: string): string[] {
  const names: string[] = [];
  const pattern = /var\s*\(\s*(--[\w-]+)/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const name = match[1];
    if (name) {
      names.push(name);
    }
  }

  return names;
}

// =====================================================
// CssVariableResolver クラス
// =====================================================

/**
 * CSS変数解決クラス
 *
 * HTMLからCSS変数定義を収集し、var() 参照を実際の値に解決する
 *
 * @example
 * ```typescript
 * const resolver = new CssVariableResolver();
 * resolver.extractVariablesFromHtml(html);
 *
 * // 単一値の解決
 * const result = resolver.resolve('var(--color-bg)');
 * // { success: true, resolvedValue: '#ffffff', originalValue: 'var(--color-bg)' }
 *
 * // フォールバック付き
 * const result2 = resolver.resolve('var(--undefined-var, #000)');
 * // { success: true, resolvedValue: '#000', fallbackUsed: true, ... }
 * ```
 */
export class CssVariableResolver {
  private variables: CssVariableMap = new Map();
  private options: Required<CssVariableResolverOptions>;

  constructor(options: CssVariableResolverOptions = {}) {
    this.options = {
      maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
      undefinedStrategy: options.undefinedStrategy ?? 'fallback',
      extractFromHtml: options.extractFromHtml ?? true,
    };
  }

  /**
   * HTMLからCSS変数定義を抽出
   *
   * 抽出元:
   * - <style> タグ内の :root, html, body セレクタ
   * - インラインスタイル
   *
   * @param html - 解析対象のHTML
   * @returns 抽出された変数の数
   */
  extractVariablesFromHtml(html: string): number {
    if (!html || html.trim().length === 0) {
      return 0;
    }

    let extractedCount = 0;

    // 1. <style> タグからCSS変数定義を抽出
    const $ = cheerio.load(html);
    $('style').each((_, elem) => {
      const cssContent = $(elem).html();
      if (cssContent) {
        extractedCount += this.extractVariablesFromCss(cssContent);
      }
    });

    // 2. ルート要素のインラインスタイルからも抽出
    for (const selector of ROOT_SELECTORS) {
      $(selector).each((_, elem) => {
        const style = $(elem).attr('style');
        if (style) {
          extractedCount += this.extractVariablesFromStyleAttr(style, selector);
        }
      });
    }

    return extractedCount;
  }

  /**
   * CSSテキストから変数定義を抽出
   *
   * @param css - CSSテキスト
   * @returns 抽出された変数の数
   */
  extractVariablesFromCss(css: string): number {
    if (!css) return 0;

    let count = 0;

    // ルートセレクタ内の変数定義を検索
    for (const selector of ROOT_SELECTORS) {
      // セレクタのブロックを検索（:root { ... }, html { ... } 等）
      const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const blockPattern = new RegExp(`${escapedSelector}\\s*\\{([^}]+)\\}`, 'gi');

      let blockMatch: RegExpExecArray | null;
      while ((blockMatch = blockPattern.exec(css)) !== null) {
        const blockContent = blockMatch[1];
        if (blockContent) {
          count += this.extractVariablesFromBlock(blockContent, selector);
        }
      }
    }

    return count;
  }

  /**
   * CSSブロックから変数定義を抽出
   *
   * @param block - CSSブロックの内容
   * @param _source - 定義元セレクタ（将来のデバッグ/トレース用に保持）
   * @returns 抽出された変数の数
   */
  private extractVariablesFromBlock(block: string, _source: string): number {
    let count = 0;
    let match: RegExpExecArray | null;
    const pattern = new RegExp(CSS_VAR_DEFINITION_PATTERN.source, 'g');

    while ((match = pattern.exec(block)) !== null) {
      const name = match[1];
      const value = match[2]?.trim();

      if (name && value) {
        // 既存の定義を上書き（後から定義されたものが優先）
        this.variables.set(name, value);
        count++;
      }
    }

    return count;
  }

  /**
   * style属性から変数定義を抽出
   *
   * @param styleAttr - style属性の値
   * @param _source - 定義元セレクタ（現在未使用だが将来のデバッグ用に保持）
   * @returns 抽出された変数の数
   */
  private extractVariablesFromStyleAttr(styleAttr: string, _source: string): number {
    return this.extractVariablesFromBlock(styleAttr, _source);
  }

  /**
   * 手動で変数を追加
   *
   * @param name - 変数名（--で始まる）
   * @param value - 変数の値
   */
  setVariable(name: string, value: string): void {
    if (!name.startsWith('--')) {
      name = `--${name}`;
    }
    this.variables.set(name, value);
  }

  /**
   * 複数の変数を一括追加
   *
   * @param variables - 変数名と値のマップ
   */
  setVariables(variables: Record<string, string>): void {
    for (const [name, value] of Object.entries(variables)) {
      this.setVariable(name, value);
    }
  }

  /**
   * 変数の値を取得
   *
   * @param name - 変数名
   * @returns 変数の値（未定義の場合undefined）
   */
  getVariable(name: string): string | undefined {
    if (!name.startsWith('--')) {
      name = `--${name}`;
    }
    return this.variables.get(name);
  }

  /**
   * 登録されているすべての変数を取得
   *
   * @returns 変数名と値のマップ
   */
  getAllVariables(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, value] of this.variables) {
      result[name] = value;
    }
    return result;
  }

  /**
   * CSS変数参照を解決
   *
   * @param value - 解決対象の値（var(--name)を含む）
   * @returns 解決結果
   */
  resolve(value: string): CssVariableResolutionResult {
    if (!value || typeof value !== 'string') {
      return {
        success: false,
        originalValue: value ?? '',
        error: 'Invalid input value',
      };
    }

    // CSS変数が含まれていない場合はそのまま返す
    if (!containsCssVariable(value)) {
      return {
        success: true,
        resolvedValue: value,
        originalValue: value,
      };
    }

    try {
      const resolvedValue = this.resolveValue(value, new Set(), 0);
      const fallbackUsed = this.wasFallbackUsed(value, resolvedValue);

      return {
        success: true,
        resolvedValue,
        originalValue: value,
        fallbackUsed,
      };
    } catch (error) {
      return {
        success: false,
        originalValue: value,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 値に含まれるすべてのCSS変数を解決（再帰的）
   *
   * @param value - 解決対象の値
   * @param visited - 循環参照検出用のセット
   * @param depth - 現在の解決深度
   * @returns 解決後の値
   */
  private resolveValue(value: string, visited: Set<string>, depth: number): string {
    // 深度チェック
    if (depth > this.options.maxDepth) {
      throw new Error(`Maximum resolution depth (${this.options.maxDepth}) exceeded`);
    }

    // CSS変数が含まれていない場合はそのまま返す
    if (!containsCssVariable(value)) {
      return value;
    }

    // var() を置換
    const pattern = new RegExp(CSS_VAR_PATTERN.source, 'gi');
    let result = value;

    // 置換を繰り返す（一度に全部置換すると正規表現のインデックスがずれる）
    let iterationCount = 0;
    const maxIterations = 100; // 無限ループ防止

    while (containsCssVariable(result) && iterationCount < maxIterations) {
      iterationCount++;
      pattern.lastIndex = 0;

      const newResult = result.replace(pattern, (fullMatch, varName, fallback) => {
        if (!varName) return fullMatch;

        // 循環参照チェック
        if (visited.has(varName)) {
          throw new Error(`Circular reference detected: ${varName}`);
        }

        // 変数の値を取得
        const varValue = this.variables.get(varName);

        if (varValue !== undefined) {
          // 再帰的に解決（ネストされた変数対応）
          const newVisited = new Set(visited);
          newVisited.add(varName);
          return this.resolveValue(varValue, newVisited, depth + 1);
        }

        // 未定義の変数の場合
        if (fallback !== undefined && fallback.trim().length > 0) {
          // フォールバック値を使用（フォールバック値も解決が必要な場合がある）
          return this.resolveValue(fallback.trim(), visited, depth + 1);
        }

        // フォールバックなしで未定義
        switch (this.options.undefinedStrategy) {
          case 'keep':
            return fullMatch;
          case 'remove':
            return '';
          case 'fallback':
          default:
            // フォールバックがない場合は元のまま
            return fullMatch;
        }
      });

      if (newResult === result) {
        // 変更がなければループを終了
        break;
      }
      result = newResult;
    }

    return result;
  }

  /**
   * フォールバック値が使用されたかチェック
   *
   * @param original - 元の値
   * @param _resolved - 解決後の値（将来の比較ロジック用に保持）
   * @returns フォールバック値が使用された場合true
   */
  private wasFallbackUsed(original: string, _resolved: string): boolean {
    // フォールバック付きのvar()を検索
    const fallbackPattern = /var\s*\(\s*(--[\w-]+)\s*,\s*([^)]+)\s*\)/gi;
    let match: RegExpExecArray | null;

    while ((match = fallbackPattern.exec(original)) !== null) {
      const varName = match[1];
      const fallback = match[2]?.trim();

      if (varName && fallback) {
        // 変数が定義されていない場合、フォールバックが使用された
        if (!this.variables.has(varName)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * すべての変数をクリア
   */
  clear(): void {
    this.variables.clear();
  }

  /**
   * 登録されている変数の数を取得
   */
  get size(): number {
    return this.variables.size;
  }
}

// =====================================================
// 便利な関数
// =====================================================

/**
 * HTMLから色値を抽出し、CSS変数を解決
 *
 * @param html - 解析対象のHTML
 * @param cssContent - 追加のCSSコンテンツ（オプション）
 * @returns 解決済みの色値配列
 */
export function extractAndResolveColors(
  html: string,
  cssContent?: string
): {
  backgroundColors: string[];
  textColors: string[];
  resolver: CssVariableResolver;
} {
  const resolver = new CssVariableResolver();

  // HTMLから変数を抽出
  resolver.extractVariablesFromHtml(html);

  // 追加のCSSから変数を抽出
  if (cssContent) {
    resolver.extractVariablesFromCss(cssContent);
  }

  const backgroundColors = new Set<string>();
  const textColors = new Set<string>();

  // ヘルパー: 背景色値を処理して追加
  const processBackgroundColor = (value: string): void => {
    const trimmedValue = value.trim();
    if (trimmedValue && !trimmedValue.includes('gradient') && !trimmedValue.includes('url(')) {
      const result = resolver.resolve(trimmedValue);
      if (result.success && result.resolvedValue) {
        if (isValidColorValue(result.resolvedValue)) {
          backgroundColors.add(result.resolvedValue);
        }
      }
    }
  };

  // ヘルパー: テキスト色値を処理して追加
  const processTextColor = (value: string): void => {
    const trimmedValue = value.trim();
    if (trimmedValue) {
      const result = resolver.resolve(trimmedValue);
      if (result.success && result.resolvedValue) {
        if (isValidColorValue(result.resolvedValue)) {
          textColors.add(result.resolvedValue);
        }
      }
    }
  };

  // ヘルパー: CSSテキストから色を抽出
  const extractColorsFromCssText = (cssText: string): void => {
    // 背景色を抽出
    const bgColorPattern = /background(?:-color)?:\s*([^;}\n]+)/gi;
    let match: RegExpExecArray | null;

    while ((match = bgColorPattern.exec(cssText)) !== null) {
      if (match[1]) {
        processBackgroundColor(match[1]);
      }
    }

    // テキスト色を抽出（background-colorではなくcolorのみ）
    const colorPattern = /(?:^|[;\s{])color:\s*([^;}\n]+)/gi;

    while ((match = colorPattern.exec(cssText)) !== null) {
      if (match[1]) {
        processTextColor(match[1]);
      }
    }
  };

  // 1. HTMLからstyle属性を持つ要素を解析
  const $ = cheerio.load(html);

  // 全要素のstyle属性から色を抽出
  $('[style]').each((_, elem) => {
    const styleAttr = $(elem).attr('style');
    if (styleAttr) {
      extractColorsFromCssText(styleAttr);
    }
  });

  // 2. <style>タグ内のCSSからも色を抽出
  $('style').each((_, elem) => {
    const cssContent = $(elem).html();
    if (cssContent) {
      extractColorsFromCssText(cssContent);
    }
  });

  // 3. 追加のCSSコンテンツからも抽出
  if (cssContent) {
    extractColorsFromCssText(cssContent);
  }

  return {
    backgroundColors: Array.from(backgroundColors),
    textColors: Array.from(textColors),
    resolver,
  };
}

/**
 * 値が有効な色値かチェック
 *
 * @param value - チェック対象の値
 * @returns 有効な色値の場合true
 */
export function isValidColorValue(value: string): boolean {
  if (!value || typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim().toLowerCase();

  // 空文字、inherit、initial等は除外
  if (
    trimmed === '' ||
    trimmed === 'inherit' ||
    trimmed === 'initial' ||
    trimmed === 'unset' ||
    trimmed === 'transparent' ||
    trimmed === 'currentcolor'
  ) {
    return false;
  }

  // 未解決のvar()が含まれている場合は除外
  if (containsCssVariable(trimmed)) {
    return false;
  }

  // 有効な色フォーマットをチェック
  const validPatterns = [
    /^#[0-9a-f]{3,8}$/i, // hex
    /^rgba?\s*\(/i, // rgb/rgba
    /^hsla?\s*\(/i, // hsl/hsla
    /^oklch\s*\(/i, // oklch
    /^oklab\s*\(/i, // oklab
    /^lab\s*\(/i, // lab
    /^lch\s*\(/i, // lch
    /^hwb\s*\(/i, // hwb
    /^color\s*\(/i, // color()
  ];

  // パターンマッチ
  if (validPatterns.some((p) => p.test(trimmed))) {
    return true;
  }

  // CSS named colors（一部）
  const namedColors = new Set([
    'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple',
    'pink', 'gray', 'grey', 'brown', 'cyan', 'magenta', 'lime', 'navy',
    'teal', 'olive', 'maroon', 'silver', 'aqua', 'fuchsia',
    // 追加の一般的な色名
    'aliceblue', 'antiquewhite', 'aquamarine', 'azure', 'beige', 'bisque',
    'blanchedalmond', 'blueviolet', 'burlywood', 'cadetblue', 'chartreuse',
    'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'darkblue',
    'darkcyan', 'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki',
    'darkmagenta', 'darkolivegreen', 'darkorange', 'darkorchid', 'darkred',
    'darksalmon', 'darkseagreen', 'darkslateblue', 'darkslategray', 'darkslategrey',
    'darkturquoise', 'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey',
    'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen', 'gainsboro', 'ghostwhite',
    'gold', 'goldenrod', 'greenyellow', 'honeydew', 'hotpink', 'indianred', 'indigo',
    'ivory', 'khaki', 'lavender', 'lavenderblush', 'lawngreen', 'lemonchiffon',
    'lightblue', 'lightcoral', 'lightcyan', 'lightgoldenrodyellow', 'lightgray',
    'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon', 'lightseagreen',
    'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow',
    'limegreen', 'linen', 'mediumaquamarine', 'mediumblue', 'mediumorchid',
    'mediumpurple', 'mediumseagreen', 'mediumslateblue', 'mediumspringgreen',
    'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream', 'mistyrose',
    'moccasin', 'navajowhite', 'oldlace', 'olivedrab', 'orangered', 'orchid',
    'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip',
    'peachpuff', 'peru', 'plum', 'powderblue', 'rebeccapurple', 'rosybrown',
    'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen', 'seashell',
    'sienna', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow', 'springgreen',
    'steelblue', 'tan', 'thistle', 'tomato', 'turquoise', 'violet', 'wheat',
    'whitesmoke', 'yellowgreen',
  ]);

  return namedColors.has(trimmed);
}
