// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Template Engine
 *
 * Mustache/Handlebars風の軽量テンプレートエンジン
 * 変数置換、条件分岐、ループをサポート
 *
 * @module @reftrix/webdesign-core/template-engine
 */

import type { Template, TemplateContext } from '../types/template.types';
import type { SectionType } from '../types/section.types';

/**
 * テンプレートエンジン
 *
 * @example
 * ```typescript
 * const engine = new TemplateEngine();
 *
 * engine.register({
 *   id: 'hero-react',
 *   sectionType: 'hero',
 *   framework: 'react',
 *   content: '<h1>{{title}}</h1>'
 * });
 *
 * const result = engine.render(template, {
 *   section: { type: 'hero' },
 *   options: { framework: 'react' },
 *   title: 'Hello World'
 * });
 * ```
 */
export class TemplateEngine {
  private templates: Map<string, Template> = new Map();

  /**
   * テンプレートを登録
   *
   * @param template - 登録するテンプレート
   */
  register(template: Template): void {
    const key = this.getTemplateKey(template.sectionType, template.framework);
    this.templates.set(template.id, template);
    // セクションタイプ+フレームワークのキーでも登録
    this.templates.set(key, template);
  }

  /**
   * テンプレートを削除
   *
   * @param id - テンプレートID
   * @returns 削除成功時true
   */
  unregister(id: string): boolean {
    const template = this.templates.get(id);
    if (!template) {
      return false;
    }

    const key = this.getTemplateKey(template.sectionType, template.framework);
    this.templates.delete(id);
    this.templates.delete(key);
    return true;
  }

  /**
   * テンプレートを取得
   *
   * @param sectionType - セクションタイプ
   * @param framework - フレームワーク
   * @returns テンプレート（存在しない場合undefined）
   */
  get(sectionType: SectionType, framework: string): Template | undefined {
    const key = this.getTemplateKey(sectionType, framework);
    return this.templates.get(key);
  }

  /**
   * テンプレートの存在確認
   *
   * @param sectionType - セクションタイプ
   * @param framework - フレームワーク
   * @returns 存在する場合true
   */
  has(sectionType: SectionType, framework: string): boolean {
    const key = this.getTemplateKey(sectionType, framework);
    return this.templates.has(key);
  }

  /**
   * テンプレートをレンダリング
   *
   * @param template - テンプレート
   * @param context - コンテキスト
   * @returns レンダリング結果
   */
  render(template: Template, context: TemplateContext): string {
    let result = template.content;

    // デフォルトコンテキストをマージ
    const mergedContext = {
      ...template.defaultContext,
      ...context,
    };

    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[TemplateEngine] Rendering:', {
        templateId: template.id,
        sectionType: template.sectionType,
        framework: template.framework,
      });
    }

    // 1. コメント削除
    result = this.removeComments(result);

    // 2. ループ処理（条件分岐より先に処理）
    result = this.processLoops(result, mergedContext);

    // 3. 条件分岐処理
    result = this.processConditionals(result, mergedContext);

    // 4. 変数置換
    result = this.replaceVariables(result, mergedContext);

    return result;
  }

  /**
   * セクションタイプとフレームワークでレンダリング
   *
   * @param sectionType - セクションタイプ
   * @param framework - フレームワーク
   * @param context - コンテキスト
   * @returns レンダリング結果
   * @throws テンプレートが存在しない場合
   */
  renderByType(
    sectionType: SectionType,
    framework: string,
    context: TemplateContext
  ): string {
    const template = this.get(sectionType, framework);
    if (!template) {
      throw new Error(
        `Template not found for sectionType="${sectionType}", framework="${framework}"`
      );
    }
    return this.render(template, context);
  }

  /**
   * テンプレートキー生成
   *
   * @param sectionType - セクションタイプ
   * @param framework - フレームワーク
   * @returns テンプレートキー
   */
  private getTemplateKey(sectionType: SectionType, framework: string): string {
    return `${sectionType}:${framework}`;
  }

  /**
   * コメント削除
   *
   * @param content - コンテンツ
   * @returns コメント削除後のコンテンツ
   */
  private removeComments(content: string): string {
    // {{! ... }} 形式のコメントを削除
    // コメント内のネストした {{ }} も考慮
    let result = content;
    const commentStart = '{{!';
    let pos = 0;

    while ((pos = result.indexOf(commentStart, pos)) !== -1) {
      const start = pos;
      let depth = 1;
      let i = pos + commentStart.length;

      // バランスの取れた }} を探す
      while (i < result.length && depth > 0) {
        if (result.substr(i, 2) === '{{') {
          depth++;
          i += 2;
        } else if (result.substr(i, 2) === '}}') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }

      if (depth === 0) {
        // バランスが取れた場合、コメント全体を削除
        result = result.substring(0, start) + result.substring(i);
        pos = start; // 同じ位置から再開
      } else {
        // バランスが取れない場合はスキップ
        pos = i;
      }
    }

    return result;
  }

  /**
   * 変数置換
   *
   * @param content - コンテンツ
   * @param context - コンテキスト
   * @returns 変数置換後のコンテンツ
   */
  private replaceVariables(content: string, context: TemplateContext): string {
    // {{variable|default}} または {{variable}} 形式の変数を置換
    // スペースを含むデフォルト値に対応するため、より柔軟な正規表現を使用
    return content.replace(/\{\{([^#/!][^}]*?)\}\}/g, (_match, key) => {
      const trimmedKey = key.trim();

      // デフォルト値の処理
      let variableKey = trimmedKey;
      let defaultValue = '';

      if (trimmedKey.includes('|')) {
        const parts = trimmedKey.split('|');
        variableKey = parts[0].trim();
        defaultValue = parts.slice(1).join('|').trim();
      }

      // 特殊変数（@index等）の処理
      if (variableKey.startsWith('@')) {
        const value = context[variableKey];
        if (value !== undefined && value !== null) {
          return String(value);
        }
        return '';
      }

      // ネストしたプロパティの取得
      const value = this.getNestedProperty(context, variableKey);

      // 値が存在しないか空文字の場合、デフォルト値を使用
      if (value === undefined || value === null || value === '') {
        return defaultValue;
      }

      return String(value);
    });
  }

  /**
   * 条件分岐処理
   *
   * @param content - コンテンツ
   * @param context - コンテキスト
   * @returns 条件分岐処理後のコンテンツ
   */
  private processConditionals(content: string, context: TemplateContext): string {
    // {{#if condition}}...{{/if}} 形式の条件分岐を処理
    // ネストした条件分岐に対応するため、最も内側から処理
    let result = content;
    let prevResult = '';
    let iterations = 0;
    const maxIterations = 100; // 無限ループ防止

    while (result !== prevResult && iterations < maxIterations) {
      prevResult = result;
      iterations++;

      result = result.replace(
        /\{\{#if\s+(\w+(?:\.\w+)*)\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_match, condition, block) => {
          const value = this.getNestedProperty(context, condition);
          const isTruthy = this.isTruthy(value);

          return isTruthy ? block : '';
        }
      );
    }

    return result;
  }

  /**
   * ループ処理
   *
   * @param content - コンテンツ
   * @param context - コンテキスト
   * @returns ループ処理後のコンテンツ
   */
  private processLoops(content: string, context: TemplateContext): string {
    // {{#each items}}...{{/each}} 形式のループを処理
    // ネストしたループに対応するため、バランスの取れたタグを探す
    let result = content;
    const eachStart = /\{\{#each\s+(\w+(?:\.\w+)*)\}\}/;
    let iterations = 0;
    const maxIterations = 100;

    while (iterations < maxIterations) {
      iterations++;
      const match = eachStart.exec(result);

      if (!match) {
        break;
      }

      const startPos = match.index;
      const arrayKey = match[1] as string;
      const headerLength = match[0].length;

      // バランスの取れた {{/each}} を探す
      let depth = 1;
      let pos = startPos + headerLength;
      let blockContent = '';

      while (pos < result.length && depth > 0) {
        if (result.substr(pos, 7) === '{{#each') {
          depth++;
        } else if (result.substr(pos, 9) === '{{/each}}') {
          depth--;
          if (depth === 0) {
            blockContent = result.substring(startPos + headerLength, pos);
            break;
          }
        }
        pos++;
      }

      if (depth !== 0) {
        // バランスが取れていない場合はスキップ
        break;
      }

      const array = this.getNestedProperty(context, arrayKey);

      if (!Array.isArray(array)) {
        result = result.substring(0, startPos) + result.substring(pos + 9);
        continue;
      }

      const expanded = array
        .map((item, index) => {
          // ループ内のコンテキストを作成
          const loopContext: TemplateContext = {
            ...context,
            '@index': index,
            '@first': index === 0,
            '@last': index === array.length - 1,
          };

          // itemがオブジェクトの場合、プロパティをコンテキストに追加
          if (typeof item === 'object' && item !== null) {
            Object.assign(loopContext, item);
          } else {
            // プリミティブ値の場合、{{this}}でアクセス可能にする
            loopContext.this = item;
          }

          // ネストしたループを再帰的に処理
          let itemResult = this.processLoops(blockContent, loopContext);
          // ループ内の条件分岐を処理
          itemResult = this.processConditionals(itemResult, loopContext);
          // 変数を置換
          itemResult = this.replaceVariables(itemResult, loopContext);

          return itemResult;
        })
        .join('');

      result = result.substring(0, startPos) + expanded + result.substring(pos + 9);
    }

    return result;
  }

  /**
   * ネストしたプロパティを取得
   *
   * @param obj - オブジェクト
   * @param path - プロパティパス（例: "user.address.city"）
   * @returns プロパティ値
   */
  private getNestedProperty(obj: Record<string, unknown>, path: string): unknown {
    const keys = path.split('.');
    let current: unknown = obj;

    for (const key of keys) {
      if (current === undefined || current === null) {
        return undefined;
      }

      if (typeof current === 'object' && current !== null && key in current) {
        current = (current as Record<string, unknown>)[key];
      } else {
        return undefined;
      }
    }

    return current;
  }

  /**
   * 真偽値判定
   *
   * @param value - 値
   * @returns 真偽値
   */
  private isTruthy(value: unknown): boolean {
    if (value === undefined || value === null) {
      return false;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      return value !== 0;
    }

    if (typeof value === 'string') {
      return value !== '';
    }

    if (Array.isArray(value)) {
      return value.length > 0;
    }

    return Boolean(value);
  }
}

// 名前付きエクスポート
export type { Template, TemplateContext };
