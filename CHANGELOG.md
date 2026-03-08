# Changelog / 変更履歴

All notable changes to this project will be documented in this file.

このプロジェクトに対する注目すべき変更点はすべてこのファイルに記載されます。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

形式は [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) に基づき、
[セマンティックバージョニング](https://semver.org/spec/v2.0.0.html) に準拠しています。

## [0.1.3] - 2026-03-08

### Added / 追加

- **User preference profiling system** (3 new MCP tools: `preference.hear`, `preference.get`, `preference.reset`) / **ユーザー嗜好プロファイリングシステム**（3つの新規MCPツール: `preference.hear`, `preference.get`, `preference.reset`）
  - `preference.hear`: Stateless hearing session (Mode A: sample presentation with progress tracking, Mode B: feedback recording with profile update) / ステートレスヒアリングセッション（Mode A: サンプル提示＋進捗トラッキング、Mode B: フィードバック記録＋プロファイル更新）
  - `preference.get`: Profile retrieval with GDPR data portability (Art. 20) via `include_signals` / プロファイル取得（GDPRデータポータビリティ Art. 20 対応、`include_signals`オプション）
  - `preference.reset`: Soft reset and hard delete (GDPR Art. 17 Right to Erasure) / ソフトリセット＋完全削除（GDPR Art. 17 忘れられる権利）
  - 2-factor confidence model (MoodCategory coverage 0.6 + interaction sufficiency 0.4, threshold 0.8, max 15 hearings) / 2因子信頼度モデル（MoodCategoryカバレッジ 0.6 + インタラクション充足度 0.4、閾値 0.8、最大15回ヒアリング）
  - GDPR Art. 13/14 compliant `profiling_notice` on new profile creation / 新規プロファイル作成時にGDPR Art. 13/14準拠の`profiling_notice`を返却
- **Preference-aware search reranking** across all 5 search tools (layout, motion, background, narrative, responsive) / **全5検索ツールにpreference rerankingを統合**（layout, motion, background, narrative, responsive）
  - Cosine similarity reranking with configurable `rerank_weight` (default 0.3) / コサイン類似度リランキング（設定可能な`rerank_weight`、デフォルト0.3）
  - `applyPreferenceReranking()` shared helper replacing ~35-line inline code per tool / 共通ヘルパー`applyPreferenceReranking()`で各ツール~35行のインラインコードを1行に集約
- **Database schema**: `preference_profiles`, `preference_signals` tables with Prisma migration / **データベーススキーマ追加**: `preference_profiles`, `preference_signals`テーブル（Prismaマイグレーション）
- **PRIVACY.md**: Profiling privacy policy (GDPR Art. 6/13/14/22, 8 sections, bilingual) / **PRIVACY.md**: プロファイリングプライバシーポリシー（GDPR Art. 6/13/14/22、8セクション、日英バイリンガル）
- **DATA_RETENTION.md**: Data retention policy (soft reset, hard delete, data export specifications) / **DATA_RETENTION.md**: データ保持ポリシー（ソフトリセット、完全削除、データエクスポート仕様）
- 138 new tests (29 service + 13 security + 96 tool/schema tests) / テスト138件追加（サービス29 + セキュリティ13 + ツール/スキーマ96）
- SEC/TDA/LCC 3-agent audit passed (12 audits across 4 phases, all PASS) / SEC/TDA/LCC 3エージェント監査全4Phase全PASS（12監査すべて合格）
- **Embedding Idle Timer**: MCPサーバー本体のEmbeddingService ONNX Worker ThreadがCUDA VRAMを30秒アイドル後に自動解放。後続のOllama Vision解析（page.analyze）がGPUで実行可能に / Auto-release CUDA VRAM from MCP server's EmbeddingService ONNX Worker Thread after 30s idle, enabling GPU acceleration for subsequent Ollama Vision analysis (page.analyze)
  - 環境変数 `EMBEDDING_IDLE_TIMEOUT_MS` で設定可能（デフォルト30秒、0で無効化） / Configurable via `EMBEDDING_IDLE_TIMEOUT_MS` env var (default 30s, 0 to disable)
- **Ollama GPU不整合検出** (`system.health`): nvidia-smiでGPU検出 + Ollama `size_vram=0` の不整合をクロスチェックし、actionable warningを表示。不整合時はステータスを `degraded` に降格 / **Ollama GPU mismatch detection** (`system.health`): Cross-checks nvidia-smi GPU detection against Ollama `size_vram=0`, shows actionable warning with fix steps. Downgrades status to `degraded` on mismatch (REFTRIX-GPU-MISMATCH-01)

### Fixed / 修正

- **RRF hybrid search missing `id`** -- search results lacked `id` field required for preference reranking / **RRFハイブリッド検索の`id`欠落** -- 検索結果にリランキングに必要な`id`フィールドが欠落していた
- **Responsive search reranking ID mismatch** -- `responsive_analysis_id` vs top-level `id` inconsistency / **レスポンシブ検索のリランキングID不一致** -- `responsive_analysis_id`とトップレベル`id`の不整合
- **DI factory registration** -- `PrismaClient` and `EmbeddingService` factories were missing at MCP server startup / **DIファクトリ登録欠落** -- MCPサーバー起動時に`PrismaClient`と`EmbeddingService`のファクトリが未登録
- **GPU VRAM競合修正**: 検索ツール（layout.search等）実行後にMCPサーバー本体のONNX Embeddingが~1,406MiB VRAMを占有し続け、Ollama Vision (11.7GB)がCPUフォールバックする問題を修正 / Fix GPU VRAM contention where MCP server's ONNX Embedding held ~1,406MiB VRAM after search tool execution, causing Ollama Vision (11.7GB) to fall back to CPU

### Security / セキュリティ

- **SEC-M-2**: `truncateId()` PII-safe ID truncation utility (5 files, 21 locations) / `truncateId()` PII安全なID切り詰めユーティリティ（5ファイル、21箇所）
- **SEC-L-1**: `parseVectorString()` NaN/Infinity defense with `Number.isFinite()` validation / `parseVectorString()`のNaN/Infinity防御（`Number.isFinite()`バリデーション）
- **SEC-L-2**: Embedding vector pre-generation NaN/Infinity validation / Embeddingベクトル生成前のNaN/Infinityバリデーション
- **LCC-5**: `sanitizeErrorMessage()` preventing internal DB structure leakage / `sanitizeErrorMessage()`で内部DB構造の漏洩を防止

### Changed / 変更

- MCP tool count: 20 → **23** (added `preference.hear`, `preference.get`, `preference.reset`) / MCPツール数: 20 → **23**（`preference.hear`, `preference.get`, `preference.reset`追加）
- All 5 search tool schemas now include optional `profile_id` parameter / 全5検索ツールスキーマにオプションの`profile_id`パラメータを追加

### Documentation / ドキュメント

- Updated `README.md`, `apps/mcp-server/README.md` with preference profiling info / `README.md`、`apps/mcp-server/README.md`にpreference profiling情報を追加
- Updated `docs/users-guide/02-mcp-tools-guide.md` with Preference tools section (Chapter 14) / `docs/users-guide/02-mcp-tools-guide.md`にPreferenceツールセクション（第14章）を追加
- Updated `docs/legal/PRIVACY_POLICY.md` v0.1.0 → v0.1.1 (profiling contradiction fix, Art. 22 explanation) / `docs/legal/PRIVACY_POLICY.md` v0.1.0 → v0.1.1（プロファイリング矛盾修正、Art. 22説明追加）
- Updated `docs/legal/TERMS_OF_SERVICE.md` with preference profiling in feature list / `docs/legal/TERMS_OF_SERVICE.md`の機能リストにpreference profilingを追加
- Updated ` (api-endpoints, database-schema, mcp-tools-reference) / ` database-schema, mcp-tools-reference）
- Updated ` with truncateId and NaN/Infinity defense patterns / `

## [0.1.2] - 2026-03-05

### Added / 追加

- **Apple Silicon Metal GPU detection** / **Apple Silicon Metal GPU検出**
  - `GpuVendor` enum (`NVIDIA | APPLE_METAL | UNKNOWN`) for GPU vendor identification / GPUベンダー識別用の`GpuVendor`列挙型
  - `HardwareDetector.isAppleSilicon()` static method (`process.platform + process.arch`, no external commands) / 外部コマンド不使用の静的メソッド
  - Ollama `/api/ps` reports Apple Silicon Unified Memory as `size_vram > 0`, so existing GPU detection works correctly / Ollama `/api/ps`がUnified Memoryを`size_vram > 0`として報告するため既存GPU判定で正しく動作
  - OllamaReadinessProbe log improved: "Apple Silicon detected: Metal GPU manages memory natively" (was "assuming CPU mode") / ReadinessProbeログ改善
  - 10 new tests (8 hardware-detector + 2 readiness-probe) / テスト10件追加
  - SEC/TDA/LCC 3-agent audit passed / SEC/TDA/LCC 3エージェント監査通過
- **NOTICE file** with Apple trademark attribution (per LCC audit recommendation) / Apple商標帰属表示のNOTICEファイル（LCC監査推奨）

### Fixed / 修正

- **Docker Compose backup authentication failure** / **Docker Composeバックアップ認証失敗**
  - Root cause: Docker Compose only reads `.env` by default, not `.env.local`, causing `POSTGRES_PASSWORD` to always resolve to the default `change_me` / 根本原因: Docker Composeは`.env`のみ読み込み、`.env.local`を読まないため`POSTGRES_PASSWORD`が常にデフォルト値`change_me`に展開される
  - Fix: `env_file` two-stage loading (`.env.example` defaults → `.env.local` overrides) / 修正: `env_file` 2段階読み込み（`.env.example`デフォルト → `.env.local`上書き）
  - Added auth pre-flight check (`pg_isready` + `psql SELECT 1`) to `db-backup.sh` and `db-restore.sh` / `db-backup.sh`と`db-restore.sh`に認証事前チェック（`pg_isready` + `psql SELECT 1`）追加
  - Added container-mode support to `db-restore.sh` (`REFTRIX_BACKUP_INSIDE_CONTAINER=true`) / `db-restore.sh`にコンテナ内モード対応追加（`REFTRIX_BACKUP_INSIDE_CONTAINER=true`）
  - `POSTGRES_PASSWORD` added to `.env.example` for Docker Compose consumption / Docker Compose用に`.env.example`に`POSTGRES_PASSWORD`追加
- **Quickstart setup completeness** / **Quickstartセットアップの完全性**
  - Added `pnpm exec playwright install chromium` for page crawling browser dependency / ページクロール用ブラウザ依存の`pnpm exec playwright install chromium`追加
  - Integrated Ollama setup into main Setup section (was optional, now required) / Ollamaセットアップをメインセットアップセクションに統合（オプション→必須）
  - Added `NODE_ENV` and `OLLAMA_BASE_URL` to MCP config example / MCP設定例に`NODE_ENV`と`OLLAMA_BASE_URL`追加
  - Corrected worker auto-start documentation (WorkerSupervisor auto-starts, no manual launch needed) / Worker自動起動ドキュメントの修正（WorkerSupervisorが自動起動、手動起動不要）
- **Ollama Vision OOM prevention (3-point unload)** / **Ollama Vision OOM防止（3箇所アンロード）**
  - Unloads Vision model via `keep_alive: "0"` at 3 points: (1) after Phase 1 Layout Analysis, (2) after Phase 2.5 Scroll Vision, (3) after Phase 4 Narrative / 3箇所でVisionモデルをアンロード
  - Frees ~10.6 GB on CPU-only (16 GB RAM) to prevent embedding OOM / CPU-only環境で~10.6GB解放しembedding OOM防止
  - Phase 1 unload also fixes Phase 2.5 skip on GPU environments (VRAM threshold was not cleared) / Phase 1アンロードでGPU環境のPhase 2.5スキップも解消
  - Idempotent (no-op when Vision not loaded); SSRF-safe via `validateOllamaLocalhostUrl()` / 冪等; SSRF対策済み
- **Default mode `visionUsed: false`** -- was incorrectly set even when Vision was used / デフォルトモードでVision使用時もfalseになっていた
- **CPU-only scroll vision timeout** -- scroll vision analysis timed out prematurely on CPU environments / CPU環境でスクロールVision分析が早期タイムアウト

### Changed / 変更

- Ollama (`llama3.2-vision`) promoted from optional to required prerequisite / Ollama（`llama3.2-vision`）をオプションから必須の前提条件に昇格
- Backup/restore scripts now show clear bilingual error messages on auth failure / バックアップ/リストアスクリプトが認証失敗時に明確な日英エラーメッセージを表示

### Documentation / ドキュメント

- Updated `current-architecture.md` HardwareDetector section with GpuVendor enum, `isAppleSilicon()`, Apple Silicon Unified Memory explanation / `current-architecture.md`のHardwareDetectorセクションにGpuVendor enum・isAppleSilicon()・Unified Memory説明を追加
- Updated `current-architecture.md` Database Backup & Restore section (bilingual, env_file two-stage loading, auth pre-flight check) / `current-architecture.md`のDatabase Backup & Restoreセクション更新（日英バイリンガル、env_file 2段階読み込み、認証事前チェック）
- Added troubleshooting section 2.6: Backup/Restore Authentication Failure / トラブルシューティングセクション2.6追加: バックアップ/リストア認証失敗
- Updated FAQ Q8 to use `pnpm db:backup` / FAQ Q8を`pnpm db:backup`に更新
- Updated ` with Ollama Vision Unload + Apple Metal Support info / ` Vision Unload＋Apple Metal Support情報を追加

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
