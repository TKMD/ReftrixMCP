// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One resident DINOv2 instance shared by design.verify_reproduction and design.search_by_image
 * (VR-M-02 / VR-M-04). Both tools take `dinov2Semaphore` between `get` and `release`, so the single
 * model is never used concurrently and only one copy of it is resident in the MCP process.
 */
import { logger } from "../../utils/logger";
import { createLaunchSemaphore } from "../../utils/launch-semaphore";

export interface VerifyDinov2 {
  initialize(): Promise<void>;
  generateEmbedding(imageBuffer: Buffer): Promise<number[]>;
  dispose(): Promise<void>;
  readonly initialized: boolean;
}

/** Idle period after which the resident DINOv2 instance is disposed. */
export const DINOV2_RESIDENT_IDLE_MS = 300_000;

export interface ResidentDinov2 {
  get(): VerifyDinov2 | null;
  release(dino: VerifyDinov2, broken: boolean): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * One resident DINOv2 instance, disposed after an idle period. Loading and disposing the model on
 * every call does not give the native memory back: measured on the dev DB the MCP process grew by
 * ~400 MB per call (689 -> 3472 MB over 8 calls); a reused instance stayed at ~770 MB.
 * Callers hold `dinov2Semaphore` between `get` and `release`, so the instance is never shared
 * concurrently.
 */
export function createResidentDinov2(
  factory: () => VerifyDinov2 | null,
  idleMs: number = DINOV2_RESIDENT_IDLE_MS
): ResidentDinov2 {
  let instance: VerifyDinov2 | null = null;
  let timer: NodeJS.Timeout | undefined;
  const drop = async (): Promise<void> => {
    const d = instance;
    instance = null;
    if (d === null) return;
    try {
      await d.dispose();
    } catch (error) {
      logger.warn("[design] resident DINOv2 dispose failed", {
        error: (error as Error).message,
      });
    }
  };
  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    get(): VerifyDinov2 | null {
      clear();
      if (instance === null) instance = factory();
      return instance;
    },
    async release(dino: VerifyDinov2, broken: boolean): Promise<void> {
      clear();
      if (broken || dino !== instance) {
        if (dino === instance) {
          await drop();
        } else {
          await dino.dispose().catch(() => undefined);
        }
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        void drop();
      }, idleMs);
      timer.unref();
    },
    async shutdown(): Promise<void> {
      clear();
      await drop();
    },
  };
}

/**
 * DINOv2 runs in the MCP server process: one model load at a time, so a generate -> verify ->
 * fix loop cannot stack concurrent ONNX sessions (native memory).
 */
export const dinov2Semaphore = createLaunchSemaphore(1);
