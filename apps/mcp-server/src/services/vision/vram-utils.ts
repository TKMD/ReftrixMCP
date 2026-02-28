// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * VRAM ユーティリティ — nvidia-smi による GPU VRAM 情報取得
 *
 * GpuResourceManager と OllamaReadinessProbe の両方で使用される
 * 共通の VRAM クエリロジック。
 *
 * SEC: execFile 使用（コマンドインジェクション防止）
 *
 * @module services/vision/vram-utils
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** nvidia-smi コマンドタイムアウト (ms) */
const NVIDIA_SMI_TIMEOUT_MS = 5000;

/**
 * GPU VRAM 情報
 */
export interface VramInfo {
  /** VRAM 使用量（MB） */
  usedMb: number;
  /** VRAM 総量（MB） */
  totalMb: number;
  /** VRAM 空き容量（MB） */
  freeMb: number;
  /** GPU 使用率（%） */
  gpuUtilizationPercent: number;
}

/**
 * nvidia-smi で GPU VRAM 情報を取得
 *
 * SEC: execFile 使用（コマンドインジェクション防止）
 *
 * @returns VRAM 情報。GPU 非搭載 / nvidia-smi 未対応時は null
 */
export async function queryVram(): Promise<VramInfo | null> {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=memory.used,memory.total,memory.free,utilization.gpu',
      '--format=csv,noheader,nounits',
    ], {
      timeout: NVIDIA_SMI_TIMEOUT_MS,
    });

    const line = stdout.trim().split('\n')[0];
    if (!line) {
      return null;
    }

    const parts = line.split(',').map((s) => s.trim());
    if (parts.length < 4) {
      return null;
    }

    const usedMb = parseInt(parts[0]!, 10);
    const totalMb = parseInt(parts[1]!, 10);
    const freeMb = parseInt(parts[2]!, 10);
    const gpuUtilizationPercent = parseInt(parts[3]!, 10);

    if (isNaN(usedMb) || isNaN(totalMb) || isNaN(freeMb) || isNaN(gpuUtilizationPercent)) {
      return null;
    }

    return { usedMb, totalMb, freeMb, gpuUtilizationPercent };
  } catch {
    return null;
  }
}
