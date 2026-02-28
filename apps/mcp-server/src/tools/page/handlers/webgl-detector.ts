// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * WebGL/3Dコンテンツ検出ユーティリティ
 *
 * HTMLからWebGL/3Dライブラリの使用を早期検出し、
 * タイムアウトを自動延長するかどうかを判断する。
 *
 * Phase4-1: WebGL自動検出・設定切替機能を追加
 * - URL/ドメインベースの事前検出（preDetect）
 * - HTMLコンテンツベースの詳細検出（analyzeHtml）
 * - 検出結果から最適な設定を自動決定（getRecommendedConfig）
 *
 * @module tools/page/handlers/webgl-detector
 */

import { logger, isDevelopment } from '../../../utils/logger';
import {
  preDetectWebGL as preDetectWebGLFromPreDetector,
  detectSiteTier as detectSiteTierFromPreDetector,
  KNOWN_ULTRA_HEAVY_DOMAINS,
  KNOWN_HEAVY_DOMAINS,
} from './webgl-pre-detector';
import { type SiteTier } from './retry-strategy';

// ============================================================================
// Phase4-1: 新しい統合型インターフェース
// ============================================================================

/**
 * 統合WebGL検出結果
 *
 * URL事前検出とHTML解析の両方の結果を統合した形式
 */
export interface WebGLDetectionResult {
  /** WebGL/3Dコンテンツが検出されたか（統合判定） */
  isWebGL: boolean;
  /** 検出の確信度（0-1、正規化済み） */
  confidence: number;
  /** サイト種別（normal/webgl/heavy/ultra-heavy） */
  siteTier: SiteTier;
  /** 検出されたライブラリ一覧 */
  detectedLibraries: string[];
  /** 検出の根拠（詳細） */
  indicators: {
    /** 既知ドメインとのマッチ */
    domainMatch: boolean;
    /** URLパターンマッチ */
    urlPatternMatch: boolean;
    /** HTML内で検出されたインジケータ */
    htmlIndicators: string[];
    /** スクリプト内で検出されたインジケータ */
    scriptIndicators: string[];
  };
  /** 推奨設定（自動計算） */
  recommendedConfig: RecommendedConfig;

  // === 後方互換性フィールド ===
  /** @deprecated Use isWebGL instead */
  detected: boolean;
  /** @deprecated Use detectedLibraries instead */
  libraries: string[];
  /** @deprecated Use indicators for detailed evidence */
  evidence: string[];
}

/**
 * 推奨Playwright/Browser設定
 *
 * WebGL検出結果に基づいて最適な設定を提供
 */
export interface RecommendedConfig {
  /** GPU有効化（--use-angle=gl） */
  enableGPU: boolean;
  /** WebGL初期化待機を有効化 */
  waitForWebGL: boolean;
  /** WebGL初期化待機時間（ms） */
  webglWaitMs: number;
  /** タイムアウト（ms） */
  timeout: number;
  /** ページ読み込み完了条件 */
  waitUntil: 'load' | 'domcontentloaded' | 'networkidle';
  /** JavaScript無効化 */
  disableJavaScript: boolean;
  /** WebGL無効化（--disable-gpu等） */
  disableWebGL: boolean;
  /** タイムアウト時に強制終了 */
  forceKillOnTimeout: boolean;
}

/**
 * 後方互換性用の旧WebGL検出結果インターフェース
 * @deprecated Use WebGLDetectionResult instead
 */
export interface LegacyWebGLDetectionResult {
  detected: boolean;
  libraries: string[];
  confidence: number;
  evidence: string[];
}

/**
 * WebGL/3Dライブラリのパターン
 *
 * 重み付け基準:
 * - 1.0: 確実にWebGL使用（Three.js, Babylon.js等）
 * - 0.8-0.9: 高確率でWebGL使用（raw-webgl, regl等）
 * - 0.6-0.7: WebGL使用の可能性（Pixi.js, p5.js等）
 * - 0.3-0.4: 重いアニメーション（GSAP, Lottie等）
 */
const WEBGL_PATTERNS: Array<{
  name: string;
  patterns: RegExp[];
  weight: number;
}> = [
  {
    name: 'three.js',
    patterns: [
      /three\.(?:min\.)?js/i,
      /THREE\s*\./,
      /new\s+THREE\./,
      /three\/build\/three/i,
      /@three\/examples/i,
    ],
    weight: 1.0,
  },
  {
    name: 'babylon.js',
    patterns: [
      /babylon\.(?:min\.)?js/i,
      /BABYLON\s*\./,
      /new\s+BABYLON\./,
      /babylonjs/i,
    ],
    weight: 1.0,
  },
  {
    name: 'a-frame',
    patterns: [
      /aframe\.(?:min\.)?js/i,
      /<a-scene/i,
      /<a-entity/i,
      /AFRAME\s*\./,
    ],
    weight: 0.9,
  },
  {
    name: 'playcanvas',
    patterns: [
      /playcanvas\.(?:min\.)?js/i,
      /pc\.Application/i,
      /playcanvas/i,
    ],
    weight: 1.0,
  },
  {
    name: 'pixi.js',
    patterns: [
      /pixi\.(?:min\.)?js/i,
      /PIXI\s*\./,
      /new\s+PIXI\./,
      /@pixi\//i,
    ],
    weight: 0.7, // PixiはWebGLだが2Dが多い
  },
  {
    name: 'p5.js',
    patterns: [
      /p5\.(?:min\.)?js/i,
      /new\s+p5\(/i,
      /createCanvas\s*\(\s*\d+\s*,\s*\d+\s*,\s*WEBGL/i,
    ],
    weight: 0.6,
  },
  {
    name: 'raw-webgl',
    patterns: [
      /getContext\s*\(\s*['"]webgl['"]/i,
      /getContext\s*\(\s*['"]webgl2['"]/i,
      /getContext\s*\(\s*['"]experimental-webgl['"]/i,
      /WebGLRenderingContext/i,
      /WebGL2RenderingContext/i,
    ],
    weight: 0.8,
  },
  {
    name: 'regl',
    patterns: [
      /regl\.(?:min\.)?js/i,
      /createREGL/i,
      /require\s*\(\s*['"]regl['"]\)/i,
    ],
    weight: 0.9,
  },
  {
    name: 'ogl',
    patterns: [
      /ogl\.(?:min\.)?js/i,
      /OGL\s*\./,
      /import\s+.*\s+from\s+['"]ogl['"]/i,
    ],
    weight: 0.9,
  },
  // Phase4-1: アニメーションライブラリを追加
  {
    name: 'gsap',
    patterns: [
      /gsap\.(?:min\.)?js/i,
      /gsap\./i,
      /TweenMax/i,
      /TweenLite/i,
      /ScrollTrigger/i,
      /gsap\.registerPlugin/i,
      /gsap\.to\s*\(/i,
      /gsap\.from\s*\(/i,
      /gsap\.timeline/i,
    ],
    weight: 0.4, // GSAPは重いアニメーションだがWebGLではない
  },
  {
    name: 'lottie',
    patterns: [
      /lottie\.(?:min\.)?js/i,
      /lottie\./i,
      /bodymovin\.(?:min\.)?js/i,
      /bodymovin\./i,
      /lottie\.loadAnimation/i,
      /lottie-web/i,
    ],
    weight: 0.3, // Lottieは比較的軽い
  },
  {
    name: 'gl-matrix',
    patterns: [
      /gl-matrix\.(?:min\.)?js/i,
      /glMatrix/i,
      /mat4\.create/i,
      /vec3\.create/i,
    ],
    weight: 0.5, // WebGL補助ライブラリ
  },
  {
    name: 'gpu.js',
    patterns: [
      /gpu\.(?:min\.)?js/i,
      /new\s+GPU\s*\(/i,
      /gpu\.createKernel/i,
    ],
    weight: 0.8, // GPU.jsはWebGL使用
  },
];

/**
 * 重いアニメーション/レンダリングのパターン
 */
const HEAVY_ANIMATION_PATTERNS: Array<{
  name: string;
  patterns: RegExp[];
  weight: number;
}> = [
  {
    name: 'canvas-animation',
    patterns: [
      /requestAnimationFrame/i,
      /cancelAnimationFrame/i,
    ],
    weight: 0.3, // 単独では弱い証拠
  },
  {
    name: 'shader',
    patterns: [
      /gl\.createShader/i,
      /gl\.shaderSource/i,
      /gl\.compileShader/i,
      /vertexShader/i,
      /fragmentShader/i,
      /glsl/i,
    ],
    weight: 0.7,
  },
  {
    name: 'webxr',
    patterns: [
      /navigator\.xr/i,
      /XRSession/i,
      /immersive-vr/i,
      /immersive-ar/i,
    ],
    weight: 1.0,
  },
];

/**
 * HTMLからWebGL/3Dコンテンツを検出
 *
 * @param html - 解析対象のHTML文字列
 * @returns WebGL検出結果（後方互換性用レガシー形式）
 * @deprecated Use WebGLDetector.analyzeHtml() for full detection capabilities
 */
export function detectWebGL(html: string): LegacyWebGLDetectionResult {
  const libraries: string[] = [];
  const evidence: string[] = [];
  let totalWeight = 0;

  // WebGLライブラリの検出
  for (const lib of WEBGL_PATTERNS) {
    for (const pattern of lib.patterns) {
      if (pattern.test(html)) {
        if (!libraries.includes(lib.name)) {
          libraries.push(lib.name);
          totalWeight += lib.weight;
        }
        evidence.push(`${lib.name}: ${pattern.source}`);
        break; // 同じライブラリの複数パターンはカウントしない
      }
    }
  }

  // 重いアニメーションパターンの検出
  for (const anim of HEAVY_ANIMATION_PATTERNS) {
    for (const pattern of anim.patterns) {
      if (pattern.test(html)) {
        totalWeight += anim.weight;
        evidence.push(`${anim.name}: ${pattern.source}`);
        break;
      }
    }
  }

  // Canvas要素の検出（WebGL使用の可能性）
  const canvasCount = (html.match(/<canvas/gi) ?? []).length;
  if (canvasCount > 0) {
    totalWeight += Math.min(canvasCount * 0.2, 0.6);
    evidence.push(`canvas elements: ${canvasCount}`);
  }

  // 確信度を計算（0-1にクランプ）
  const confidence = Math.min(totalWeight / 2, 1);

  // WebGL検出判定（確信度0.5以上で検出とする）
  const detected = confidence >= 0.5 || libraries.length > 0;

  if (isDevelopment() && detected) {
    logger.debug('[webgl-detector] WebGL content detected', {
      libraries,
      confidence,
      evidenceCount: evidence.length,
    });
  }

  return {
    detected,
    libraries,
    confidence,
    evidence,
  };
}

/**
 * WebGL検出に基づいてタイムアウトを調整
 *
 * @param originalTimeout - 元のタイムアウト値（ms）
 * @param webglResult - WebGL検出結果（レガシー形式）
 * @returns 調整後のタイムアウト値（ms）
 * @deprecated Use WebGLDetector.getRecommendedConfig() for full configuration
 */
export function adjustTimeoutForWebGL(
  originalTimeout: number,
  webglResult: LegacyWebGLDetectionResult
): {
  effectiveTimeout: number;
  extended: boolean;
} {
  // WebGL未検出の場合は元のタイムアウトをそのまま使用
  if (!webglResult.detected) {
    return {
      effectiveTimeout: originalTimeout,
      extended: false,
    };
  }

  // WebGL検出時のタイムアウト延長
  // - 確信度0.5-0.7: 1.5倍
  // - 確信度0.7-0.9: 2倍
  // - 確信度0.9以上: 2.5倍
  let multiplier: number;
  if (webglResult.confidence >= 0.9) {
    multiplier = 2.5;
  } else if (webglResult.confidence >= 0.7) {
    multiplier = 2.0;
  } else {
    multiplier = 1.5;
  }

  // 最大タイムアウトは300秒（5分）
  const MAX_TIMEOUT = 300000;
  const extendedTimeout = Math.min(originalTimeout * multiplier, MAX_TIMEOUT);

  // 元のタイムアウトがすでに延長後の値より大きい場合は延長しない
  if (originalTimeout >= extendedTimeout) {
    return {
      effectiveTimeout: originalTimeout,
      extended: false,
    };
  }

  if (isDevelopment()) {
    logger.debug('[webgl-detector] Timeout extended for WebGL', {
      originalTimeout,
      extendedTimeout,
      multiplier,
      confidence: webglResult.confidence,
    });
  }

  return {
    effectiveTimeout: extendedTimeout,
    extended: true,
  };
}

/**
 * デフォルトのWebGLタイムアウト延長値
 * 60秒 -> 120秒
 */
export const DEFAULT_WEBGL_TIMEOUT_EXTENSION = 120000;

/**
 * WebGL検出しきい値
 * この確信度以上でWebGL検出とみなす
 */
export const WEBGL_DETECTION_THRESHOLD = 0.5;

// ============================================================================
// Phase4-1: WebGLDetector クラス（統合版）
// ============================================================================

/**
 * シグナル重み付け設定
 *
 * 各シグナルに重みを付けて信頼度スコアを計算
 */
const SIGNAL_WEIGHTS = {
  /** 既知WebGLドメインマッチ */
  knownWebGLDomain: 0.8,
  /** Canvas要素検出 */
  canvasElement: 0.3,
  /** Three.jsスクリプト検出 */
  threeJsScript: 0.9,
  /** Babylon.jsスクリプト検出 */
  babylonJsScript: 0.9,
  /** Pixi.jsスクリプト検出 */
  pixiJsScript: 0.7,
  /** WebGLコンテキスト検出 */
  webglContext: 0.8,
  /** GSAPスクリプト検出 */
  gsapScript: 0.4,
  /** Lottieスクリプト検出 */
  lottieScript: 0.3,
  /** URLパターンマッチ */
  urlPattern: 0.5,
} as const;

/**
 * 統合WebGL検出クラス
 *
 * URL事前検出とHTML解析の両方をサポートし、
 * 最適な設定を自動決定する。
 *
 * @example
 * ```typescript
 * // URL事前検出
 * const urlResult = WebGLDetector.preDetect('https://resn.co.nz');
 * console.log(urlResult.siteTier); // 'ultra-heavy'
 *
 * // HTML解析
 * const htmlResult = WebGLDetector.analyzeHtml(htmlContent);
 * console.log(htmlResult.detectedLibraries); // ['three.js']
 *
 * // 推奨設定取得
 * const config = WebGLDetector.getRecommendedConfig(htmlResult);
 * console.log(config.enableGPU); // true
 * ```
 */
export class WebGLDetector {
  /**
   * URLからWebGL/Three.jsサイトかどうかを事前推定
   *
   * HTML取得前にURLパターンからWebGLサイトかを推定し、
   * 適切な設定を先制的に決定する。
   *
   * @param url - 検査対象URL
   * @returns 統合検出結果
   */
  static preDetect(url: string): WebGLDetectionResult {
    // 既存の事前検出関数を使用
    const preResult = preDetectWebGLFromPreDetector(url);
    const siteTier = detectSiteTierFromPreDetector(url, preResult);

    // 統合形式に変換
    const detectedLibraries: string[] = [];
    const htmlIndicators: string[] = [];
    const scriptIndicators: string[] = [];

    // 信頼度計算
    let confidence = preResult.confidence;

    // ドメインマッチの場合はライブラリとして記録
    if (preResult.matchedDomain) {
      // ultra-heavyドメインの場合はThree.js使用と推定
      if (KNOWN_ULTRA_HEAVY_DOMAINS.includes(preResult.matchedDomain)) {
        detectedLibraries.push('three.js');
      }
      // heavyドメインの場合もThree.js使用と推定
      if (KNOWN_HEAVY_DOMAINS.includes(preResult.matchedDomain)) {
        detectedLibraries.push('three.js');
      }
    }

    // 推奨設定を計算
    const recommendedConfig = this.getRecommendedConfigInternal({
      isWebGL: preResult.isLikelyWebGL,
      confidence,
      siteTier,
    });

    return {
      isWebGL: preResult.isLikelyWebGL,
      confidence,
      siteTier,
      detectedLibraries,
      indicators: {
        domainMatch: !!preResult.matchedDomain,
        urlPatternMatch: !!preResult.matchedPattern,
        htmlIndicators,
        scriptIndicators,
      },
      recommendedConfig,
      // 後方互換性
      detected: preResult.isLikelyWebGL,
      libraries: detectedLibraries,
      evidence: preResult.matchedDomain
        ? [`Domain: ${preResult.matchedDomain}`]
        : preResult.matchedPattern
          ? [`URL pattern: ${preResult.matchedPattern}`]
          : [],
    };
  }

  /**
   * HTMLコンテンツからWebGL/3Dコンテンツを検出
   *
   * HTML内のスクリプト、Canvas要素、WebGLコンテキストを検出し、
   * 信頼度スコアを計算する。
   *
   * @param html - 解析対象のHTML文字列
   * @returns 統合検出結果
   */
  static analyzeHtml(html: string): WebGLDetectionResult {
    // 空文字列の場合は早期リターン
    if (!html || html.trim() === '') {
      return this.createEmptyResult();
    }

    const detectedLibraries: string[] = [];
    const htmlIndicators: string[] = [];
    const scriptIndicators: string[] = [];
    const evidence: string[] = [];
    let totalWeight = 0;

    // WebGLライブラリの検出
    for (const lib of WEBGL_PATTERNS) {
      for (const pattern of lib.patterns) {
        if (pattern.test(html)) {
          if (!detectedLibraries.includes(lib.name)) {
            detectedLibraries.push(lib.name);
            totalWeight += lib.weight;
          }
          scriptIndicators.push(`${lib.name}: ${pattern.source}`);
          evidence.push(`${lib.name}: ${pattern.source}`);
          break; // 同じライブラリの複数パターンはカウントしない
        }
      }
    }

    // 重いアニメーションパターンの検出
    for (const anim of HEAVY_ANIMATION_PATTERNS) {
      for (const pattern of anim.patterns) {
        if (pattern.test(html)) {
          totalWeight += anim.weight;
          scriptIndicators.push(`${anim.name}: ${pattern.source}`);
          evidence.push(`${anim.name}: ${pattern.source}`);
          break;
        }
      }
    }

    // Canvas要素の検出
    const canvasMatches = html.match(/<canvas/gi);
    const canvasCount = canvasMatches?.length ?? 0;
    if (canvasCount > 0) {
      htmlIndicators.push(`canvas elements: ${canvasCount}`);
      evidence.push(`canvas elements: ${canvasCount}`);
      // Canvas単独では弱い証拠
      totalWeight += Math.min(canvasCount * 0.2, 0.6);
    }

    // 信頼度を計算（0-1に正規化）
    const confidence = Math.min(totalWeight / 2, 1);

    // SiteTierを決定
    const siteTier = this.determineSiteTier(confidence, detectedLibraries);

    // WebGL判定（WebGLライブラリが検出された場合、または信頼度が高い場合）
    const hasWebGLLibrary = detectedLibraries.some((lib) =>
      ['three.js', 'babylon.js', 'pixi.js', 'a-frame', 'playcanvas', 'raw-webgl', 'regl', 'ogl', 'gpu.js'].includes(lib)
    );
    const isWebGL = hasWebGLLibrary || confidence >= WEBGL_DETECTION_THRESHOLD;

    // 推奨設定を計算
    const recommendedConfig = this.getRecommendedConfigInternal({
      isWebGL,
      confidence,
      siteTier,
    });

    if (isDevelopment() && isWebGL) {
      logger.debug('[WebGLDetector.analyzeHtml] WebGL content detected', {
        detectedLibraries,
        confidence,
        siteTier,
        htmlIndicatorCount: htmlIndicators.length,
        scriptIndicatorCount: scriptIndicators.length,
      });
    }

    return {
      isWebGL,
      confidence,
      siteTier,
      detectedLibraries,
      indicators: {
        domainMatch: false,
        urlPatternMatch: false,
        htmlIndicators,
        scriptIndicators,
      },
      recommendedConfig,
      // 後方互換性
      detected: isWebGL,
      libraries: detectedLibraries,
      evidence,
    };
  }

  /**
   * 検出結果から推奨設定を取得
   *
   * 外部から呼び出し可能な公開メソッド。
   * WebGLDetectionResultからrecommendedConfigを除いた型を受け付ける。
   *
   * @param result - 検出結果（recommendedConfigなし）
   * @returns 推奨設定
   */
  static getRecommendedConfig(
    result: Omit<WebGLDetectionResult, 'recommendedConfig'>
  ): RecommendedConfig {
    return this.getRecommendedConfigInternal({
      isWebGL: result.isWebGL,
      confidence: result.confidence,
      siteTier: result.siteTier,
    });
  }

  /**
   * 信頼度とライブラリからSiteTierを決定
   *
   * @param confidence - 信頼度（0-1）
   * @param detectedLibraries - 検出されたライブラリ一覧
   * @returns SiteTier
   */
  private static determineSiteTier(
    confidence: number,
    detectedLibraries: string[]
  ): SiteTier {
    // 重いWebGLライブラリが検出された場合
    const hasHeavyWebGL = detectedLibraries.some((lib) =>
      ['three.js', 'babylon.js', 'a-frame', 'playcanvas'].includes(lib)
    );

    // 信頼度とライブラリに基づいてSiteTierを決定
    if (hasHeavyWebGL && confidence >= 0.7) {
      return 'ultra-heavy';
    }
    if (hasHeavyWebGL || confidence >= 0.5) {
      return 'heavy';
    }
    if (confidence >= 0.3) {
      return 'webgl';
    }
    return 'normal';
  }

  /**
   * 内部用: 推奨設定を計算
   *
   * @param params - 計算パラメータ
   * @returns 推奨設定
   */
  private static getRecommendedConfigInternal(params: {
    isWebGL: boolean;
    confidence: number;
    siteTier: SiteTier;
  }): RecommendedConfig {
    // Note: confidence is available for future granular configuration based on confidence level
    const { isWebGL, siteTier } = params;

    // 通常サイト
    if (!isWebGL || siteTier === 'normal') {
      return {
        enableGPU: false,
        waitForWebGL: false,
        webglWaitMs: 0,
        timeout: 60000, // 1分
        waitUntil: 'load',
        disableJavaScript: false,
        disableWebGL: false,
        forceKillOnTimeout: false,
      };
    }

    // WebGLサイト
    switch (siteTier) {
      case 'ultra-heavy':
        return {
          enableGPU: true,
          waitForWebGL: true,
          webglWaitMs: 5000,
          timeout: 180000, // 3分
          waitUntil: 'networkidle',
          disableJavaScript: false,
          disableWebGL: false,
          forceKillOnTimeout: true, // ultra-heavyでは強制終了有効
        };

      case 'heavy':
        return {
          enableGPU: true,
          waitForWebGL: true,
          webglWaitMs: 3000,
          timeout: 120000, // 2分
          waitUntil: 'networkidle',
          disableJavaScript: false,
          disableWebGL: false,
          forceKillOnTimeout: false,
        };

      case 'webgl':
      default:
        return {
          enableGPU: true,
          waitForWebGL: true,
          webglWaitMs: 2000,
          timeout: 90000, // 1.5分
          waitUntil: 'networkidle',
          disableJavaScript: false,
          disableWebGL: false,
          forceKillOnTimeout: false,
        };
    }
  }

  /**
   * 空の検出結果を生成
   */
  private static createEmptyResult(): WebGLDetectionResult {
    return {
      isWebGL: false,
      confidence: 0,
      siteTier: 'normal',
      detectedLibraries: [],
      indicators: {
        domainMatch: false,
        urlPatternMatch: false,
        htmlIndicators: [],
        scriptIndicators: [],
      },
      recommendedConfig: {
        enableGPU: false,
        waitForWebGL: false,
        webglWaitMs: 0,
        timeout: 60000,
        waitUntil: 'load',
        disableJavaScript: false,
        disableWebGL: false,
        forceKillOnTimeout: false,
      },
      // 後方互換性
      detected: false,
      libraries: [],
      evidence: [],
    };
  }

  /**
   * 信頼度スコアを計算（複数シグナルを統合）
   *
   * @param signals - 検出されたシグナル
   * @returns 正規化された信頼度（0-1）
   */
  static calculateConfidence(signals: {
    domainMatch: boolean;
    urlPatternMatch: boolean;
    libraries: string[];
    canvasCount: number;
    webglContext: boolean;
  }): number {
    let totalWeight = 0;
    let maxPossibleWeight = 0;

    // ドメインマッチ
    maxPossibleWeight += SIGNAL_WEIGHTS.knownWebGLDomain;
    if (signals.domainMatch) {
      totalWeight += SIGNAL_WEIGHTS.knownWebGLDomain;
    }

    // URLパターン
    maxPossibleWeight += SIGNAL_WEIGHTS.urlPattern;
    if (signals.urlPatternMatch) {
      totalWeight += SIGNAL_WEIGHTS.urlPattern;
    }

    // ライブラリ検出
    for (const lib of signals.libraries) {
      if (lib === 'three.js') {
        totalWeight += SIGNAL_WEIGHTS.threeJsScript;
        maxPossibleWeight += SIGNAL_WEIGHTS.threeJsScript;
      } else if (lib === 'babylon.js') {
        totalWeight += SIGNAL_WEIGHTS.babylonJsScript;
        maxPossibleWeight += SIGNAL_WEIGHTS.babylonJsScript;
      } else if (lib === 'pixi.js') {
        totalWeight += SIGNAL_WEIGHTS.pixiJsScript;
        maxPossibleWeight += SIGNAL_WEIGHTS.pixiJsScript;
      } else if (lib === 'gsap') {
        totalWeight += SIGNAL_WEIGHTS.gsapScript;
        maxPossibleWeight += SIGNAL_WEIGHTS.gsapScript;
      } else if (lib === 'lottie') {
        totalWeight += SIGNAL_WEIGHTS.lottieScript;
        maxPossibleWeight += SIGNAL_WEIGHTS.lottieScript;
      }
    }

    // Canvas要素
    if (signals.canvasCount > 0) {
      totalWeight += Math.min(signals.canvasCount * 0.1, SIGNAL_WEIGHTS.canvasElement);
      maxPossibleWeight += SIGNAL_WEIGHTS.canvasElement;
    }

    // WebGLコンテキスト
    maxPossibleWeight += SIGNAL_WEIGHTS.webglContext;
    if (signals.webglContext) {
      totalWeight += SIGNAL_WEIGHTS.webglContext;
    }

    // 正規化（0-1）
    if (maxPossibleWeight === 0) return 0;
    return Math.min(totalWeight / maxPossibleWeight, 1);
  }
}
