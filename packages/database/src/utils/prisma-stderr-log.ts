// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prisma log routing for stdio servers.
 * Prisma's string log levels (`log: ["error"]`) write to stdout, which an MCP stdio server
 * reserves for JSON-RPC. Emit events instead and forward them to stderr.
 */

type PrismaLogLevel = "query" | "info" | "warn" | "error";

export function prismaEventLogConfig(
  levels: readonly PrismaLogLevel[]
): { emit: "event"; level: PrismaLogLevel }[] {
  return levels.map((level) => ({ emit: "event" as const, level }));
}

interface PrismaLogEvent {
  message?: string;
  query?: string;
  target?: string;
}

interface EventSource {
  $on?: (event: PrismaLogLevel, cb: (e: PrismaLogEvent) => void) => void;
}

export function forwardPrismaLogsToStderr(
  client: unknown,
  levels: readonly PrismaLogLevel[]
): void {
  const src = client as EventSource;
  if (typeof src.$on !== "function") return;
  for (const level of levels) {
    src.$on(level, (e) => {
      // eslint-disable-next-line no-console
      console.error(`prisma:${level}`, level === "query" ? (e.query ?? "") : (e.message ?? ""));
    });
  }
}

export function prismaLogLevels(): readonly PrismaLogLevel[] {
  return process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"];
}
