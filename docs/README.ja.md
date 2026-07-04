# ReftrixMCP — 日本語ガイド

> English version: [README.md](../README.md)

---

## 概要

**Reftrix（リフトリクス）** は、Webデザインを「検索可能なナレッジベース」として集約し、MCPツール + Claudeエージェントを介して、レイアウト分析・モーション検出・品質評価を実行するプラットフォームです。

> フロントエンドエンジニア、デザイナー、AIエージェント開発者向け — 実サイトを分析し、再利用可能なUIパターンをClaudeやMCPクライアント経由で取得できます。

Webページを「単なるスクリーンショット」ではなく、ベクトルDB + RAGで参照できる**構造化ナレッジ**として扱います。

### 解決する課題

| 現状の課題                 | Reftrixによる解決                            |
| -------------------------- | -------------------------------------------- |
| デザイン参考探しが手作業   | セマンティック検索でセクションパターンを発見 |
| レイアウト分析が属人的     | 自動セクション検出・グリッド解析             |
| モーション実装の参考不足   | CSS/JS実装パターンのデータベース化           |
| デザイン品質の定量評価困難 | 3軸評価（独自性・技巧・文脈）で客観評価      |
| ナレッジの分散             | 一元化されたWebデザインKB                    |
| AI生成デザインの画一化     | Anti-AI-cliche検出で人間味のあるデザイン     |

---

## 主な機能

### 🎨 Layout Analysis（レイアウト解析）

- **セマンティック検索**: pgvector + HNSW索引でセクションパターンを検索
- **自動セクション検出**: Hero, Feature, CTA, Testimonial等の自動分類
- **グリッド解析**: CSS Grid/Flexboxパターンの検出
- **タイポグラフィ抽出**: フォント設定・階層・スケールの分析
- **コード生成**: React/Vue/HTMLへの自動変換

### 🎬 Motion Detection（モーション検出）

- **CSS静的解析**: animation/transition/keyframesパターン検出
- **video mode（デフォルト有効）**: スクロール時フレームキャプチャ（15px/frame）
- **Frame Image Analysis**: Pixelmatch + Sharpによる差分検出・CLS問題特定
- **パフォーマンス検証**: will-change、transform、opacityの使用チェック
- **アクセシビリティ**: prefers-reduced-motion対応チェック
- **実装コード生成**: CSS/Tailwind/Framer Motion/GSAPコード出力

### 📊 Quality Evaluation（品質評価）

- **3軸評価**: 独自性（Originality）・技巧（Craftsmanship）・文脈適合性（Contextuality）
- **Anti-AI-cliche検出**: 抽象グラデーション球・無意味な線パターンなど検出
- **改善提案**: カテゴリ別の具体的改善アクション生成
- **スコアリング**: 0-100点 + A-Fグレード評価

### 🏢 Studio（プロジェクト管理）

以下の機能はMCPツールで提供されています。

- **ブランドパレット**: style.get_paletteでカラーパレット取得
- **統合解析**: page.analyzeでLayout+Motion+Quality一括実行
- **デザインブリーフ**: brief.validateで要件完全性チェック

### 🤖 MCP統合

- **Model Context Protocol**: Claude等のAIエージェントと直接統合
- **40のMCPツール**: WebDesign専用の分析・検索・評価ツール

### 🔍 Vision統合

- **Ollama Vision統合**: page.analyzeでllama3.2-visionを使用したレイアウト解析
- **デフォルト有効**: useVision=trueがデフォルト設定
- **Graceful Degradation**: Ollama利用不可時もHTML解析で続行
- **Vision分析結果**: SectionPattern.layoutInfo.visionAnalysisに保存

### 🔐 セキュリティ

- **HTMLサニタイズ**: Webページ取得時のHTMLサニタイズ処理（DOMPurify 3.3.x）
- **SSRF対策**: プライベートIP・メタデータサービスへのアクセスブロック
- **レート制限**: Token Bucket + Redis Luaスクリプトによるアトミック制御（CWE-770 DoS対策）。3ティア構成: analysis 10RPM / search 120RPM / default 60RPM。Graceful Degradation: Redis未接続時はインメモリフォールバック。全40 MCPツールに自動適用
- **入力検証**: Zodスキーマによる厳格な検証
- **SBOM**: CycloneDX 1.6 JSON形式の自動生成（EU CRA 2026/9/11脆弱性報告義務対応）

### ⚡ パフォーマンス

| メトリクス           | 目標    | 実績                               |
| -------------------- | ------- | ---------------------------------- |
| Vector Search P95    | < 500ms | 10.66ms                            |
| API Response P95     | < 100ms | ~15ms                              |
| Embedding生成        | < 100ms | 46ms (Decision), 24ms (Checkpoint) |
| Frame Diff (1ペア)   | < 100ms | ✅                                 |
| Statement Coverage   | > 80%   | ✅                                 |
| pass@1 (初回成功率)  | ≥ 85%   | ✅                                 |
| pass^3 (3回連続成功) | ≥ 70%   | ✅                                 |

**最適化手法**:

- **HNSW Index**: m=16で精度86%達成
- **Connection Pooling**: データベース接続最適化
- **Memory Cache**: 頻繁なクエリキャッシュ
- **Token Efficiency**: MCPツールレスポンス98.7%削減（178KB → 2KB）

---

## クイックスタート

### 前提条件

- **Node.js**: v20.19.0以上
- **pnpm**: v10.0.0以上
- **Ollama**: llama3.2-vision モデル（Vision分析に必要、約7.9GB）
- **Docker**: v24.0以上
- **Git**: v2.40以上

### インストール

```bash
# リポジトリをクローン
git clone https://github.com/TKMD/ReftrixMCP.git
cd ReftrixMCP

# 依存関係をインストール
pnpm install

# 環境変数を設定
cp .env.example .env.local
cp .env.local packages/database/.env

# データベースを起動
pnpm docker:up

# データベースマイグレーション
pnpm db:migrate
pnpm db:seed

# ビルド（MCPサーバー + パッケージ）
pnpm build

# Playwright Chromiumインストール
pnpm exec playwright install chromium

# DINOv2 Visual Embeddingモデルダウンロード（約800MB）
pnpm --filter @reftrixmcp/ml download:dinov2

# テスト実行
pnpm test
```

MCPサーバーは Claude Desktop から利用します。

### Claude Desktop設定

```json
{
  "mcpServers": {
    "reftrix": {
      "command": "node",
      "args": ["/path/to/reftrix/apps/mcp-server/dist/index.js"],
      "env": {
        "NODE_ENV": "development",
        "DATABASE_URL": "postgresql://reftrix:change_me@localhost:26432/reftrix?schema=public",
        "REDIS_URL": "redis://localhost:27379",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_HOST": "http://localhost:11434",
        "ENABLE_SECTION_SCREENSHOT_FALLBACK": "true"
      }
    }
  }
}
```

### MCP Client CLI設定

プロジェクトルートの `.mcp.json` または `~/.claude/.mcp.json` に以下を追加:

```json
{
  "mcpServers": {
    "reftrix": {
      "command": "node",
      "args": ["/path/to/reftrix/apps/mcp-server/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://reftrix:change_me@localhost:26432/reftrix?schema=public",
        "REDIS_URL": "redis://localhost:27379",
        "NODE_ENV": "development",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_HOST": "http://localhost:11434"
      }
    }
  }
}
```

> **注意**: `change_me` はプレースホルダーです。本番環境では必ず安全なパスワードに変更してください。

---

## 技術スタック

### MCPサーバー

| 技術           | バージョン | 選定理由                           |
| -------------- | ---------- | ---------------------------------- |
| **Node.js**    | 20.x LTS   | 長期サポート、ES Modules安定       |
| **Zod**        | 3.24.x     | スキーマ検証                       |
| **MCP SDK**    | 1.26.x     | Model Context Protocol統合         |
| **TypeScript** | 5.9.x      | node20モジュール、deferred imports |

### フロントエンド（example/reftrix4）

| 技術            | バージョン | 選定理由                                        |
| --------------- | ---------- | ----------------------------------------------- |
| **Next.js**     | 16.x       | React 19対応、Turbopack標準                     |
| **React**       | 19.x       | Activity API、useEffectEvent、Server Components |
| **TailwindCSS** | 4.1.x      | text-shadow、mask、改善されたブラウザ互換性     |

### コアパッケージ

| 技術           | バージョン | 選定理由         |
| -------------- | ---------- | ---------------- |
| **Prisma**     | 6.x        | 型安全なORM      |
| **Playwright** | 1.57.x     | ブラウザ自動化   |
| **Sharp**      | 0.34.x     | 画像処理         |
| **Pixelmatch** | 6.0.x      | フレーム差分検出 |

### データベース

| 技術           | バージョン | 選定理由                        |
| -------------- | ---------- | ------------------------------- |
| **PostgreSQL** | 18.x       | 最新安定版、I/Oサブシステム改善 |
| **pgvector**   | 0.8.x      | HNSW改善、フィルタリング強化    |

### ML/検索

| 技術                     | バージョン | 選定理由                              |
| ------------------------ | ---------- | ------------------------------------- |
| **ONNX Runtime**         | 1.21.x     | ローカルML推論（Worker Threadで実行） |
| **multilingual-e5-base** | -          | 多言語対応Embedding（768次元）        |
| **Ollama**               | Latest     | Vision分析統合（llama3.2-vision）     |

### Image Processing

| 技術           | バージョン | 選定理由                               |
| -------------- | ---------- | -------------------------------------- |
| **Sharp**      | 0.34.x     | 高速画像処理・前処理                   |
| **Pixelmatch** | 6.x        | 高精度差分検出（Frame Image Analysis） |

### テスト

| 技術           | バージョン                                                   | 選定理由                 |
| -------------- | ------------------------------------------------------------ | ------------------------ |
| **Vitest**     | 4.x（mcp-server, ml, core, webdesign-core）/ 3.x（database） | 高速テストフレームワーク |
| **Playwright** | 1.57.x                                                       | E2Eテスト                |

---

## 使用方法

### MCPツール（Claude統合）

**TypeScript使用例**:

```typescript
// Progressive Disclosure（3層構造）
// Layer 1: Frontmatter（summary=true）
const results = await mcp__reftrix__layout_search({ query: "hero section", limit: 10 });
// Response: 最小限のセクション情報のみ（99%削減）

// Layer 2: Interface（full details）
const detail = await mcp__reftrix__layout_inspect({ id: "uuid" });
// Response: 完全なレイアウト構造情報

// Layer 3: Examples（Layout + Motion + Quality）
const analysis = await mcp__reftrix__page_analyze({
  url: "https://example.com",
  summary: true, // トークン効率化
  layoutOptions: { useVision: true }, // Ollama Vision統合
  motionOptions: { detect_js_animations: true }, // GSAP/Framer Motion検出
});
```

---

## MCP ツール一覧

Reftrixは**40のMCPツール**を提供しています（WebDesign専用）。

### レイアウト解析（5ツール）

| ツール名               | 説明                                                               |
| ---------------------- | ------------------------------------------------------------------ |
| `layout.ingest`        | Webページ取得・スクリーンショット（save_to_db, auto_analyze対応）  |
| `layout.batch_ingest`  | 複数URLの一括インジェスト                                          |
| `layout.inspect`       | レイアウト解析（セクション・グリッド・タイポグラフィ、Vision統合） |
| `layout.search`        | セマンティックセクション検索                                       |
| `layout.generate_code` | React/Vue/HTMLコード生成                                           |

### モーション検出（2ツール）

| ツール名        | 説明                                                                          |
| --------------- | ----------------------------------------------------------------------------- |
| `motion.detect` | モーション検出（video mode デフォルト有効、15px/frame、Frame Image Analysis） |
| `motion.search` | モーションパターン検索                                                        |

### 品質評価（1ツール）

| ツール名           | 説明                                                  |
| ------------------ | ----------------------------------------------------- |
| `quality.evaluate` | デザイン品質評価（3軸評価、suggest_improvements統合） |

### ブランド・スタイル（2ツール）

| ツール名            | 説明                 |
| ------------------- | -------------------- |
| `style.get_palette` | ブランドパレット取得 |
| `brief.validate`    | デザインブリーフ検証 |

### ナラティブ・バックグラウンド（2ツール）

| ツール名            | 説明                                 |
| ------------------- | ------------------------------------ |
| `narrative.search`  | ナラティブパターン検索               |
| `background.search` | バックグラウンドデザインパターン検索 |

### レスポンシブ解析（1ツール）

| ツール名            | 説明                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `responsive.search` | レスポンシブ分析結果のセマンティック検索（ビューポート差異・ブレークポイント・スクリーンショット差分） |

### 嗜好プロファイリング（3ツール）

| ツール名           | 説明                                                                              |
| ------------------ | --------------------------------------------------------------------------------- |
| `preference.hear`  | 嗜好ヒアリングセッション（サンプル提示・フィードバック収集・2ファクタconfidence） |
| `preference.get`   | 嗜好プロファイル取得（GDPRシグナルエクスポート対応）                              |
| `preference.reset` | プロファイルリセットまたは完全削除（GDPRデータ消去権対応）                        |

### パーツ解析（3ツール）

| ツール名       | 説明                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| `part.search`  | UIパーツのセマンティック検索（16パーツタイプ、visual/text/hybridモード） |
| `part.inspect` | パーツ詳細取得（スタイル・バウンディングボックス・インタラクション情報） |
| `part.compare` | 2-5パーツの並列比較（スタイル・レイアウト・アクセシビリティ）            |

### 横断検索（1ツール）

| ツール名         | 説明                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `search.unified` | 横断検索 — layout/part/motion/background/narrativeの5サービスを並列検索し、類似度マージで統合結果を返却 |

### デザイン画像検索（1ツール）

| ツール名                 | 説明                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `design.search_by_image` | 画像類似検索 — Base64/URLからDINOv2 visual embeddingを生成し、HNSW + RRF 3ソースで類似デザインを検索 |

### 統合解析（2ツール）

| ツール名            | 説明                                                             |
| ------------------- | ---------------------------------------------------------------- |
| `page.analyze`      | 統合Web解析（layout+motion+quality、Vision統合、video mode対応） |
| `page.getJobStatus` | 非同期ジョブステータス確認                                       |

### システム（1ツール）

| ツール名        | 説明                      |
| --------------- | ------------------------- |
| `system.health` | MCPサーバーヘルスチェック |

---

## プロジェクト構造

```
ReftrixMCP/
├── apps/
│   ├── cli/                          # スタンドアロンCLI（MCP非依存）
│   └── mcp-server/                   # MCP Server（40ツール）
│       └── src/
│           └── tools/                # MCPツール定義
│
├── packages/
│   ├── database/                     # Prisma スキーマ・マイグレーション
│   ├── core/                         # コアドメインロジック
│   ├── ml/                           # ML/Embeddingサービス
│   ├── webdesign-core/               # Webデザイン解析コア
│   └── config/                       # 共有設定
│
├── docs/
│   └── users-guide/                  # ユーザーガイド
│
├── docker/                           # Docker設定
└── .github/workflows/                # CI/CD
```

---

## 開発

### テスト駆動開発（TDD）

このプロジェクトでは**TDD**を必須としています。

```bash
# 全テスト実行
pnpm test

# ウォッチモード
pnpm test:watch

# カバレッジレポート
pnpm test:coverage

# E2Eテスト
pnpm test:e2e
```

### コード品質

```bash
# リント
pnpm lint

# フォーマット
pnpm format

# 型チェック
pnpm typecheck
```

### データベース

```bash
# マイグレーション作成
pnpm db:migrate

# Prisma Studio起動（ポート26555）
pnpm db:studio

# シードデータ投入
pnpm db:seed
```

### ワーカー管理

page.analyzeはBullMQキューとワーカープロセスで非同期実行されます。**WorkerSupervisor** が管理します。

**v0.4.0 PR7d-2 以降**: MCP サーバー起動時に `WorkerSupervisor` が自動で page-analyze Worker を fork するため、通常運用では手動起動は不要です。手動起動は開発者/バッチスクリプト用途のみで、Redis-based dual-run guard により既存 Worker 検出時は `exit(1)` します。意図的な opt-out は `REFTRIX_ALLOW_MANUAL_WORKER=true` を設定してください（ADR-0011 参照）。

```bash
# page.analyzeワーカー起動（開発者向け、MCP サーバー未起動時のみ）
# Start page.analyze worker (developer-only, when MCP server is not running)
pnpm --filter @reftrixmcp/mcp-server worker:start:page
```

**WorkerSupervisor** は OOM クラッシュ防止のため、N 件のジョブ完了後にワーカープロセスを自動再起動します。デフォルトは 1 件ごとに再起動（`WORKER_MAX_JOBS_BEFORE_RESTART` 環境変数でオーバーライド可能）。計画的再起動時の新規ジョブ取得防止には **Pre-Return Pause パターン** を使用しています。

**BullMQ UI（Bull Board）**: ジョブの監視・管理用ダッシュボードがポート21080で利用可能です。

### Embeddingバックフィル

```bash
# Embeddingカバレッジ確認
pnpm --filter @reftrixmcp/mcp-server check:embeddings

# 欠損Embeddingのバックフィル実行
pnpm --filter @reftrixmcp/mcp-server backfill:embeddings
```

---

## 環境変数

`.env.example` をコピーして `.env.local` を作成してください。主な環境変数は以下の通りです。

| 変数名                           | デフォルト | 説明                                                                                                                                                                |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | -          | PostgreSQL接続文字列（ポート26432）                                                                                                                                 |
| `REDIS_URL`                      | -          | Redis接続文字列（BullMQキュー用、ポート27379）                                                                                                                      |
| `ONNX_EXECUTION_PROVIDER`        | `cpu`      | ONNX実行プロバイダ（`cpu` / `cuda`）                                                                                                                                |
| `WORKER_MAX_JOBS_BEFORE_RESTART` | `1`        | WorkerSupervisorの再起動間隔（ジョブ数）                                                                                                                            |
| `REFTRIX_RESPECT_ROBOTS_TXT`     | `"true"`   | robots.txt準拠。`"true"`の場合、クロール前にrobots.txtのDisallowディレクティブを確認します。詳細は[PRIVACY_POLICY.md](./legal/PRIVACY_POLICY.md)のSection 4.3を参照 |
| `MCP_AUTH_ENABLED`               | `"false"`  | MCP認証の有効化（本番環境推奨）                                                                                                                                     |

---

## ポートオフセット設定

他プロジェクトとの干渉を防ぐため、すべてのポートに**21000オフセット**を設定しています。

| サービス         | 標準ポート | Reftrixポート |
| ---------------- | ---------- | ------------- |
| PostgreSQL       | 5432       | **26432**     |
| Redis            | 6379       | **27379**     |
| Prisma Studio    | 5555       | **26555**     |
| BullMQ UI        | -          | **21080**     |
| example/reftrix4 | 3004       | **24004**     |

---

## 貢献

貢献を歓迎します！詳細は [CONTRIBUTING.md](../CONTRIBUTING.md) をご覧ください。

### 貢献方法

1. リポジトリをフォーク
2. フィーチャーブランチを作成（`git checkout -b feature/amazing-feature`）
3. 変更をコミット（`git commit -m 'feat: add amazing feature'`）
4. ブランチをプッシュ（`git push origin feature/amazing-feature`）
5. プルリクエストを作成

### コミットメッセージ規約

Conventional Commits形式を使用してください:

- `feat:` - 新機能
- `fix:` - バグ修正
- `docs:` - ドキュメント
- `test:` - テスト
- `refactor:` - リファクタリング
- `chore:` - ビルド・設定変更

---

## ライセンス

Copyright (C) 2025-2026 Reftrix Contributors

このプロジェクトは [GNU Affero General Public License v3.0 (AGPL-3.0)](../LICENSE) の下でライセンスされています。

### AGPL-3.0の要点

- **自由な使用・修正・配布**: ソースコードの閲覧・修正・再配布が可能です
- **ネットワーク利用条件**: 本ソフトウェアを使用してネットワークサービス（SaaS等）を提供する場合、サービス利用者に対して修正版のソースコードを公開する必要があります
- **派生物への適用**: 本ソフトウェアの派生物にも同じAGPL-3.0ライセンスが適用されます（コピーレフト）

### 商用ライセンス

AGPL-3.0の条件が適合しないユースケース（プロプライエタリ製品への組み込み、ソースコード非公開でのSaaS提供等）には、商用ライセンスをご用意しています。

**お問い合わせ**: [ライセンスに関するお問い合わせ](mailto:licence@reftrix.io)

### ソースコードの入手

本プロジェクトのソースコードは以下から入手できます:

- **GitHub**: https://github.com/TKMD/ReftrixMCP
- **リリース**: [GitHub Releases](https://github.com/TKMD/ReftrixMCP/releases)

---

## セキュリティ

セキュリティ脆弱性を発見した場合は、[SECURITY.md](../SECURITY.md) の手順に従って報告してください。

---

## 法務・プライバシー

- **プライバシーポリシー**: [docs/legal/PRIVACY_POLICY.md](./legal/PRIVACY_POLICY.md)
- **サードパーティライセンス**: [THIRDPARTY_LICENSES.md](../THIRDPARTY_LICENSES.md)
- **サードパーティ商標**: [NOTICE](../NOTICE)

---

## ドキュメント

| ガイド                                                               | 内容                                 |
| -------------------------------------------------------------------- | ------------------------------------ |
| [Getting Started](./users-guide/01-getting-started.md)               | インストール、セットアップ、初回分析 |
| [MCP Tools Guide](./users-guide/02-mcp-tools-guide.md)               | 全40ツールの使用例                   |
| [page.analyze Deep Dive](./users-guide/03-page-analyze-deep-dive.md) | 非同期分析フローとデータ構造         |
| [Troubleshooting](./users-guide/04-troubleshooting.md)               | よくある問題と解決方法               |

---

## ロードマップ

### Phase 1: Foundation ✅ Complete

- プロジェクトセットアップ
- データベーススキーマ
- コアAPI実装

### Phase 2: Core Features ✅ Complete

- 検索UI実装
- セキュリティ強化
- WebDesign解析基盤

### Phase 3: MCP Integration ✅ Complete

- MCPサーバー基盤
- レイアウト・モーション・品質評価ツール
- プロジェクト管理ツール
- 統合解析機能

### Phase 4: Studio & Projects ✅ Complete

- プロジェクト管理UI
- ブランドパレット統合
- Webページ解析機能
- 品質評価・モーション検出

### Phase 5: Polish & Launch ✅ Complete

- 高度なUI機能
- ドキュメントサイト
- パフォーマンスチューニング
- 本番デプロイ

### Phase 6: v0.3.0 Tier 2 ✅ Complete

- アクセシビリティ監査（WCAG 2.1 AA）
- Core Web Vitals評価
- デザイン比較・変更追跡
- GDPRコンプライアンス（削除権・データポータビリティ）
- セマンティック検索高度化（Query Understanding + Reranking）

---

## 既知の制限事項（v0.5.0）

- CPUモードではEmbedding生成に約2-5秒/テキスト（バッチ処理にはGPU推奨）
- 最低16GB RAM推奨、並行分析には32GB推奨
- 初回Embedding操作時に約400MBのモデル（multilingual-e5-base）をダウンロード
- `page.analyze` はWorkerSupervisorが管理する別プロセスで実行されます。`start-workers.ts` の起動が必要です（`pnpm --filter @reftrixmcp/mcp-server worker:start:page`）
- Vision分析（レイアウト、モーション、ナラティブ）にはOllama + llama3.2-visionが必要（未起動時はGraceful Degradation）
- DINOv2 visual embeddingモデルは約800MBのダウンロードが必要（ViT-B/14 ONNX）

### GPU・Vision関連（v0.1.2）

- **Apple Silicon (M1/M2/M3+)**: Metal GPUが自動検出されます。追加設定は不要です
- **Vision分析**: Ollama + llama3.2-vision が必要です。Visionモデルは各Phase完了後に自動アンロード（3箇所）され、メモリを効率的に管理します（CPU-only環境で約10.6GBを解放）

---

## サポート

- **GitHub Issues**: バグ報告や機能提案
- **GitHub Discussions**: 一般的な質問や議論

---

## 謝辞

- **TailwindCSS Team**: 優れたv4.1リリース
- **Vercel**: Next.js 16とReact 19サポート
- **pgvector Team**: 強力なベクトル検索拡張
- **Model Context Protocol**: 標準化されたAIツール統合プロトコル

---

## リンク

- **リポジトリ**: https://github.com/TKMD/ReftrixMCP
- **ドキュメント**: https://github.com/TKMD/ReftrixMCP/tree/main/docs
- **Issues**: https://github.com/TKMD/ReftrixMCP/issues
- **Discussions**: https://github.com/TKMD/ReftrixMCP/discussions

---

**注意**: このプロジェクトは現在開発中です。v1.0.0リリースまでAPIや機能は予告なく変更される可能性があります。
