// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OllamaReadinessProbe - VRAM状態チェックとOllamaサービス準備確認
 *
 * P2-8: Phase 2.5（ScrollVision Analysis）実行前にGPU VRAM状態を確認し、
 * Ollama Vision LLM（llama3.2-vision: ~7.8GB VRAM）を安全に実行できるか判定する。
 *
 * 機能:
 * - nvidia-smi によるGPU VRAM空き容量チェック
 * - Ollama /api/tags による接続確認
 * - VRAM不足時の待機（指数バックオフ付き）
 * - GPU非搭載環境のgraceful degradation
 *
 * @see apps/mcp-server/src/services/vision/hardware-detector.ts
 * @see apps/mcp-server/src/services/vision/scroll-vision.analyzer.ts
 */

import { queryVram } from './vram-utils.js';
import type { VramInfo } from './vram-utils.js';
import { HardwareDetector } from './hardware-detector.js';

// =============================================================================
// 定数
// =============================================================================

/**
 * llama3.2-visionが必要とする最小VRAM（MB）
 *
 * モデルロード時に約7.8GB使用。安全マージン含め8192MBを閾値とする。
 */
const MIN_VRAM_FREE_MB = 8192;

/**
 * VRAM待機の最大リトライ回数
 */
const MAX_WAIT_RETRIES = 3;

/**
 * VRAM待機の基準間隔（ミリ秒）
 * 指数バックオフ: 10s → 20s → 40s
 */
const WAIT_BASE_DELAY_MS = 10000;

/**
 * Ollama APIタイムアウト（ミリ秒）
 */
const OLLAMA_API_TIMEOUT_MS = 5000;

// =============================================================================
// 型定義
// =============================================================================

// VramInfo は vram-utils.ts から re-export（後方互換性のため）
export type { VramInfo } from './vram-utils.js';

/**
 * Readiness Probe結果
 */
export interface ReadinessProbeResult {
  /** Ollama Vision実行可能か */
  ready: boolean;
  /** GPU VRAM情報（取得できた場合） */
  vram: VramInfo | null;
  /** Ollamaサービスが応答するか */
  ollamaAvailable: boolean;
  /** 待機した回数（0 = 即座にready） */
  waitRetries: number;
  /** 待機した総時間（ミリ秒） */
  totalWaitMs: number;
  /** 理由（ready=falseの場合） */
  reason?: string | undefined;
}

/**
 * OllamaReadinessProbe設定
 */
export interface OllamaReadinessProbeConfig {
  /** Ollama API URL */
  ollamaUrl?: string | undefined;
  /** 最小VRAM空き容量（MB） */
  minVramFreeMb?: number | undefined;
  /** 最大待機リトライ回数 */
  maxWaitRetries?: number | undefined;
  /** 待機基準間隔（ミリ秒） */
  waitBaseDelayMs?: number | undefined;
  /** VRAM待機を無効化（常にreadyを返す） */
  skipVramCheck?: boolean | undefined;
}

// =============================================================================
// OllamaReadinessProbe クラス
// =============================================================================

/**
 * Ollama Vision実行前のReadiness Probe
 *
 * Phase 2.5（ScrollVision Analysis）実行前に呼び出し、
 * GPU VRAMに十分な空きがあるか確認する。
 * 空きが不足している場合は指数バックオフで待機し、
 * 他のプロセス（Chromiumなど）がVRAMを解放するのを待つ。
 *
 * @example
 * ```typescript
 * const probe = new OllamaReadinessProbe();
 * const result = await probe.check();
 * if (result.ready) {
 *   // Vision分析を実行
 *   await analyzeScrollCaptures(captures);
 * } else {
 *   logger.warn('Ollama not ready', { reason: result.reason });
 * }
 * ```
 */
export class OllamaReadinessProbe {
  private readonly ollamaUrl: string;
  private readonly minVramFreeMb: number;
  private readonly maxWaitRetries: number;
  private readonly waitBaseDelayMs: number;
  private readonly skipVramCheck: boolean;

  constructor(config?: OllamaReadinessProbeConfig) {
    this.ollamaUrl = config?.ollamaUrl ?? 'http://localhost:11434';
    this.minVramFreeMb = config?.minVramFreeMb ?? MIN_VRAM_FREE_MB;
    this.maxWaitRetries = config?.maxWaitRetries ?? MAX_WAIT_RETRIES;
    this.waitBaseDelayMs = config?.waitBaseDelayMs ?? WAIT_BASE_DELAY_MS;
    this.skipVramCheck = config?.skipVramCheck ?? false;
  }

  // ===========================================================================
  // パブリックメソッド
  // ===========================================================================

  /**
   * Readiness Probeを実行
   *
   * 1. Ollama接続チェック
   * 2. GPU VRAM空き容量チェック（nvidia-smi）
   * 3. 不足時は指数バックオフで待機
   *
   * @returns Probe結果
   */
  async check(): Promise<ReadinessProbeResult> {
    const startTime = Date.now();
    let waitRetries = 0;

    // 1. Ollama接続チェック
    const ollamaAvailable = await this.checkOllamaAvailable();
    if (!ollamaAvailable) {
      return {
        ready: false,
        vram: null,
        ollamaAvailable: false,
        waitRetries: 0,
        totalWaitMs: Date.now() - startTime,
        reason: 'Ollama service is not available',
      };
    }

    // 2. VRAM チェックスキップモード
    if (this.skipVramCheck) {
      return {
        ready: true,
        vram: null,
        ollamaAvailable: true,
        waitRetries: 0,
        totalWaitMs: Date.now() - startTime,
      };
    }

    // 3. VRAM空き容量チェック（リトライ付き）
    for (let attempt = 0; attempt <= this.maxWaitRetries; attempt++) {
      const vram = await queryVram();

      // nvidia-smi利用不可（CPU環境 or nvidia-smi未インストール）
      if (vram === null) {
        return {
          ready: true,
          vram: null,
          ollamaAvailable: true,
          waitRetries: 0,
          totalWaitMs: Date.now() - startTime,
          reason: HardwareDetector.isAppleSilicon()
            ? 'Apple Silicon detected: Metal GPU manages memory natively (nvidia-smi not applicable)'
            : 'nvidia-smi not available, assuming CPU mode (no VRAM check)',
        };
      }

      // VRAM十分
      if (vram.freeMb >= this.minVramFreeMb) {
        return {
          ready: true,
          vram,
          ollamaAvailable: true,
          waitRetries,
          totalWaitMs: Date.now() - startTime,
        };
      }

      // 最後のリトライでもVRAM不足
      if (attempt === this.maxWaitRetries) {
        return {
          ready: false,
          vram,
          ollamaAvailable: true,
          waitRetries,
          totalWaitMs: Date.now() - startTime,
          reason: `Insufficient VRAM: ${vram.freeMb}MB free < ${this.minVramFreeMb}MB required (after ${waitRetries} retries)`,
        };
      }

      // 待機（指数バックオフ）
      waitRetries++;
      const delay = this.waitBaseDelayMs * Math.pow(2, attempt);
      await this.sleep(delay);
    }

    // 到達しないがTypeScript型ガード
    return {
      ready: false,
      vram: null,
      ollamaAvailable: true,
      waitRetries,
      totalWaitMs: Date.now() - startTime,
      reason: 'Unexpected: exceeded retry loop',
    };
  }

  /**
   * VRAM情報のみ取得（待機なし）
   *
   * @returns VRAM情報（GPU非搭載時はnull）
   */
  async getVramInfo(): Promise<VramInfo | null> {
    return queryVram();
  }

  // ===========================================================================
  // プライベートメソッド
  // ===========================================================================

  /**
   * Ollama接続確認
   */
  private async checkOllamaAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), OLLAMA_API_TIMEOUT_MS);

      try {
        const response = await fetch(`${this.ollamaUrl}/api/tags`, {
          method: 'GET',
          signal: controller.signal,
        });
        return response.ok;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      return false;
    }
  }

  /**
   * 指定ミリ秒だけスリープ
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
