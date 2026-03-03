#!/usr/bin/env bash
# Reftrix PostgreSQL バックアップスクリプト
# pg_dump (custom format, zstd圧縮) でバックアップ
# 7世代ローテーション
#
# 動作モード:
#   ホストモード（デフォルト）: docker exec 経由で pg_dump を実行
#   コンテナ内モード: REFTRIX_BACKUP_INSIDE_CONTAINER=true で直接実行
set -euo pipefail

DB_USER="${PGUSER:-reftrix}"
DB_NAME="${PGDATABASE:-reftrix}"
RETENTION_COUNT=7

# 動作モード判定
if [ "${REFTRIX_BACKUP_INSIDE_CONTAINER:-false}" = "true" ]; then
  # コンテナ内モード: pg_dump を直接実行
  BACKUP_DIR="${BACKUP_DIR:-/backups}"
  PG_HOST="${PGHOST:-postgres}"
else
  # ホストモード: docker exec 経由で実行
  CONTAINER_NAME="${CONTAINER_NAME:-reftrix-postgres}"
  BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
fi

# バックアップディレクトリ作成
mkdir -p "$BACKUP_DIR"

# 排他制御: mkdirベースのロック（POSIX互換）
LOCK_DIR="$BACKUP_DIR/.backup.lock"
cleanup_lock() {
  rm -rf "$LOCK_DIR"
}
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "エラー: 別のバックアップが実行中です" >&2
  exit 1
fi
trap cleanup_lock EXIT

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

# バックアップ実行
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="$BACKUP_DIR/reftrix-${TIMESTAMP}.dump"

echo "$(date): バックアップ開始: $DB_NAME -> $BACKUP_FILE"

if [ "${REFTRIX_BACKUP_INSIDE_CONTAINER:-false}" = "true" ]; then
  # コンテナ内モード: 直接 pg_dump 実行（PGPASSWORD は環境変数から自動取得）
  pg_dump -h "$PG_HOST" -U "$DB_USER" -d "$DB_NAME" \
    --format=custom \
    --compress=zstd:3 \
    > "$BACKUP_FILE"
else
  # ホストモード: docker exec 経由
  docker exec "$CONTAINER_NAME" \
    pg_dump -U "$DB_USER" -d "$DB_NAME" \
      --format=custom \
      --compress=zstd:3 \
    > "$BACKUP_FILE"
fi

# バックアップ整合性検証
echo "整合性を検証中..."
if [ "${REFTRIX_BACKUP_INSIDE_CONTAINER:-false}" = "true" ]; then
  pg_restore --list "$BACKUP_FILE" > /dev/null 2>&1 || {
    echo "エラー: バックアップファイルが不正です" >&2
    rm -f "$BACKUP_FILE"
    exit 1
  }
else
  docker exec -i "$CONTAINER_NAME" pg_restore --list < "$BACKUP_FILE" > /dev/null 2>&1 || {
    echo "エラー: バックアップファイルが不正です" >&2
    rm -f "$BACKUP_FILE"
    exit 1
  }
fi

# サイズ表示
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "$(date): バックアップ完了: $BACKUP_FILE ($BACKUP_SIZE)"

# 7世代ローテーション（古いファイルを削除）
BACKUP_COUNT=$(find "$BACKUP_DIR" -name 'reftrix-*.dump' -type f | wc -l)
if [ "$BACKUP_COUNT" -gt "$RETENTION_COUNT" ]; then
  DELETE_COUNT=$((BACKUP_COUNT - RETENTION_COUNT))
  echo "ローテーション: ${DELETE_COUNT}件の古いバックアップを削除"
  # ls -t で新しい順にソートし、保持数以降を削除（POSIX互換）
  ls -t "$BACKUP_DIR"/reftrix-*.dump \
    | tail -n +"$((RETENTION_COUNT + 1))" \
    | xargs rm -f 2>/dev/null || true
fi

echo "現在のバックアップ一覧:"
ls -lh "$BACKUP_DIR"/reftrix-*.dump 2>/dev/null || echo "  (なし)"
