# はじめに - Reftrixセットアップガイド / Getting Started - Reftrix Setup Guide

**Version**: 0.1.0
**Updated**: 2026-03-01

---

## 1. 概要 / Overview

このガイドでは、Reftrix MCPサーバーのインストールからセットアップ、動作確認までの手順を説明します。

This guide explains the steps from installing the Reftrix MCP server to setup and verification.

ReftrixはWebデザインを「検索可能なナレッジベース」として集約し、MCPツール + Claudeエージェントを介してレイアウト分析・モーション検出・品質評価を実行するプラットフォームです。Claude DesktopのMCPツールとして利用します。

Reftrix is a platform that aggregates web design as a "searchable knowledge base" and performs layout analysis, motion detection, and quality evaluation via MCP tools + Claude agents. It is used as MCP tools for Claude Desktop.

---

## 2. システム要件 / System Requirements

### 2.1 必須要件 / Required

| 項目 / Item | 要件 / Requirement |
|------|------|
| **OS** | Linux (Ubuntu 20.04+), macOS 12+, Windows 10/11 |
| **Node.js** | 20.x LTS 以上（>=20.19.0）/ 20.x LTS or higher (>=20.19.0) |
| **pnpm** | 10.x 以上 / 10.x or higher |
| **PostgreSQL** | 18.x（pgvector 0.8.x） |
| **Redis** | 7.x 以上（BullMQジョブキュー用）/ 7.x or higher (for BullMQ job queue) |
| **Ollama** | llama3.2-vision モデル（ナラティブ分析・Vision分析用）/ llama3.2-vision model (for narrative & vision analysis) |
| **メモリ / Memory** | 16GB RAM 以上（Ollama Vision推論 + Embedding生成に必要）/ 16GB RAM minimum (required for Ollama Vision inference + embedding generation) |
| **ディスク / Disk** | 30GB 以上の空き容量（llama3.2-vision: ~7.9GB + ONNXモデル: ~400MB）/ 30GB+ free space (llama3.2-vision: ~7.9GB + ONNX model: ~400MB) |

### 2.2 推奨環境 / Recommended

| 項目 / Item | 推奨 / Recommended |
|------|------|
| **メモリ / Memory** | 32GB RAM 以上 / 32GB RAM or more |
| **CPU** | 8コア以上 / 8 cores or more |
| **SSD** | 必須（データベースパフォーマンス向上）/ Required (improves database performance) |
| **GPU** | NVIDIA GPU (CUDA 12対応) - Embedding/Vision高速化 / NVIDIA GPU (CUDA 12 compatible) - Embedding/Vision acceleration |

---

## 3. インストール手順 / Installation Steps

### 3.1 前提条件のインストール / Install Prerequisites

#### Node.js のインストール / Installing Node.js

```bash
# Node Version Manager (nvm) を使用する場合 / Using Node Version Manager (nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc  # または ~/.zshrc / or ~/.zshrc
nvm install 20
nvm use 20
node --version  # v20.x.x を確認 / Verify v20.x.x
```

#### pnpm のインストール / Installing pnpm

```bash
npm install -g pnpm@10
pnpm --version  # 10.x.x を確認 / Verify 10.x.x
```

#### Ollama のインストール / Installing Ollama

ReftrixはナラティブやVision分析にOllama（llama3.2-vision）を使用します。

Reftrix uses Ollama (llama3.2-vision) for narrative and vision analysis.

```bash
# Linux
curl -fsSL https://ollama.com/install.sh | sh

# macOS（Homebrewの場合 / via Homebrew）
brew install ollama
```

> **Note / 注意**: Linuxでは公式インストールスクリプトがsystemdサービスを自動登録するため、インストール後にOllamaが自動起動します。
>
> On Linux, the official install script registers a systemd service, so Ollama starts automatically after installation.

```bash
# llama3.2-vision モデルをダウンロード（約7.9GB）
# Download the llama3.2-vision model (~7.9GB)
ollama pull llama3.2-vision

# インストール確認 / Verify installation
ollama list
# "llama3.2-vision" が表示されればOK / Should show "llama3.2-vision"
```

Ollamaが起動していない場合:

If Ollama is not running:

```bash
# systemdサービスとして起動 / Start as systemd service
sudo systemctl start ollama

# または直接起動（フォアグラウンド）/ Or start directly (foreground)
ollama serve
```

```bash
# 動作確認 / Verify Ollama is accessible
curl -s http://localhost:11434/api/tags | head -c 200
```

### 3.2 Reftrixのインストール / Installing Reftrix

#### リポジトリのクローン / Clone the Repository

```bash
git clone https://github.com/TKMD/ReftrixMCP.git
cd ReftrixMCP
```

#### 依存関係のインストール / Install Dependencies

```bash
pnpm install

# pnpm 10.x: ネイティブビルドスクリプトの承認（Prisma, Sharp等）
# pnpm 10.x: Approve native build scripts (Prisma, Sharp, etc.)
pnpm approve-builds
pnpm install
```

> **注意 / Note**: pnpm 10.x ではセキュリティ上の理由から、パッケージの postinstall スクリプトがデフォルトでブロックされます。`pnpm approve-builds` で `@prisma/client`, `prisma`, `sharp`, `esbuild` 等のビルドスクリプトを許可してから、再度 `pnpm install` を実行してください。
>
> In pnpm 10.x, package postinstall scripts are blocked by default for security. Run `pnpm approve-builds` to allow build scripts for `@prisma/client`, `prisma`, `sharp`, `esbuild`, etc., then run `pnpm install` again.

#### Playwrightブラウザのインストール / Install Playwright Browser

Webページのクロール（`page.analyze`、`layout.ingest`）にはChromiumが必要です。

Chromium is required for web page crawling (`page.analyze`, `layout.ingest`).

```bash
pnpm exec playwright install chromium
```

#### 環境変数の設定 / Configure Environment Variables

```bash
cp .env.example .env.local
nano .env.local  # 任意のエディタで編集 / Edit with your preferred editor
```

**.env.local の主要設定 / Key .env.local settings:**

```env
# データベース接続（ポートオフセット: 26432）/ Database connection (port offset: 26432)
DATABASE_URL="postgresql://reftrix:change_me@localhost:26432/reftrix?schema=public"

# Redis接続（ポートオフセット: 27379）/ Redis connection (port offset: 27379)
REDIS_URL="redis://localhost:27379"

# 環境設定 / Environment setting
NODE_ENV=development
```

**Prisma用の環境変数ファイルを作成 / Create environment file for Prisma:**

```bash
# Prisma CLIは .env.local を認識しないため、packages/database/.env が必要です
# Prisma CLI does not read .env.local — packages/database/.env is required
cp .env.local packages/database/.env
```

> **重要 / Important**: Prisma CLIは `.env.local` を読み込みません。`pnpm db:migrate` や `pnpm db:seed` は Prisma 経由で実行されるため、`packages/database/.env` に `DATABASE_URL` が設定されている必要があります。`.env.local` を変更した場合は `packages/database/.env` も更新してください。
>
> **Important**: Prisma CLI does not load `.env.local`. Since `pnpm db:migrate` and `pnpm db:seed` run via Prisma, `DATABASE_URL` must be set in `packages/database/.env`. If you change `.env.local`, also update `packages/database/.env`.

> **Warning**: `change_me` はプレースホルダーです。本番環境では必ず安全なパスワードに変更してください。
>
> **Warning**: `change_me` is a placeholder. Always change it to a secure password in production.

> **重要 / Important**: Reftrixは他プロジェクトとのポート競合を避けるため、21000オフセットを使用しています。
> Reftrix uses a 21000 offset to avoid port conflicts with other projects.
> - PostgreSQL: `26432`（標準5432 + 21000 / standard 5432 + 21000）
> - Redis: `27379`（標準6379 + 21000 / standard 6379 + 21000）
> - Prisma Studio: `26555`（標準5555 + 21000 / standard 5555 + 21000）

### 3.3 データベースのセットアップ / Database Setup

#### Dockerを使用する場合（推奨） / Using Docker (Recommended)

> **注意（既存のDockerボリュームがある場合） / Note (if you have existing Docker volumes)**:
> 既にReftrix関連のDockerボリュームが存在する場合（別リポジトリやパスワード変更後など）、パスワード不一致で認証エラー（P1000）が発生します。初回セットアップ前に以下を実行してください:
>
> If Reftrix-related Docker volumes already exist (from another repo or after password changes), authentication will fail (P1000) due to password mismatch. Run the following before first setup:
>
> ```bash
> # 既存のコンテナとボリュームを一括削除（-v でボリュームも削除）
> # Remove existing containers and volumes (-v removes volumes too)
> docker compose -f docker/docker-compose.yml down -v
> ```

```bash
# PostgreSQL + Redis を起動 / Start PostgreSQL + Redis
pnpm docker:up

# PostgreSQLが起動完了するまで待機（約10-15秒）
# Wait for PostgreSQL to be ready (~10-15 seconds)
docker compose -f docker/docker-compose.yml exec postgres pg_isready -U reftrix -d reftrix
# "accepting connections" と表示されるまで再実行 / Re-run until "accepting connections" is shown

# マイグレーション実行 / Run migrations
pnpm db:migrate

# シードデータ投入 / Seed data
pnpm db:seed
```

#### 手動セットアップの場合 / Manual Setup

PostgreSQL 18 + pgvector 0.8 がインストール済みである必要があります。

Requires PostgreSQL 18 + pgvector 0.8 to be already installed.

```bash
# 1. データベースとユーザーの作成（未作成の場合）
#    Create database and user (if not already created)
sudo -u postgres psql -c "CREATE DATABASE reftrix;"
sudo -u postgres psql -c "CREATE USER reftrix WITH PASSWORD 'your_secure_password';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE reftrix TO reftrix;"

# 2. pgvector拡張の有効化 / Enable pgvector extension
sudo -u postgres psql -d reftrix -c "CREATE EXTENSION IF NOT EXISTS vector;"

# 3. マイグレーション実行 / Run migrations
pnpm prisma migrate deploy

# 4. Prisma Client生成 / Generate Prisma Client
pnpm prisma generate
```

**pgvectorの確認 / Verify pgvector:**

```bash
psql -h localhost -p 26432 -U reftrix -d reftrix -c "SELECT extname FROM pg_extension WHERE extname='vector';"
```

正常にインストールされていれば `vector` が表示されます。

If installed correctly, `vector` will be displayed.

---

## 4. MCPサーバーのビルドと設定 / Build and Configure the MCP Server

### 4.1 MCPサーバーのビルド / Build the MCP Server

```bash
# ビルド（全パッケージ）/ Build (all packages)
pnpm build

# または MCPサーバーのみ / Or MCP server only
cd apps/mcp-server
pnpm build
```

### 4.2 ONNXモデル（multilingual-e5-base）/ ONNX Model (multilingual-e5-base)

ReftrixはEmbedding生成に multilingual-e5-base モデル（768次元）を使用します。モデルは初回使用時に `@huggingface/transformers` 経由で自動ダウンロードされます。

Reftrix uses the multilingual-e5-base model (768 dimensions) for embedding generation. The model is automatically downloaded on first use via `@huggingface/transformers`.

| 項目 / Item | 詳細 / Details |
|------|------|
| ダウンロードサイズ / Download size | 約400MB / ~400MB |
| キャッシュ先 / Cache location | `MODEL_CACHE_DIR`（デフォルト: `./.cache/models`）/ `MODEL_CACHE_DIR` (default: `./.cache/models`) |
| 初回所要時間 / First-run time | 1-3分（ネットワーク速度による）/ 1-3 minutes (depends on network speed) |

> **注意 / Note**: 初回のEmbedding操作（`layout.ingest`、`page.analyze`等）はモデルダウンロードのため時間がかかります。2回目以降はキャッシュから読み込まれるため高速です。初回実行時にはインターネット接続が必要です。
>
> The first embedding operation (`layout.ingest`, `page.analyze`, etc.) takes longer due to model download. Subsequent runs load from cache and are fast. An internet connection is required on first run.

### 4.3 Claude Desktop設定 / Claude Desktop Configuration

Claude DesktopでReftrixのMCPツールを使用するには、設定ファイルを編集します。

To use Reftrix MCP tools in Claude Desktop, edit the configuration file.

**macOS:**
```bash
nano ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

**Linux:**
```bash
nano ~/.config/Claude/claude_desktop_config.json
```

**Windows:**
```
%APPDATA%\Claude\claude_desktop_config.json
```

**設定内容 / Configuration:**

```json
{
  "mcpServers": {
    "reftrix": {
      "command": "node",
      "args": ["/absolute/path/to/reftrix/apps/mcp-server/dist/index.js"],
      "env": {
        "NODE_ENV": "development",
        "DATABASE_URL": "postgresql://reftrix:change_me@localhost:26432/reftrix?schema=public",
        "REDIS_URL": "redis://localhost:27379",
        "OLLAMA_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

> **注意 / Note**: `/absolute/path/to/reftrix/` を実際のパスに置き換えてください。/ Replace `/absolute/path/to/reftrix/` with the actual path.

> **重要 / Important**: `NODE_ENV` は必須です。設定しないとサーバーが起動しません。有効な値: `development`, `production`, `test` / `NODE_ENV` is required. The server will not start without it. Valid values: `development`, `production`, `test`

> **Warning**: `change_me` はプレースホルダーです。必ず安全なパスワードに変更してください。/ `change_me` is a placeholder. Always use a secure password.

---

## 5. ワーカーの起動 / Start Workers

page.analyzeは非同期処理のため、ワーカープロセスの起動が必要です。

Since page.analyze runs asynchronously, a worker process must be started.

```bash
# page.analyzeワーカー起動（WorkerSupervisor管理）
# Start page.analyze worker (managed by WorkerSupervisor)
pnpm --filter @reftrix/mcp-server worker:start:page
```

> **Warning / 警告**: ワーカー未起動の場合、`page.analyze` と `quality.batch_evaluate` の結果はDBに保存されません。ジョブはキューに滞留し、ワーカー起動後に処理されます。
>
> **Warning**: Without the worker running, `page.analyze` and `quality.batch_evaluate` results will NOT be saved to the database. Jobs will remain queued until the worker is started.

> **重要 / Important**: ワーカープロセスは `.env.local` から `DATABASE_URL` を読み込みます（`loadEnvLocal()` 経由）。`.mcp.json` や `claude_desktop_config.json` の `env` 設定はMCPサーバープロセスにのみ適用され、ワーカープロセスには反映されません。ワーカーが正しくDBに接続するには、プロジェクトルートに `.env.local` が必要です。
>
> **Important**: The worker process reads `DATABASE_URL` from `.env.local` (via `loadEnvLocal()`). The `env` settings in `.mcp.json` or `claude_desktop_config.json` only apply to the MCP server process, not the worker. A `.env.local` file in the project root is required for the worker to connect to the database.

### 5.1 Ollamaの起動確認 / Verify Ollama is Running

ワーカーが正常に動作するためには、Ollamaが起動しており llama3.2-vision モデルが利用可能である必要があります。

The worker requires Ollama to be running with the llama3.2-vision model available.

```bash
# Ollamaが起動しているか確認 / Check if Ollama is running
curl -s http://localhost:11434/api/tags | head -c 200

# モデルが利用可能か確認 / Verify model is available
ollama list
# "llama3.2-vision" が表示されればOK / Should show "llama3.2-vision"
```

> **Note / 注意**: Ollamaのインストールとモデルダウンロードはセクション3.1で完了しています。起動していない場合は `sudo systemctl start ollama` で起動してください。
>
> Ollama installation and model download were completed in section 3.1. If not running, start with `sudo systemctl start ollama`.

---

## 6. 動作確認 / Verification

### 6.1 MCPツールの確認 / Verify MCP Tools

Claude Desktopを再起動し、以下のように依頼してください：

Restart Claude Desktop and make a request like:

```
「このURLのレイアウトを分析して: https://example.com」
"Analyze the layout of this URL: https://example.com"
```

Claudeが `layout.ingest` または `page.analyze` ツールを使用して応答すれば成功です。

If Claude responds using the `layout.ingest` or `page.analyze` tool, the setup is successful.

### 6.2 ヘルスチェック / Health Check

```typescript
// Claude Desktop から / From Claude Desktop
await mcp__reftrix__system_health({ detailed: true });
```

---

## 7. 次のステップ / Next Steps

セットアップが完了したら、以下のガイドを参照して機能を活用してください：

Once setup is complete, refer to the following guides to utilize the features:

- [MCPツール使用ガイド / MCP Tools Usage Guide](./02-mcp-tools-guide.md) - 19のMCPツールの使用方法 / How to use the 19 MCP tools
- [page.analyze詳細ガイド / page.analyze Deep Dive](./03-page-analyze-deep-dive.md) - 統合分析の詳細 / Detailed unified analysis
- [トラブルシューティングガイド / Troubleshooting Guide](./04-troubleshooting.md) - 問題解決 / Problem solving

---

## 8. トラブルシューティング / Troubleshooting

### よくある問題 / Common Issues

#### データベース接続エラー / Database Connection Error

```
Error: P1001: Can't reach database server at `localhost:26432`
```

**解決策 / Solution:**
1. PostgreSQLが起動しているか確認 / Verify PostgreSQL is running
   ```bash
   pnpm docker:up  # または / or sudo systemctl start postgresql
   ```
2. ポート番号が正しいか確認（26432）/ Verify the port number is correct (26432)
3. ユーザー・パスワードが正しいか確認 / Verify username and password

#### MCPサーバーがビルドされていない / MCP Server Not Built

```
Error: Cannot find module '/path/to/apps/mcp-server/dist/index.js'
```

**解決策 / Solution:**
```bash
pnpm build
```

詳細なトラブルシューティングは [トラブルシューティングガイド / Troubleshooting Guide](./04-troubleshooting.md) を参照してください。

---

## 付録 / Appendix

### A. ポート一覧 / Port List

| サービス / Service | ポート / Port | 説明 / Description |
|---------|--------|------|
| PostgreSQL | 26432 | データベース（pgvector）/ Database (pgvector) |
| Redis | 27379 | BullMQジョブキューバックエンド / BullMQ job queue backend |
| Prisma Studio | 26555 | データベース管理UI / Database management UI |

### B. 環境変数一覧 / Environment Variables

| 変数名 / Variable | 説明 / Description | デフォルト値 / Default |
|--------|------|-------------|
| `DATABASE_URL` | PostgreSQL接続URL（ポート: 26432）/ PostgreSQL connection URL (port: 26432) | - |
| `REDIS_URL` | Redis接続URL / Redis connection URL | - |
| `REDIS_HOST` | Redisホスト / Redis host | `localhost` |
| `REDIS_PORT` | Redisポート / Redis port | `27379` |
| `NODE_ENV` | 環境（development/production）/ Environment (development/production) | development |
| `OLLAMA_BASE_URL` | Ollama接続URL / Ollama connection URL | `http://localhost:11434` |
| `ONNX_EXECUTION_PROVIDER` | ONNX実行プロバイダ（cuda/rocm/未設定でCPU）/ ONNX execution provider (cuda/rocm/CPU if unset) | - |
| `WORKER_MAX_JOBS_BEFORE_RESTART` | N件完了後にワーカーを再起動 / Restart worker after N jobs | `1` |

> **注記 / Note**: 上記は主要な環境変数のみです。完全な環境変数リストは `.env.example` を参照してください。
>
> The above lists only the key environment variables. See `.env.example` for the complete list.

### C. ディレクトリ構造 / Directory Structure

```
reftrix/
├── apps/
│   └── mcp-server/         # MCPサーバー（19ツール）/ MCP server (19 tools)
├── packages/
│   ├── database/           # Prismaスキーマ・マイグレーション / Prisma schema & migrations
│   ├── core/               # コアドメインロジック / Core domain logic
│   ├── ml/                 # ML/Embeddingサービス / ML/Embedding service
│   ├── webdesign-core/     # Webデザイン解析コア / Web design analysis core
│   └── config/             # 共有設定 / Shared configuration
├── docker/                 # Docker設定 / Docker configuration
├── docs/                   # ドキュメント / Documentation
└── package.json
```
