#!/usr/bin/env bash
# Reftrix PostgreSQL リストアスクリプト
# Reftrix PostgreSQL restore script
# 引数でバックアップファイル指定、なければ最新を使用
# Specify backup file as argument, or uses latest if omitted
# FORCE=true で確認プロンプトをスキップ
# FORCE=true to skip confirmation prompt
#
# 動作モード / Operating modes:
#   ホストモード（デフォルト）: docker exec 経由で pg_restore を実行
#   Host mode (default): run pg_restore via docker exec
#   コンテナ内モード: REFTRIX_BACKUP_INSIDE_CONTAINER=true で直接実行
#   Container mode: direct execution with REFTRIX_BACKUP_INSIDE_CONTAINER=true
set -euo pipefail

DB_USER="${PGUSER:-reftrix}"
DB_NAME="${PGDATABASE:-reftrix}"

# 動作モード判定 / Mode detection
if [ "${REFTRIX_BACKUP_INSIDE_CONTAINER:-false}" = "true" ]; then
  # コンテナ内モード / Container mode
  BACKUP_DIR="${BACKUP_DIR:-/backups}"
  PG_HOST="${PGHOST:-postgres}"
else
  # ホストモード / Host mode
  CONTAINER_NAME="${CONTAINER_NAME:-reftrix-postgres}"
  BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
fi

# 接続・認証の事前チェック / Pre-flight connection and auth check
if [ "${REFTRIX_BACKUP_INSIDE_CONTAINER:-false}" = "true" ]; then
  # コンテナ内モード: pg_isready + 認証テスト
  # Container mode: pg_isready + auth test
  if ! pg_isready -h "$PG_HOST" -U "$DB_USER" -d "$DB_NAME" -q 2>/dev/null; then
    echo "エラー: PostgreSQL ($PG_HOST) に接続できません" >&2
    echo "Error: Cannot connect to PostgreSQL ($PG_HOST)" >&2
    exit 1
  fi
  if ! psql -h "$PG_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" > /dev/null 2>&1; then
    echo "エラー: PostgreSQL 認証に失敗しました (ホスト: $PG_HOST, ユーザー: $DB_USER)" >&2
    echo "  PGPASSWORD 環境変数が正しく設定されているか確認してください" >&2
    echo "Error: PostgreSQL authentication failed (host: $PG_HOST, user: $DB_USER)" >&2
    echo "  Verify PGPASSWORD environment variable is set correctly" >&2
    exit 1
  fi
else
  # ホストモード: コンテナ稼働確認 + 接続テスト
  # Host mode: container running check + connection test
  if ! docker inspect --format='{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null | grep -q true; then
    echo "エラー: コンテナ $CONTAINER_NAME が稼働していません" >&2
    echo "Error: Container $CONTAINER_NAME is not running" >&2
    exit 1
  fi
  if ! docker exec "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" > /dev/null 2>&1; then
    echo "エラー: PostgreSQL 接続テストに失敗しました (コンテナ: $CONTAINER_NAME)" >&2
    echo "Error: PostgreSQL connection test failed (container: $CONTAINER_NAME)" >&2
    exit 1
  fi
fi

# バックアップファイル選択 / Backup file selection
if [ $# -ge 1 ]; then
  BACKUP_FILE="$1"
else
  # POSIX互換: ls -t で最新ファイルを取得（macOS/Linux両対応）
  # POSIX-compatible: get latest file with ls -t (works on macOS/Linux)
  BACKUP_FILE=$(ls -t "$BACKUP_DIR"/reftrix-*.dump 2>/dev/null | head -n 1)
fi

if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  echo "エラー: バックアップファイルが見つかりません" >&2
  echo "Error: Backup file not found" >&2
  echo "使用法 / Usage: $0 [バックアップファイルパス / backup file path]" >&2
  exit 1
fi

BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "リストア対象 / Restore target: $BACKUP_FILE ($BACKUP_SIZE)"

# 確認プロンプト（FORCE=true でスキップ） / Confirmation prompt (skip with FORCE=true)
if [ "${FORCE:-false}" != "true" ]; then
  echo ""
  echo "警告: データベース $DB_NAME の既存データは上書きされます"
  echo "Warning: Existing data in database $DB_NAME will be overwritten"
  read -rp "続行しますか? / Continue? (y/N): " CONFIRM
  if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    echo "リストアを中止しました / Restore cancelled"
    exit 0
  fi
fi

# 拡張の事前確認・作成 / Pre-check and create extensions
echo "拡張を確認中... / Checking extensions..."
if [ "${REFTRIX_BACKUP_INSIDE_CONTAINER:-false}" = "true" ]; then
  psql -h "$PG_HOST" -U "$DB_USER" -d "$DB_NAME" -c "
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  "
else
  docker exec "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" -c "
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  "
fi

# リストア実行 / Execute restore
echo "リストア開始... / Starting restore..."
RC=0
if [ "${REFTRIX_BACKUP_INSIDE_CONTAINER:-false}" = "true" ]; then
  # コンテナ内モード: 直接 pg_restore 実行
  # Container mode: direct pg_restore execution
  pg_restore -h "$PG_HOST" -U "$DB_USER" -d "$DB_NAME" \
    --clean --if-exists \
    --no-owner --no-privileges \
    "$BACKUP_FILE" || RC=$?
else
  # ホストモード: docker exec 経由
  # Host mode: via docker exec
  docker exec -i "$CONTAINER_NAME" \
    pg_restore -U "$DB_USER" -d "$DB_NAME" \
      --clean --if-exists \
      --no-owner --no-privileges \
    < "$BACKUP_FILE" || RC=$?
fi

if [ "$RC" -gt 1 ]; then
  echo "エラー: pg_restore が致命的エラーで終了しました (exit $RC)" >&2
  echo "Error: pg_restore exited with fatal error (exit $RC)" >&2
  exit 1
fi
if [ "$RC" -eq 1 ]; then
  echo "警告: pg_restore が警告付きで完了しました（DROPエラー等は無害です）"
  echo "Warning: pg_restore completed with warnings (DROP errors are harmless)"
fi

echo "リストア完了 / Restore complete: $BACKUP_FILE"
