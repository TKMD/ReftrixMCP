// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * db-migrate-safe.sh テスト
 *
 * シェルスクリプトの主要フロー（バックアップ→マイグレーション→ロールバック）を
 * シナリオベースで検証する。実DBへの接続は行わず、スクリプトの構造と
 * 終了コードの整合性をテストする。
 *
 * Tests for db-migrate-safe.sh shell script.
 * Verifies the main workflow (backup → migration → rollback) via scenario-based
 * tests. No real DB connections — tests script structure and exit code correctness.
 *
 * @module tests/scripts/db-migrate-safe
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT_PATH = resolve(__dirname, "../../../../scripts/db-migrate-safe.sh");
const PROJECT_ROOT = resolve(__dirname, "../../../..");

describe("db-migrate-safe.sh", () => {
  // =====================================================
  // スクリプト存在確認 / Script existence check
  // =====================================================

  describe("script file", () => {
    it("should exist at scripts/db-migrate-safe.sh", () => {
      expect(existsSync(SCRIPT_PATH)).toBe(true);
    });

    it("should be a valid bash script with shebang", () => {
      const content = readFileSync(SCRIPT_PATH, "utf-8");
      expect(content.startsWith("#!/usr/bin/env bash")).toBe(true);
    });

    it("should use set -euo pipefail for safety", () => {
      const content = readFileSync(SCRIPT_PATH, "utf-8");
      expect(content).toContain("set -euo pipefail");
    });

    it("should be executable or parseable by bash", () => {
      // bash -n はシンタックスチェックのみ（実行しない）
      // bash -n performs syntax check only (no execution)
      expect(() => {
        execFileSync("bash", ["-n", SCRIPT_PATH]);
      }).not.toThrow();
    });
  });

  // =====================================================
  // ワークフロー構造検証 / Workflow structure verification
  // =====================================================

  describe("workflow structure", () => {
    let content: string;

    beforeAll(() => {
      content = readFileSync(SCRIPT_PATH, "utf-8");
    });

    it("should execute backup as Step 1", () => {
      expect(content).toContain("Step 1");
      expect(content).toContain("db-backup.sh");
    });

    it("should execute prisma migrate deploy as Step 2", () => {
      expect(content).toContain("Step 2");
      expect(content).toContain("prisma migrate deploy");
    });

    it("should auto-rollback on migration failure as Step 3", () => {
      expect(content).toContain("Step 3");
      expect(content).toContain("db-restore.sh");
    });

    it("should abort if backup fails (exit 1 before migration)", () => {
      // backup失敗時は即座にexit 1（マイグレーション実行しない）
      const backupSection = content.split("Step 2")[0];
      expect(backupSection).toContain("exit 1");
    });

    it("should abort if no backup file found", () => {
      expect(content).toContain("No backup file found");
      // バックアップファイル未検出時もexit 1
      const lines = content.split("\n");
      const noBackupLine = lines.findIndex((l) => l.includes("No backup file found"));
      expect(noBackupLine).toBeGreaterThan(-1);
      // その近くにexit 1がある
      const nearbyLines = lines.slice(noBackupLine, noBackupLine + 3).join("\n");
      expect(nearbyLines).toContain("exit 1");
    });

    it("should exit 0 on migration success", () => {
      expect(content).toContain("MIGRATION_SUCCESS=true");
      // 成功時はexit 0
      const successSection = content.split("Step 3")[0];
      expect(successSection).toContain("exit 0");
    });

    it("should use FORCE=true for auto-rollback restore", () => {
      // 自動ロールバック時はユーザー確認スキップ
      expect(content).toContain("FORCE=true bash");
      expect(content).toContain("db-restore.sh");
    });

    it("should provide manual recovery instructions on rollback failure", () => {
      expect(content).toContain("Manual recovery required");
      expect(content).toContain("Manual restore:");
    });

    it("should exit 1 after rollback (whether rollback succeeds or fails)", () => {
      // Step 3セクション（マイグレーション失敗時）は常にexit 1で終了
      const step3Section = content.split("Step 3")[1];
      expect(step3Section).toBeDefined();
      expect(step3Section).toContain("exit 1");
    });
  });

  // =====================================================
  // pnpmスクリプト登録確認 / pnpm script registration
  // =====================================================

  describe("pnpm script registration", () => {
    it("should be registered as db:migrate:safe in root package.json", () => {
      const packageJson = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf-8"));
      expect(packageJson.scripts["db:migrate:safe"]).toBeDefined();
      expect(packageJson.scripts["db:migrate:safe"]).toContain("db-migrate-safe.sh");
    });
  });

  // =====================================================
  // セキュリティ検証 / Security verification
  // =====================================================

  describe("security", () => {
    let content: string;

    beforeAll(() => {
      content = readFileSync(SCRIPT_PATH, "utf-8");
    });

    it("should reference project-local paths only (no hardcoded absolute paths)", () => {
      // ハードコードされた絶対パスがないことを確認（PROJECT_DIR相対のみ）
      const lines = content.split("\n").filter((l) => !l.startsWith("#") && l.trim() !== "");
      const absolutePathLines = lines.filter(
        (l) =>
          /\/(home|usr|var|tmp|etc)\//.test(l) &&
          !l.includes("SCRIPT_DIR") &&
          !l.includes("PROJECT_DIR")
      );
      expect(absolutePathLines).toEqual([]);
    });

    it("should not contain sensitive credentials", () => {
      expect(content).not.toMatch(/password\s*=/i);
      expect(content).not.toMatch(/PGPASSWORD=/);
      // 認証情報は別スクリプト(db-backup.sh/db-restore.sh)に委譲
    });
  });
});
