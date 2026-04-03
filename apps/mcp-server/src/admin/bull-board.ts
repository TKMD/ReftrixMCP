// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BullMQ Board UI - Job Management Dashboard
 *
 * BullMQジョブの状態確認・管理を行うWeb UIを提供する。
 * Express + @bull-board/express で構築し、Basic Auth認証を必須とする。
 *
 * セキュリティ:
 * - Basic Auth必須（BULLMQ_UI_USER / BULLMQ_UI_PASSWORD 未設定時はUI無効化）
 * - localhost binding のみ（0.0.0.0 禁止）
 * - /admin/queues パスで公開
 *
 * @module admin/bull-board
 */

import { timingSafeEqual, scryptSync } from "crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { Queue } from "bullmq";
import { getRedisConfig } from "../config/redis";
import { logger } from "../utils/logger";
import { PAGE_ANALYZE_QUEUE_NAME } from "../queues/page-analyze-queue";
import type { Server } from "http";

/**
 * Bull Board UI のデフォルトポート
 * Port offset: 21000 + 80 = 21080
 */
const BULL_BOARD_PORT = 21080;

/**
 * Bull Board の設定インターフェース
 */
export interface BullBoardConfig {
  /** Basic Auth ユーザー名 */
  username: string;
  /** Basic Auth パスワード */
  password: string;
  /** ポート番号 (default: 21080) */
  port?: number;
}

/**
 * 環境変数から Bull Board 設定を取得
 *
 * @returns 設定オブジェクト、またはnull（認証情報未設定の場合）
 */
export function getBullBoardConfig(): BullBoardConfig | null {
  const username = process.env.BULLMQ_UI_USER;
  const password = process.env.BULLMQ_UI_PASSWORD;

  if (!username || !password) {
    return null;
  }

  return {
    username,
    password,
    port: BULL_BOARD_PORT,
  };
}

/**
 * Basic Auth ミドルウェア
 *
 * RFC 7617 に準拠した Basic Authentication を実装。
 * タイミング攻撃を考慮し、固定時間比較を行う。
 *
 * @param username - 期待するユーザー名
 * @param password - 期待するパスワード
 */
function basicAuthMiddleware(
  username: string,
  password: string
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Basic ")) {
      res.setHeader("WWW-Authenticate", 'Basic realm="BullMQ Board"');
      res.status(401).send("Authentication required");
      return;
    }

    const base64Credentials = authHeader.slice(6);
    let decoded: string;
    try {
      decoded = Buffer.from(base64Credentials, "base64").toString("utf-8");
    } catch {
      res.status(401).send("Invalid credentials");
      return;
    }

    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex === -1) {
      res.status(401).send("Invalid credentials");
      return;
    }

    const providedUser = decoded.slice(0, separatorIndex);
    const providedPass = decoded.slice(separatorIndex + 1);

    // scryptSync + timingSafeEqual で定時間比較（CodeQL js/insufficient-password-hash 対策）
    // BullMQ UIは内部開発ツール。パスワードは環境変数から取得。
    const salt = "reftrix-bullmq-auth";
    const hash = (value: string): Buffer => scryptSync(value, salt, 32);
    const userMatch = timingSafeEqual(hash(providedUser), hash(username));
    const passMatch = timingSafeEqual(hash(providedPass), hash(password));

    if (userMatch && passMatch) {
      next();
    } else {
      res.setHeader("WWW-Authenticate", 'Basic realm="BullMQ Board"');
      res.status(401).send("Invalid credentials");
    }
  };
}

/**
 * Bull Board UI を起動する
 *
 * @param config - Bull Board 設定
 * @returns HTTP Server インスタンス、またはnull（起動失敗時）
 */
export async function startBullBoard(config: BullBoardConfig): Promise<Server | null> {
  try {
    const redisConfig = getRedisConfig();

    // Queue インスタンスを作成（UI用、読み取り専用）
    const pageAnalyzeQueue = new Queue(PAGE_ANALYZE_QUEUE_NAME, {
      connection: {
        host: redisConfig.host,
        port: redisConfig.port,
        maxRetriesPerRequest: redisConfig.maxRetriesPerRequest,
      },
    });

    // Bull Board セットアップ
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath("/admin/queues");

    createBullBoard({
      queues: [new BullMQAdapter(pageAnalyzeQueue)],
      serverAdapter,
    });

    // Express アプリ作成
    const app = express();

    // Basic Auth を /admin/queues 以下全体に適用
    app.use("/admin/queues", basicAuthMiddleware(config.username, config.password));
    app.use("/admin/queues", serverAdapter.getRouter());

    // ルートにリダイレクト
    app.get("/", (_req: Request, res: Response): void => {
      res.redirect("/admin/queues");
    });

    const port = config.port ?? BULL_BOARD_PORT;

    // localhost のみバインド（セキュリティ: 0.0.0.0 禁止）
    const server = app.listen(port, "127.0.0.1", () => {
      logger.info(`[BullBoard] UI started at http://127.0.0.1:${port}/admin/queues`);
    });

    return server;
  } catch (error: unknown) {
    logger.error("[BullBoard] Failed to start UI", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
