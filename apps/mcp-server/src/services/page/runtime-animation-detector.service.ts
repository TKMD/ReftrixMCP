// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RuntimeAnimationDetectorService
 * Playwrightを使用したJavaScript駆動アニメーションの実行時検出サービス
 *
 * 機能:
 * - Element.getAnimations() によるWeb Animations API検出
 * - IntersectionObserver使用状況の検出
 * - requestAnimationFrame コールバックの監視
 * - スクロール位置別のアニメーショントリガー検出
 *
 * Phase2: JS実行時解析 - ブラウザコンテキストでの動的検出
 *
 * @module services/page/runtime-animation-detector.service
 */

/* eslint-disable no-undef -- page.evaluate() runs in browser context where window/document exist */

import type { Page } from 'playwright';
import { logger, isDevelopment } from '../../utils/logger';

// グローバルWindow型拡張をインポート（ブラウザコンテキストのカスタムプロパティ用）
import '../../types/reftrix-window';

// =====================================================
// 型定義
// =====================================================

/**
 * アニメーションタイプ
 */
export type AnimationType = 'css_animation' | 'web_animations_api' | 'css_transition';

/**
 * アニメーション情報
 */
export interface AnimationInfo {
  /** 一意識別子 */
  id: string;
  /** アニメーションタイプ */
  type: AnimationType;
  /** 再生状態 */
  playState: 'idle' | 'running' | 'paused' | 'finished';
  /** アニメーション時間（ms） */
  duration: number;
  /** 繰り返し回数 */
  iterations: number;
  /** イージング関数 */
  easing: string;
  /** ターゲット要素のCSSセレクタ */
  targetSelector: string;
  /** アニメーション名（@keyframesまたはElement.animate） */
  animationName?: string;
  /** アニメーション対象プロパティ */
  properties?: string[];
  /** アニメーション方向 */
  direction?: string;
  /** フィルモード */
  fillMode?: string;
  /** 遅延時間（ms） */
  delay?: number;
  /** 現在の再生時間（ms） */
  currentTime?: number;
}

/**
 * IntersectionObserver情報
 */
export interface IntersectionObserverInfo {
  /** 一意識別子 */
  id: string;
  /** 監視対象の要素数 */
  targetCount: number;
  /** オブザーバーオプション */
  options: {
    threshold: number[];
    rootMargin?: string;
    root?: string;
  };
  /** 監視対象要素のセレクタ配列 */
  targetSelectors: string[];
}

/**
 * requestAnimationFrame情報
 */
export interface RAFInfo {
  /** 一意識別子 */
  id: string;
  /** コール回数 */
  callCount: number;
  /** 平均フレーム時間（ms） */
  avgFrameTime: number;
  /** 変更された要素のセレクタ配列 */
  modifiedElements: string[];
  /** アクティブかどうか */
  isActive: boolean;
}

/**
 * ランタイムアニメーション検出オプション
 */
export interface RuntimeAnimationOptions {
  /** アニメーション待機時間（ms） デフォルト: 3000 */
  wait_for_animations?: number;
  /** チェックするスクロール位置の配列（%） デフォルト: [0] */
  scroll_positions?: number[];
}

/**
 * スクロール位置ごとの検出結果
 */
export interface ScrollPositionResult {
  /** 検出されたアニメーション数 */
  animationCount: number;
  /** 新たにトリガーされたアニメーション */
  triggeredAnimations: string[];
}

/**
 * ランタイムアニメーション検出結果
 */
export interface RuntimeAnimationResult {
  /** Web Animations APIで検出されたアニメーション */
  animations: AnimationInfo[];
  /** 検出されたIntersectionObserver */
  intersectionObservers: IntersectionObserverInfo[];
  /** 検出されたRAFコールバック */
  rafCallbacks: RAFInfo[];
  /** 検出された総数 */
  totalDetected: number;
  /** 検出にかかった時間（ms） */
  detectionTimeMs: number;
  /** スクロール位置ごとの結果 */
  scrollPositionResults?: Record<string, ScrollPositionResult>;
  /** スクロールでトリガーされたアニメーション */
  triggeredAnimations?: string[];
}

/**
 * デフォルトのオプション
 */
const DEFAULT_OPTIONS: Required<RuntimeAnimationOptions> = {
  wait_for_animations: 3000,
  scroll_positions: [0],
};

// =====================================================
// RuntimeAnimationDetectorService クラス
// =====================================================

/**
 * JavaScript駆動アニメーションの実行時検出サービス
 */
export class RuntimeAnimationDetectorService {

  /**
   * オプションを正規化
   */
  private normalizeOptions(options?: RuntimeAnimationOptions): Required<RuntimeAnimationOptions> {
    const normalized = { ...DEFAULT_OPTIONS, ...options };

    // 負の値を修正
    if (normalized.wait_for_animations < 0) {
      normalized.wait_for_animations = DEFAULT_OPTIONS.wait_for_animations;
    }

    // スクロール位置を0-100の範囲に制限
    normalized.scroll_positions = (normalized.scroll_positions || [0])
      .filter((pos) => pos >= 0 && pos <= 100)
      .slice(0, 20);

    if (normalized.scroll_positions.length === 0) {
      normalized.scroll_positions = [0];
    }

    return normalized;
  }

  /**
   * ページからアニメーションを検出
   *
   * @param page - Playwrightページオブジェクト
   * @param options - 検出オプション
   * @returns 検出結果
   */
  async detect(page: Page, options?: RuntimeAnimationOptions): Promise<RuntimeAnimationResult> {
    const startTime = Date.now();

    const opts = this.normalizeOptions(options);

    if (isDevelopment()) {
      logger.debug('[RuntimeAnimationDetectorService] detect called', {
        waitForAnimations: opts.wait_for_animations,
        scrollPositions: opts.scroll_positions,
      });
    }

    try {
      // ページがまだ開いているか確認
      if (page.isClosed()) {
        throw new Error('Page is closed');
      }

      // 並列で検出を実行
      const [animations, intersectionObservers, rafCallbacks, scrollPositionResults] =
        await Promise.all([
          this.detectAnimations(page),
          this.detectIntersectionObservers(page),
          this.detectRAFCallbacks(page, opts.wait_for_animations),
          this.detectAtScrollPositions(page, opts.scroll_positions),
        ]);

      const detectionTimeMs = Date.now() - startTime;

      // トリガーされたアニメーションを集計
      const triggeredAnimations = Object.values(scrollPositionResults)
        .flatMap((result) => result.triggeredAnimations)
        .filter((v, i, arr) => arr.indexOf(v) === i); // 重複除去

      const result: RuntimeAnimationResult = {
        animations,
        intersectionObservers,
        rafCallbacks,
        totalDetected: animations.length + intersectionObservers.length + rafCallbacks.length,
        detectionTimeMs,
        scrollPositionResults,
        triggeredAnimations,
      };

      if (isDevelopment()) {
        logger.debug('[RuntimeAnimationDetectorService] detect completed', {
          totalDetected: result.totalDetected,
          animations: animations.length,
          intersectionObservers: intersectionObservers.length,
          rafCallbacks: rafCallbacks.length,
          detectionTimeMs,
        });
      }

      return result;
    } catch (error) {
      const detectionTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.error('[RuntimeAnimationDetectorService] detect error', { error });
      }

      // ページナビゲーション中などはエラーではなく空の結果を返す
      if (
        error instanceof Error &&
        (error.message.includes('Target closed') ||
          error.message.includes('Navigation') ||
          error.message.includes('closed'))
      ) {
        return {
          animations: [],
          intersectionObservers: [],
          rafCallbacks: [],
          totalDetected: 0,
          detectionTimeMs,
          scrollPositionResults: {},
          triggeredAnimations: [],
        };
      }

      throw error;
    }
  }

  /**
   * Web Animations API経由でアニメーションを検出
   */
  private async detectAnimations(page: Page): Promise<AnimationInfo[]> {
    try {
      const rawAnimations = await page.evaluate(() => {
        const animations: Array<{
          id: string;
          type: string;
          playState: string;
          duration: number;
          iterations: number;
          easing: string;
          targetSelector: string;
          animationName?: string;
          properties?: string[];
          direction?: string;
          fillMode?: string;
          delay?: number;
          currentTime?: number;
        }> = [];

        // document.getAnimations() でアクティブなアニメーションを取得
        const allAnimations = document.getAnimations();
        let counter = 0;

        for (const anim of allAnimations) {
          counter++;
          const target = anim.effect?.getComputedTiming
            ? (anim.effect as KeyframeEffect).target
            : null;

          let targetSelector = '';
          if (target instanceof Element) {
            if (target.id) {
              targetSelector = `#${target.id}`;
            } else if (target.className && typeof target.className === 'string') {
              targetSelector = `.${target.className.split(' ').filter(Boolean).join('.')}`;
            } else {
              targetSelector = target.tagName.toLowerCase();
            }
          }

          const timing = anim.effect?.getComputedTiming?.() || {};
          const isCssAnimation = anim instanceof CSSAnimation;
          const isCssTransition = anim instanceof CSSTransition;

          let animType = 'web_animations_api';
          if (isCssAnimation) {
            animType = 'css_animation';
          } else if (isCssTransition) {
            animType = 'css_transition';
          }

          // KeyframeEffectからプロパティを取得
          let properties: string[] = [];
          if (anim.effect instanceof KeyframeEffect) {
            const keyframes = anim.effect.getKeyframes();
            const propSet = new Set<string>();
            for (const kf of keyframes) {
              Object.keys(kf).forEach((key) => {
                if (
                  key !== 'offset' &&
                  key !== 'computedOffset' &&
                  key !== 'easing' &&
                  key !== 'composite'
                ) {
                  propSet.add(key);
                }
              });
            }
            properties = Array.from(propSet);
          }

          const animationEntry: {
            id: string;
            type: string;
            playState: string;
            duration: number;
            iterations: number;
            easing: string;
            targetSelector: string;
            animationName?: string;
            properties?: string[];
            direction?: string;
            fillMode?: string;
            delay?: number;
            currentTime?: number;
          } = {
            id: `anim-${counter}`,
            type: animType,
            playState: anim.playState,
            duration:
              typeof timing.duration === 'number' ? timing.duration : timing.duration ? 0 : 0,
            iterations:
              timing.iterations === Infinity ? Infinity : (timing.iterations as number) || 1,
            easing: (timing.easing as string) || 'linear',
            targetSelector,
            properties,
            direction: (timing.direction as string) || 'normal',
            fillMode: (timing.fill as string) || 'none',
            delay: typeof timing.delay === 'number' ? timing.delay : 0,
          };

          // CSSAnimationの場合のみanimationNameを設定
          if (isCssAnimation) {
            animationEntry.animationName = (anim as CSSAnimation).animationName;
          }

          // currentTimeが有効な場合のみ設定
          if (anim.currentTime !== null) {
            animationEntry.currentTime = Number(anim.currentTime);
          }

          animations.push(animationEntry);
        }

        return animations;
      });

      return rawAnimations.map((anim) => ({
        ...anim,
        type: anim.type as AnimationType,
        playState: anim.playState as AnimationInfo['playState'],
        iterations: anim.iterations === null ? Infinity : anim.iterations,
      }));
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[RuntimeAnimationDetectorService] detectAnimations error', { error });
      }
      return [];
    }
  }

  /**
   * IntersectionObserverの使用を検出
   */
  private async detectIntersectionObservers(page: Page): Promise<IntersectionObserverInfo[]> {
    try {
      // IntersectionObserverをフックして検出するスクリプトを注入
      const observers = await page.evaluate(() => {
        const results: Array<{
          id: string;
          targetCount: number;
          options: {
            threshold: number[];
            rootMargin?: string;
            root?: string;
          };
          targetSelectors: string[];
        }> = [];

        // グローバルに登録されたオブザーバー情報を取得
        const registeredObservers = window.__reftrix_io_observers || [];

        let counter = 0;
        for (const observer of registeredObservers) {
          counter++;
          const rootValue = observer.root;
          results.push({
            id: `io-${counter}`,
            targetCount: observer.targets?.length || 0,
            options: {
              threshold: observer.threshold || [0],
              rootMargin: observer.rootMargin || '0px',
              ...(rootValue !== undefined && { root: rootValue }),
            },
            targetSelectors: observer.targetSelectors || [],
          });
        }

        return results;
      });

      return observers;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[RuntimeAnimationDetectorService] detectIntersectionObservers error', {
          error,
        });
      }
      return [];
    }
  }

  /**
   * requestAnimationFrameの使用を検出
   */
  private async detectRAFCallbacks(page: Page, waitTime: number): Promise<RAFInfo[]> {
    try {
      // RAFをフックするスクリプトを注入
      await page.evaluate(() => {
        if (window.__reftrix_raf_hooked) return;

        window.__reftrix_raf_data = {
          callbacks: new Map<
            number,
            {
              callCount: number;
              frameTimes: number[];
              lastTime: number;
              modifiedElements: Set<string>;
              isActive: boolean;
            }
          >(),
          nextId: 1,
        };

        const originalRAF = window.requestAnimationFrame.bind(window);
        const originalCAF = window.cancelAnimationFrame.bind(window);

        // MutationObserverで変更された要素を追跡
        const mutationObserver = new MutationObserver((mutations) => {
          const rafData = window.__reftrix_raf_data;
          for (const mutation of mutations) {
            if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
              const target = mutation.target as Element;
              let selector = target.tagName.toLowerCase();
              if (target.id) {
                selector = `#${target.id}`;
              } else if (target.className && typeof target.className === 'string') {
                selector = `.${target.className.split(' ').filter(Boolean).join('.')}`;
              }

              // アクティブなRAFコールバックに関連付け
              if (rafData) {
                for (const [, data] of rafData.callbacks) {
                  if (data.isActive) {
                    data.modifiedElements.add(selector);
                  }
                }
              }
            }
          }
        });

        mutationObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['style', 'class'],
          subtree: true,
        });

        window.requestAnimationFrame = (callback: FrameRequestCallback): number => {
          const rafData = window.__reftrix_raf_data;
          if (!rafData) {
            return originalRAF(callback);
          }
          const id = rafData.nextId++;

          if (!rafData.callbacks.has(id)) {
            rafData.callbacks.set(id, {
              callCount: 0,
              frameTimes: [],
              lastTime: performance.now(),
              modifiedElements: new Set(),
              isActive: true,
            });
          }

          const wrappedCallback = (time: DOMHighResTimeStamp): void => {
            const data = rafData.callbacks.get(id);
            if (data) {
              data.callCount++;
              const frameTime = time - data.lastTime;
              data.frameTimes.push(frameTime);
              data.lastTime = time;

              // 最新100フレームのみ保持
              if (data.frameTimes.length > 100) {
                data.frameTimes.shift();
              }
            }
            callback(time);
          };

          return originalRAF(wrappedCallback);
        };

        window.cancelAnimationFrame = (handle: number): void => {
          const rafData = window.__reftrix_raf_data;
          if (rafData) {
            const data = rafData.callbacks.get(handle);
            if (data) {
              data.isActive = false;
            }
          }
          originalCAF(handle);
        };

        window.__reftrix_raf_hooked = true;
      });

      // 待機時間だけRAFが実行されるのを待つ
      await page.waitForTimeout(Math.min(waitTime, 500));

      // RAFデータを収集
      const rafResults = await page.evaluate(() => {
        const rafData = window.__reftrix_raf_data;
        if (!rafData) return [];

        const results: Array<{
          id: string;
          callCount: number;
          avgFrameTime: number;
          modifiedElements: string[];
          isActive: boolean;
        }> = [];

        let counter = 0;
        for (const [, data] of rafData.callbacks) {
          if (data.callCount > 0) {
            counter++;
            const avgFrameTime =
              data.frameTimes.length > 0
                ? data.frameTimes.reduce((a: number, b: number) => a + b, 0) / data.frameTimes.length
                : 0;

            results.push({
              id: `raf-${counter}`,
              callCount: data.callCount,
              avgFrameTime,
              modifiedElements: Array.from(data.modifiedElements),
              isActive: data.isActive,
            });
          }
        }

        return results;
      });

      return rafResults;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[RuntimeAnimationDetectorService] detectRAFCallbacks error', { error });
      }
      return [];
    }
  }

  /**
   * スクロール位置ごとにアニメーションを検出
   */
  private async detectAtScrollPositions(
    page: Page,
    scrollPositions: number[]
  ): Promise<Record<string, ScrollPositionResult>> {
    const results: Record<string, ScrollPositionResult> = {};

    try {
      // IntersectionObserverをフックするスクリプトを注入
      await page.evaluate(() => {
        if (window.__reftrix_io_hooked) return;

        window.__reftrix_io_observers = [];
        window.__reftrix_io_triggers = [];

        const OriginalIO = window.IntersectionObserver;

        // カスタムIntersectionObserverでオリジナルを上書き
        (window as unknown as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver = class ReftrixIntersectionObserver extends OriginalIO {
          private _targets: Element[] = [];
          private _id: number;

          constructor(
            callback: IntersectionObserverCallback,
            options?: IntersectionObserverInit
          ) {
            const wrappedCallback: IntersectionObserverCallback = (entries, observer) => {
              for (const entry of entries) {
                if (entry.isIntersecting) {
                  let selector = entry.target.tagName.toLowerCase();
                  if (entry.target.id) {
                    selector = `#${entry.target.id}`;
                  }
                  window.__reftrix_io_triggers?.push({
                    selector,
                    time: Date.now(),
                    ratio: entry.intersectionRatio,
                  });
                }
              }
              callback(entries, observer);
            };

            super(wrappedCallback, options);

            this._id = (window.__reftrix_io_observers?.length ?? 0) + 1;

            window.__reftrix_io_observers?.push({
              id: this._id,
              targets: this._targets,
              threshold: options?.threshold
                ? Array.isArray(options.threshold)
                  ? options.threshold
                  : [options.threshold]
                : [0],
              rootMargin: options?.rootMargin || '0px',
              root: options?.root ? 'custom' : undefined,
              targetSelectors: [] as string[],
            });
          }

          observe(target: Element): void {
            this._targets.push(target);

            // オブザーバー情報を更新
            const observer = window.__reftrix_io_observers?.find(
              (o: { id: number }) => o.id === this._id
            );
            if (observer) {
              observer.targets = this._targets;

              let selector = target.tagName.toLowerCase();
              if (target.id) {
                selector = `#${target.id}`;
              } else if (target.className && typeof target.className === 'string') {
                selector = `.${target.className.split(' ').filter(Boolean).join('.')}`;
              }
              observer.targetSelectors.push(selector);
            }

            super.observe(target);
          }

          unobserve(target: Element): void {
            const index = this._targets.indexOf(target);
            if (index > -1) {
              this._targets.splice(index, 1);
            }
            super.unobserve(target);
          }
        };

        window.__reftrix_io_hooked = true;
      });

      // 各スクロール位置でチェック
      for (const position of scrollPositions) {
        // スクロール位置を設定（0-100%）
        await page.evaluate((pos) => {
          const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
          window.scrollTo(0, (maxScroll * pos) / 100);
        }, position);

        // スクロール後のトランジション完了を待つ
        await page.waitForTimeout(100);

        // トリガーされたIOを取得
        const triggers = await page.evaluate(() => {
          const allTriggers = window.__reftrix_io_triggers || [];
          const recentTriggers = allTriggers.filter(
            (t: { time: number }) => Date.now() - t.time < 500
          );
          return recentTriggers.map((t: { selector: string }) => t.selector);
        });

        // 現在のアニメーション数を取得
        const animationCount = await page.evaluate(() => document.getAnimations().length);

        results[String(position)] = {
          animationCount,
          triggeredAnimations: triggers,
        };
      }

      return results;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[RuntimeAnimationDetectorService] detectAtScrollPositions error', { error });
      }
      return {};
    }
  }
}
