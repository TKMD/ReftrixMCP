// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * URL を受け取るツールの robots.txt 確認 / robots.txt check for tools that take a URL
 *
 * motion.detect / accessibility.audit / performance.evaluate / responsive.capture が、ページを
 * 開く前に呼ぶ。`ReftrixBot` のトークンで照合し、`REFTRIX_RESPECT_ROBOTS_TXT=false` のときだけ
 * 全体として止まる (ツールごとの上書きは無い)。CAP-M-03、INV-ROBOTS-URL-TOOLS-001。
 *
 * Called by the four URL tools before they open the page; matched with the `ReftrixBot` token and
 * disabled only globally by `REFTRIX_RESPECT_ROBOTS_TXT=false` (no per-tool override).
 */

import { isUrlAllowedByRobotsTxt } from "@reftrixmcp/core";
import { logger } from "./logger";

/** 拒否されたときのエラーコード / Error code when disallowed */
export const ROBOTS_TXT_BLOCKED = "ROBOTS_TXT_BLOCKED" as const;

/**
 * robots.txt で拒否されていればクライアント向けの文を返し、許可なら null。
 * Returns a client-facing message when robots.txt disallows the URL, otherwise null.
 */
export async function robotsTxtBlockMessage(url: string, tool: string): Promise<string | null> {
  const result = await isUrlAllowedByRobotsTxt(url);
  if (result.allowed) return null;
  logger.warn(`[MCP Tool] ${tool} blocked by robots.txt`, {
    domain: result.domain,
    reason: result.reason,
  });
  return (
    `Blocked by robots.txt for ReftrixBot (domain: ${result.domain}, reason: ${result.reason}; ` +
    `a robots.txt that cannot be fetched also blocks). ` +
    `The check can only be turned off for the whole server with REFTRIX_RESPECT_ROBOTS_TXT=false; ` +
    `doing so may have legal implications depending on jurisdiction.`
  );
}
