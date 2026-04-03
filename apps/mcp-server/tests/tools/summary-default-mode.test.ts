// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MCP_DEFAULT_SUMMARY_MODE 環境変数テスト
 *
 * P1-PERF-3: LLM向けsummaryデフォルト値の最適化
 *
 * 目的:
 * - LLM最適化: 環境変数未設定時はsummary=true（コンテキスト効率化）
 * - MCP_DEFAULT_SUMMARY_MODE=false で明示的に無効化可能
 * - 明示的なsummary指定は環境変数より優先
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("getSummaryDefault ヘルパー関数", () => {
  const originalEnv = process.env.MCP_DEFAULT_SUMMARY_MODE;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MCP_DEFAULT_SUMMARY_MODE = originalEnv;
    } else {
      delete process.env.MCP_DEFAULT_SUMMARY_MODE;
    }
    vi.resetModules();
  });

  it("MCP_DEFAULT_SUMMARY_MODE=true で true を返す", async () => {
    process.env.MCP_DEFAULT_SUMMARY_MODE = "true";
    const { getSummaryDefault } = await import("../../src/tools/schemas");
    expect(getSummaryDefault()).toBe(true);
  });

  it("MCP_DEFAULT_SUMMARY_MODE=false で false を返す", async () => {
    process.env.MCP_DEFAULT_SUMMARY_MODE = "false";
    const { getSummaryDefault } = await import("../../src/tools/schemas");
    expect(getSummaryDefault()).toBe(false);
  });

  // P1-PERF-3: LLM向け最適化 - 環境変数未設定時はtrueをデフォルトに
  it("環境変数未設定で true を返す（LLM最適化デフォルト）", async () => {
    delete process.env.MCP_DEFAULT_SUMMARY_MODE;
    const { getSummaryDefault } = await import("../../src/tools/schemas");
    expect(getSummaryDefault()).toBe(true);
  });

  // P1-PERF-3: 無効な値もLLM最適化デフォルトでtrueに
  it("無効な値で true を返す（LLM最適化デフォルト）", async () => {
    process.env.MCP_DEFAULT_SUMMARY_MODE = "invalid";
    const { getSummaryDefault } = await import("../../src/tools/schemas");
    expect(getSummaryDefault()).toBe(true);
  });
});
