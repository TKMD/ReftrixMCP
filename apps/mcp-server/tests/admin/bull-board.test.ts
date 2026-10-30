// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BullMQ Board UI ユニットテスト
 * Bull Board の設定取得、環境変数オーバーライド、Basic Auth 認証ミドルウェアを検証。
 *
 * BullMQ Board UI unit tests
 * Verifies config retrieval, env var overrides, and Basic Auth middleware.
 *
 * @module tests/admin/bull-board.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { once } from "node:events";
import type { Server } from "http";
import type { AddressInfo } from "node:net";

// =====================================================
// 外部依存モック / External dependency mocks
// =====================================================

// BullMQ Queue モック / BullMQ Queue mock
vi.mock("bullmq", () => {
  class MockQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    close(): void {}
  }
  return { Queue: MockQueue };
});

// @bull-board/api モック / @bull-board/api mock
vi.mock("@bull-board/api", () => ({
  createBullBoard: vi.fn(),
}));

// @bull-board/api/bullMQAdapter モック
vi.mock("@bull-board/api/bullMQAdapter", () => {
  class MockBullMQAdapter {
    constructor() {}
  }
  return { BullMQAdapter: MockBullMQAdapter };
});

// @bull-board/express モック — getRouter は Express Router を返す
vi.mock("@bull-board/express", () => {
  const { Router } = require("express");
  class MockExpressAdapter {
    setBasePath(_path: string): void {}
    getRouter(): ReturnType<typeof Router> {
      return Router();
    }
  }
  return { ExpressAdapter: MockExpressAdapter };
});

// Redis設定モック / Redis config mock
vi.mock("../../src/config/redis", () => ({
  getRedisConfig: vi.fn().mockReturnValue({
    host: "127.0.0.1",
    port: 6379,
    maxRetriesPerRequest: null,
  }),
}));

// loggerモック / Logger mock
vi.mock("../../src/utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Queue名モック / Queue name mock
vi.mock("../../src/queues/page-analyze-queue", () => ({
  PAGE_ANALYZE_QUEUE_NAME: "test-page-analyze",
}));

import {
  getBullBoardConfig,
  startBullBoard,
  type BullBoardConfig,
} from "../../src/admin/bull-board";

// =====================================================
// テスト / Tests
// =====================================================

// =====================================================
// ヘルパー / Helpers
// =====================================================

/**
 * port 0（OS 割り当て）で起動し、listen 完了を待って実ポートを返す。
 * 乱数ポートは ephemeral 範囲と衝突し得て、listen 完了前の fetch は ECONNREFUSED になる
 * (tracked-issues/testing.md §15)。
 *
 * Starts on port 0 (OS-assigned), waits for `listening`, and returns the bound port.
 * A random port can collide with the ephemeral range and a fetch before listen
 * completes gets ECONNREFUSED (tracked-issues/testing.md §15).
 */
async function startOnFreePort(
  username: string,
  password: string
): Promise<{ server: Server; port: number }> {
  const server = await startBullBoard({ username, password, port: 0 });
  if (server === null) {
    throw new Error("startBullBoard returned null");
  }
  if (!server.listening) {
    await once(server, "listening");
  }
  return { server, port: (server.address() as AddressInfo).port };
}

describe("getBullBoardConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // 環境変数を初期化 / Initialize env vars
    process.env = { ...originalEnv };
    delete process.env.BULLMQ_UI_USER;
    delete process.env.BULLMQ_UI_PASSWORD;
    delete process.env.BULLMQ_UI_PORT;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return null when BULLMQ_UI_USER is not set", () => {
    // Arrange
    process.env.BULLMQ_UI_PASSWORD = "test-password";

    // Act
    const config = getBullBoardConfig();

    // Assert
    expect(config).toBeNull();
  });

  it("should return null when BULLMQ_UI_PASSWORD is not set", () => {
    // Arrange
    process.env.BULLMQ_UI_USER = "test-user";

    // Act
    const config = getBullBoardConfig();

    // Assert
    expect(config).toBeNull();
  });

  it("should return null when both BULLMQ_UI_USER and BULLMQ_UI_PASSWORD are not set", () => {
    // Act
    const config = getBullBoardConfig();

    // Assert
    expect(config).toBeNull();
  });

  it("should return config with default port 21080 when credentials are set", () => {
    // Arrange
    process.env.BULLMQ_UI_USER = "admin";
    process.env.BULLMQ_UI_PASSWORD = "secret123";

    // Act
    const config = getBullBoardConfig();

    // Assert
    expect(config).not.toBeNull();
    expect(config!.username).toBe("admin");
    expect(config!.password).toBe("secret123");
    expect(config!.port).toBe(21080);
  });

  it("should return credentials from environment variables", () => {
    // Arrange
    process.env.BULLMQ_UI_USER = "custom-user";
    process.env.BULLMQ_UI_PASSWORD = "custom-pass";

    // Act
    const config = getBullBoardConfig();

    // Assert
    expect(config).toEqual({
      username: "custom-user",
      password: "custom-pass",
      port: 21080,
    });
  });

  it("should return null when BULLMQ_UI_USER is empty string", () => {
    // Arrange
    process.env.BULLMQ_UI_USER = "";
    process.env.BULLMQ_UI_PASSWORD = "password";

    // Act
    const config = getBullBoardConfig();

    // Assert
    expect(config).toBeNull();
  });

  it("should return null when BULLMQ_UI_PASSWORD is empty string", () => {
    // Arrange
    process.env.BULLMQ_UI_USER = "admin";
    process.env.BULLMQ_UI_PASSWORD = "";

    // Act
    const config = getBullBoardConfig();

    // Assert
    expect(config).toBeNull();
  });
});

describe("startBullBoard - Basic Auth middleware", () => {
  const originalEnv = process.env;
  let server: Server | null = null;
  let testPort: number;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // testPort は各テストで port 0 起動後の実ポートを代入する
    // testPort is assigned the actual bound port after a port-0 start in each test
    testPort = 0;
  });

  afterEach(async () => {
    process.env = originalEnv;
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = null;
    }
  });

  it("should return 401 when no authorization header is provided", async () => {
    // Arrange
    // Act
    ({ server, port: testPort } = await startOnFreePort("admin", "secret"));

    const response = await fetch(`http://127.0.0.1:${testPort}/admin/queues`);

    // Assert
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
  });

  it("should return 401 when invalid credentials are provided", async () => {
    // Arrange
    // Act
    ({ server, port: testPort } = await startOnFreePort("admin", "secret"));

    // Base64 encode "wrong-user:wrong-pass"
    const invalidCredentials = Buffer.from("wrong-user:wrong-pass").toString("base64");

    // Act
    const response = await fetch(`http://127.0.0.1:${testPort}/admin/queues`, {
      headers: {
        Authorization: `Basic ${invalidCredentials}`,
      },
    });

    // Assert
    expect(response.status).toBe(401);
  });

  it("should pass authentication and not return 401 when valid credentials are provided", async () => {
    // Arrange
    // Act
    ({ server, port: testPort } = await startOnFreePort("admin", "secret"));

    // Base64 encode "admin:secret"
    const validCredentials = Buffer.from("admin:secret").toString("base64");

    // Act
    const response = await fetch(`http://127.0.0.1:${testPort}/admin/queues`, {
      headers: {
        Authorization: `Basic ${validCredentials}`,
      },
    });

    // Assert — 認証成功でミドルウェアを通過（401でない）
    // モックRouterは空なので404が返るが、認証自体は成功している
    // Auth passes (not 401); mocked Router is empty so 404 is expected
    expect(response.status).not.toBe(401);
  });

  it("should return 401 when correct username but wrong password is provided", async () => {
    // Arrange
    // Act
    ({ server, port: testPort } = await startOnFreePort("admin", "secret"));

    const partialCredentials = Buffer.from("admin:wrong-password").toString("base64");

    // Act
    const response = await fetch(`http://127.0.0.1:${testPort}/admin/queues`, {
      headers: {
        Authorization: `Basic ${partialCredentials}`,
      },
    });

    // Assert
    expect(response.status).toBe(401);
  });

  it("should return 401 when Authorization header is not Basic scheme", async () => {
    // Arrange
    // Act
    ({ server, port: testPort } = await startOnFreePort("admin", "secret"));

    // Act
    const response = await fetch(`http://127.0.0.1:${testPort}/admin/queues`, {
      headers: {
        Authorization: "Bearer some-token",
      },
    });

    // Assert
    expect(response.status).toBe(401);
  });

  it("should return 401 when base64 decoded value has no colon separator", async () => {
    // Arrange
    // Act
    ({ server, port: testPort } = await startOnFreePort("admin", "secret"));

    // Base64 encode "no-colon-here" (no separator)
    const malformedCredentials = Buffer.from("no-colon-here").toString("base64");

    // Act
    const response = await fetch(`http://127.0.0.1:${testPort}/admin/queues`, {
      headers: {
        Authorization: `Basic ${malformedCredentials}`,
      },
    });

    // Assert
    expect(response.status).toBe(401);
  });

  it("should use default port 21080 when config.port is undefined", () => {
    // Arrange
    const config: BullBoardConfig = {
      username: "admin",
      password: "secret",
      // port intentionally omitted
    };

    // Assert: default port value is 21080
    expect(config.port).toBeUndefined();
    // startBullBoard will use BULL_BOARD_PORT (21080) internally
    // We verify via getBullBoardConfig that default is 21080
    process.env.BULLMQ_UI_USER = "admin";
    process.env.BULLMQ_UI_PASSWORD = "secret";
    const defaultConfig = getBullBoardConfig();
    expect(defaultConfig!.port).toBe(21080);
  });

  it("should redirect root path to /admin/queues", async () => {
    // Arrange
    // Act
    ({ server, port: testPort } = await startOnFreePort("admin", "secret"));

    // Act — fetch without following redirects
    const response = await fetch(`http://127.0.0.1:${testPort}/`, {
      redirect: "manual",
    });

    // Assert
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/queues");
  });
});

describe("startBullBoard - error handling", () => {
  it("should return null and log error when startup fails", async () => {
    // Arrange — Redis config をエラーを投げるようにモック
    const { getRedisConfig } = await import("../../src/config/redis");
    vi.mocked(getRedisConfig).mockImplementationOnce(() => {
      throw new Error("Redis connection failed");
    });

    const { logger } = await import("../../src/utils/logger");

    const config: BullBoardConfig = {
      username: "admin",
      password: "secret",
      port: 39999,
    };

    // Act
    const server = await startBullBoard(config);

    // Assert
    expect(server).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      "[BullBoard] Failed to start UI",
      expect.objectContaining({
        error: "Redis connection failed",
      })
    );
  });
});
