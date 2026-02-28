// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * JSAnimationDetectorService
 *
 * Chrome DevTools Protocol (CDP) と Web Animations API を使用した
 * JavaScript駆動アニメーションの包括的な検出サービス
 *
 * 機能:
 * - CDP Animation ドメインによるアニメーション検出
 * - Web Animations API (document.getAnimations()) による検出
 * - アニメーションライブラリ検出 (GSAP, Framer Motion, Anime.js, Three.js, Lottie)
 *
 * @module services/motion/js-animation-detector
 */

import type { Page, CDPSession } from 'playwright';
import { logger, isDevelopment } from '../../utils/logger';

// =====================================================
// 型定義
// =====================================================

// =====================================================
// 信頼度スコア型定義 (v0.1.0)
// =====================================================

/**
 * 検出ソース種別
 *
 * 各ソースは検出方法の信頼性に基づいてスコアが割り当てられます:
 * - cdp: Chrome DevTools Protocol (0.95) - 最高信頼度
 * - web_animations_api: document.getAnimations() (0.90)
 * - library_signature: GSAP/Framer Motion等のシグネチャ (0.75)
 * - raf_monitoring: requestAnimationFrame監視 (0.70)
 * - intersection_observer: IntersectionObserver検出 (0.65)
 */
export type DetectionSource =
  | 'cdp'
  | 'web_animations_api'
  | 'library_signature'
  | 'raf_monitoring'
  | 'intersection_observer';

/**
 * 検出結果の信頼度情報
 */
export interface DetectionConfidence {
  /** 総合信頼度スコア (0-1) */
  score: number;
  /** 検出に使用したソース */
  sources: DetectionSource[];
  /** ソースごとの信頼度 */
  sourceScores: Record<DetectionSource, number>;
  /** 信頼度計算の根拠 */
  rationale: string[];
}

/**
 * ソースごとの基本信頼度
 */
export const BASE_CONFIDENCE_SCORES: Record<DetectionSource, number> = {
  cdp: 0.95,
  web_animations_api: 0.90,
  library_signature: 0.75,
  raf_monitoring: 0.70,
  intersection_observer: 0.65,
};

/**
 * CDP Animation イベントのタイミング情報
 */
export interface CDPAnimationSource {
  /** アニメーション時間（ms） */
  duration: number;
  /** 遅延時間（ms） */
  delay: number;
  /** 繰り返し回数 */
  iterations: number;
  /** アニメーション方向 */
  direction: string;
  /** イージング関数 */
  easing: string;
  /** キーフレームルール（CSSアニメーションの場合） */
  keyframesRule?: {
    name?: string;
    keyframes?: Array<{
      offset: string;
      easing: string;
      style?: string;
    }>;
  };
}

/**
 * CDP経由で検出されたアニメーション
 */
export interface CDPAnimation {
  /** CDP アニメーションID */
  id: string;
  /** アニメーション名 */
  name: string;
  /** 一時停止状態 */
  pausedState: boolean;
  /** 再生状態 */
  playState: string;
  /** 再生速度 */
  playbackRate: number;
  /** 開始時間 */
  startTime: number;
  /** 現在時間 */
  currentTime: number;
  /** アニメーションタイプ */
  type: 'CSSAnimation' | 'CSSTransition' | 'WebAnimation';
  /** ソース情報（タイミング） */
  source: CDPAnimationSource;
  /** 信頼度情報 (v0.1.0) */
  confidence?: DetectionConfidence;
}

/**
 * Web Animations API で検出されたアニメーション
 */
export interface WebAnimation {
  /** アニメーションID */
  id: string;
  /** 再生状態 */
  playState: string;
  /** ターゲット要素 */
  target: string;
  /** タイミング情報 */
  timing: {
    duration: number;
    delay: number;
    iterations: number;
    direction: string;
    easing: string;
    fill: string;
  };
  /** キーフレーム */
  keyframes: Array<{
    offset: number | null;
    easing: string;
    composite: string;
    [property: string]: unknown;
  }>;
  /** 信頼度情報 (v0.1.0) */
  confidence?: DetectionConfidence;
}

// =====================================================
// Three.js 詳細情報型定義
// =====================================================

/**
 * Three.js オブジェクト情報
 * シーン内のMesh、Light、Cameraなどの情報
 */
export interface ThreeJSObject {
  /** オブジェクトタイプ (Mesh, Light, Camera, Group など) */
  type: string;
  /** ジオメトリタイプ (BoxGeometry, SphereGeometry など) */
  geometry?: string | undefined;
  /** マテリアルタイプ (MeshStandardMaterial, MeshBasicMaterial など) */
  material?: string | undefined;
  /** 位置 [x, y, z] */
  position?: [number, number, number] | undefined;
  /** 回転 [x, y, z] (ラジアン) */
  rotation?: [number, number, number] | undefined;
  /** スケール [x, y, z] */
  scale?: [number, number, number] | undefined;
  /** ライト固有: 色 (hex) */
  color?: string | undefined;
  /** ライト固有: 強度 */
  intensity?: number | undefined;
}

/**
 * Three.js シーン情報
 */
export interface ThreeJSScene {
  /** シーンID */
  id: string;
  /** 背景色 (hex) */
  background?: string | undefined;
  /** フォグ設定 */
  fog?: {
    /** フォグタイプ (Fog | FogExp2) */
    type: string;
    /** フォグ色 (hex) */
    color: string;
    /** 密度 (FogExp2の場合) */
    density?: number | undefined;
    /** 開始距離 (Fogの場合) */
    near?: number | undefined;
    /** 終了距離 (Fogの場合) */
    far?: number | undefined;
  } | undefined;
  /** シーン内オブジェクト */
  objects: ThreeJSObject[];
}

/**
 * Three.js カメラ情報
 */
export interface ThreeJSCamera {
  /** カメラタイプ (PerspectiveCamera | OrthographicCamera) */
  type: string;
  /** 視野角 (PerspectiveCameraの場合) */
  fov?: number | undefined;
  /** アスペクト比 */
  aspect?: number | undefined;
  /** ニアクリップ */
  near?: number | undefined;
  /** ファークリップ */
  far?: number | undefined;
  /** 位置 [x, y, z] */
  position?: [number, number, number] | undefined;
  /** OrthographicCamera: 左端 */
  left?: number | undefined;
  /** OrthographicCamera: 右端 */
  right?: number | undefined;
  /** OrthographicCamera: 上端 */
  top?: number | undefined;
  /** OrthographicCamera: 下端 */
  bottom?: number | undefined;
}

/**
 * Three.js レンダラー情報
 */
export interface ThreeJSRenderer {
  /** アンチエイリアス有効 */
  antialias?: boolean | undefined;
  /** シャドウマップ有効 */
  shadowMap?: boolean | undefined;
  /** トーンマッピング */
  toneMapping?: string | undefined;
  /** 出力カラースペース */
  outputColorSpace?: string | undefined;
  /** ピクセル比 */
  pixelRatio?: number | undefined;
}

/**
 * Three.js パフォーマンス指標
 */
export interface ThreeJSPerformance {
  /** FPS (取得可能な場合) */
  fps?: number | undefined;
  /** 描画コール数 */
  drawCalls?: number | undefined;
  /** 三角形数 */
  triangles?: number | undefined;
  /** ポイント数 */
  points?: number | undefined;
  /** ライン数 */
  lines?: number | undefined;
}

/**
 * Three.js 詳細情報
 * WebGL/3Dベースの要素を再利用可能にするための包括的情報
 */
export interface ThreeJSDetails {
  /** Three.jsバージョン (r167 など) */
  version?: string | undefined;
  /** シーン配列 */
  scenes: ThreeJSScene[];
  /** カメラ配列 */
  cameras: ThreeJSCamera[];
  /** レンダラー設定 */
  renderer: ThreeJSRenderer;
  /** パフォーマンス指標 */
  performance: ThreeJSPerformance;
  /** テクスチャURL配列 */
  textures?: string[] | undefined;
}

// =====================================================
// ライブラリ検出結果型定義
// =====================================================

/**
 * ライブラリ検出結果
 */
export interface LibraryDetectionResult {
  /** GSAP検出結果 */
  gsap: {
    detected: boolean;
    version?: string | undefined;
    tweens?: number | undefined;
    /** 信頼度情報 (v0.1.0) */
    confidence?: DetectionConfidence | undefined;
  };
  /** Framer Motion検出結果 */
  framerMotion: {
    detected: boolean;
    elements?: number | undefined;
    /** 信頼度情報 (v0.1.0) */
    confidence?: DetectionConfidence | undefined;
  };
  /** Anime.js検出結果 */
  anime: {
    detected: boolean;
    instances?: number | undefined;
    /** 信頼度情報 (v0.1.0) */
    confidence?: DetectionConfidence | undefined;
  };
  /** Three.js検出結果 */
  three: {
    detected: boolean;
    scenes?: number | undefined;
    /** Three.js詳細情報 (v0.1.0) */
    details?: ThreeJSDetails | undefined;
    /** 信頼度情報 (v0.1.0) */
    confidence?: DetectionConfidence | undefined;
  };
  /** Lottie検出結果 */
  lottie: {
    detected: boolean;
    animations?: number | undefined;
    /** 信頼度情報 (v0.1.0) */
    confidence?: DetectionConfidence | undefined;
  };
}

/**
 * JSアニメーション検出結果
 */
export interface JSAnimationResult {
  /** CDP経由で検出されたアニメーション */
  cdpAnimations: CDPAnimation[];
  /** Web Animations API で検出されたアニメーション */
  webAnimations: WebAnimation[];
  /** ライブラリ検出結果 */
  libraries: LibraryDetectionResult;
  /** 検出にかかった時間（ms） */
  detectionTimeMs: number;
  /** 総検出数 */
  totalDetected: number;
  /** 総合信頼度スコア (v0.1.0) */
  overallConfidence?: DetectionConfidence;
}

/**
 * JSアニメーション検出オプション
 */
export interface JSAnimationDetectOptions {
  /** CDPアニメーション検出を有効にするか (default: true) */
  enableCDP?: boolean;
  /** Web Animations API検出を有効にするか (default: true) */
  enableWebAnimations?: boolean;
  /** ライブラリ検出を有効にするか (default: true) */
  enableLibraryDetection?: boolean;
  /** アニメーション待機時間（ms） (default: 1000) */
  waitTime?: number;
}

// =====================================================
// デフォルトオプション
// =====================================================

const DEFAULT_OPTIONS: Required<JSAnimationDetectOptions> = {
  enableCDP: true,
  enableWebAnimations: true,
  enableLibraryDetection: true,
  waitTime: 1000,
};

// =====================================================
// 信頼度計算ヘルパー関数 (v0.1.0)
// =====================================================

/**
 * 複数ソースからの信頼度をマージ
 * 複数ソースで検出された場合、信頼度は上昇する（逓減効果あり）
 *
 * @param sources - 検出に使用したソースの配列
 * @returns マージされた信頼度スコア (0-1)
 */
function mergeConfidenceScores(sources: DetectionSource[]): number {
  if (sources.length === 0) return 0;

  const firstSource = sources[0];
  if (sources.length === 1 && firstSource !== undefined) {
    return BASE_CONFIDENCE_SCORES[firstSource];
  }

  // 最高スコアを基準に、追加ソースごとにボーナス
  const sortedScores = sources
    .map((s) => BASE_CONFIDENCE_SCORES[s])
    .sort((a, b) => b - a);

  const firstScore = sortedScores[0];
  if (firstScore === undefined) return 0;

  let score: number = firstScore;

  // 追加ソースごとに信頼度を増加（逓減効果）
  for (let i = 1; i < sortedScores.length; i++) {
    const currentScore = sortedScores[i];
    if (currentScore !== undefined) {
      const bonus = (1 - score) * currentScore * 0.5;
      score += bonus;
    }
  }

  return Math.min(score, 1.0);
}

/**
 * 信頼度情報を生成
 *
 * @param sources - 検出に使用したソースの配列
 * @param additionalRationale - 追加の根拠説明
 * @returns 信頼度情報オブジェクト
 */
export function calculateConfidence(
  sources: DetectionSource[],
  additionalRationale: string[] = []
): DetectionConfidence {
  const sourceScores: Record<DetectionSource, number> = {
    cdp: 0,
    web_animations_api: 0,
    library_signature: 0,
    raf_monitoring: 0,
    intersection_observer: 0,
  };

  sources.forEach((s) => {
    sourceScores[s] = BASE_CONFIDENCE_SCORES[s];
  });

  const rationale: string[] = [];

  if (sources.includes('cdp')) {
    rationale.push('CDP Animation domain detection (high confidence)');
  }
  if (sources.includes('web_animations_api')) {
    rationale.push('Web Animations API detection');
  }
  if (sources.includes('library_signature')) {
    rationale.push('Animation library signature detected');
  }
  if (sources.includes('raf_monitoring')) {
    rationale.push('requestAnimationFrame callback detected');
  }
  if (sources.includes('intersection_observer')) {
    rationale.push('IntersectionObserver triggered animation');
  }

  rationale.push(...additionalRationale);

  return {
    score: mergeConfidenceScores(sources),
    sources,
    sourceScores,
    rationale,
  };
}

// =====================================================
// JSAnimationDetectorService クラス
// =====================================================

/**
 * JavaScript駆動アニメーションの包括的検出サービス
 *
 * CDP + Web Animations API + ライブラリシグネチャ検出を組み合わせて
 * Webページ上のJavaScriptアニメーションを検出します。
 */
export class JSAnimationDetectorService {
  private cdpSession: CDPSession | null = null;
  private cdpAnimations: Map<string, CDPAnimation> = new Map();
  private isListening = false;

  /**
   * CDPセッションを初期化してAnimationドメインを有効化
   */
  private async initializeCDP(page: Page): Promise<CDPSession> {
    if (this.cdpSession) {
      return this.cdpSession;
    }

    try {
      const client = await page.context().newCDPSession(page);

      // Animation ドメインを有効化
      await client.send('Animation.enable');

      this.cdpSession = client;

      if (isDevelopment()) {
        logger.debug('[JSAnimationDetector] CDP session initialized');
      }

      return client;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[JSAnimationDetector] CDP initialization failed', { error });
      }
      throw new Error(
        `CDP initialization failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * CDPイベントリスナーを設定
   */
  private setupCDPListeners(client: CDPSession): void {
    if (this.isListening) {
      return;
    }

    // Animation.animationCreated イベント
    client.on('Animation.animationCreated', (event: { id: string }) => {
      if (isDevelopment()) {
        logger.debug('[JSAnimationDetector] Animation created', { id: event.id });
      }
    });

    // Animation.animationStarted イベント（タイミング情報含む）
    client.on(
      'Animation.animationStarted',
      (event: {
        animation: {
          id: string;
          name: string;
          pausedState: boolean;
          playState: string;
          playbackRate: number;
          startTime: number;
          currentTime: number;
          type: string;
          source?: {
            duration?: number;
            delay?: number;
            iterationStart?: number;
            iterations?: number;
            direction?: string;
            easing?: string;
            keyframesRule?: {
              name?: string;
              keyframes?: Array<{
                offset: string;
                easing: string;
                style?: string;
              }>;
            };
          };
        };
      }) => {
        const anim = event.animation;

        // 信頼度情報を生成（CDP検出は高信頼度）
        const confidenceRationale: string[] = [
          `Animation type: ${anim.type}`,
          `Duration: ${anim.source?.duration ?? 0}ms`,
        ];
        if (anim.source?.keyframesRule?.keyframes) {
          confidenceRationale.push(
            `Keyframes detected: ${anim.source.keyframesRule.keyframes.length}`
          );
        }

        const cdpAnimation: CDPAnimation = {
          id: anim.id,
          name: anim.name || `animation-${anim.id}`,
          pausedState: anim.pausedState,
          playState: anim.playState,
          playbackRate: anim.playbackRate,
          startTime: anim.startTime,
          currentTime: anim.currentTime,
          type: this.mapAnimationType(anim.type),
          source: {
            duration: anim.source?.duration ?? 0,
            delay: anim.source?.delay ?? 0,
            iterations: anim.source?.iterations ?? 1,
            direction: anim.source?.direction ?? 'normal',
            easing: anim.source?.easing ?? 'linear',
            ...(anim.source?.keyframesRule !== undefined
              ? { keyframesRule: anim.source.keyframesRule }
              : {}),
          },
          confidence: calculateConfidence(['cdp'], confidenceRationale),
        };

        this.cdpAnimations.set(anim.id, cdpAnimation);

        if (isDevelopment()) {
          logger.debug('[JSAnimationDetector] Animation started', {
            id: anim.id,
            name: anim.name,
            type: cdpAnimation.type,
            duration: cdpAnimation.source.duration,
          });
        }
      }
    );

    // Animation.animationCanceled イベント
    client.on('Animation.animationCanceled', (event: { id: string }) => {
      this.cdpAnimations.delete(event.id);

      if (isDevelopment()) {
        logger.debug('[JSAnimationDetector] Animation canceled', { id: event.id });
      }
    });

    this.isListening = true;
  }

  /**
   * CDPのアニメーションタイプをマッピング
   */
  private mapAnimationType(
    type: string
  ): 'CSSAnimation' | 'CSSTransition' | 'WebAnimation' {
    switch (type) {
      case 'CSSAnimation':
        return 'CSSAnimation';
      case 'CSSTransition':
        return 'CSSTransition';
      default:
        return 'WebAnimation';
    }
  }

  /**
   * CDP経由でアニメーションを検出
   */
  private async detectCDPAnimations(
    page: Page,
    waitTime: number
  ): Promise<CDPAnimation[]> {
    try {
      const client = await this.initializeCDP(page);
      this.setupCDPListeners(client);

      // アニメーションが開始されるのを待つ
      await page.waitForTimeout(waitTime);

      // 現在のアニメーション状態を取得
      const animations = Array.from(this.cdpAnimations.values());

      if (isDevelopment()) {
        logger.debug('[JSAnimationDetector] CDP animations detected', {
          count: animations.length,
        });
      }

      return animations;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[JSAnimationDetector] CDP detection failed', { error });
      }
      return [];
    }
  }

  /**
   * Web Animations API でアニメーションを検出
   */
  /* eslint-disable no-undef -- page.evaluate() runs in browser context */
  private async detectWebAnimations(page: Page): Promise<WebAnimation[]> {
    try {
      const animations = await page.evaluate(() => {
        const results: Array<{
          id: string;
          playState: string;
          target: string;
          timing: {
            duration: number;
            delay: number;
            iterations: number;
            direction: string;
            easing: string;
            fill: string;
          };
          keyframes: Array<{
            offset: number | null;
            easing: string;
            composite: string;
            [property: string]: unknown;
          }>;
        }> = [];

        const allAnimations = document.getAnimations();
        let counter = 0;

        for (const anim of allAnimations) {
          counter++;

          // ターゲット要素のセレクタを取得
          let targetSelector = 'unknown';
          const effect = anim.effect as KeyframeEffect | null;
          if (effect?.target instanceof Element) {
            const target = effect.target;
            if (target.id) {
              targetSelector = `#${target.id}`;
            } else if (target.className && typeof target.className === 'string') {
              targetSelector = `.${target.className.split(' ').filter(Boolean).join('.')}`;
            } else {
              targetSelector = target.tagName.toLowerCase();
            }
          }

          // タイミング情報を取得
          const timing = effect?.getComputedTiming() ?? {};

          // キーフレームを取得
          let keyframes: Array<{
            offset: number | null;
            easing: string;
            composite: string;
            [property: string]: unknown;
          }> = [];

          if (effect instanceof KeyframeEffect) {
            try {
              keyframes = effect.getKeyframes().map((kf) => ({
                offset: kf.offset,
                easing: kf.easing as string,
                composite: kf.composite as string,
                ...Object.fromEntries(
                  Object.entries(kf).filter(
                    ([key]) =>
                      !['offset', 'easing', 'composite', 'computedOffset'].includes(key)
                  )
                ),
              }));
            } catch {
              // キーフレーム取得失敗は無視
            }
          }

          results.push({
            id: anim.id || `web-anim-${counter}`,
            playState: anim.playState,
            target: targetSelector,
            timing: {
              duration:
                typeof timing.duration === 'number' ? timing.duration : 0,
              delay: typeof timing.delay === 'number' ? timing.delay : 0,
              iterations:
                timing.iterations === Infinity
                  ? -1
                  : typeof timing.iterations === 'number'
                    ? timing.iterations
                    : 1,
              direction: (timing.direction as string) ?? 'normal',
              easing: (timing.easing as string) ?? 'linear',
              fill: (timing.fill as string) ?? 'none',
            },
            keyframes,
          });
        }

        return results;
      });

      if (isDevelopment()) {
        logger.debug('[JSAnimationDetector] Web Animations detected', {
          count: animations.length,
        });
      }

      // 信頼度情報を追加（Web Animations APIは高信頼度）
      const animationsWithConfidence: WebAnimation[] = animations.map((anim) => {
        const confidenceRationale: string[] = [
          `Target: ${anim.target}`,
          `Duration: ${anim.timing.duration}ms`,
          `Play state: ${anim.playState}`,
        ];
        if (anim.keyframes.length > 0) {
          confidenceRationale.push(`Keyframes: ${anim.keyframes.length}`);
        }

        return {
          ...anim,
          confidence: calculateConfidence(['web_animations_api'], confidenceRationale),
        };
      });

      return animationsWithConfidence;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[JSAnimationDetector] Web Animations detection failed', { error });
      }
      return [];
    }
  }
  /* eslint-enable no-undef */

  /**
   * Three.jsシーン詳細情報を取得
   *
   * WebGLコンテキストとThree.jsオブジェクトから詳細情報を抽出します。
   * セキュリティ上、JavaScriptコードの実行が必要なため、Playwright page.evaluate() を使用します。
   *
   * @param page - Playwrightページオブジェクト
   * @returns Three.js詳細情報（検出できない場合はnull）
   */
  /* eslint-disable no-undef -- page.evaluate() runs in browser context */
  private async detectThreeJSDetails(page: Page): Promise<ThreeJSDetails | null> {
    const startTime = Date.now();

    try {
      const result = await page.evaluate(() => {
        // windowの型拡張（Three.js関連）
        const win = window as unknown as {
          THREE?: {
            REVISION?: string;
            Scene?: new () => unknown;
            WebGLRenderer?: new () => unknown;
          };
          __THREE_DEVTOOLS__?: {
            scenes?: unknown[];
            renderers?: unknown[];
          };
        };

        // Three.jsが存在しない場合はnull
        if (typeof win.THREE === 'undefined') {
          return null;
        }

        // 結果オブジェクトを初期化
        // Note: exactOptionalPropertyTypes対応のため、undefinedを避けて初期化
        const threeVersion = win.THREE.REVISION;
        const details: {
          version?: string;
          scenes: Array<{
            id: string;
            background?: string;
            fog?: {
              type: string;
              color: string;
              density?: number;
              near?: number;
              far?: number;
            };
            objects: Array<{
              type: string;
              geometry?: string;
              material?: string;
              position?: [number, number, number];
              rotation?: [number, number, number];
              scale?: [number, number, number];
              color?: string;
              intensity?: number;
            }>;
          }>;
          cameras: Array<{
            type: string;
            fov?: number;
            aspect?: number;
            near?: number;
            far?: number;
            position?: [number, number, number];
            left?: number;
            right?: number;
            top?: number;
            bottom?: number;
          }>;
          renderer: {
            antialias?: boolean;
            shadowMap?: boolean;
            toneMapping?: string;
            outputColorSpace?: string;
            pixelRatio?: number;
          };
          performance: {
            fps?: number;
            drawCalls?: number;
            triangles?: number;
            points?: number;
            lines?: number;
          };
          textures?: string[];
        } = {
          scenes: [],
          cameras: [],
          renderer: {},
          performance: {},
          textures: [],
        };

        // versionがundefinedでない場合のみ設定
        if (threeVersion !== undefined) {
          details.version = threeVersion;
        }

        // WebGLコンテキストからレンダラー情報を取得
        const canvases = document.querySelectorAll('canvas');
        let webglContextCount = 0;

        canvases.forEach((canvas, index) => {
          try {
            const gl =
              (canvas.getContext('webgl') as WebGLRenderingContext | null) ||
              (canvas.getContext('webgl2') as WebGL2RenderingContext | null);

            if (!gl) return;
            webglContextCount++;

            // WebGLコンテキスト属性からレンダラー情報を推定
            const attrs = gl.getContextAttributes();
            if (attrs && index === 0) {
              // 最初のcanvasの設定をレンダラー情報として採用
              details.renderer = {
                antialias: attrs.antialias ?? false,
                // preserveDrawingBuffer, premultipliedAlphaなども取得可能だが省略
              };
            }

            // シーン情報（簡易版: canvas要素ベース）
            details.scenes.push({
              id: `scene-${index}`,
              objects: [],
            });

            // WebGL拡張情報からパフォーマンス統計を取得試行
            // 注: renderer.infoへの直接アクセスは不可のため、推定値のみ
            try {
              // WEBGL_debug_renderer_infoは一部ブラウザで取得可能
              // ただしプライバシー保護のため詳細は取得しない
              const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
              if (debugExt) {
                // デバッグ情報が取得可能な場合のみフラグを設定
                // 実際のGPU情報はプライバシー上の理由で省略
              }
            } catch {
              // 拡張取得失敗は無視
            }
          } catch {
            // コンテキスト取得失敗は無視
          }
        });

        // __THREE_DEVTOOLS__から追加情報を取得（開発ツール拡張使用時）
        if (win.__THREE_DEVTOOLS__) {
          try {
            const devtools = win.__THREE_DEVTOOLS__;

            // シーン情報を更新
            if (Array.isArray(devtools.scenes)) {
              details.scenes = devtools.scenes.map((scene, index) => {
                const sceneObj = scene as Record<string, unknown>;
                const sceneId = (sceneObj.uuid as string) || `scene-${index}`;
                let background: string | undefined;
                let fog:
                  | {
                      type: string;
                      color: string;
                      density?: number;
                      near?: number;
                      far?: number;
                    }
                  | undefined;

                // 背景色を取得
                if (sceneObj.background) {
                  const bg = sceneObj.background as Record<string, unknown>;
                  if (typeof bg.getHexString === 'function') {
                    background = `#${(bg.getHexString as () => string)()}`;
                  }
                }

                // フォグ情報を取得
                if (sceneObj.fog) {
                  const fogObj = sceneObj.fog as Record<string, unknown>;
                  const fogColor = fogObj.color as Record<string, unknown> | undefined;
                  // exactOptionalPropertyTypes対応: undefinedを直接代入しない
                  const fogData: {
                    type: string;
                    color: string;
                    density?: number;
                    near?: number;
                    far?: number;
                  } = {
                    type: fogObj.isFogExp2 ? 'FogExp2' : 'Fog',
                    color:
                      fogColor && typeof fogColor.getHexString === 'function'
                        ? `#${(fogColor.getHexString as () => string)()}`
                        : '#000000',
                  };
                  // 数値プロパティは存在する場合のみ設定
                  if (typeof fogObj.density === 'number') {
                    fogData.density = fogObj.density;
                  }
                  if (typeof fogObj.near === 'number') {
                    fogData.near = fogObj.near;
                  }
                  if (typeof fogObj.far === 'number') {
                    fogData.far = fogObj.far;
                  }
                  fog = fogData;
                }

                // 子オブジェクトを取得（最大20個に制限）
                const objects: Array<{
                  type: string;
                  geometry?: string;
                  material?: string;
                  position?: [number, number, number];
                  rotation?: [number, number, number];
                  scale?: [number, number, number];
                  color?: string;
                  intensity?: number;
                }> = [];

                if (Array.isArray(sceneObj.children)) {
                  const children = sceneObj.children.slice(0, 20) as Array<
                    Record<string, unknown>
                  >;
                  for (const child of children) {
                    const objType = (child.type as string) || 'Object3D';
                    const obj: {
                      type: string;
                      geometry?: string;
                      material?: string;
                      position?: [number, number, number];
                      rotation?: [number, number, number];
                      scale?: [number, number, number];
                      color?: string;
                      intensity?: number;
                    } = { type: objType };

                    // ジオメトリ情報
                    if (child.geometry) {
                      const geo = child.geometry as Record<string, unknown>;
                      obj.geometry = (geo.type as string) || 'BufferGeometry';
                    }

                    // マテリアル情報
                    if (child.material) {
                      const mat = child.material as Record<string, unknown>;
                      obj.material = (mat.type as string) || 'Material';
                    }

                    // 位置情報
                    if (child.position) {
                      const pos = child.position as Record<string, unknown>;
                      if (
                        typeof pos.x === 'number' &&
                        typeof pos.y === 'number' &&
                        typeof pos.z === 'number'
                      ) {
                        obj.position = [pos.x, pos.y, pos.z];
                      }
                    }

                    // 回転情報
                    if (child.rotation) {
                      const rot = child.rotation as Record<string, unknown>;
                      if (
                        typeof rot.x === 'number' &&
                        typeof rot.y === 'number' &&
                        typeof rot.z === 'number'
                      ) {
                        obj.rotation = [rot.x, rot.y, rot.z];
                      }
                    }

                    // スケール情報
                    if (child.scale) {
                      const scl = child.scale as Record<string, unknown>;
                      if (
                        typeof scl.x === 'number' &&
                        typeof scl.y === 'number' &&
                        typeof scl.z === 'number'
                      ) {
                        obj.scale = [scl.x, scl.y, scl.z];
                      }
                    }

                    // ライト固有情報
                    if (objType.includes('Light')) {
                      if (child.color) {
                        const col = child.color as Record<string, unknown>;
                        if (typeof col.getHexString === 'function') {
                          obj.color = `#${(col.getHexString as () => string)()}`;
                        }
                      }
                      if (typeof child.intensity === 'number') {
                        obj.intensity = child.intensity;
                      }
                    }

                    objects.push(obj);
                  }
                }

                // exactOptionalPropertyTypes対応: undefinedを直接代入しない
                const sceneData: {
                  id: string;
                  background?: string;
                  fog?: {
                    type: string;
                    color: string;
                    density?: number;
                    near?: number;
                    far?: number;
                  };
                  objects: typeof objects;
                } = {
                  id: sceneId,
                  objects,
                };
                if (background !== undefined) {
                  sceneData.background = background;
                }
                if (fog !== undefined) {
                  sceneData.fog = fog;
                }
                return sceneData;
              });
            }

            // レンダラー情報を更新
            if (Array.isArray(devtools.renderers) && devtools.renderers.length > 0) {
              const renderer = devtools.renderers[0] as Record<string, unknown>;

              // シャドウマップ
              if (renderer.shadowMap) {
                const sm = renderer.shadowMap as Record<string, unknown>;
                details.renderer.shadowMap = sm.enabled === true;
              }

              // トーンマッピング
              if (typeof renderer.toneMapping === 'number') {
                // Three.js ToneMappingを文字列にマッピング
                const toneMappingMap: Record<number, string> = {
                  0: 'NoToneMapping',
                  1: 'LinearToneMapping',
                  2: 'ReinhardToneMapping',
                  3: 'CineonToneMapping',
                  4: 'ACESFilmicToneMapping',
                };
                details.renderer.toneMapping =
                  toneMappingMap[renderer.toneMapping] || 'Unknown';
              }

              // 出力カラースペース
              if (typeof renderer.outputColorSpace === 'string') {
                details.renderer.outputColorSpace = renderer.outputColorSpace;
              }

              // ピクセル比
              if (typeof renderer.getPixelRatio === 'function') {
                try {
                  details.renderer.pixelRatio = (
                    renderer.getPixelRatio as () => number
                  )();
                } catch {
                  // 取得失敗は無視
                }
              }

              // パフォーマンス統計
              if (renderer.info) {
                const info = renderer.info as Record<string, unknown>;
                const render = info.render as Record<string, unknown> | undefined;

                if (render) {
                  if (typeof render.calls === 'number') {
                    details.performance.drawCalls = render.calls;
                  }
                  if (typeof render.triangles === 'number') {
                    details.performance.triangles = render.triangles;
                  }
                  if (typeof render.points === 'number') {
                    details.performance.points = render.points;
                  }
                  if (typeof render.lines === 'number') {
                    details.performance.lines = render.lines;
                  }
                }
              }
            }
          } catch {
            // DevTools情報取得失敗は無視
          }
        }

        // シーン数が0の場合、WebGLコンテキスト数に基づいて生成
        if (details.scenes.length === 0 && webglContextCount > 0) {
          for (let i = 0; i < webglContextCount; i++) {
            details.scenes.push({
              id: `scene-${i}`,
              objects: [],
            });
          }
        }

        return details;
      });

      // 処理時間を計測
      const processingTimeMs = Date.now() - startTime;

      if (isDevelopment()) {
        logger.debug('[JSAnimationDetector] Three.js details detected', {
          hasDetails: result !== null,
          version: result?.version,
          scenesCount: result?.scenes.length ?? 0,
          camerasCount: result?.cameras.length ?? 0,
          processingTimeMs,
        });
      }

      return result;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[JSAnimationDetector] Three.js details detection failed', { error });
      }
      return null;
    }
  }
  /* eslint-enable no-undef */

  /**
   * アニメーションライブラリを検出
   */
  /* eslint-disable no-undef -- page.evaluate() runs in browser context */
  private async detectLibraries(page: Page): Promise<LibraryDetectionResult> {
    try {
      const result = await page.evaluate(() => {
        // windowの型拡張
        const win = window as unknown as {
          gsap?: {
            version?: string;
            globalTimeline?: {
              getChildren?: () => unknown[];
            };
          };
          anime?: {
            running?: unknown[];
          };
          THREE?: {
            REVISION?: string;
          };
          lottie?: {
            getRegisteredAnimations?: () => unknown[];
          };
        };

        // GSAP 検出
        const gsapDetected = typeof win.gsap !== 'undefined';
        let gsapVersion: string | undefined;
        let gsapTweens = 0;

        if (gsapDetected && win.gsap) {
          gsapVersion = win.gsap.version;
          // GSAPのアクティブなアニメーション数を取得
          try {
            const timeline = win.gsap.globalTimeline;
            if (timeline?.getChildren) {
              gsapTweens = timeline.getChildren().length;
            }
          } catch {
            // 取得失敗は無視
          }
        }

        // Framer Motion 検出（data-framer-* 属性で判定）
        const framerMotionElements = document.querySelectorAll(
          '[data-framer-appear-id], [data-framer-name], [data-framer-component-type]'
        );
        const framerMotionDetected = framerMotionElements.length > 0;

        // Anime.js 検出
        const animeDetected = typeof win.anime !== 'undefined';
        let animeInstances = 0;
        if (animeDetected && win.anime?.running) {
          animeInstances = win.anime.running.length;
        }

        // Three.js 検出
        const threeDetected = typeof win.THREE !== 'undefined';
        let threeScenes = 0;
        if (threeDetected) {
          // canvas要素でWebGLコンテキストを使用しているものをカウント
          const canvases = document.querySelectorAll('canvas');
          canvases.forEach((canvas) => {
            try {
              const gl =
                canvas.getContext('webgl') || canvas.getContext('webgl2');
              if (gl) {
                threeScenes++;
              }
            } catch {
              // コンテキスト取得失敗は無視
            }
          });
        }

        // Lottie 検出
        const lottieDetected = typeof win.lottie !== 'undefined';
        let lottieAnimations = 0;
        if (lottieDetected && win.lottie?.getRegisteredAnimations) {
          try {
            lottieAnimations = win.lottie.getRegisteredAnimations().length;
          } catch {
            // 取得失敗は無視
          }
        }

        // Lottie要素も検出（lottie-player, dotlottie-player）
        const lottieElements = document.querySelectorAll(
          'lottie-player, dotlottie-player, [data-lottie]'
        );
        if (lottieElements.length > 0) {
          lottieAnimations = Math.max(lottieAnimations, lottieElements.length);
        }

        return {
          gsap: {
            detected: gsapDetected,
            version: gsapVersion,
            tweens: gsapTweens,
          },
          framerMotion: {
            detected: framerMotionDetected,
            elements: framerMotionElements.length,
          },
          anime: {
            detected: animeDetected,
            instances: animeInstances,
          },
          three: {
            detected: threeDetected,
            scenes: threeScenes,
          },
          lottie: {
            detected: lottieDetected || lottieElements.length > 0,
            animations: lottieAnimations,
          },
        };
      });

      // Three.js詳細情報を取得（Three.jsが検出された場合のみ）
      let threeDetails: ThreeJSDetails | undefined;
      if (result.three.detected) {
        const details = await this.detectThreeJSDetails(page);
        if (details) {
          threeDetails = details;
        }
      }

      // 信頼度情報を追加（各ライブラリごとに）
      const finalResult: LibraryDetectionResult = {
        gsap: {
          ...result.gsap,
          confidence: result.gsap.detected
            ? calculateConfidence(['library_signature'], [
                `Library: GSAP`,
                ...(result.gsap.version ? [`Version: ${result.gsap.version}`] : []),
                ...(result.gsap.tweens ? [`Active tweens: ${result.gsap.tweens}`] : []),
              ])
            : undefined,
        },
        framerMotion: {
          ...result.framerMotion,
          confidence: result.framerMotion.detected
            ? calculateConfidence(['library_signature'], [
                `Library: Framer Motion`,
                `Elements with data-framer-*: ${result.framerMotion.elements}`,
              ])
            : undefined,
        },
        anime: {
          ...result.anime,
          confidence: result.anime.detected
            ? calculateConfidence(['library_signature'], [
                `Library: anime.js`,
                ...(result.anime.instances
                  ? [`Running instances: ${result.anime.instances}`]
                  : []),
              ])
            : undefined,
        },
        three: {
          ...result.three,
          details: threeDetails,
          confidence: result.three.detected
            ? calculateConfidence(['library_signature'], [
                `Library: Three.js`,
                ...(threeDetails?.version ? [`Version: ${threeDetails.version}`] : []),
                `WebGL scenes: ${result.three.scenes}`,
              ])
            : undefined,
        },
        lottie: {
          ...result.lottie,
          confidence: result.lottie.detected
            ? calculateConfidence(['library_signature'], [
                `Library: Lottie`,
                `Animations: ${result.lottie.animations}`,
              ])
            : undefined,
        },
      };

      if (isDevelopment()) {
        logger.debug('[JSAnimationDetector] Libraries detected', {
          gsap: finalResult.gsap.detected,
          framerMotion: finalResult.framerMotion.detected,
          anime: finalResult.anime.detected,
          three: finalResult.three.detected,
          threeDetails: finalResult.three.details !== undefined,
          lottie: finalResult.lottie.detected,
        });
      }

      return finalResult;
    } catch (error) {
      if (isDevelopment()) {
        logger.error('[JSAnimationDetector] Library detection failed', { error });
      }

      return {
        gsap: { detected: false, version: undefined, tweens: undefined },
        framerMotion: { detected: false, elements: undefined },
        anime: { detected: false, instances: undefined },
        three: { detected: false, scenes: undefined, details: undefined },
        lottie: { detected: false, animations: undefined },
      };
    }
  }
  /* eslint-enable no-undef */

  /**
   * JSアニメーションを検出
   *
   * @param page - Playwrightページオブジェクト
   * @param options - 検出オプション
   * @returns 検出結果
   */
  async detect(
    page: Page,
    options?: JSAnimationDetectOptions
  ): Promise<JSAnimationResult> {
    const startTime = Date.now();
    const opts = { ...DEFAULT_OPTIONS, ...options };

    if (isDevelopment()) {
      logger.debug('[JSAnimationDetector] detect called', {
        enableCDP: opts.enableCDP,
        enableWebAnimations: opts.enableWebAnimations,
        enableLibraryDetection: opts.enableLibraryDetection,
        waitTime: opts.waitTime,
      });
    }

    // 並列で検出を実行
    const [cdpAnimations, webAnimations, libraries] = await Promise.all([
      opts.enableCDP ? this.detectCDPAnimations(page, opts.waitTime) : Promise.resolve([]),
      opts.enableWebAnimations ? this.detectWebAnimations(page) : Promise.resolve([]),
      opts.enableLibraryDetection
        ? this.detectLibraries(page)
        : Promise.resolve({
            gsap: { detected: false, version: undefined, tweens: undefined },
            framerMotion: { detected: false, elements: undefined },
            anime: { detected: false, instances: undefined },
            three: { detected: false, scenes: undefined },
            lottie: { detected: false, animations: undefined },
          }),
    ]);

    const detectionTimeMs = Date.now() - startTime;

    // 総検出数を計算
    const totalDetected =
      cdpAnimations.length +
      webAnimations.length +
      (libraries.gsap.tweens ?? 0) +
      (libraries.framerMotion.elements ?? 0) +
      (libraries.anime.instances ?? 0) +
      (libraries.lottie.animations ?? 0);

    // 総合信頼度スコアを計算（使用されたソースを集約）
    const usedSources: DetectionSource[] = [];
    const overallRationale: string[] = [];

    if (opts.enableCDP && cdpAnimations.length > 0) {
      usedSources.push('cdp');
      overallRationale.push(`CDP animations detected: ${cdpAnimations.length}`);
    }
    if (opts.enableWebAnimations && webAnimations.length > 0) {
      usedSources.push('web_animations_api');
      overallRationale.push(`Web Animations detected: ${webAnimations.length}`);
    }
    if (opts.enableLibraryDetection) {
      const detectedLibraries: string[] = [];
      if (libraries.gsap.detected) detectedLibraries.push('GSAP');
      if (libraries.framerMotion.detected) detectedLibraries.push('Framer Motion');
      if (libraries.anime.detected) detectedLibraries.push('anime.js');
      if (libraries.three.detected) detectedLibraries.push('Three.js');
      if (libraries.lottie.detected) detectedLibraries.push('Lottie');

      if (detectedLibraries.length > 0) {
        usedSources.push('library_signature');
        overallRationale.push(`Libraries detected: ${detectedLibraries.join(', ')}`);
      }
    }

    overallRationale.push(`Detection time: ${detectionTimeMs}ms`);

    const overallConfidence =
      usedSources.length > 0
        ? calculateConfidence(usedSources, overallRationale)
        : calculateConfidence([], ['No animations detected']);

    const result: JSAnimationResult = {
      cdpAnimations,
      webAnimations,
      libraries,
      detectionTimeMs,
      totalDetected,
      overallConfidence,
    };

    if (isDevelopment()) {
      logger.info('[JSAnimationDetector] Detection completed', {
        cdpAnimations: cdpAnimations.length,
        webAnimations: webAnimations.length,
        totalDetected,
        detectionTimeMs,
        overallConfidenceScore: overallConfidence.score,
      });
    }

    return result;
  }

  /**
   * CDPセッションをクリーンアップ
   */
  async cleanup(): Promise<void> {
    if (this.cdpSession) {
      try {
        await this.cdpSession.send('Animation.disable');
        await this.cdpSession.detach();
      } catch {
        // クリーンアップエラーは無視
      }
      this.cdpSession = null;
    }

    this.cdpAnimations.clear();
    this.isListening = false;

    if (isDevelopment()) {
      logger.debug('[JSAnimationDetector] Cleanup completed');
    }
  }
}

// =====================================================
// ファクトリ関数
// =====================================================

/**
 * JSAnimationDetectorService インスタンスを作成
 */
export function createJSAnimationDetector(): JSAnimationDetectorService {
  return new JSAnimationDetectorService();
}
