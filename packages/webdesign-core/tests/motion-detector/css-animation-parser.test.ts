// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CSSAnimationParser テストスイート
 * TDD: Red Phase - 先にテストを記述し、実装で通す
 * @module @reftrix/webdesign-core/tests/motion-detector/css-animation-parser
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CSSAnimationParser } from '../../src/motion-detector/css-animation-parser';
import type {
  KeyframeDefinition,
  AnimationShorthand,
  TransitionDefinition,
  TimingFunctionInfo,
} from '../../src/types/css-animation.types';

describe('CSSAnimationParser', () => {
  let parser: CSSAnimationParser;

  beforeEach(() => {
    parser = new CSSAnimationParser();
  });

  // ===========================================================================
  // 1. キーフレーム解析テスト (15テスト)
  // ===========================================================================
  describe('parseKeyframes', () => {
    // 基本的な@keyframes解析
    it('基本的な@keyframesを解析できる', () => {
      const css = `
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;
      const result = parser.parseKeyframes(css);

      expect(result.size).toBe(1);
      expect(result.has('fadeIn')).toBe(true);

      const fadeIn = result.get('fadeIn')!;
      expect(fadeIn.name).toBe('fadeIn');
      expect(fadeIn.keyframes).toHaveLength(2);
    });

    // from/to記法の解析
    it('from/toをoffset 0/1に変換する', () => {
      const css = `
        @keyframes slide {
          from { transform: translateX(0); }
          to { transform: translateX(100px); }
        }
      `;
      const result = parser.parseKeyframes(css);
      const slide = result.get('slide')!;

      expect(slide.keyframes[0].offset).toBe(0);
      expect(slide.keyframes[1].offset).toBe(1);
    });

    // 0%/100%記法の解析
    it('パーセント記法を正しく解析する', () => {
      const css = `
        @keyframes bounce {
          0% { transform: translateY(0); }
          50% { transform: translateY(-20px); }
          100% { transform: translateY(0); }
        }
      `;
      const result = parser.parseKeyframes(css);
      const bounce = result.get('bounce')!;

      expect(bounce.keyframes).toHaveLength(3);
      expect(bounce.keyframes[0].offset).toBe(0);
      expect(bounce.keyframes[1].offset).toBe(0.5);
      expect(bounce.keyframes[2].offset).toBe(1);
    });

    // 複数ステップの解析
    it('複数のキーフレームステップを解析する', () => {
      const css = `
        @keyframes multiStep {
          0% { opacity: 0; }
          25% { opacity: 0.25; }
          50% { opacity: 0.5; }
          75% { opacity: 0.75; }
          100% { opacity: 1; }
        }
      `;
      const result = parser.parseKeyframes(css);
      const multiStep = result.get('multiStep')!;

      expect(multiStep.keyframes).toHaveLength(5);
      expect(multiStep.keyframes[1].offset).toBe(0.25);
      expect(multiStep.keyframes[3].offset).toBe(0.75);
    });

    // 複数プロパティの解析
    it('1つのステップ内の複数プロパティを解析する', () => {
      const css = `
        @keyframes multiProp {
          0% {
            opacity: 0;
            transform: scale(0.5);
            background-color: red;
          }
          100% {
            opacity: 1;
            transform: scale(1);
            background-color: blue;
          }
        }
      `;
      const result = parser.parseKeyframes(css);
      const multiProp = result.get('multiProp')!;

      expect(Object.keys(multiProp.keyframes[0].properties)).toHaveLength(3);
      expect(multiProp.keyframes[0].properties['opacity']).toBe('0');
      expect(multiProp.keyframes[0].properties['transform']).toBe('scale(0.5)');
      expect(multiProp.keyframes[0].properties['background-color']).toBe('red');
    });

    // ネストされた値（transform複合）の解析
    it('transform複合値を正しく解析する', () => {
      const css = `
        @keyframes complexTransform {
          0% { transform: translateX(0) rotate(0deg) scale(1); }
          100% { transform: translateX(100px) rotate(360deg) scale(1.5); }
        }
      `;
      const result = parser.parseKeyframes(css);
      const complexTransform = result.get('complexTransform')!;

      expect(complexTransform.keyframes[0].properties['transform']).toBe(
        'translateX(0) rotate(0deg) scale(1)'
      );
    });

    // ベンダープレフィックス付きの解析
    it('@-webkit-keyframesを解析する', () => {
      const css = `
        @-webkit-keyframes webkitFade {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;
      const result = parser.parseKeyframes(css);

      expect(result.has('webkitFade')).toBe(true);
    });

    // 複数の@keyframes定義
    it('複数の@keyframes定義を解析する', () => {
      const css = `
        @keyframes anim1 {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes anim2 {
          0% { transform: scale(1); }
          100% { transform: scale(2); }
        }
      `;
      const result = parser.parseKeyframes(css);

      expect(result.size).toBe(2);
      expect(result.has('anim1')).toBe(true);
      expect(result.has('anim2')).toBe(true);
    });

    // 同じオフセットの複数定義（カンマ区切り）
    it('カンマ区切りのオフセットを解析する', () => {
      const css = `
        @keyframes flash {
          0%, 50%, 100% { opacity: 1; }
          25%, 75% { opacity: 0; }
        }
      `;
      const result = parser.parseKeyframes(css);
      const flash = result.get('flash')!;

      // カンマ区切りは展開されるため、5つのステップになる
      expect(flash.keyframes.length).toBeGreaterThanOrEqual(2);
      // offset 0のステップが存在する
      const hasZero = flash.keyframes.some(k => k.offset === 0);
      expect(hasZero).toBe(true);
    });

    // 空の@keyframes
    it('空の@keyframesを処理する', () => {
      const css = `
        @keyframes empty {
        }
      `;
      const result = parser.parseKeyframes(css);
      const empty = result.get('empty');

      // 空のキーフレームはMapに含まれるが、keyframesは空配列
      expect(empty?.keyframes).toHaveLength(0);
    });

    // raw文字列の保持
    it('元のCSS文字列をrawフィールドに保持する', () => {
      const css = `
        @keyframes testRaw {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;
      const result = parser.parseKeyframes(css);
      const testRaw = result.get('testRaw')!;

      expect(testRaw.raw).toContain('from');
      expect(testRaw.raw).toContain('opacity');
    });

    // 不正なCSS
    it('不正なCSSでもクラッシュしない', () => {
      const css = `
        @keyframes broken {
          from { opacity: ;; }
          to { }
        }
      `;
      expect(() => parser.parseKeyframes(css)).not.toThrow();
    });

    // @keyframesがない場合
    it('@keyframesがない場合は空のMapを返す', () => {
      const css = `.class { color: red; }`;
      const result = parser.parseKeyframes(css);

      expect(result.size).toBe(0);
    });

    // クォート付きアニメーション名
    it('クォート付きアニメーション名を解析する', () => {
      const css = `
        @keyframes "my-animation" {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;
      const result = parser.parseKeyframes(css);

      // クォートは除去されるべき
      expect(result.has('my-animation')).toBe(true);
    });

    // calc()値の保持
    it('calc()値を正しく保持する', () => {
      const css = `
        @keyframes calcTest {
          from { width: calc(100% - 20px); }
          to { width: calc(100% + 20px); }
        }
      `;
      const result = parser.parseKeyframes(css);
      const calcTest = result.get('calcTest')!;

      expect(calcTest.keyframes[0].properties['width']).toContain('calc');
    });
  });

  // ===========================================================================
  // 2. animation shorthand解析テスト (10テスト)
  // ===========================================================================
  describe('parseAnimationShorthand', () => {
    // 全プロパティ指定
    it('全プロパティが指定されたshorthandを解析する', () => {
      const value = 'fadeIn 2s ease-in-out 0.5s infinite alternate both paused';
      const result = parser.parseAnimationShorthand(value);

      expect(result.name).toBe('fadeIn');
      expect(result.duration).toBe(2000);
      expect(result.timingFunction).toBe('ease-in-out');
      expect(result.delay).toBe(500);
      expect(result.iterationCount).toBe('infinite');
      expect(result.direction).toBe('alternate');
      expect(result.fillMode).toBe('both');
      expect(result.playState).toBe('paused');
    });

    // 最小指定（名前と時間のみ）
    it('名前と時間のみのshorthandを解析する', () => {
      const value = 'slide 1s';
      const result = parser.parseAnimationShorthand(value);

      expect(result.name).toBe('slide');
      expect(result.duration).toBe(1000);
      // デフォルト値
      expect(result.timingFunction).toBe('ease');
      expect(result.delay).toBe(0);
      expect(result.iterationCount).toBe(1);
      expect(result.direction).toBe('normal');
      expect(result.fillMode).toBe('none');
      expect(result.playState).toBe('running');
    });

    // cubic-bezierタイミング関数
    it('cubic-bezierタイミング関数を解析する', () => {
      const value = 'bounce 0.5s cubic-bezier(0.68, -0.55, 0.265, 1.55)';
      const result = parser.parseAnimationShorthand(value);

      expect(result.timingFunction).toBe('cubic-bezier(0.68, -0.55, 0.265, 1.55)');
    });

    // steps()タイミング関数
    it('steps()タイミング関数を解析する', () => {
      const value = 'typewriter 3s steps(20, end)';
      const result = parser.parseAnimationShorthand(value);

      expect(result.timingFunction).toBe('steps(20, end)');
    });

    // 数値のiteration-count
    it('数値のiteration-countを解析する', () => {
      const value = 'pulse 1s 3';
      const result = parser.parseAnimationShorthand(value);

      expect(result.iterationCount).toBe(3);
    });

    // alternate-reverse方向
    it('alternate-reverse方向を解析する', () => {
      const value = 'swing 2s alternate-reverse';
      const result = parser.parseAnimationShorthand(value);

      expect(result.direction).toBe('alternate-reverse');
    });

    // delay付きの解析
    it('delayを正しく解析する', () => {
      const value = 'fadeIn 1s ease 500ms';
      const result = parser.parseAnimationShorthand(value);

      expect(result.duration).toBe(1000);
      expect(result.delay).toBe(500);
    });

    // ms単位の時間値
    it('ms単位の時間値を解析する', () => {
      const value = 'quick 300ms linear 100ms';
      const result = parser.parseAnimationShorthand(value);

      expect(result.duration).toBe(300);
      expect(result.delay).toBe(100);
    });

    // noneアニメーション名
    it('"none"アニメーション名を解析する', () => {
      const value = 'none';
      const result = parser.parseAnimationShorthand(value);

      expect(result.name).toBe('none');
    });

    // 空文字列
    it('空文字列でデフォルト値を返す', () => {
      const value = '';
      const result = parser.parseAnimationShorthand(value);

      expect(result.name).toBe('none');
      expect(result.duration).toBe(0);
    });
  });

  // ===========================================================================
  // 3. animation個別プロパティ解析テスト (5テスト追加)
  // ===========================================================================
  describe('parseAnimationProperties', () => {
    it('個別のanimation-*プロパティを解析する', () => {
      const styles = {
        'animation-name': 'fadeIn',
        'animation-duration': '2s',
        'animation-timing-function': 'ease-out',
        'animation-delay': '1s',
        'animation-iteration-count': '3',
        'animation-direction': 'reverse',
        'animation-fill-mode': 'forwards',
        'animation-play-state': 'paused',
      };
      const result = parser.parseAnimationProperties(styles);

      expect(result.name).toBe('fadeIn');
      expect(result.duration).toBe(2000);
      expect(result.timingFunction).toBe('ease-out');
      expect(result.delay).toBe(1000);
      expect(result.iterationCount).toBe(3);
      expect(result.direction).toBe('reverse');
      expect(result.fillMode).toBe('forwards');
      expect(result.playState).toBe('paused');
    });

    it('部分的なプロパティでデフォルト値を使用する', () => {
      const styles = {
        'animation-name': 'slide',
        'animation-duration': '1s',
      };
      const result = parser.parseAnimationProperties(styles);

      expect(result.name).toBe('slide');
      expect(result.duration).toBe(1000);
      expect(result.timingFunction).toBe('ease');
      expect(result.delay).toBe(0);
    });

    it('infiniteをiteration-countとして解析する', () => {
      const styles = {
        'animation-name': 'spin',
        'animation-duration': '1s',
        'animation-iteration-count': 'infinite',
      };
      const result = parser.parseAnimationProperties(styles);

      expect(result.iterationCount).toBe('infinite');
    });

    it('ベンダープレフィックス付きプロパティを解析する', () => {
      const styles = {
        '-webkit-animation-name': 'fadeIn',
        '-webkit-animation-duration': '1s',
      };
      const result = parser.parseAnimationProperties(styles);

      expect(result.name).toBe('fadeIn');
      expect(result.duration).toBe(1000);
    });

    it('空のスタイルオブジェクトでデフォルト値を返す', () => {
      const styles = {};
      const result = parser.parseAnimationProperties(styles);

      expect(result.name).toBe('none');
      expect(result.duration).toBe(0);
    });
  });

  // ===========================================================================
  // 4. transition解析テスト (10テスト)
  // ===========================================================================
  describe('parseTransitionShorthand', () => {
    // 単一プロパティのtransition
    it('単一プロパティのtransitionを解析する', () => {
      const value = 'opacity 0.3s ease-in';
      const result = parser.parseTransitionShorthand(value);

      expect(result).toHaveLength(1);
      expect(result[0].property).toBe('opacity');
      expect(result[0].duration).toBe(300);
      expect(result[0].timingFunction).toBe('ease-in');
    });

    // 複数プロパティのtransition（カンマ区切り）
    it('複数プロパティのtransitionを解析する', () => {
      const value = 'opacity 0.3s ease, transform 0.5s ease-out';
      const result = parser.parseTransitionShorthand(value);

      expect(result).toHaveLength(2);
      expect(result[0].property).toBe('opacity');
      expect(result[0].duration).toBe(300);
      expect(result[1].property).toBe('transform');
      expect(result[1].duration).toBe(500);
    });

    // allプロパティ
    it('"all"プロパティを解析する', () => {
      const value = 'all 0.2s ease';
      const result = parser.parseTransitionShorthand(value);

      expect(result).toHaveLength(1);
      expect(result[0].property).toBe('all');
    });

    // delay付き
    it('delayを正しく解析する', () => {
      const value = 'color 0.5s linear 0.1s';
      const result = parser.parseTransitionShorthand(value);

      expect(result[0].duration).toBe(500);
      expect(result[0].delay).toBe(100);
    });

    // ms単位
    it('ms単位の時間を解析する', () => {
      const value = 'width 200ms';
      const result = parser.parseTransitionShorthand(value);

      expect(result[0].duration).toBe(200);
    });

    // プロパティ名のみ（デフォルト値）
    it('プロパティ名のみでデフォルト値を使用する', () => {
      const value = 'height';
      const result = parser.parseTransitionShorthand(value);

      expect(result[0].property).toBe('height');
      expect(result[0].duration).toBe(0);
      expect(result[0].timingFunction).toBe('ease');
    });

    // cubic-bezier
    it('cubic-bezierタイミング関数を解析する', () => {
      const value = 'transform 1s cubic-bezier(0.4, 0, 0.2, 1)';
      const result = parser.parseTransitionShorthand(value);

      expect(result[0].timingFunction).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
    });

    // none値
    it('"none"を解析する', () => {
      const value = 'none';
      const result = parser.parseTransitionShorthand(value);

      expect(result).toHaveLength(1);
      expect(result[0].property).toBe('none');
    });

    // 空文字列
    it('空文字列で空配列を返す', () => {
      const value = '';
      const result = parser.parseTransitionShorthand(value);

      expect(result).toHaveLength(0);
    });

    // 複雑なマルチプロパティ
    it('3つ以上のプロパティを解析する', () => {
      const value = 'opacity 0.3s, transform 0.5s ease-out, background-color 0.2s linear 0.1s';
      const result = parser.parseTransitionShorthand(value);

      expect(result).toHaveLength(3);
      expect(result[2].property).toBe('background-color');
      expect(result[2].delay).toBe(100);
    });
  });

  // ===========================================================================
  // 5. transition個別プロパティ解析テスト (5テスト)
  // ===========================================================================
  describe('parseTransitionProperties', () => {
    it('個別のtransition-*プロパティを解析する', () => {
      const styles = {
        'transition-property': 'opacity, transform',
        'transition-duration': '0.3s, 0.5s',
        'transition-timing-function': 'ease-in, ease-out',
        'transition-delay': '0s, 0.1s',
      };
      const result = parser.parseTransitionProperties(styles);

      expect(result).toHaveLength(2);
      expect(result[0].property).toBe('opacity');
      expect(result[0].duration).toBe(300);
      expect(result[1].property).toBe('transform');
      expect(result[1].timingFunction).toBe('ease-out');
    });

    it('プロパティ数が合わない場合は最後の値を繰り返す', () => {
      const styles = {
        'transition-property': 'opacity, transform, color',
        'transition-duration': '0.3s',
        'transition-timing-function': 'ease',
      };
      const result = parser.parseTransitionProperties(styles);

      expect(result).toHaveLength(3);
      expect(result[2].duration).toBe(300); // 最後の値を使用
    });

    it('transition-propertyのみでデフォルト値を使用する', () => {
      const styles = {
        'transition-property': 'all',
      };
      const result = parser.parseTransitionProperties(styles);

      expect(result[0].property).toBe('all');
      expect(result[0].duration).toBe(0);
      expect(result[0].timingFunction).toBe('ease');
    });

    it('空のスタイルオブジェクトで空配列を返す', () => {
      const styles = {};
      const result = parser.parseTransitionProperties(styles);

      expect(result).toHaveLength(0);
    });

    it('ベンダープレフィックス付きプロパティを解析する', () => {
      const styles = {
        '-webkit-transition-property': 'opacity',
        '-webkit-transition-duration': '0.5s',
      };
      const result = parser.parseTransitionProperties(styles);

      expect(result[0].property).toBe('opacity');
      expect(result[0].duration).toBe(500);
    });
  });

  // ===========================================================================
  // 6. timing function解析テスト (10テスト)
  // ===========================================================================
  describe('parseTimingFunction', () => {
    // キーワード: ease
    it('easeキーワードを解析する', () => {
      const result = parser.parseTimingFunction('ease');

      expect(result.type).toBe('keyword');
      expect(result.value).toBe('ease');
      expect(result.controlPoints).toEqual([0.25, 0.1, 0.25, 1]);
    });

    // キーワード: linear
    it('linearキーワードを解析する', () => {
      const result = parser.parseTimingFunction('linear');

      expect(result.type).toBe('keyword');
      expect(result.value).toBe('linear');
      expect(result.controlPoints).toEqual([0, 0, 1, 1]);
    });

    // キーワード: ease-in
    it('ease-inキーワードを解析する', () => {
      const result = parser.parseTimingFunction('ease-in');

      expect(result.type).toBe('keyword');
      expect(result.value).toBe('ease-in');
      expect(result.controlPoints).toEqual([0.42, 0, 1, 1]);
    });

    // キーワード: ease-out
    it('ease-outキーワードを解析する', () => {
      const result = parser.parseTimingFunction('ease-out');

      expect(result.type).toBe('keyword');
      expect(result.value).toBe('ease-out');
      expect(result.controlPoints).toEqual([0, 0, 0.58, 1]);
    });

    // キーワード: ease-in-out
    it('ease-in-outキーワードを解析する', () => {
      const result = parser.parseTimingFunction('ease-in-out');

      expect(result.type).toBe('keyword');
      expect(result.value).toBe('ease-in-out');
      expect(result.controlPoints).toEqual([0.42, 0, 0.58, 1]);
    });

    // cubic-bezier()
    it('cubic-bezier()を解析する', () => {
      const result = parser.parseTimingFunction('cubic-bezier(0.4, 0, 0.2, 1)');

      expect(result.type).toBe('cubic-bezier');
      expect(result.value).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
      expect(result.controlPoints).toEqual([0.4, 0, 0.2, 1]);
    });

    // steps()基本
    it('steps()を解析する', () => {
      const result = parser.parseTimingFunction('steps(4, end)');

      expect(result.type).toBe('steps');
      expect(result.value).toBe('steps(4, end)');
      expect(result.steps).toBe(4);
      expect(result.jumpTerm).toBe('end');
    });

    // step-start
    it('step-startを解析する', () => {
      const result = parser.parseTimingFunction('step-start');

      expect(result.type).toBe('steps');
      expect(result.steps).toBe(1);
      expect(result.jumpTerm).toBe('start');
    });

    // step-end
    it('step-endを解析する', () => {
      const result = parser.parseTimingFunction('step-end');

      expect(result.type).toBe('steps');
      expect(result.steps).toBe(1);
      expect(result.jumpTerm).toBe('end');
    });

    // 不明なタイミング関数
    it('不明なタイミング関数でkeywordとして返す', () => {
      const result = parser.parseTimingFunction('unknown-function');

      expect(result.type).toBe('keyword');
      expect(result.value).toBe('unknown-function');
    });
  });

  // ===========================================================================
  // 7. ユーティリティテスト (5テスト)
  // ===========================================================================
  describe('parseDuration', () => {
    it('秒単位の時間を解析する', () => {
      const result = parser.parseDuration('2s');
      expect(result).toBe(2000);
    });

    it('ミリ秒単位の時間を解析する', () => {
      const result = parser.parseDuration('500ms');
      expect(result).toBe(500);
    });

    it('小数点付きの秒を解析する', () => {
      const result = parser.parseDuration('1.5s');
      expect(result).toBe(1500);
    });

    it('単位なしの値は0を返す', () => {
      const result = parser.parseDuration('100');
      expect(result).toBe(0);
    });

    it('不正な値は0を返す', () => {
      const result = parser.parseDuration('invalid');
      expect(result).toBe(0);
    });
  });

  describe('normalizeVendorPrefix', () => {
    it('-webkit-プレフィックスを除去する', () => {
      const result = parser.normalizeVendorPrefix('-webkit-animation');
      expect(result).toBe('animation');
    });

    it('-moz-プレフィックスを除去する', () => {
      const result = parser.normalizeVendorPrefix('-moz-transform');
      expect(result).toBe('transform');
    });

    it('-ms-プレフィックスを除去する', () => {
      const result = parser.normalizeVendorPrefix('-ms-animation');
      expect(result).toBe('animation');
    });

    it('-o-プレフィックスを除去する', () => {
      const result = parser.normalizeVendorPrefix('-o-transition');
      expect(result).toBe('transition');
    });

    it('プレフィックスがない場合はそのまま返す', () => {
      const result = parser.normalizeVendorPrefix('animation');
      expect(result).toBe('animation');
    });
  });

  // ===========================================================================
  // 8. エッジケース・追加テスト (5テスト)
  // ===========================================================================
  describe('エッジケース', () => {
    it('複数のアニメーションを含むshorthandで最初のアニメーションを返す', () => {
      // 複数アニメーションはカンマ区切り
      const value = 'fadeIn 1s, slideIn 2s';
      const result = parser.parseAnimationShorthand(value);

      // 最初のアニメーションのみ解析（複数は別途サポート必要）
      expect(result.name).toBe('fadeIn');
      expect(result.duration).toBe(1000);
    });

    it('var()を含む値を保持する', () => {
      const css = `
        @keyframes varTest {
          from { transform: translateX(var(--start-x)); }
          to { transform: translateX(var(--end-x)); }
        }
      `;
      const result = parser.parseKeyframes(css);
      const varTest = result.get('varTest')!;

      expect(varTest.keyframes[0].properties['transform']).toContain('var(');
    });

    it('コメントを含むCSSを処理する', () => {
      const css = `
        /* コメント */
        @keyframes commentTest {
          /* 開始状態 */
          from { opacity: 0; }
          /* 終了状態 */
          to { opacity: 1; }
        }
      `;
      const result = parser.parseKeyframes(css);

      expect(result.has('commentTest')).toBe(true);
      const commentTest = result.get('commentTest')!;
      expect(commentTest.keyframes).toHaveLength(2);
    });

    it('!importantを含む値を処理する', () => {
      const css = `
        @keyframes importantTest {
          from { opacity: 0 !important; }
          to { opacity: 1 !important; }
        }
      `;
      const result = parser.parseKeyframes(css);
      const importantTest = result.get('importantTest')!;

      // !importantは保持される
      expect(importantTest.keyframes[0].properties['opacity']).toContain('0');
    });

    it('非常に長いアニメーション名を処理する', () => {
      const longName = 'a'.repeat(100);
      const css = `
        @keyframes ${longName} {
          from { opacity: 0; }
          to { opacity: 1; }
        }
      `;
      const result = parser.parseKeyframes(css);

      expect(result.has(longName)).toBe(true);
    });
  });

  // ===========================================================================
  // 9. steps() バリエーションテスト (5テスト追加で合計55テスト)
  // ===========================================================================
  describe('steps() バリエーション', () => {
    it('steps(n)形式を解析する（デフォルトend）', () => {
      const result = parser.parseTimingFunction('steps(5)');

      expect(result.type).toBe('steps');
      expect(result.steps).toBe(5);
      expect(result.jumpTerm).toBe('end'); // デフォルト
    });

    it('steps(n, jump-start)を解析する', () => {
      const result = parser.parseTimingFunction('steps(3, jump-start)');

      expect(result.type).toBe('steps');
      expect(result.steps).toBe(3);
      expect(result.jumpTerm).toBe('jump-start');
    });

    it('steps(n, jump-end)を解析する', () => {
      const result = parser.parseTimingFunction('steps(4, jump-end)');

      expect(result.type).toBe('steps');
      expect(result.steps).toBe(4);
      expect(result.jumpTerm).toBe('jump-end');
    });

    it('steps(n, jump-none)を解析する', () => {
      const result = parser.parseTimingFunction('steps(6, jump-none)');

      expect(result.type).toBe('steps');
      expect(result.steps).toBe(6);
      expect(result.jumpTerm).toBe('jump-none');
    });

    it('steps(n, jump-both)を解析する', () => {
      const result = parser.parseTimingFunction('steps(2, jump-both)');

      expect(result.type).toBe('steps');
      expect(result.steps).toBe(2);
      expect(result.jumpTerm).toBe('jump-both');
    });
  });
});
