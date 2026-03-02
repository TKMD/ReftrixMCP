# Changelog / 変更履歴

All notable changes to this project will be documented in this file.

このプロジェクトに対する注目すべき変更点はすべてこのファイルに記載されます。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

形式は [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) に基づき、
[セマンティックバージョニング](https://semver.org/spec/v2.0.0.html) に準拠しています。

## [Unreleased]

## [0.1.1] - 2026-03-03

### Added / 追加

- **Responsive design analysis** (`responsive.search` -- 20th MCP tool) / **レスポンシブデザイン分析**（`responsive.search` -- 20番目のMCPツール）
  - Multi-viewport capture (mobile 375px / tablet 768px / desktop 1440px) with Playwright / Playwrightによるマルチビューポートキャプチャ
  - Difference detection engine v2: computedStyle, BoundingRect, external CSS resolution / 検出エンジンv2: computedStyle・BoundingRect・外部CSS解決
  - Screenshot diff via Pixelmatch with configurable threshold / Pixelmatchによるスクリーンショット差分（閾値設定可能）
  - 8 diff categories: layout, typography, spacing, visibility, navigation, image, interaction, animation / 8つの差異カテゴリ
  - Semantic search over responsive analysis results via pgvector HNSW + JSONB filters / pgvector HNSW + JSONBフィルタによるレスポンシブ分析セマンティック検索
  - Embedding generation integrated into Worker Phase 5 pipeline / Worker Phase 5パイプラインにEmbedding生成を統合
  - Clean-slate pattern: re-analysis overwrites previous results per URL / Clean-slateパターン: 同一URL再分析時に旧データを上書き
  - SEC/TDA/LCC 3-agent audit passed (2 rounds) / SEC/TDA/LCC 3エージェント監査通過（2ラウンド）
- Full Japanese README at `docs/README.ja.md` / 日本語フルREADME（`docs/README.ja.md`）
- Restructured English-main `README.md` (~150 lines, concise and action-oriented) / 英語メインREADME再構築（約150行、簡潔・行動指向）

### Fixed / 修正

- ONNX Worker Thread `execArgv` propagation causing zero embeddings / ONNX Worker ThreadのexecArgv伝播によるEmbedding生成0件問題
- Missing `setEmbeddingServiceFactory` in Worker process DI initialization / WorkerプロセスDI初期化でのsetEmbeddingServiceFactory未設定
- `screenshot_diffs` design bug: separated internal capture from response payload / screenshot_diffs設計バグ: 内部キャプチャとレスポンス返却の分離
- `viewportsAnalyzed` missing `width`/`height` fields / viewportsAnalyzedのwidth/heightフィールド欠落
- Offset schema missing `.int()` constraint (SEC W-1) / offsetスキーマの.int()制約欠落（SEC W-1）

### Changed / 変更

- MCP tool count: 19 → **20** (added `responsive.search`) / MCPツール数: 19 → **20**（`responsive.search`追加）
- Updated all documentation to reflect 20 tools / 全ドキュメントを20ツールに更新
  - `README.md`, `apps/mcp-server/README.md`, `docs/users-guide/02-mcp-tools-guide.md`, `docs/users-guide/03-page-analyze-deep-dive.md`

## [0.1.0] - 2026-03-01

### Added / 追加

- Initial OSS release / 初回OSS公開
- MCP Server with 19 tools (layout, motion, quality, page analysis, search) / 19ツール搭載のMCPサーバー（レイアウト、モーション、品質、ページ分析、検索）
- Layout analysis and section detection / レイアウト分析とセクション検出
- Motion/animation detection (CSS + JavaScript) / モーション・アニメーション検出（CSS + JavaScript）
- Design quality evaluation / デザイン品質評価
- Semantic search with multilingual-e5-base embeddings (768 dimensions) / multilingual-e5-baseエンベディングによるセマンティック検索（768次元）
- Hybrid search (vector + full-text with RRF) / ハイブリッド検索（ベクトル + 全文検索、RRF統合）
- Background design detection / 背景デザイン検出
- Narrative analysis with vector + full-text + hybrid search / ベクトル・全文・ハイブリッド検索対応のナラティブ分析
- Frame image analysis with Worker thread parallelization, CLS calculation, and color change detection / Worker Thread並列処理・CLS計算・色変化検出対応のフレーム画像分析
- Page analysis pipeline with WorkerSupervisor / WorkerSupervisorによるページ分析パイプライン
- GPU Resource Manager for ONNX/Ollama coordination / ONNX/Ollama連携のためのGPUリソースマネージャー
- PostgreSQL 18 + pgvector 0.8 with HNSW indexing / PostgreSQL 18 + pgvector 0.8（HNSWインデックス）
- Browser automation with Playwright / Playwrightによるブラウザ自動化
- Comprehensive pre-release security audit / 包括的リリース前セキュリティ監査
- `pnpm audit --audit-level=high` enforced in CI / CIでHigh以上の脆弱性チェック強制
- `REFTRIX_RESPECT_ROBOTS_TXT` environment variable for robots.txt compliance / robots.txt準拠のための環境変数
- Coverage thresholds for all 5 packages / 全5パッケージにカバレッジ閾値を設定
- Prisma `postinstall` generate hook / Prisma postinstallでの自動generate
