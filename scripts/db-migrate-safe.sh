#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
# SPDX-License-Identifier: AGPL-3.0-only

# Reftrix 安全なデータベースマイグレーションスクリプト
# Reftrix Safe Database Migration Script
#
# マイグレーション実行前に自動バックアップ、失敗時に自動ロールバック
# Auto-backup before migration, auto-rollback on failure
#
# 使用方法 / Usage:
#   pnpm db:migrate:safe
#   bash scripts/db-migrate-safe.sh
#
# 動作フロー / Workflow:
#   1. Pre-migration backup (scripts/db-backup.sh)
#   2. Prisma migrate deploy
#   3. On failure: auto-restore from backup
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
DATABASE_DIR="$PROJECT_DIR/packages/database"

# 色付き出力 / Colored output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[migrate]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[migrate]${NC} $1"; }
log_error() { echo -e "${RED}[migrate]${NC} $1" >&2; }

# =====================================================
# Step 1: Pre-migration backup / マイグレーション前バックアップ
# =====================================================

log_info "Step 1: マイグレーション前バックアップを作成中..."
log_info "Step 1: Creating pre-migration backup..."

if ! bash "$SCRIPT_DIR/db-backup.sh"; then
  log_error "バックアップに失敗しました。マイグレーションを中止します。"
  log_error "Backup failed. Aborting migration."
  exit 1
fi

# 最新のバックアップファイルを特定 / Identify latest backup file
BACKUP_FILE=$(ls -t "$BACKUP_DIR"/reftrix-*.dump 2>/dev/null | head -1)
if [ -z "$BACKUP_FILE" ]; then
  log_error "バックアップファイルが見つかりません。マイグレーションを中止します。"
  log_error "No backup file found. Aborting migration."
  exit 1
fi

log_info "バックアップ完了: $(basename "$BACKUP_FILE")"
log_info "Backup complete: $(basename "$BACKUP_FILE")"

# =====================================================
# Step 2: Run migration / マイグレーション実行
# =====================================================

log_info "Step 2: Prisma migrate deploy を実行中..."
log_info "Step 2: Running Prisma migrate deploy..."

MIGRATION_SUCCESS=true
if ! (cd "$DATABASE_DIR" && npx prisma migrate deploy); then
  MIGRATION_SUCCESS=false
fi

if [ "$MIGRATION_SUCCESS" = true ]; then
  log_info "✅ マイグレーション成功"
  log_info "✅ Migration successful"
  exit 0
fi

# =====================================================
# Step 3: Auto-rollback / 自動ロールバック
# =====================================================

log_error "❌ マイグレーション失敗。自動ロールバックを開始します..."
log_error "❌ Migration failed. Starting auto-rollback..."
log_warn "リストア元: $(basename "$BACKUP_FILE")"
log_warn "Restoring from: $(basename "$BACKUP_FILE")"

if FORCE=true bash "$SCRIPT_DIR/db-restore.sh" "$BACKUP_FILE"; then
  log_warn "⚠️  ロールバック完了。データベースはマイグレーション前の状態に復元されました。"
  log_warn "⚠️  Rollback complete. Database restored to pre-migration state."
  log_warn "マイグレーションの失敗原因を確認し、修正後に再実行してください。"
  log_warn "Check migration failure cause, fix, and re-run."
else
  log_error "🔴 ロールバックにも失敗しました！手動で復旧が必要です。"
  log_error "🔴 Rollback also failed! Manual recovery required."
  log_error "バックアップファイル: $BACKUP_FILE"
  log_error "Backup file: $BACKUP_FILE"
  log_error "手動リストア: FORCE=true bash scripts/db-restore.sh $BACKUP_FILE"
  log_error "Manual restore: FORCE=true bash scripts/db-restore.sh $BACKUP_FILE"
fi

exit 1
