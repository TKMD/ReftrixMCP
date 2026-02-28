// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSSアニメーション解析パーサー
 * @keyframes、animation、transitionプロパティを解析する
 * @module @reftrix/webdesign-core/motion-detector/css-animation-parser
 */

import postcss, { type AtRule, type Declaration } from 'postcss';
import valueParser from 'postcss-value-parser';

import type {
  AnimationDirection,
  AnimationFillMode,
  AnimationPlayState,
  AnimationShorthand,
  KeyframeDefinition,
  KeyframeStep,
  StepsJumpTerm,
  TimingFunctionInfo,
  TransitionDefinition,
} from '../types/css-animation.types';

import {
  ANIMATION_DIRECTION_VALUES,
  ANIMATION_FILL_MODE_VALUES,
  ANIMATION_PLAY_STATE_VALUES,
  CSS_ANIMATION_DEFAULTS,
  CSS_TRANSITION_DEFAULTS,
  TIMING_FUNCTION_KEYWORDS,
  VENDOR_PREFIXES,
} from '../types/css-animation.types';

// 開発環境ログ出力フラグ
const isDev = process.env.NODE_ENV === 'development';

/**
 * CSSアニメーション解析パーサー
 * postcssとpostcss-value-parserを使用してCSSアニメーションを解析する
 */
export class CSSAnimationParser {
  /**
   * CSS文字列から@keyframes定義を解析する
   * @param css - CSS文字列
   * @returns キーフレーム名とその定義のMap
   */
  parseKeyframes(css: string): Map<string, KeyframeDefinition> {
    const result = new Map<string, KeyframeDefinition>();

    try {
      const root = postcss.parse(css);
      root.walkAtRules((atRule: AtRule) => {
        // @keyframesまたは@-webkit-keyframesなどを処理
        const ruleName = this.normalizeVendorPrefix(atRule.name);
        if (ruleName !== 'keyframes') {
          return;
        }

        // アニメーション名を取得（クォートを除去）
        const name = atRule.params.replace(/^["']|["']$/g, '');
        const keyframes: KeyframeStep[] = [];

        // キーフレームルールを解析
        atRule.walkRules((rule) => {
          // セレクタからオフセット値を抽出（カンマ区切りの場合は複数）
          const offsets = this.parseKeyframeSelectors(rule.selector);
          const properties: Record<string, string> = {};

          // 各宣言を取得
          rule.walkDecls((decl: Declaration) => {
            properties[decl.prop] = decl.value;
          });

          // 各オフセットに対してキーフレームステップを追加
          for (const offset of offsets) {
            keyframes.push({
              offset,
              properties: { ...properties },
            });
          }
        });

        // オフセット値でソート
        keyframes.sort((a, b) => a.offset - b.offset);

        // 元のCSSテキストを保持
        const raw = atRule.toString();

        result.set(name, { name, keyframes, raw });

        if (isDev) {
          // eslint-disable-next-line no-console -- Intentional debug log in development
          console.log(`[CSSAnimationParser] Parsed keyframes: ${name}, steps: ${keyframes.length}`);
        }
      });
    } catch (error) {
      // パースエラーでもクラッシュしない
      if (isDev) {
        console.warn('[CSSAnimationParser] Failed to parse CSS:', error);
      }
    }

    return result;
  }

  /**
   * キーフレームセレクタをオフセット値の配列に変換する
   * @param selector - キーフレームセレクタ（"from", "to", "50%", "0%, 100%"など）
   * @returns オフセット値の配列（0-1）
   */
  private parseKeyframeSelectors(selector: string): number[] {
    const parts = selector.split(',').map((s) => s.trim());
    const offsets: number[] = [];

    for (const part of parts) {
      if (part === 'from') {
        offsets.push(0);
      } else if (part === 'to') {
        offsets.push(1);
      } else if (part.endsWith('%')) {
        const value = parseFloat(part);
        if (!isNaN(value)) {
          offsets.push(value / 100);
        }
      }
    }

    return offsets;
  }

  /**
   * animation shorthandプロパティを解析する
   * @param value - animation shorthand値
   * @returns 解析されたAnimationShorthand
   */
  parseAnimationShorthand(value: string): AnimationShorthand {
    const result: AnimationShorthand = { ...CSS_ANIMATION_DEFAULTS };

    if (!value || value.trim() === '') {
      return result;
    }

    // 複数アニメーションの場合は最初のもののみ処理
    // カンマで分割するときに関数内のカンマを無視する
    const animations = this.splitByComma(value);
    const firstAnimation = animations[0]?.trim() ?? '';
    if (!firstAnimation) {
      return result;
    }
    const parsed = valueParser(firstAnimation);

    // 時間値のカウント（最初がduration、2番目がdelay）
    let timeCount = 0;
    // 名前が設定されたかどうか
    let nameSet = false;

    parsed.walk((node) => {
      if (node.type === 'word') {
        const word = node.value;

        // 時間値かどうか確認
        if (this.isTimeValue(word)) {
          const ms = this.parseDuration(word);
          if (timeCount === 0) {
            result.duration = ms;
          } else {
            result.delay = ms;
          }
          timeCount++;
          return;
        }

        // infiniteまたは数値のiteration-count
        if (word === 'infinite') {
          result.iterationCount = 'infinite';
          return;
        }

        const numValue = parseFloat(word);
        if (!isNaN(numValue) && numValue >= 0) {
          result.iterationCount = numValue;
          return;
        }

        // タイミング関数キーワード
        if (TIMING_FUNCTION_KEYWORDS[word]) {
          result.timingFunction = word;
          return;
        }

        // direction
        if (ANIMATION_DIRECTION_VALUES.includes(word as AnimationDirection)) {
          result.direction = word as AnimationDirection;
          return;
        }

        // fill-mode
        if (ANIMATION_FILL_MODE_VALUES.includes(word as AnimationFillMode)) {
          result.fillMode = word as AnimationFillMode;
          return;
        }

        // play-state
        if (ANIMATION_PLAY_STATE_VALUES.includes(word as AnimationPlayState)) {
          result.playState = word as AnimationPlayState;
          return;
        }

        // それ以外はアニメーション名として扱う（最初の不明な単語のみ）
        if (!nameSet) {
          result.name = word;
          nameSet = true;
        }
      } else if (node.type === 'function') {
        // cubic-bezier()やsteps()
        const funcValue = valueParser.stringify(node);

        if (node.value === 'cubic-bezier' || node.value === 'steps') {
          result.timingFunction = funcValue;
        }
      }
    });

    if (isDev) {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[CSSAnimationParser] Parsed animation shorthand:', result);
    }

    return result;
  }

  /**
   * 個別のanimation-*プロパティを解析する
   * @param styles - CSSプロパティと値のマップ
   * @returns 解析されたAnimationShorthand
   */
  parseAnimationProperties(styles: Record<string, string>): AnimationShorthand {
    const result: AnimationShorthand = { ...CSS_ANIMATION_DEFAULTS };

    // ベンダープレフィックスを正規化したプロパティを取得
    const normalizedStyles: Record<string, string> = {};
    for (const [key, value] of Object.entries(styles)) {
      const normalizedKey = this.normalizeVendorPrefix(key);
      normalizedStyles[normalizedKey] = value;
    }

    // animation-name
    if (normalizedStyles['animation-name']) {
      result.name = normalizedStyles['animation-name'];
    }

    // animation-duration
    if (normalizedStyles['animation-duration']) {
      result.duration = this.parseDuration(normalizedStyles['animation-duration']);
    }

    // animation-timing-function
    if (normalizedStyles['animation-timing-function']) {
      result.timingFunction = normalizedStyles['animation-timing-function'];
    }

    // animation-delay
    if (normalizedStyles['animation-delay']) {
      result.delay = this.parseDuration(normalizedStyles['animation-delay']);
    }

    // animation-iteration-count
    if (normalizedStyles['animation-iteration-count']) {
      const count = normalizedStyles['animation-iteration-count'];
      if (count === 'infinite') {
        result.iterationCount = 'infinite';
      } else {
        const num = parseFloat(count);
        if (!isNaN(num)) {
          result.iterationCount = num;
        }
      }
    }

    // animation-direction
    if (normalizedStyles['animation-direction']) {
      const dir = normalizedStyles['animation-direction'] as AnimationDirection;
      if (ANIMATION_DIRECTION_VALUES.includes(dir)) {
        result.direction = dir;
      }
    }

    // animation-fill-mode
    if (normalizedStyles['animation-fill-mode']) {
      const fill = normalizedStyles['animation-fill-mode'] as AnimationFillMode;
      if (ANIMATION_FILL_MODE_VALUES.includes(fill)) {
        result.fillMode = fill;
      }
    }

    // animation-play-state
    if (normalizedStyles['animation-play-state']) {
      const state = normalizedStyles['animation-play-state'] as AnimationPlayState;
      if (ANIMATION_PLAY_STATE_VALUES.includes(state)) {
        result.playState = state;
      }
    }

    return result;
  }

  /**
   * transition shorthandプロパティを解析する
   * @param value - transition shorthand値
   * @returns 解析されたTransitionDefinition配列
   */
  parseTransitionShorthand(value: string): TransitionDefinition[] {
    const result: TransitionDefinition[] = [];

    if (!value || value.trim() === '') {
      return result;
    }

    // カンマで分割して各トランジションを処理
    const transitions = this.splitByComma(value);

    for (const transition of transitions) {
      const parsed = valueParser(transition.trim());
      const def: TransitionDefinition = { ...CSS_TRANSITION_DEFAULTS };

      let timeCount = 0;
      let propertySet = false;

      parsed.walk((node) => {
        if (node.type === 'word') {
          const word = node.value;

          // 時間値
          if (this.isTimeValue(word)) {
            const ms = this.parseDuration(word);
            if (timeCount === 0) {
              def.duration = ms;
            } else {
              def.delay = ms;
            }
            timeCount++;
            return;
          }

          // タイミング関数キーワード
          if (TIMING_FUNCTION_KEYWORDS[word]) {
            def.timingFunction = word;
            return;
          }

          // それ以外はプロパティ名
          if (!propertySet) {
            def.property = word;
            propertySet = true;
          }
        } else if (node.type === 'function') {
          // cubic-bezier()
          if (node.value === 'cubic-bezier') {
            def.timingFunction = valueParser.stringify(node);
          }
        }
      });

      result.push(def);
    }

    if (isDev) {
      // eslint-disable-next-line no-console -- Intentional debug log in development
      console.log('[CSSAnimationParser] Parsed transition shorthand:', result);
    }

    return result;
  }

  /**
   * 個別のtransition-*プロパティを解析する
   * @param styles - CSSプロパティと値のマップ
   * @returns 解析されたTransitionDefinition配列
   */
  parseTransitionProperties(styles: Record<string, string>): TransitionDefinition[] {
    // ベンダープレフィックスを正規化
    const normalizedStyles: Record<string, string> = {};
    for (const [key, value] of Object.entries(styles)) {
      const normalizedKey = this.normalizeVendorPrefix(key);
      normalizedStyles[normalizedKey] = value;
    }

    // transition-propertyがなければ空配列
    if (!normalizedStyles['transition-property']) {
      return [];
    }

    // 各プロパティをカンマで分割
    const properties = this.splitByComma(normalizedStyles['transition-property']);
    const durations = normalizedStyles['transition-duration']
      ? this.splitByComma(normalizedStyles['transition-duration'])
      : ['0s'];
    const timingFunctions = normalizedStyles['transition-timing-function']
      ? this.splitByComma(normalizedStyles['transition-timing-function'])
      : ['ease'];
    const delays = normalizedStyles['transition-delay']
      ? this.splitByComma(normalizedStyles['transition-delay'])
      : ['0s'];

    const result: TransitionDefinition[] = [];

    for (let i = 0; i < properties.length; i++) {
      const prop = properties[i];
      if (prop === undefined) continue;
      result.push({
        property: prop.trim(),
        duration: this.parseDuration(this.getValueAtIndex(durations, i)),
        timingFunction: this.getValueAtIndex(timingFunctions, i).trim(),
        delay: this.parseDuration(this.getValueAtIndex(delays, i)),
      });
    }

    return result;
  }

  /**
   * タイミング関数を解析する
   * @param value - タイミング関数の値
   * @returns 解析されたTimingFunctionInfo
   */
  parseTimingFunction(value: string): TimingFunctionInfo {
    const trimmed = value.trim();

    // step-start / step-end
    if (trimmed === 'step-start') {
      return {
        type: 'steps',
        value: trimmed,
        steps: 1,
        jumpTerm: 'start',
      };
    }

    if (trimmed === 'step-end') {
      return {
        type: 'steps',
        value: trimmed,
        steps: 1,
        jumpTerm: 'end',
      };
    }

    // キーワード
    if (TIMING_FUNCTION_KEYWORDS[trimmed]) {
      return {
        type: 'keyword',
        value: trimmed,
        controlPoints: TIMING_FUNCTION_KEYWORDS[trimmed],
      };
    }

    // 関数形式をパース
    const parsed = valueParser(trimmed);
    let result: TimingFunctionInfo | null = null;

    parsed.walk((node) => {
      if (node.type === 'function') {
        if (node.value === 'cubic-bezier') {
          const args: number[] = [];
          node.nodes.forEach((n) => {
            if (n.type === 'word') {
              const num = parseFloat(n.value);
              if (!isNaN(num)) {
                args.push(num);
              }
            }
          });

          if (args.length === 4) {
            result = {
              type: 'cubic-bezier',
              value: valueParser.stringify(node),
              controlPoints: args as [number, number, number, number],
            };
          }
        } else if (node.value === 'steps') {
          const args: (number | string)[] = [];
          node.nodes.forEach((n) => {
            if (n.type === 'word') {
              const num = parseInt(n.value, 10);
              if (!isNaN(num)) {
                args.push(num);
              } else {
                args.push(n.value);
              }
            }
          });

          const steps = typeof args[0] === 'number' ? args[0] : 1;
          let jumpTerm: StepsJumpTerm = 'end'; // デフォルト

          if (args.length > 1 && typeof args[1] === 'string') {
            jumpTerm = args[1] as StepsJumpTerm;
          }

          result = {
            type: 'steps',
            value: valueParser.stringify(node),
            steps,
            jumpTerm,
          };
        }
      }
    });

    if (result) {
      return result;
    }

    // 不明な値はkeywordとして返す
    return {
      type: 'keyword',
      value: trimmed,
    };
  }

  /**
   * 時間値（s/ms）をミリ秒に変換する
   * @param value - 時間値文字列
   * @returns ミリ秒
   */
  parseDuration(value: string): number {
    const trimmed = value.trim();

    if (trimmed.endsWith('ms')) {
      const num = parseFloat(trimmed);
      return isNaN(num) ? 0 : num;
    }

    if (trimmed.endsWith('s')) {
      const num = parseFloat(trimmed);
      return isNaN(num) ? 0 : num * 1000;
    }

    // 単位なしまたは不正な値
    return 0;
  }

  /**
   * ベンダープレフィックスを除去する
   * @param property - CSSプロパティ名
   * @returns 正規化されたプロパティ名
   */
  normalizeVendorPrefix(property: string): string {
    for (const prefix of VENDOR_PREFIXES) {
      if (property.startsWith(prefix)) {
        return property.slice(prefix.length);
      }
    }
    return property;
  }

  /**
   * 値が時間値かどうか判定する
   * @param value - 値文字列
   * @returns 時間値ならtrue
   */
  private isTimeValue(value: string): boolean {
    return /^\d+(\.\d+)?(s|ms)$/.test(value);
  }

  /**
   * カンマで文字列を分割する（関数内のカンマは無視）
   * @param value - 分割する文字列
   * @returns 分割された文字列配列
   */
  private splitByComma(value: string): string[] {
    const result: string[] = [];
    let current = '';
    let depth = 0;

    for (const char of value) {
      if (char === '(') {
        depth++;
        current += char;
      } else if (char === ')') {
        depth--;
        current += char;
      } else if (char === ',' && depth === 0) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      result.push(current.trim());
    }

    return result;
  }

  /**
   * 配列から指定インデックスの値を取得（範囲外なら最後の要素）
   * @param arr - 配列
   * @param index - インデックス
   * @returns 値
   */
  private getValueAtIndex(arr: string[], index: number): string {
    if (index < arr.length) {
      return arr[index] ?? '';
    }
    return arr[arr.length - 1] ?? '';
  }
}
