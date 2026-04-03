// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase 5: Child Process IPC Type Definitions and Zod Schemas
 *
 * Defines the IPC message protocol between the parent (fork orchestrator)
 * and child processes (text-embedding, visual-embedding).
 *
 * P0-2: All IPC messages are validated with Zod discriminatedUnion schemas.
 * P0-10: Error messages are sanitized via sanitizeErrorMessage (CWE-209).
 * P1-14: IPC error messages are capped at 1000 characters.
 *
 * @module workers/phases/phase-5-child-ipc
 */

import { z } from "zod";

import { sanitizeErrorMessage } from "../../utils/sanitize-error";

// ============================================================================
// Constants
// ============================================================================

/** Maximum length for IPC error messages (P1-14) */
export const IPC_ERROR_MESSAGE_MAX_LENGTH = 1000;

/** Maximum length for IPC string fields */
const IPC_STRING_MAX_LENGTH = 10_000;

/** Maximum length for serialized JSON data fields (50MB safety) */
const IPC_DATA_MAX_LENGTH = 50_000_000;

// ============================================================================
// Parent → Child Messages
// ============================================================================

/**
 * Zod schema for IdMapping entries (Map<string, string> serialized as array)
 */
const idMappingEntrySchema = z.tuple([
  z.string().max(IPC_STRING_MAX_LENGTH),
  z.string().max(IPC_STRING_MAX_LENGTH),
]);

/**
 * Parent → Child: Initialize text embedding child process
 */
export const parentInitTextSchema = z.object({
  type: z.literal("init-text"),
  webPageId: z.string().uuid(),
  url: z.string().max(IPC_STRING_MAX_LENGTH),
  // SaveResult idMappings serialized as [key, value][] arrays
  sectionIdMapping: z.array(idMappingEntrySchema).nullable(),
  motionIdMapping: z.array(idMappingEntrySchema).nullable(),
  jsIdMapping: z.array(idMappingEntrySchema).nullable(),
  bgIds: z.array(z.string().max(IPC_STRING_MAX_LENGTH)).nullable(),
  scrollVisionIdMapping: z.array(idMappingEntrySchema).nullable(),
  // Serialized analysis results (JSON strings for large payloads)
  layoutResultJson: z.string().max(IPC_DATA_MAX_LENGTH).nullable(),
  motionResultJson: z.string().max(IPC_DATA_MAX_LENGTH).nullable(),
  jsAnimationsJson: z.string().max(IPC_DATA_MAX_LENGTH).nullable(),
  scrollVisionResultJson: z.string().max(IPC_DATA_MAX_LENGTH).nullable(),
  responsiveAnalysisId: z.string().max(IPC_STRING_MAX_LENGTH).optional(),
  partsSavedCount: z.number().int().min(0).optional(),
});

/**
 * Parent → Child: Initialize visual embedding child process
 */
export const parentInitVisualSchema = z.object({
  type: z.literal("init-visual"),
  webPageId: z.string().uuid(),
  url: z.string().max(IPC_STRING_MAX_LENGTH),
  screenshotPngPath: z.string().max(IPC_STRING_MAX_LENGTH),
  sectionIdMapping: z.array(idMappingEntrySchema).nullable(),
  partsSavedCount: z.number().int().min(0).optional(),
  layoutResultJson: z.string().max(IPC_DATA_MAX_LENGTH).nullable(),
  viewportWidth: z.number().int().min(1).max(4096).optional(),
  viewportHeight: z.number().int().min(1).max(4096).optional(),
  fallbackEnabled: z.boolean(),
  dinov2ModelPath: z.string().max(IPC_STRING_MAX_LENGTH),
});

/**
 * Parent → Child: Relay lock extension acknowledgment
 */
export const parentLockAckSchema = z.object({
  type: z.literal("lock-ack"),
  success: z.boolean(),
});

/**
 * Parent → Child: Graceful shutdown request
 */
export const parentShutdownSchema = z.object({
  type: z.literal("shutdown"),
});

/**
 * Union of all parent → child message types
 */
export const parentToChildSchema = z.discriminatedUnion("type", [
  parentInitTextSchema,
  parentInitVisualSchema,
  parentLockAckSchema,
  parentShutdownSchema,
]);

export type ParentToChildMessage = z.infer<typeof parentToChildSchema>;

// ============================================================================
// Child → Parent Messages
// ============================================================================

/**
 * Child → Parent: Heartbeat (keeps parent aware child is alive)
 */
export const childHeartbeatSchema = z.object({
  type: z.literal("heartbeat"),
  rssMb: z.number().min(0),
  phase: z.string().max(200),
});

/**
 * Child → Parent: Request lock extension relay
 */
export const childLockRequestSchema = z.object({
  type: z.literal("lock-request"),
  label: z.string().max(200),
});

/**
 * Child → Parent: Progress update
 */
export const childProgressSchema = z.object({
  type: z.literal("progress"),
  completed: z.number().int().min(0),
  total: z.number().int().min(0),
  phase: z.string().max(200),
});

/**
 * Child → Parent: Text embedding result (success)
 */
export const childTextResultSchema = z.object({
  type: z.literal("text-result"),
  sectionEmbeddingsGenerated: z.number().int().min(0),
  motionEmbeddingsGenerated: z.number().int().min(0),
  bgEmbeddingsGenerated: z.number().int().min(0),
  jsAnimationEmbeddingsGenerated: z.number().int().min(0),
  responsiveEmbeddingsGenerated: z.number().int().min(0),
  partEmbeddingsGenerated: z.number().int().min(0),
  embeddingFailedChunks: z.number().int().min(0),
});

/**
 * Child → Parent: Visual embedding result (success)
 */
export const childVisualResultSchema = z.object({
  type: z.literal("visual-result"),
  sectionVisualEmbeddingsGenerated: z.number().int().min(0),
  partVisualEmbeddingsGenerated: z.number().int().min(0),
  embeddingFailedChunks: z.number().int().min(0),
});

/**
 * Child → Parent: Error report
 */
export const childErrorSchema = z.object({
  type: z.literal("error"),
  message: z.string().max(IPC_ERROR_MESSAGE_MAX_LENGTH),
  phase: z.string().max(200).optional(),
});

/**
 * Union of all child → parent message types
 */
export const childToParentSchema = z.discriminatedUnion("type", [
  childHeartbeatSchema,
  childLockRequestSchema,
  childProgressSchema,
  childTextResultSchema,
  childVisualResultSchema,
  childErrorSchema,
]);

export type ChildToParentMessage = z.infer<typeof childToParentSchema>;

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate an IPC message from parent to child.
 * Returns null if validation fails (with logged warning).
 */
export function validateParentMessage(raw: unknown): ParentToChildMessage | null {
  const result = parentToChildSchema.safeParse(raw);
  if (!result.success) {
    // Log validation failure (no PII — only schema error details)
    console.warn("[Phase5-IPC] Invalid parent message:", result.error.issues[0]?.message);
    return null;
  }
  return result.data;
}

/**
 * Validate an IPC message from child to parent.
 * Returns null if validation fails (with logged warning).
 */
export function validateChildMessage(raw: unknown): ChildToParentMessage | null {
  const result = childToParentSchema.safeParse(raw);
  if (!result.success) {
    // Log validation failure (no PII — only schema error details)
    console.warn("[Phase5-IPC] Invalid child message:", result.error.issues[0]?.message);
    return null;
  }
  return result.data;
}

// ============================================================================
// Serialization Helpers
// ============================================================================

/**
 * Truncate an error message to IPC maximum length (P1-14).
 */
export function truncateErrorForIPC(message: string): string {
  if (message.length <= IPC_ERROR_MESSAGE_MAX_LENGTH) return message;
  return message.slice(0, IPC_ERROR_MESSAGE_MAX_LENGTH);
}

/**
 * Serialize a Map<string, string> to IPC-safe [key, value][] array.
 */
export function serializeIdMapping(
  map: Map<string, string> | undefined | null
): [string, string][] | null {
  if (!map || map.size === 0) return null;
  return Array.from(map.entries());
}

/**
 * Deserialize an IPC [key, value][] array back to Map<string, string>.
 */
export function deserializeIdMapping(entries: [string, string][] | null): Map<string, string> {
  if (!entries) return new Map();
  return new Map(entries);
}

/**
 * Append ?connection_limit=N to a DATABASE_URL (P0-3).
 * Handles URLs that already have query parameters.
 */
export function appendConnectionLimit(databaseUrl: string, limit: number): string {
  const separator = databaseUrl.includes("?") ? "&" : "?";
  return `${databaseUrl}${separator}connection_limit=${limit}`;
}

// ============================================================================
// Shared Child Process IPC Helpers
// ============================================================================
// These functions are shared between text-embedding-child and visual-embedding-child
// to eliminate 71-line IPC duplication (TDA audit finding).
// Any change here is automatically reflected in both child processes.

/** Heartbeat interval handle (module-level singleton for child process) */
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Send a typed IPC message to parent. Fire-and-forget.
 * Used for heartbeats, lock-request relay, and progress updates.
 */
export function sendToParent(msg: ChildToParentMessage): void {
  try {
    if (process.send) {
      process.send(msg);
    }
  } catch {
    // Parent may have already disconnected
  }
}

/**
 * Send a typed IPC message and wait for it to be flushed to the kernel buffer.
 * Must be called before process.exit() to prevent IPC race condition.
 * Safety timeout: 5 seconds (SEC/TDA recommendation).
 */
export async function sendToParentAndFlush(msg: ChildToParentMessage): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000); // Safety timeout (SEC/TDA recommendation)
    try {
      if (process.send) {
        process.send(msg, () => {
          clearTimeout(timer);
          resolve();
        });
      } else {
        clearTimeout(timer);
        resolve();
      }
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

/**
 * Start periodic heartbeat to keep parent aware child is alive.
 * @param phase - Phase identifier for heartbeat messages (e.g. "text-embedding", "visual-embedding")
 */
export function startHeartbeat(phase: string): void {
  heartbeatInterval = setInterval(() => {
    const mem = process.memoryUsage();
    sendToParent({
      type: "heartbeat",
      rssMb: Math.round(mem.rss / 1024 / 1024),
      phase,
    });
  }, 10_000);
}

/**
 * Stop heartbeat interval.
 */
export function stopHeartbeat(): void {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

/**
 * Register process-level error handlers for uncaught exceptions and unhandled rejections.
 * Both handlers send sanitized error messages to parent via IPC and exit with code 1.
 *
 * @param phase - Phase identifier prefix (e.g. "text-embedding", "visual-embedding")
 */
export function registerProcessErrorHandlers(phase: string): void {
  process.on("uncaughtException", (error) => {
    sendToParentAndFlush({
      type: "error",
      message: truncateErrorForIPC(sanitizeErrorMessage(error)),
      phase: `${phase}-uncaught`,
    }).finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    sendToParentAndFlush({
      type: "error",
      message: truncateErrorForIPC(
        sanitizeErrorMessage(reason instanceof Error ? reason : new Error(String(reason)))
      ),
      phase: `${phase}-unhandled`,
    }).finally(() => process.exit(1));
  });
}

/**
 * Handle graceful shutdown: stop heartbeat, disconnect Prisma, and exit.
 * Used in the "shutdown" message handler of both child processes.
 *
 * @param prismaClient - Prisma client instance to disconnect (typed as { $disconnect(): Promise<void> } for flexibility)
 */
export async function handleShutdown(prismaClient: {
  $disconnect(): Promise<void>;
}): Promise<never> {
  stopHeartbeat();
  try {
    await prismaClient.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
