// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * page.analyze タイムアウトユーティリティ
 *
 * 各分析フェーズに個別タイムアウトを適用するためのユーティリティ関数。
 * Graceful Degradation: タイムアウト時は部分結果を返却し、警告に記録する。
 *
 * v0.1.0: Progressive/Strict戦略、WebGL検出によるタイムアウト延長をサポート
 *
 * @module tools/page/handlers/timeout-utils
 */

import { logger, isDevelopment } from '../../../utils/logger';
import {
  PAGE_ANALYZE_TIMEOUTS,
  PAGE_ANALYZE_ERROR_CODES,
  type AnalysisWarning,
  type TimeoutStrategy,
  type ExecutionStatus,
} from '../schemas';
import {
  VisionTimeouts,
  HardwareType,
  TimeoutCalculator,
} from '../../../services/vision/timeout-calculator';

// Re-export for external use
export { VisionTimeouts, HardwareType };

/**
 * 最大延長タイムアウト（25分）
 *
 * CPU_LARGE (20分) + オーバーヘッド (5分) を考慮した最大値。
 * ユーザー指定のタイムアウトがこれより大きい場合はユーザー指定を使用。
 */
export const MAX_EXTENDED_TIMEOUT = 25 * 60 * 1000; // 25分 = 1,500,000ms

/**
 * タイムアウトエラー
 */
export class PhaseTimeoutError extends Error {
  public readonly phase: string;
  public readonly timeoutMs: number;

  constructor(phase: string, timeoutMs: number) {
    super(`${phase} timed out after ${timeoutMs}ms`);
    this.name = 'PhaseTimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * タイムアウト付きでPromiseを実行
 *
 * @param promise - 実行するPromise
 * @param timeoutMs - タイムアウト時間（ms）
 * @param phaseName - フェーズ名（ログ・エラーメッセージ用）
 * @returns Promise結果
 * @throws PhaseTimeoutError タイムアウト時
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phaseName: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new PhaseTimeoutError(phaseName, timeoutMs));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    if (timeoutId) clearTimeout(timeoutId);
    return result;
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    throw error;
  }
}

/**
 * タイムアウト付きで分析フェーズを実行（Graceful Degradation対応）
 *
 * タイムアウト時は警告を記録し、成功フラグをfalseで返す。
 *
 * @param promise - 実行するPromise
 * @param timeoutMs - タイムアウト時間（ms）
 * @param phaseName - フェーズ名
 * @param feature - 警告用の機能名
 * @param warnings - 警告を追加する配列
 * @returns 結果（タイムアウト時はnull）
 */
export async function withTimeoutGraceful<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phaseName: string,
  feature: 'layout' | 'motion' | 'quality',
  warnings: AnalysisWarning[]
): Promise<T | null> {
  const startTime = Date.now();

  try {
    const result = await withTimeout(promise, timeoutMs, phaseName);

    if (isDevelopment()) {
      logger.debug(`[page.analyze] ${phaseName} completed`, {
        durationMs: Date.now() - startTime,
        timeoutMs,
      });
    }

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;

    if (error instanceof PhaseTimeoutError) {
      if (isDevelopment()) {
        logger.warn(`[page.analyze] ${phaseName} timed out (graceful degradation)`, {
          timeoutMs,
          durationMs,
        });
      }

      warnings.push({
        feature,
        code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR,
        message: `${phaseName} timed out after ${timeoutMs}ms (graceful degradation)`,
      });

      return null;
    }

    // タイムアウト以外のエラーもGraceful Degradationで処理
    // 各フェーズの失敗は全体の処理を中断せず、warningsに記録して継続
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (isDevelopment()) {
      logger.warn(`[page.analyze] ${phaseName} failed (graceful degradation)`, {
        errorMessage,
        durationMs,
      });
    }

    // feature に応じたエラーコードを選択
    const errorCode = feature === 'layout'
      ? PAGE_ANALYZE_ERROR_CODES.LAYOUT_ANALYSIS_FAILED
      : feature === 'motion'
        ? PAGE_ANALYZE_ERROR_CODES.MOTION_DETECTION_FAILED
        : PAGE_ANALYZE_ERROR_CODES.QUALITY_EVALUATION_FAILED;

    warnings.push({
      feature,
      code: errorCode,
      message: `${phaseName} failed: ${errorMessage} (graceful degradation)`,
    });

    return null;
  }
}

/**
 * タイムアウト分配オプション
 */
export interface DistributeTimeoutOptions {
  /** 全体タイムアウト（ms） */
  overallTimeout: number;
  /** フレームキャプチャが有効か */
  hasFrameCapture: boolean;
  /** JSアニメーション検出が有効か */
  hasJsAnimation: boolean;
  /**
   * WebGLサイト検出情報（v0.1.0）
   * WebGLサイトの場合、モーション検出タイムアウトを延長
   */
  webglInfo?: {
    detected: boolean;
    multiplier: number;
  };
}

/**
 * ハードウェア情報（Vision CPU完走保証 Phase 4用）
 *
 * CPU環境でVision分析を使用する場合、layoutAnalysisタイムアウトを
 * VisionTimeoutsに基づいて自動延長する。
 */
export interface HardwareInfoForTimeout {
  /** ハードウェアタイプ（GPU/CPU） */
  type: HardwareType;
  /** Vision分析が有効か */
  isVisionEnabled: boolean;
  /** 画像サイズ（バイト）- CPU環境でのタイムアウト計算に使用 */
  imageSizeBytes?: number;
}

/**
 * calculateEffectiveTimeout の入力オプション
 */
export interface CalculateEffectiveTimeoutOptions {
  /** 元のタイムアウト（ユーザー指定または default） */
  originalTimeout: number;
  /** ハードウェアタイプ */
  hardwareType: HardwareType;
  /** Vision分析が有効か */
  isVisionEnabled: boolean;
  /** 画像サイズ（バイト）- CPU環境でのタイムアウト計算に使用 */
  imageSizeBytes?: number;
}

/**
 * calculateEffectiveTimeout の戻り値
 */
export interface CalculateEffectiveTimeoutResult {
  /** 有効タイムアウト（ms） */
  effectiveTimeout: number;
  /** タイムアウトが延長されたか */
  extended: boolean;
  /** 延長理由（extended=trueの場合のみ） */
  reason?: string;
}

/**
 * 有効なタイムアウトを計算（Vision CPU完走保証 Phase 4）
 *
 * CPU環境でVision分析を使用する場合、適切なタイムアウトを自動計算する。
 * - GPU環境: 元のタイムアウトを維持
 * - CPU環境 + Vision有効: VisionTimeoutsに基づいて延長
 * - ユーザー指定タイムアウトが計算値より大きい場合: ユーザー指定を使用
 *
 * @param options - 計算オプション
 * @returns 有効タイムアウトと延長情報
 */
export function calculateEffectiveTimeout(
  options: CalculateEffectiveTimeoutOptions
): CalculateEffectiveTimeoutResult {
  const { originalTimeout, hardwareType, isVisionEnabled, imageSizeBytes } = options;

  // GPU環境またはVision無効の場合は延長なし
  if (hardwareType === HardwareType.GPU || !isVisionEnabled) {
    return {
      effectiveTimeout: originalTimeout,
      extended: false,
    };
  }

  // CPU環境 + Vision有効: タイムアウト計算
  const calculator = new TimeoutCalculator();
  const calculatedTimeout = calculator.calculate(hardwareType, imageSizeBytes);

  // 最大延長タイムアウトを超えない
  const clampedTimeout = Math.min(calculatedTimeout, MAX_EXTENDED_TIMEOUT);

  // ユーザー指定タイムアウトが計算値より大きい場合はユーザー指定を使用
  if (originalTimeout >= clampedTimeout) {
    return {
      effectiveTimeout: originalTimeout,
      extended: false,
    };
  }

  // 延長が必要
  if (isDevelopment()) {
    logger.debug('[timeout-utils] CPU Vision timeout extension', {
      originalTimeout,
      calculatedTimeout,
      clampedTimeout,
      hardwareType,
      imageSizeBytes,
    });
  }

  return {
    effectiveTimeout: clampedTimeout,
    extended: true,
    reason: `CPU environment with Vision enabled (${calculator.formatTimeout(clampedTimeout)})`,
  };
}

/**
 * ユーザー指定のタイムアウトを各フェーズに分配
 *
 * 全体タイムアウトから各フェーズに適切なタイムアウトを割り当てる。
 * フェーズ間の依存関係を考慮して配分。
 *
 * v0.1.0: WebGLサイト検出時はモーション検出タイムアウトを延長
 * v0.1.0: CPU環境でVision分析を使用する場合、layoutAnalysisタイムアウトを延長
 *
 * @param overallTimeout - 全体タイムアウト（ms）
 * @param hasFrameCapture - フレームキャプチャが有効か
 * @param hasJsAnimation - JSアニメーション検出が有効か
 * @param webglInfo - WebGLサイト情報（オプション）
 * @param hardwareInfo - ハードウェア情報（Vision CPU完走保証 Phase 4）
 * @returns 各フェーズのタイムアウト
 */
export function distributeTimeout(
  overallTimeout: number,
  hasFrameCapture: boolean,
  hasJsAnimation: boolean,
  webglInfo?: { detected: boolean; multiplier: number },
  hardwareInfo?: HardwareInfoForTimeout
): {
  fetchHtml: number;
  layoutAnalysis: number;
  motionDetection: number;
  qualityEvaluation: number;
  frameCapture: number;
  jsAnimationDetection: number;
  dbSave: number;
} {
  // デフォルト値から開始
  const defaults = { ...PAGE_ANALYZE_TIMEOUTS };

  // CSS静的解析のみの場合のモーション検出タイムアウト（外部CSS取得 + 解析 + 任意Vision検出）
  // 外部CSS取得: 5秒/ファイル × 最大20ファイル（並列5）= 約20秒 + 解析1秒 + Vision検出10秒 + オーバーヘッド
  const CSS_ONLY_MOTION_TIMEOUT = 45000; // 45秒（v0.1.0: Vision検出時間を考慮して30秒から増加）

  // WebGL検出時の追加タイムアウト乗数（JSアニメーション検出有効時のみ適用）
  // WebGLサイトはPlaywright起動 + ページ読み込み + CDP検出に時間がかかるため
  const webglMultiplier = (webglInfo?.detected && hasJsAnimation)
    ? webglInfo.multiplier
    : 1.0;

  // モーションタイムアウトを有効な機能に基づいて計算
  // v0.1.0: JSアニメーション有効時は加算方式に変更（重いWebGLサイト対応）
  let motionTimeout: number;
  if (hasFrameCapture || hasJsAnimation) {
    // フレームキャプチャとJSアニメーションを加算
    const baseMotion = defaults.MOTION_DETECTION;
    const frameCapturePortion = hasFrameCapture ? defaults.FRAME_CAPTURE : 0;
    const jsAnimationPortion = hasJsAnimation ? defaults.JS_ANIMATION_DETECTION : 0;

    // 加算方式: CSS解析 + フレームキャプチャ + JSアニメーション
    motionTimeout = baseMotion + frameCapturePortion + jsAnimationPortion;

    // WebGL乗数を適用（JSアニメーション有効時のみ）
    motionTimeout = Math.floor(motionTimeout * webglMultiplier);
  } else {
    motionTimeout = CSS_ONLY_MOTION_TIMEOUT; // CSS静的解析のみは30秒で十分
  }

  // defaultTotalを有効な機能に基づいて動的に計算
  // これにより、video mode/JS animationが無効の場合、他のフェーズにより多くの時間が割り当てられる
  const defaultTotal =
    defaults.FETCH_HTML +
    defaults.LAYOUT_ANALYSIS +
    motionTimeout + // 動的に計算されたモーションタイムアウト
    defaults.QUALITY_EVALUATION +
    defaults.DB_SAVE;

  const ratio = Math.min(1, overallTimeout / defaultTotal);

  // 最小タイムアウトを保証（タイムアウトが短すぎると処理が完了しない）
  // ただし、合計がoverallTimeoutを超えないように調整
  const MIN_MOTION_TIMEOUT = 30000; // CSS解析には最低30秒必要（外部CSS取得+任意Vision含む）

  // フレームキャプチャ有効時の最小モーションタイムアウト（v0.1.0）
  // video mode: Playwright起動 + スクロールキャプチャ + 任意フレーム分析
  const MIN_FRAME_CAPTURE_MOTION_TIMEOUT = 120000; // 2分

  // WebGLサイト + JSアニメーション有効時の最小モーションタイムアウト
  const MIN_WEBGL_JS_MOTION_TIMEOUT = 180000; // 3分

  // 計算されたタイムアウトに最小値を適用（モーション検出のみ）
  // モーション検出は外部CSS取得を含むため、最低時間を保証
  // 優先順位: WebGL+JS > FrameCapture > CSS-only
  const minMotionTimeout = (webglInfo?.detected && hasJsAnimation)
    ? MIN_WEBGL_JS_MOTION_TIMEOUT
    : hasFrameCapture
      ? MIN_FRAME_CAPTURE_MOTION_TIMEOUT
      : MIN_MOTION_TIMEOUT;

  const calculatedMotionTimeout = Math.max(minMotionTimeout, Math.floor(motionTimeout * ratio));
  let calculatedLayoutTimeout = Math.floor(defaults.LAYOUT_ANALYSIS * ratio);
  const calculatedQualityTimeout = Math.floor(defaults.QUALITY_EVALUATION * ratio);
  const calculatedDbTimeout = Math.floor(defaults.DB_SAVE * ratio);

  // =====================================================
  // Vision CPU完走保証 Phase 4: CPU環境でのlayoutAnalysisタイムアウト延長
  // =====================================================
  // CPU環境でVision分析が有効な場合、layoutAnalysisタイムアウトを
  // VisionTimeoutsに基づいて自動延長する。これにより、内部のVision分析が
  // 外側のphaseタイムアウトで先にタイムアウトすることを防ぐ。
  if (hardwareInfo?.isVisionEnabled && hardwareInfo.type === HardwareType.CPU) {
    const calculator = new TimeoutCalculator();
    const visionRequiredTimeout = calculator.calculate(
      hardwareInfo.type,
      hardwareInfo.imageSizeBytes
    );

    // layoutAnalysisタイムアウトがVision必要時間より短い場合は延長
    if (calculatedLayoutTimeout < visionRequiredTimeout) {
      if (isDevelopment()) {
        logger.debug('[timeout-utils] CPU Vision timeout extension for layoutAnalysis', {
          originalLayoutTimeout: calculatedLayoutTimeout,
          visionRequiredTimeout,
          hardwareType: hardwareInfo.type,
          imageSizeBytes: hardwareInfo.imageSizeBytes,
        });
      }
      calculatedLayoutTimeout = visionRequiredTimeout;
    }
  }

  // JSアニメーション検出タイムアウトもWebGL乗数を適用
  const calculatedJsAnimationTimeout = Math.floor(
    defaults.JS_ANIMATION_DETECTION * ratio * webglMultiplier
  );

  if (isDevelopment()) {
    logger.debug('[timeout-utils] distributeTimeout calculated', {
      overallTimeout,
      hasFrameCapture,
      hasJsAnimation,
      webglDetected: webglInfo?.detected ?? false,
      webglMultiplier,
      motionTimeout,
      minMotionTimeout,
      defaultTotal,
      ratio,
      calculatedMotionTimeout,
      calculatedJsAnimationTimeout,
      calculatedLayoutTimeout,
      calculatedQualityTimeout,
      // Vision CPU完走保証 Phase 4
      hardwareType: hardwareInfo?.type,
      visionEnabled: hardwareInfo?.isVisionEnabled,
      cpuExtended: hardwareInfo?.isVisionEnabled && hardwareInfo.type === HardwareType.CPU,
    });
  }

  return {
    fetchHtml: Math.floor(defaults.FETCH_HTML * ratio),
    layoutAnalysis: calculatedLayoutTimeout,
    motionDetection: calculatedMotionTimeout,
    qualityEvaluation: calculatedQualityTimeout,
    frameCapture: Math.floor(defaults.FRAME_CAPTURE * ratio),
    jsAnimationDetection: calculatedJsAnimationTimeout,
    dbSave: calculatedDbTimeout,
  };
}

/**
 * 残り時間を計算
 *
 * @param startTime - 開始時刻
 * @param overallTimeout - 全体タイムアウト
 * @param minTimeout - 最小タイムアウト（これ以下にはならない）
 * @returns 残り時間（ms）
 */
export function getRemainingTimeout(
  startTime: number,
  overallTimeout: number,
  minTimeout: number = 5000
): number {
  const elapsed = Date.now() - startTime;
  const remaining = overallTimeout - elapsed;
  return Math.max(remaining, minTimeout);
}

// =====================================================
// Execution Status Tracker (v0.1.0)
// =====================================================

/**
 * 分析フェーズの種類
 */
export type AnalysisPhase = 'html' | 'screenshot' | 'layout' | 'motion' | 'quality';

/**
 * フェーズの優先順位（低い値が高優先）
 */
export const PHASE_PRIORITY: Record<AnalysisPhase, number> = {
  html: 1,
  screenshot: 2,
  layout: 3,
  motion: 4,
  quality: 5,
};

/**
 * ExecutionStatus追跡クラス
 *
 * 分析の実行状態を追跡し、progressive/strict戦略に基づいて
 * 部分結果を返却するかどうかを判断する。
 */
/**
 * ハードウェア情報（ExecutionStatus用）
 */
export interface HardwareInfoForStatus {
  type: HardwareType;
  vramBytes?: number;
  isGpuAvailable?: boolean;
}

export class ExecutionStatusTracker {
  private completedPhases: Set<AnalysisPhase> = new Set();
  private failedPhases: Set<AnalysisPhase> = new Set();
  /** タイムアウトで失敗したフェーズを個別に追跡（v0.1.0） */
  private timedoutPhases: Set<'layout' | 'motion' | 'quality'> = new Set();
  private startTime: number;
  private timeoutOccurred: boolean = false;
  private webglDetected: boolean = false;
  private timeoutExtended: boolean = false;
  private originalTimeoutMs: number;
  private effectiveTimeoutMs: number;
  private strategy: TimeoutStrategy;
  private partialResultsEnabled: boolean;
  /** フェーズごとのタイムアウト設定（v0.1.0） */
  private phaseTimeouts: { layout: number; motion: number; quality: number } | undefined;
  /** CPU環境でタイムアウトが延長されたか（Vision CPU完走保証 Phase 4） */
  private cpuModeExtended: boolean = false;
  /** ハードウェア情報（Vision CPU完走保証 Phase 4） */
  private hardwareInfo: HardwareInfoForStatus | undefined;

  constructor(options: {
    originalTimeoutMs: number;
    effectiveTimeoutMs: number;
    strategy: TimeoutStrategy;
    partialResultsEnabled: boolean;
    webglDetected?: boolean;
    timeoutExtended?: boolean;
    /** フェーズごとのタイムアウト設定（v0.1.0） */
    phaseTimeouts?: { layout: number; motion: number; quality: number };
    /** CPU環境でタイムアウトが延長されたか（Vision CPU完走保証 Phase 4） */
    cpuModeExtended?: boolean;
    /** ハードウェア情報（Vision CPU完走保証 Phase 4） */
    hardwareInfo?: HardwareInfoForStatus;
  }) {
    this.startTime = Date.now();
    this.originalTimeoutMs = options.originalTimeoutMs;
    this.effectiveTimeoutMs = options.effectiveTimeoutMs;
    this.strategy = options.strategy;
    this.partialResultsEnabled = options.partialResultsEnabled;
    this.webglDetected = options.webglDetected ?? false;
    this.timeoutExtended = options.timeoutExtended ?? false;
    this.cpuModeExtended = options.cpuModeExtended ?? false;
    // exactOptionalPropertyTypes対応: undefinedを直接代入せず条件付きで代入
    if (options.phaseTimeouts) {
      this.phaseTimeouts = options.phaseTimeouts;
    }
    if (options.hardwareInfo) {
      this.hardwareInfo = options.hardwareInfo;
    }
  }

  /**
   * フェーズの完了を記録
   */
  markCompleted(phase: AnalysisPhase): void {
    this.completedPhases.add(phase);
    this.failedPhases.delete(phase); // 完了したら失敗リストから削除
    // タイムアウトフェーズからも削除
    if (phase === 'layout' || phase === 'motion' || phase === 'quality') {
      this.timedoutPhases.delete(phase);
    }
  }

  /**
   * フェーズの失敗を記録
   */
  markFailed(phase: AnalysisPhase, isTimeout: boolean = false): void {
    this.failedPhases.add(phase);
    if (isTimeout) {
      this.timeoutOccurred = true;
      // タイムアウトで失敗したフェーズを個別に追跡（v0.1.0）
      if (phase === 'layout' || phase === 'motion' || phase === 'quality') {
        this.timedoutPhases.add(phase);
      }
    }
  }

  /**
   * WebGL検出を記録
   */
  setWebGLDetected(detected: boolean, extended: boolean): void {
    this.webglDetected = detected;
    this.timeoutExtended = extended;
  }

  /**
   * 有効タイムアウトを更新
   */
  updateEffectiveTimeout(newTimeout: number): void {
    this.effectiveTimeoutMs = newTimeout;
  }

  /**
   * フェーズごとのタイムアウト設定を更新（v0.1.0）
   *
   * phaseTimeouts計算後に呼び出すことで、ExecutionStatusに
   * 各フェーズのタイムアウト設定を含めることができる。
   */
  setPhaseTimeouts(timeouts: { layout: number; motion: number; quality: number }): void {
    this.phaseTimeouts = timeouts;
  }

  /**
   * ExecutionStatusオブジェクトを生成
   */
  toExecutionStatus(): ExecutionStatus {
    // 完了フェーズを優先順位でソート
    const completedArray = Array.from(this.completedPhases).sort(
      (a, b) => PHASE_PRIORITY[a] - PHASE_PRIORITY[b]
    );

    // 失敗フェーズを優先順位でソート
    const failedArray = Array.from(this.failedPhases).sort(
      (a, b) => PHASE_PRIORITY[a] - PHASE_PRIORITY[b]
    );

    // タイムアウトフェーズを優先順位でソート（v0.1.0）
    const TIMEOUT_PHASE_PRIORITY: Record<'layout' | 'motion' | 'quality', number> = {
      layout: 2,
      motion: 3,
      quality: 4,
    };
    const timedoutArray = Array.from(this.timedoutPhases).sort(
      (a, b) => TIMEOUT_PHASE_PRIORITY[a] - TIMEOUT_PHASE_PRIORITY[b]
    );

    const result: ExecutionStatus = {
      completed_phases: completedArray,
      failed_phases: failedArray,
      timeout_occurred: this.timeoutOccurred,
      actual_duration_ms: Date.now() - this.startTime,
      webgl_detected: this.webglDetected,
      timeout_extended: this.timeoutExtended,
    };

    // タイムアウトしたフェーズがある場合のみ追加（v0.1.0）
    if (timedoutArray.length > 0) {
      result.timedout_phases = timedoutArray;
    }

    // フェーズごとのタイムアウト設定を追加（v0.1.0）
    if (this.phaseTimeouts) {
      result.phase_timeouts = this.phaseTimeouts;
    }

    // タイムアウトが延長された場合のみ、元のタイムアウト値を含める
    if (this.timeoutExtended) {
      result.original_timeout_ms = this.originalTimeoutMs;
      result.effective_timeout_ms = this.effectiveTimeoutMs;
    }

    // Vision CPU完走保証 Phase 4: CPU環境での延長情報を追加
    if (this.cpuModeExtended) {
      result.cpu_mode_extended = true;
    }

    // ハードウェアタイプを追加
    if (this.hardwareInfo) {
      result.hardware_type = this.hardwareInfo.type;
    }

    return result;
  }

  /**
   * 部分結果を返却すべきかどうかを判断
   *
   * @returns true: 部分結果を返却, false: 完全失敗
   */
  shouldReturnPartialResults(): boolean {
    // Strict戦略では部分結果を返却しない
    if (this.strategy === 'strict') {
      return false;
    }

    // Progressive戦略かつpartial_results=trueの場合
    if (!this.partialResultsEnabled) {
      return false;
    }

    // 少なくともHTMLが取得できていれば部分結果を返却
    return this.completedPhases.has('html');
  }

  /**
   * 全フェーズが完了したかどうか
   */
  isFullyCompleted(): boolean {
    const allPhases: AnalysisPhase[] = ['html', 'screenshot', 'layout', 'motion', 'quality'];
    return allPhases.every(
      (phase) => this.completedPhases.has(phase) || !this.isPhaseEnabled(phase)
    );
  }

  /**
   * 特定のフェーズが有効かどうか（featuresオプションで無効化されていないか）
   * 注: この実装ではデフォルトでtrueを返す。実際の使用時にはfeaturesを渡す必要がある。
   */
  private isPhaseEnabled(_phase: AnalysisPhase): boolean {
    // この関数は実際の使用時にオーバーライドまたは拡張される
    return true;
  }

  /**
   * 処理時間を取得
   */
  getElapsedTime(): number {
    return Date.now() - this.startTime;
  }

  /**
   * タイムアウトが発生したかどうか
   */
  hasTimedOut(): boolean {
    return this.timeoutOccurred;
  }

  /**
   * 戦略を取得
   */
  getStrategy(): TimeoutStrategy {
    return this.strategy;
  }
}

/**
 * Progressive/Strict戦略に基づいてタイムアウト処理を実行
 *
 * @param promise - 実行するPromise
 * @param timeoutMs - タイムアウト時間（ms）
 * @param phaseName - フェーズ名
 * @param phase - 分析フェーズ
 * @param tracker - ExecutionStatusTracker
 * @param warnings - 警告を追加する配列
 * @returns 結果（タイムアウト時はnull、strict戦略ではthrow）
 */
export async function withTimeoutAndTracking<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phaseName: string,
  phase: AnalysisPhase,
  tracker: ExecutionStatusTracker,
  warnings: AnalysisWarning[]
): Promise<T | null> {
  const startTime = Date.now();

  try {
    const result = await withTimeout(promise, timeoutMs, phaseName);

    // 成功を記録
    tracker.markCompleted(phase);

    if (isDevelopment()) {
      logger.debug(`[page.analyze] ${phaseName} completed`, {
        durationMs: Date.now() - startTime,
        timeoutMs,
        phase,
      });
    }

    return result;
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const isTimeout = error instanceof PhaseTimeoutError;

    // 失敗を記録
    tracker.markFailed(phase, isTimeout);

    if (isTimeout) {
      if (isDevelopment()) {
        logger.warn(`[page.analyze] ${phaseName} timed out`, {
          timeoutMs,
          durationMs,
          phase,
          strategy: tracker.getStrategy(),
        });
      }

      // Strict戦略の場合は例外を再スロー
      if (tracker.getStrategy() === 'strict') {
        throw error;
      }

      // Progressive戦略の場合は警告を記録してnullを返す
      const feature = phase === 'html' || phase === 'screenshot' ? 'layout' : phase as 'layout' | 'motion' | 'quality';
      warnings.push({
        feature,
        code: PAGE_ANALYZE_ERROR_CODES.TIMEOUT_ERROR,
        message: `${phaseName} timed out after ${timeoutMs}ms (graceful degradation)`,
      });

      return null;
    }

    // タイムアウト以外のエラー
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (isDevelopment()) {
      logger.warn(`[page.analyze] ${phaseName} failed`, {
        errorMessage,
        durationMs,
        phase,
        strategy: tracker.getStrategy(),
      });
    }

    // Strict戦略の場合は例外を再スロー
    if (tracker.getStrategy() === 'strict') {
      throw error;
    }

    // Progressive戦略の場合は警告を記録してnullを返す
    const feature = phase === 'html' || phase === 'screenshot' ? 'layout' : phase as 'layout' | 'motion' | 'quality';
    const errorCode = feature === 'layout'
      ? PAGE_ANALYZE_ERROR_CODES.LAYOUT_ANALYSIS_FAILED
      : feature === 'motion'
        ? PAGE_ANALYZE_ERROR_CODES.MOTION_DETECTION_FAILED
        : PAGE_ANALYZE_ERROR_CODES.QUALITY_EVALUATION_FAILED;

    warnings.push({
      feature,
      code: errorCode,
      message: `${phaseName} failed: ${errorMessage} (graceful degradation)`,
    });

    return null;
  }
}
