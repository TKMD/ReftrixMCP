// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * motion.detect パターン変換モジュール
 *
 * 各種サービスの出力をMotionPattern型に変換するロジックを集約。
 * - ServiceMotionPattern → MotionPattern
 * - MotionSegment → MotionPattern (Video Mode)
 * - AnimationInfo → MotionPattern (Runtime Mode)
 *
 * @module tools/motion/pattern-converter
 */

import type {
  MotionPattern,
  EasingConfig,
  AnimatedProperty,
  PerformanceInfo,
  MotionType,
  MotionCategory,
  TriggerType,
  PerformanceLevel,
  EasingType,
  MotionWarning,
} from './schemas';
import { calculatePerformanceLevel } from './schemas';
import type { MotionPattern as ServiceMotionPattern } from '../../services/page/motion-detector.service';
import type { MotionSegment } from '../../services/page/frame-analyzer.service';
import type { AnimationInfo, RuntimeAnimationResult } from '../../services/page/runtime-animation-detector.service';
import type { DetectionResult, RuntimeInfo } from './di-factories';

// =====================================================
// Easing解析ユーティリティ
// =====================================================

/**
 * イージング文字列をEasingConfigオブジェクトに変換
 */
export function parseEasingString(easing: string | undefined): EasingConfig {
  if (!easing) {
    return { type: 'ease' };
  }

  const easingLower = easing.toLowerCase().trim();

  // 標準イージング
  const standardEasings: Record<string, EasingType> = {
    linear: 'linear',
    ease: 'ease',
    'ease-in': 'ease-in',
    'ease-out': 'ease-out',
    'ease-in-out': 'ease-in-out',
  };

  if (standardEasings[easingLower]) {
    return { type: standardEasings[easingLower] };
  }

  // cubic-bezier解析
  const cubicMatch = easing.match(/cubic-bezier\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)/i);
  if (cubicMatch && cubicMatch[1] && cubicMatch[2] && cubicMatch[3] && cubicMatch[4]) {
    return {
      type: 'cubic-bezier',
      cubicBezier: [
        parseFloat(cubicMatch[1]),
        parseFloat(cubicMatch[2]),
        parseFloat(cubicMatch[3]),
        parseFloat(cubicMatch[4]),
      ],
    };
  }

  // steps解析
  const stepsMatch = easing.match(/steps\s*\(\s*(\d+)\s*(?:,\s*(start|end|jump-start|jump-end|jump-both|jump-none))?\s*\)/i);
  if (stepsMatch && stepsMatch[1]) {
    return {
      type: 'steps',
      steps: {
        count: parseInt(stepsMatch[1], 10),
        position: stepsMatch[2] as 'start' | 'end' | 'jump-start' | 'jump-end' | 'jump-both' | 'jump-none' | undefined,
      },
    };
  }

  return { type: 'unknown' };
}

// =====================================================
// ServiceMotionPattern → MotionPattern 変換
// =====================================================

/**
 * MotionDetectorServiceの出力をdetect.tool.tsの型に変換
 *
 * MotionDetectorServiceはflatな構造（duration, easing等が直接プロパティ）を使用するが、
 * detect.tool.tsはネストされた構造（animation.duration, animation.easing等）を使用する
 */
export function adaptServicePattern(servicePattern: ServiceMotionPattern): MotionPattern {
  // easingを文字列からEasingConfigに変換
  let easing: EasingConfig = { type: 'ease' };
  if (servicePattern.easing) {
    const easingStr = servicePattern.easing;
    if (easingStr.startsWith('cubic-bezier')) {
      const match = easingStr.match(/cubic-bezier\(([\d.,\s-]+)\)/);
      if (match && match[1]) {
        const values = match[1].split(',').map((v) => parseFloat(v.trim()));
        if (values.length === 4) {
          easing = {
            type: 'cubic-bezier',
            cubicBezier: values as [number, number, number, number],
          };
        }
      }
    } else if (easingStr.startsWith('steps')) {
      const match = easingStr.match(/steps\((\d+)(?:,\s*(start|end))?\)/);
      if (match && match[1]) {
        easing = {
          type: 'steps',
          steps: {
            count: parseInt(match[1], 10),
            position: (match[2] as 'start' | 'end') || 'end',
          },
        };
      }
    } else if (['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'].includes(easingStr)) {
      easing = { type: easingStr as EasingConfig['type'] };
    }
  }

  // propertiesを変換（propertiesDetailed優先、なければstring[]からフォールバック）
  const properties: AnimatedProperty[] = servicePattern.propertiesDetailed
    ? servicePattern.propertiesDetailed.map((p) => ({
        property: p.property,
        ...(p.from !== undefined && { from: p.from }),
        ...(p.to !== undefined && { to: p.to }),
      }))
    : servicePattern.properties.map((prop) => ({
        property: prop,
      }));

  // performanceを変換
  let performance: PerformanceInfo | undefined;
  if (servicePattern.performance) {
    performance = {
      usesTransform: servicePattern.performance.usesTransform,
      usesOpacity: servicePattern.performance.usesOpacity,
      triggersLayout: servicePattern.performance.triggersLayout ?? false,
      triggersPaint: servicePattern.performance.triggersPaint ?? false,
    };
    performance.level = calculatePerformanceLevel(performance);
  }

  // directionとfillModeの型変換
  const direction = servicePattern.direction as 'normal' | 'reverse' | 'alternate' | 'alternate-reverse' | undefined;
  const fillMode = servicePattern.fillMode as 'none' | 'forwards' | 'backwards' | 'both' | undefined;

  // triggerの型変換（サービス側の型とスキーマ側の型のマッピング）
  type SchemaTriggerType = 'scroll' | 'scroll_velocity' | 'hover' | 'click' | 'focus' | 'load' | 'intersection' | 'time' | 'state_change' | 'unknown';
  const trigger: SchemaTriggerType = servicePattern.trigger as SchemaTriggerType;

  // categoryの型変換
  // v0.1.0: スキーマに新カテゴリを追加したため、直接マッピング可能
  type SchemaCategoryType =
    | 'scroll_trigger'
    | 'hover_effect'
    | 'page_transition'
    | 'loading_state'
    | 'micro_interaction'
    | 'attention_grabber'
    | 'navigation'
    | 'feedback'
    | 'entrance'
    | 'exit'
    | 'marquee'
    | 'video_overlay'
    | 'parallax'
    | 'reveal'
    | 'morphing'
    | 'background_animation'
    | 'typing_animation'
    | 'unknown';
  const categoryMapping: Record<string, SchemaCategoryType> = {
    scroll_trigger: 'scroll_trigger',
    hover_effect: 'hover_effect',
    page_transition: 'page_transition',
    loading_state: 'loading_state',
    micro_interaction: 'micro_interaction',
    attention_grabber: 'attention_grabber',
    navigation: 'navigation',
    feedback: 'feedback',
    entrance: 'entrance',
    exit: 'exit',
    // v0.1.0 new categories
    marquee: 'marquee',
    video_overlay: 'video_overlay',
    parallax: 'parallax',
    reveal: 'reveal',
    morphing: 'morphing',
    background_animation: 'background_animation',
    typing_animation: 'typing_animation',
    unknown: 'unknown',
  };
  const category: SchemaCategoryType = categoryMapping[servicePattern.category] || 'unknown';

  return {
    id: servicePattern.id,
    type: servicePattern.type,
    category,
    name: servicePattern.name,
    selector: servicePattern.selector,
    trigger,
    animation: {
      duration: servicePattern.duration,
      delay: servicePattern.delay,
      easing,
      iterations: servicePattern.iterations,
      direction,
      fillMode,
    },
    properties,
    performance,
    accessibility: servicePattern.accessibility,
    keyframes: servicePattern.keyframes,
    rawCss: servicePattern.rawCss,
  };
}

/**
 * MotionDetectorServiceの出力をDetectionResultに変換
 */
export function adaptServiceResult(serviceResult: {
  patterns: ServiceMotionPattern[];
  warnings: MotionWarning[];
}): DetectionResult {
  return {
    patterns: serviceResult.patterns.map(adaptServicePattern),
    warnings: serviceResult.warnings,
  };
}

// =====================================================
// Video Mode: MotionSegment → MotionPattern 変換
// =====================================================

/**
 * Intensityレベルを判定
 */
function getIntensityLevel(maxChangeRatio: number): 'low' | 'medium' | 'high' {
  if (maxChangeRatio >= 0.25) return 'high';
  if (maxChangeRatio >= 0.10) return 'medium';
  return 'low';
}

/**
 * MotionSegment（フレーム解析結果）からMotionPatternに変換
 *
 * Phase1: 動画キャプチャから検出されたモーションセグメントを
 * MCPツールの出力形式に変換
 */
export function convertMotionSegmentToPattern(
  segment: MotionSegment,
  index: number
): MotionPattern {
  // ユニークIDを生成
  const id = `video-motion-${index + 1}-${Math.round(segment.startMs)}-${Math.round(segment.endMs)}`;

  // セグメントの特性からカテゴリを推定
  let category: MotionPattern['category'] = 'unknown';
  let trigger: MotionPattern['trigger'] = 'load';

  // maxChangeRatio に基づいてカテゴリを推定
  if (segment.maxChangeRatio > 0.25) {
    category = 'page_transition';
  } else if (segment.maxChangeRatio > 0.15) {
    category = 'scroll_trigger';
  } else if (segment.maxChangeRatio > 0.05) {
    category = 'micro_interaction';
  } else {
    category = 'loading_state';
  }

  // durationからトリガータイプを推定
  if (segment.durationMs > 1000) {
    trigger = 'scroll';
  } else if (segment.durationMs > 300) {
    trigger = 'hover';
  }

  // estimatedTypeに基づいてプロパティを推定
  const properties: AnimatedProperty[] = [];
  switch (segment.estimatedType) {
    case 'fade':
      properties.push({ property: 'opacity' });
      break;
    case 'slide':
    case 'scale':
    case 'rotate':
      properties.push({ property: 'transform' });
      break;
    case 'complex':
    default:
      properties.push({ property: 'transform' }, { property: 'opacity' });
      break;
  }

  // パフォーマンス情報
  const performance: PerformanceInfo = {
    usesTransform: properties.some(p => p.property === 'transform'),
    usesOpacity: properties.some(p => p.property === 'opacity'),
    triggersLayout: false,
    triggersPaint: true,
    level: segment.maxChangeRatio > 0.2 ? 'fair' : 'good',
  };

  // easingをEasingConfigに変換
  let easing: EasingConfig = { type: 'ease' };
  if (segment.estimatedEasing && segment.estimatedEasing !== 'unknown') {
    easing = { type: segment.estimatedEasing };
  }

  // intensityレベルを計算
  const intensityLevel = getIntensityLevel(segment.maxChangeRatio);

  return {
    id,
    type: 'video_motion',
    category,
    name: `video-motion-${index + 1}`,
    trigger,
    animation: {
      duration: segment.durationMs,
      delay: segment.startMs,
      easing,
      iterations: 1,
    },
    properties,
    performance,
    accessibility: {
      respectsReducedMotion: false,
    },
    videoMetadata: {
      intensity: intensityLevel,
      startMs: segment.startMs,
      endMs: segment.endMs,
      avgChangeRatio: segment.avgChangeRatio,
      maxChangeRatio: segment.maxChangeRatio,
      estimatedType: segment.estimatedType,
    },
  };
}

// =====================================================
// Runtime Mode: AnimationInfo → MotionPattern 変換
// =====================================================

/**
 * RuntimeAnimationInfoをMotionPatternに変換
 */
export function convertAnimationInfoToPattern(anim: AnimationInfo, index: number): MotionPattern {
  const id = `runtime-${anim.id}`;

  // AnimationTypeからMotionTypeへのマッピング
  const typeMap: Record<string, MotionType> = {
    css_animation: 'css_animation',
    css_transition: 'css_transition',
    web_animations_api: 'library_animation',
  };
  const motionType: MotionType = typeMap[anim.type] || 'library_animation';

  // カテゴリを推定
  let category: MotionCategory = 'micro_interaction';
  if (anim.type === 'css_animation' && anim.animationName) {
    const name = anim.animationName.toLowerCase();
    if (name.includes('fade') || name.includes('appear') || name.includes('enter')) {
      category = 'attention_grabber';
    } else if (name.includes('loading') || name.includes('spin')) {
      category = 'loading_state';
    } else if (name.includes('bounce') || name.includes('pulse')) {
      category = 'feedback';
    } else if (name.includes('hover')) {
      category = 'hover_effect';
    } else if (name.includes('scroll')) {
      category = 'scroll_trigger';
    }
  }

  // トリガーを推定
  const trigger: TriggerType = anim.playState === 'running' ? 'load' : 'unknown';

  // パフォーマンス情報を構築
  const properties = anim.properties || [];
  const usesTransform = properties.some((p) =>
    ['transform', 'translate', 'rotate', 'scale'].includes(p)
  );
  const usesOpacity = properties.includes('opacity');
  const triggersLayout = properties.some((p) =>
    ['width', 'height', 'top', 'left', 'right', 'bottom', 'padding', 'margin'].includes(p)
  );
  const triggersPaint = properties.some((p) =>
    ['background', 'color', 'border', 'box-shadow', 'text-shadow'].includes(p)
  );

  // PerformanceLevelに合わせる
  let performanceLevel: PerformanceLevel = 'good';
  if (triggersLayout) {
    performanceLevel = 'poor';
  } else if (triggersPaint) {
    performanceLevel = 'fair';
  }

  const performance: PerformanceInfo = {
    usesTransform,
    usesOpacity,
    triggersLayout,
    triggersPaint,
    level: performanceLevel,
  };

  // easingをEasingConfigオブジェクトに変換
  const easingConfig = parseEasingString(anim.easing);

  // directionをリテラル型に変換
  const directionMap: Record<string, 'normal' | 'reverse' | 'alternate' | 'alternate-reverse'> = {
    normal: 'normal',
    reverse: 'reverse',
    alternate: 'alternate',
    'alternate-reverse': 'alternate-reverse',
  };
  const direction = anim.direction ? directionMap[anim.direction] : undefined;

  // fillModeをリテラル型に変換
  const fillModeMap: Record<string, 'none' | 'forwards' | 'backwards' | 'both'> = {
    none: 'none',
    forwards: 'forwards',
    backwards: 'backwards',
    both: 'both',
  };
  const fillMode = anim.fillMode ? fillModeMap[anim.fillMode] : undefined;

  return {
    id,
    type: motionType,
    category,
    name: anim.animationName || `runtime-animation-${index + 1}`,
    trigger,
    animation: {
      duration: anim.duration,
      delay: anim.delay || 0,
      easing: easingConfig,
      iterations: anim.iterations === -1 ? 'infinite' : anim.iterations,
      direction,
      fillMode,
    },
    properties: properties.map((p) => ({ property: p })),
    performance,
    accessibility: {
      respectsReducedMotion: false,
    },
    detectionSource: 'runtime',
    runtimeMetadata: {
      detectedAt: new Date().toISOString(),
      animationType: anim.type,
    },
    detected_at: new Date().toISOString(),
  };
}

/**
 * RuntimeAnimationResultをDetectionResultに変換
 */
export function convertRuntimeResultToDetectionResult(
  runtimeResult: RuntimeAnimationResult
): DetectionResult {
  const patterns: MotionPattern[] = [];

  // アニメーションをパターンに変換
  runtimeResult.animations.forEach((anim, index) => {
    patterns.push(convertAnimationInfoToPattern(anim, index));
  });

  // IntersectionObserverに基づくパターン
  runtimeResult.intersectionObservers.forEach((io, index) => {
    patterns.push({
      id: `runtime-io-${io.id}`,
      type: 'library_animation',
      category: 'scroll_trigger',
      name: `intersection-observer-${index + 1}`,
      trigger: 'intersection',
      animation: {
        duration: 0,
        delay: 0,
        easing: { type: 'linear' },
        iterations: 1,
      },
      properties: [],
      performance: {
        usesTransform: false,
        usesOpacity: false,
        triggersLayout: false,
        triggersPaint: false,
        level: 'excellent',
      },
      accessibility: {
        respectsReducedMotion: false,
      },
      detectionSource: 'runtime',
      runtimeMetadata: {
        detectedAt: new Date().toISOString(),
        animationType: 'intersection_observer',
      },
      detected_at: new Date().toISOString(),
    });
  });

  // RAFに基づくパターン
  runtimeResult.rafCallbacks.forEach((raf, index) => {
    if (raf.isActive && raf.callCount > 0) {
      patterns.push({
        id: `runtime-raf-${raf.id}`,
        type: 'library_animation',
        category: 'micro_interaction',
        name: `raf-animation-${index + 1}`,
        trigger: 'load',
        animation: {
          duration: raf.avgFrameTime * raf.callCount,
          delay: 0,
          easing: { type: 'linear' },
          iterations: 1,
        },
        properties: [],
        performance: {
          usesTransform: false,
          usesOpacity: false,
          triggersLayout: false,
          triggersPaint: false,
          level: 'good',
        },
        accessibility: {
          respectsReducedMotion: false,
        },
        detectionSource: 'runtime',
        runtimeMetadata: {
          detectedAt: new Date().toISOString(),
          animationType: 'raf_animation',
        },
        detected_at: new Date().toISOString(),
      });
    }
  });

  // 警告を生成
  const warnings: MotionWarning[] = [];
  if (patterns.length === 0) {
    warnings.push({
      code: 'RUNTIME_NO_ANIMATIONS',
      severity: 'info',
      message: 'No runtime animations detected. The page may use CSS-only animations.',
    });
  }

  // スクロール位置での検出結果を含むランタイム情報
  const runtime_info: RuntimeInfo = {
    wait_time_used: runtimeResult.detectionTimeMs,
    animations_captured: runtimeResult.animations.length,
    scroll_positions_checked: runtimeResult.scrollPositionResults
      ? Object.keys(runtimeResult.scrollPositionResults).map(Number)
      : undefined,
    patterns_by_scroll_position: runtimeResult.scrollPositionResults
      ? Object.fromEntries(
          Object.entries(runtimeResult.scrollPositionResults).map(([pos, result]) => [
            pos,
            result.animationCount,
          ])
        )
      : undefined,
    total_scroll_patterns: runtimeResult.triggeredAnimations?.length,
  };

  return {
    patterns,
    warnings,
    runtime_info,
  };
}
