# ReftrixMCP

**WebDesign Knowledge Base Platform** — Layout Analysis, Motion Detection, and Quality Evaluation with AI

**Webデザインナレッジベースプラットフォーム** — AIによるレイアウト分析・モーション検出・品質評価

[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

---

## Overview / 概要

ReftrixMCP is a platform that aggregates web design patterns (Layout, Motion, Quality) into a searchable knowledge base using vector search (pgvector) and RAG, accessible through MCP tools integrated with Claude.

ReftrixMCPは、Webデザインパターン（レイアウト・モーション・品質）をベクトル検索（pgvector）とRAGを用いて検索可能なナレッジベースに集約し、MCPツール経由でClaudeと統合するプラットフォームです。

### Key Features / 主要機能

| Feature / 機能 | Description / 説明 |
|---------|-------------|
| **Layout Analysis / レイアウト分析** | Extract and analyze page layout structures, section patterns, and design components / ページレイアウト構造・セクションパターン・デザインコンポーネントの抽出と分析 |
| **Motion Detection / モーション検出** | Detect CSS/JS animations, scroll-triggered effects, and motion patterns / CSS/JSアニメーション、スクロール連動エフェクト、モーションパターンの検出 |
| **Quality Evaluation / 品質評価** | Evaluate design quality across multiple dimensions (originality, craftsmanship, contextuality) / 複数次元（独自性、技巧性、文脈適合性）でのデザイン品質評価 |
| **Semantic Search / セマンティック検索** | 768-dimensional vector search with HNSW indexing for design pattern discovery / HNSWインデックスによる768次元ベクトル検索でデザインパターンを発見 |
| **Hybrid Search / ハイブリッド検索** | Reciprocal Rank Fusion combining vector (60%) and full-text (40%) search / Reciprocal Rank Fusionによるベクトル検索(60%)と全文検索(40%)の統合 |
| **Page Analysis / ページ分析** | Comprehensive single-URL analysis combining layout, motion, quality, and narrative / レイアウト・モーション・品質・ナラティブを統合した包括的なURL単位分析 |

## Quickstart / クイックスタート

### Prerequisites / 前提条件

- Node.js >= 20.19.0
- pnpm >= 10.0.0
- Docker & Docker Compose
- Ollama + llama3.2-vision（[インストール手順 / Install guide](https://ollama.com)）

### 1. Clone & Install / クローンとインストール

```bash
git clone https://github.com/TKMD/ReftrixMCP.git
cd ReftrixMCP
pnpm install

# pnpm 10.x: ネイティブビルドスクリプトの承認（Prisma, Sharp等）
# pnpm 10.x: Approve native build scripts (Prisma, Sharp, etc.)
pnpm approve-builds
pnpm install

# Install Ollama and download vision model / Ollamaをインストールしてモデルをダウンロード
# Linux:
curl -fsSL https://ollama.com/install.sh | sh
# macOS: brew install ollama
ollama pull llama3.2-vision  # ~7.9GB

# Configure environment variables / 環境変数を設定
cp .env.example .env.local

# Prisma用の環境変数ファイルを作成（Prisma CLIは.env.localを読めないため必須）
# Create env file for Prisma (required — Prisma CLI cannot read .env.local)
cp .env.local packages/database/.env
```

### 2. Start Infrastructure / インフラ起動

> **Note / 注意**: 既にReftrix関連のDockerボリュームが存在する場合、認証エラー（P1000）が発生します。`docker compose -f docker/docker-compose.yml down -v` で削除してから実行してください。
>
> If Reftrix-related Docker volumes already exist, authentication will fail (P1000). Run `docker compose -f docker/docker-compose.yml down -v` to remove them before proceeding.

```bash
# Start PostgreSQL (pgvector) and Redis / PostgreSQL (pgvector) と Redis を起動
pnpm docker:up

# Wait for PostgreSQL to be ready / PostgreSQLの起動完了を待機
docker compose -f docker/docker-compose.yml exec postgres pg_isready -U reftrix -d reftrix

# Install Playwright browser / Playwright ブラウザをインストール
pnpm exec playwright install chromium

# Run database migrations / データベースマイグレーションを実行
pnpm db:migrate

# Seed initial data / 初期データ投入
pnpm db:seed

# Build all packages / 全パッケージをビルド
pnpm build
```

### 3. Connect to Claude / Claude接続

Add the following to your Claude Desktop MCP configuration file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

以下をClaude DesktopのMCP設定に追加してください:

```json
{
  "mcpServers": {
    "reftrix": {
      "command": "node",
      "args": ["/path/to/ReftrixMCP/apps/mcp-server/dist/index.js"],
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

> **Note / 注意**: Replace `/path/to/ReftrixMCP/` with your actual installation path. / `/path/to/ReftrixMCP/` を実際のインストールパスに置き換えてください。

> **Important / 重要**: `NODE_ENV` is required. The server will not start without it. Valid values: `development`, `production`, `test`. / `NODE_ENV` は必須です。設定しないとサーバーが起動しません。有効な値: `development`, `production`, `test`

> **Warning**: `change_me` はプレースホルダーです。本番環境では必ず安全なパスワードに変更してください。
>
> **Warning**: `change_me` is a placeholder. Always use a secure password in production.

#### MCP Client (CLI) の場合 / For MCP Client (CLI)

プロジェクトルートに `.mcp.json` を作成してください:

Create `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "reftrix": {
      "command": "node",
      "args": ["/path/to/ReftrixMCP/apps/mcp-server/dist/index.js"],
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

> **Note / 注意**: MCP Client CLI uses `.mcp.json` instead of `claude_desktop_config.json`. Place it in the project root or `~/.claude/.mcp.json` for global configuration. / MCP Client CLIは `claude_desktop_config.json` ではなく `.mcp.json` を使用します。プロジェクトルートまたは `~/.claude/.mcp.json`（グローバル設定）に配置してください。

### 4. Start Worker / ワーカー起動

`page.analyze` runs asynchronously via BullMQ. Start the worker process:

`page.analyze` は BullMQ による非同期処理です。ワーカープロセスを起動してください:

```bash
pnpm --filter @reftrix/mcp-server worker:start:page
```

> **Warning / 警告**: ワーカー未起動の場合、`page.analyze` と `quality.batch_evaluate` の結果はDBに保存されません。ジョブはキューに滞留し、ワーカー起動後に処理されます。
>
> **Warning**: Without the worker running, `page.analyze` and `quality.batch_evaluate` results will NOT be saved to the database. Jobs will remain queued until the worker is started.

> **Note / 注意**: `layout.ingest` や `motion.detect` などの他のツールはワーカーなしで動作します。/ Other tools like `layout.ingest` and `motion.detect` work without the worker.

## Architecture / アーキテクチャ

```mermaid
graph TD
    A["MCP Client (e.g. Claude Desktop)"] -->|MCP Protocol| B[MCP Server]
    B --> C[Layout Analysis]
    B --> D[Motion Detection]
    B --> E[Quality Evaluation]
    B --> F[Search Engine]

    C --> G[(PostgreSQL + pgvector)]
    D --> G
    E --> G
    F --> G

    F --> H["ONNX Runtime<br/>multilingual-e5-base"]
    H --> G

    subgraph "19 MCP Tools"
        C
        D
        E
        F
    end

    subgraph "Storage"
        G
        I["Redis / BullMQ"]
    end
```

## Tech Stack / 技術スタック

| Category / カテゴリ | Technology / 技術 | Version / バージョン |
|----------|-----------|---------|
| Runtime | Node.js | >= 20.19.0 |
| Package Manager | pnpm | >= 10.0.0 |
| Language | TypeScript | 5.x (strict mode) |
| Database | PostgreSQL + pgvector | 18.x + 0.8.x |
| ORM | Prisma | 6.x |
| ML Runtime | ONNX Runtime | 1.21.x |
| Embedding Model | multilingual-e5-base | 768 dimensions |
| Vision LLM | Ollama + llama3.2-vision | Latest |
| Queue | BullMQ | 5.x |
| Cache | Redis | 7.x |
| Browser Automation | Playwright | 1.57.x |
| Testing | Vitest | 4.x (database: 3.x) |
| MCP Protocol | @modelcontextprotocol/sdk | Latest |
| Validation | Zod | 3.24.x |

## MCP Tools / MCPツール一覧

| Tool | Description / 説明 |
|------|-------------|
| `layout.ingest` | Analyze and store page layout / ページレイアウトの分析と保存 |
| `layout.inspect` | Inspect stored layout details / 保存されたレイアウト詳細の検査 |
| `layout.search` | Search layout patterns / レイアウトパターンの検索 |
| `layout.generate_code` | Generate code from layout patterns / レイアウトパターンからコード生成 |
| `layout.batch_ingest` | Batch layout analysis / レイアウトの一括分析 |
| `motion.detect` | Detect animations and motion / アニメーション・モーションの検出 |
| `motion.search` | Search motion patterns / モーションパターンの検索 |
| `quality.evaluate` | Evaluate design quality / デザイン品質の評価 |
| `quality.batch_evaluate` | Batch quality evaluation / 品質の一括評価 |
| `quality.getJobStatus` | Check async job status / 非同期ジョブのステータス確認 |
| `style.get_palette` | Extract color palette / カラーパレットの抽出 |
| `page.analyze` | Comprehensive page analysis / ページの包括的分析 |
| `page.getJobStatus` | Check page analysis job status / ページ分析ジョブのステータス確認 |
| `narrative.search` | Search narrative patterns / ナラティブパターンの検索 |
| `background.search` | Search background design patterns / 背景デザインパターンの検索 |
| `brief.validate` | Validate design briefs / デザインブリーフの検証 |
| `project.get` | Get project details / プロジェクト詳細の取得 |
| `project.list` | List projects / プロジェクト一覧の取得 |
| `system.health` | System health check / システムヘルスチェック |

## Project Structure / プロジェクト構造

```
ReftrixMCP/
├── apps/
│   └── mcp-server/          # MCP Server application / MCPサーバーアプリケーション
├── packages/
│   ├── config/               # Shared configuration (ESLint, TypeScript) / 共有設定
│   ├── core/                 # Core business logic / コアビジネスロジック
│   ├── database/             # Prisma schema, migrations, DB utilities / Prismaスキーマ・マイグレーション・DBユーティリティ
│   ├── ml/                   # ML inference (ONNX, embeddings) / ML推論（ONNX、Embedding）
│   └── webdesign-core/       # WebDesign domain models and services / Webデザインドメインモデル・サービス
├── docker/                   # Docker Compose configuration / Docker Compose設定
└── docs/                     # Documentation / ドキュメント
```

## Development / 開発

```bash
pnpm build        # Build all packages / 全パッケージのビルド
pnpm test         # Run tests / テスト実行
pnpm lint         # Lint check / Lintチェック
pnpm typecheck    # TypeScript type check / TypeScript型チェック
```

## Documentation / ドキュメント

For detailed setup instructions and usage guides, see: / 詳細なセットアップ手順と使い方については以下を参照:

- **[Getting Started / はじめに](./docs/users-guide/01-getting-started.md)** — Full setup guide with troubleshooting / セットアップ完全ガイド（トラブルシューティング付き）
- **[MCP Tools Guide / MCPツールガイド](./docs/users-guide/02-mcp-tools-guide.md)** — Detailed usage for all 19 tools / 全19ツールの詳細な使い方
- **[page.analyze Deep Dive](./docs/users-guide/03-page-analyze-deep-dive.md)** — Comprehensive analysis pipeline / 包括的分析パイプラインの詳細
- **[Troubleshooting / トラブルシューティング](./docs/users-guide/04-troubleshooting.md)** — Common issues and solutions / よくある問題と解決策

## Known Limitations (v0.1.0) / 既知の制限事項

| Limitation / 制限事項 | Detail / 詳細 |
|----------------------|---------------|
| **Embedding model download / Embeddingモデルダウンロード** | First embedding operation auto-downloads ~400MB model (multilingual-e5-base). Requires internet connection. / 初回Embedding操作時に約400MBのモデル（multilingual-e5-base）を自動ダウンロードします。インターネット接続が必要です。 |
| **CPU mode performance / CPUモード性能** | Embedding generation takes ~2-5s per text on CPU. GPU (CUDA) recommended for batch processing. / CPUモードではEmbedding生成に約2-5秒/テキストかかります。バッチ処理にはGPU（CUDA）推奨。 |
| **Memory requirements / メモリ要件** | Minimum 16GB RAM required. 32GB recommended for concurrent analysis with worker process and Ollama Vision. / 最低16GB RAM必要。ワーカープロセスとOllama Visionの並行分析には32GB推奨。 |
| **Worker process required / ワーカープロセス必須** | `page.analyze` and `quality.batch_evaluate` require a separate worker process. / `page.analyze` と `quality.batch_evaluate` は別途ワーカープロセスの起動が必要です。 |
| **Ollama required / Ollama必須** | Ollama with llama3.2-vision (~7.9GB) is required for narrative and vision analysis. See Prerequisites. / ナラティブ・Vision分析にはOllama + llama3.2-vision（約7.9GB）が必要です。前提条件を参照。 |

Contributions are welcome! / コントリビューション歓迎します！

## Network Use / Source Availability / ネットワーク利用時のソースコード提供

This software is licensed under **AGPL-3.0-only**.

If you modify and provide this software over a network, you must make the complete corresponding source code available to those users under the same license.

本ソフトウェアは **AGPL-3.0-only** でライセンスされています。本ソフトウェアを改変してネットワーク経由で提供する場合、利用者に対して同一ライセンスの下で完全な対応ソースコードを提供する必要があります。

- **Source Code / ソースコード**: https://github.com/TKMD/ReftrixMCP
- **Build Instructions / ビルド手順**: See [Quickstart](#quickstart--クイックスタート) above / 上記クイックスタートを参照
- **License / ライセンス**: [AGPL-3.0-only](./LICENSE)

For details on your obligations when modifying and deploying this software, please refer to [Section 13 of the AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0.html#section13).

本ソフトウェアの改変・デプロイ時の義務の詳細については、[AGPL-3.0 第13条](https://www.gnu.org/licenses/agpl-3.0.html#section13)を参照してください。

## Contributing / コントリビューション

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.
ガイドラインは [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

## Security / セキュリティ

See [SECURITY.md](./SECURITY.md) for vulnerability reporting.
脆弱性の報告方法は [SECURITY.md](./SECURITY.md) を参照してください。

## Legal & Privacy / 法務・プライバシー

- **Privacy Policy / プライバシーポリシー**: [docs/legal/PRIVACY_POLICY.md](docs/legal/PRIVACY_POLICY.md)
- **Third-Party Licenses / サードパーティライセンス**: [THIRDPARTY_LICENSES.md](THIRDPARTY_LICENSES.md)

## License / ライセンス

[AGPL-3.0-only](./LICENSE) - See [LICENSE](./LICENSE) for details.

商用ライセンスについては [licence@reftrix.io](mailto:licence@reftrix.io) までお問い合わせください。
For commercial licensing inquiries, contact [licence@reftrix.io](mailto:licence@reftrix.io).

"Reftrix" and "ReftrixMCP" are trademarks of @TKMD. See [TRADEMARK.md](TRADEMARK.md) for usage guidelines.

Copyright (c) 2026 TKMD and Reftrix Contributors
