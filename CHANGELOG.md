# Changelog / 変更履歴

All notable changes to this project will be documented in this file.

このプロジェクトに対する注目すべき変更点はすべてこのファイルに記載されます。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

形式は [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) に基づき、
[セマンティックバージョニング](https://semver.org/spec/v2.0.0.html) に準拠しています。

## [0.1.7] - 2026-03-21

### Refactored / リファクタリング

- **God Function分割**: page-analyze-worker→7フェーズモジュール（phase-0〜phase-5 + common）に分割。analyze.tool→sync-processing抽出、evaluate.tool→evaluate-engine抽出 / **God Function splits**: page-analyze-worker → 7 phase modules (phase-0–phase-5 + common). analyze.tool → sync-processing, evaluate.tool → evaluate-engine
- **スキーマ分割**: motion/schemas→3ファイル、page/schemas→3ファイル（re-export hub方式で後方互換性維持） / **Schema splits**: motion/schemas → 3 files, page/schemas → 3 files (re-export hub pattern for backward compatibility)
- **llama-vision.adapter→prompts+types分割**: LLMプロンプトと型定義を分離 / **llama-vision.adapter split**: separated LLM prompts and type definitions
- Dead code 13件削除、narrative-search重複統合、ESLint warning 27件修正 / Removed 13 dead code items, consolidated narrative-search duplicates, fixed 27 ESLint warnings

### Security / セキュリティ

- **SSRF・XSSサニタイズ・DOMPurifyバイパス修正**: 複数のセキュリティ脆弱性を解消 / **SSRF, XSS sanitization, and DOMPurify bypass fixes**: resolved multiple security vulnerabilities
- **isDevelopment()ガード違反25箇所修正**: catchブロック内でのエラーサイレント吸収を防止。全環境で`logger.warn`/`logger.error`を出力するよう統一 / **Fixed 25 isDevelopment() guard violations**: prevented silent error absorption in catch blocks. Unified to output `logger.warn`/`logger.error` in all environments
- **脆弱性解消**: flatted, effect (pnpm overrides)、undici 7.18.2→7.24.3 (High×6件)、flatted >=3.4.0 (High×1件) / **Vulnerability fixes**: flatted, effect (pnpm overrides), undici 7.18.2→7.24.3 (6 High), flatted >=3.4.0 (1 High)

### Tests / テスト

- デッドテスト11件削除（4,367行削減）、セキュリティテスト3件追加 / Removed 11 dead tests (4,367 lines reduced), added 3 security tests
- テストカバレッジ拡充（Worker系、スコアリング、グラデーション検出） / Test coverage expansion (Worker, scoring, gradient detection)

### Fixed / 修正

- **Phase 2.5 Progress範囲逆行修正**: 35-45%→60-63%に修正。進捗バーの逆行を解消 / **Phase 2.5 progress range regression fix**: corrected from 35-45% to 60-63%, resolving progress bar reversal
- **resolveMemoryConfig重複初期化を遅延初期化に変更**: 起動時の不要なメモリ設定計算を排除 / **resolveMemoryConfig lazy initialization**: eliminated redundant memory config computation at startup

### CI/CD

- **E2Eテストジョブ追加**: PostgreSQL+pgvector+Playwright+Redisを含む統合テスト環境 / **E2E test job added**: integrated test environment with PostgreSQL+pgvector+Playwright+Redis
- `format:check`有効化、`.git-blame-ignore-revs`作成 / Enabled `format:check`, created `.git-blame-ignore-revs`

### Code Style / コードスタイル

- コードベース全体（1,261ファイル）にPrettier整形適用 / Applied Prettier formatting across entire codebase (1,261 files)

## [0.1.6] - 2026-03-15

### Added / 追加

- **Section Visual Embedding (v0.1.5)**: Phase 5 (Embedding) でセクション単位のDINOv2 ViT-B/14 visual embedding生成を統合。screenshotBase64からセクションbounding boxでcrop→DINOv2で768D L2正規化ベクトルを生成し`section_embeddings.vision_embedding`に保存 / Section-level DINOv2 ViT-B/14 visual embedding generation integrated in Phase 5 (Embedding). Crops sections from screenshotBase64 using bounding boxes → generates 768D L2-normalized vectors via DINOv2, stored in `section_embeddings.vision_embedding`
  - DINOv2 init/disposeはPart Visual Embedding（v0.1.4）と共有しメモリ効率を最適化 / DINOv2 init/dispose shared with Part Visual Embedding (v0.1.4) for memory efficiency
  - PII保護: piiRiskLevel='high'パーツを含むセクションはスキップ / PII protection: skips sections containing piiRiskLevel='high' parts
  - Graceful Degradation: screenshot無し/DINOv2失敗/セクション高さ<10px時はtext_embeddingのみ / Graceful Degradation: text_embedding only when screenshot unavailable, DINOv2 fails, or section height < 10px
- **Section Screenshot Fallback (v0.1.6)**: Phase 5でscreenshotBase64範囲外のセクションに対し、`SectionScreenshotFallbackService`がPlaywrightで個別スクリーンショットを取得→DINOv2 visual embedding生成 / Section Screenshot Fallback captures individual section screenshots via Playwright for sections outside screenshotBase64 range in Phase 5 → DINOv2 visual embedding generation
  - バッチ処理化: workerがフォールバック対象セクションを事前一括収集し、1回の`captureSectionScreenshots`呼び出しで全セクション処理（page.goto N回→1回に削減） / Batch processing: worker pre-collects fallback target sections, processes all in a single `captureSectionScreenshots` call (reduces page.goto from N to 1)
  - Type-aware重複ベクトル検出: DINOv2生成後に同一sectionType内でのみコサイン類似度>0.995の重複をスキップ（スライディングウィンドウ10件、環境変数`DUPLICATE_VECTOR_THRESHOLD`で調整可能） / Type-aware duplicate vector detection: skips vision embeddings with cosine similarity > 0.995 within same sectionType (sliding window 10, configurable via `DUPLICATE_VECTOR_THRESHOLD` env var)
  - CTA小セクション（height<=200px）はdedup対象外 / CTA small sections (height <= 200px) exempt from dedup
  - scrollTo後にrequestAnimationFrame 2フレーム完了待ち（2秒タイムアウト付き）でLazy Rendering描画改善 / Post-scrollTo requestAnimationFrame 2-frame wait (2s timeout) improves lazy rendering paint
  - Feature flag `ENABLE_SECTION_SCREENSHOT_FALLBACK`（デフォルト`true`、opt-out） / Feature flag `ENABLE_SECTION_SCREENSHOT_FALLBACK` (default `true`, opt-out)
  - 安全装置: SSRF検証、NaN/Infinity防御、checkMemoryPressure毎セクション、累積300sタイムアウト、上限50セクション / Safety: SSRF validation, NaN/Infinity defense, checkMemoryPressure per section, 300s cumulative timeout, max 50 sections
- **Section Merge Post-Processor (v0.1.7-v0.1.8)**: Phase 1 (Layout Analysis) 内でmergeVisionDetectedSections()後に実行されるポストプロセッサ / Post-processor executed after mergeVisionDetectedSections() within Phase 1 (Layout Analysis)
  - Rule 1: 同一タイプ3+連続セクションをマージ（MERGEABLE_TYPES 11タイプ: unknown/feature/testimonial/gallery/partners/portfolio/team/stories/stats/faq/cta） / Rule 1: merge 3+ consecutive sections of same type (11 MERGEABLE_TYPES including cta)
  - Rule 2: コンテンツ空unknownセクション吸収（HTMLタグ除去後textContent<20文字） / Rule 2: absorb content-empty unknown sections (textContent < 20 chars after HTML tag stripping)
  - Rule 3: 同名隣接マージ（同一タイプ+同一heading+2件以上連続→1件にマージ） / Rule 3: same-heading adjacent merge (same type + same heading + 2+ consecutive → 1)
  - Feature flag `ENABLE_SECTION_MERGE_POSTPROCESSOR`（デフォルト`true`、opt-out） / Feature flag `ENABLE_SECTION_MERGE_POSTPROCESSOR` (default `true`, opt-out)
  - 安全装置: MAX_INPUT_SECTIONS=500、NaN/Infinity防御、Graceful Degradation / Safety: MAX_INPUT_SECTIONS=500, NaN/Infinity defense, Graceful Degradation
- **Section Split Post-Processor Rule 4 (v0.1.9)**: height > MAX_SECTION_HEIGHT (10,000px)の巨大セクション再分割 / Rule 4: oversized section re-splitting for sections with height > 10,000px
  - 3戦略: (A) HTML子セクション検出（`<section>`, `<article>`, `<h1>`-`<h3>`分割点）、(B) 等分割フォールバック、(C) 分割不可（MIN_SPLIT_SECTION_HEIGHT未満） / 3 strategies: (A) HTML child section detection, (B) equal-split fallback, (C) no-split (below MIN_SPLIT_SECTION_HEIGHT)
  - 実行順序: Rule 4 → Rule 1 → Rule 3 → Rule 2（分割→マージの順） / Execution order: Rule 4 → Rule 1 → Rule 3 → Rule 2 (split before merge)
  - Rule 4分割セクションはexcludeIdsでRule 1再マージ防止 / Rule 4 split sections use excludeIds to prevent Rule 1 re-merging
  - Feature flag `ENABLE_SECTION_SPLIT_POSTPROCESSOR`（デフォルト`true`、opt-out） / Feature flag (default `true`, opt-out)
- **Blank Image Detection + Dynamic Fallback (v0.1.9)**: Phase 5でfullPage screenshotのLazy Loading未描画セクション（白画像）を`isBlankImage()`で検出し、動的にFallback再取得→DINOv2 visual embedding生成 / Detects lazy-loading unrendered sections (blank images) in fullPage screenshots via `isBlankImage()`, dynamically re-captures via Section Screenshot Fallback → DINOv2 visual embedding
  - `acquireSectionCropBuffer()`でcropパス・白画像検出・Fallback取得を一元管理 / `acquireSectionCropBuffer()` unifies crop path, blank image detection, and fallback acquisition
  - 安全装置: MAX_DYNAMIC_FALLBACK_SECTIONS=20、位置ベース+動的合計50件上限、checkMemoryPressure / Safety: MAX_DYNAMIC_FALLBACK_SECTIONS=20, position-based + dynamic total capped at 50, checkMemoryPressure
  - 環境変数`BLANK_IMAGE_STDDEV_THRESHOLD`（デフォルト5.0、0-255範囲） / Env var `BLANK_IMAGE_STDDEV_THRESHOLD` (default 5.0, range 0-255)
- **Lazy Loading Scroll (v0.1.9)**: Phase 0でfullPage screenshot撮影前にページ全体をスクロールし、IntersectionObserverベースのLazy Loadingを発火。白画像問題を根本解決 / Scrolls entire page in Phase 0 before fullPage screenshot to trigger IntersectionObserver-based lazy loading, fundamentally resolving blank images
  - WebGLサイト(fullPage=false)では自動スキップ / Auto-skipped for WebGL sites (fullPage=false)
  - 安全装置: LAZY_SCROLL_MAX_ITERATIONS=50、rAF+2sタイムアウト、Graceful Degradation / Safety: MAX_ITERATIONS=50, rAF+2s timeout, Graceful Degradation
- **Section Screenshot Fallback Multi-Tile Capture (v0.1.10)**: section.height > viewportHeightの場合、セクションを動的に複数タイルに分割してPlaywrightで個別キャプチャし、Sharp compositeで垂直結合して完全なセクション画像を生成 / Multi-tile capture: dynamically splits sections exceeding viewport height into tiles, captures each via Playwright, vertically composites with Sharp
  - デフォルト上限20タイル（環境変数`MAX_TILES_PER_SECTION`でオーバーライド可能、絶対上限100） / Default cap 20 tiles (override via `MAX_TILES_PER_SECTION`, absolute limit 100)
  - Viewport統一: Fallback viewportを1920x1080に変更（ingest viewportと統一） / Viewport unification: 1920x1080 (unified with ingest viewport)
  - scrollY実測値によるclipY計算（sticky header対策、viewportHeight/2以上のズレ時は期待値にフォールバック） / scrollY actual measurement for clipY calculation (sticky header compensation)
  - 診断ログ: セクション単位のpath追跡ログ（in_range/fallback/dynamic/dedup/skipped）とサマリー出力 / Diagnostic logging: per-section path tracking (in_range/fallback/dynamic/dedup/skipped) with summary
  - SEC修正: viewport NaN/Infinity/0/負数防御+上限4096px、timeoutMs NaN防御、env var絶対上限100（SEC-TILES-01） / SEC fixes: viewport NaN defense + 4096px upper limit, absolute env var limit 100
- **Type-aware dedupヘルパー関数抽出**: `shouldSkipDuplicateVision()`として共通ヘルパーに抽出し、テスト7件追加 / Extracted type-aware dedup logic into `shouldSkipDuplicateVision()` shared helper with 7 tests
- **MAX_TILES_PER_SECTION動的化**: 環境変数によるランタイム設定でVision coverageボトルネックを解消 / Dynamic `MAX_TILES_PER_SECTION` via env var resolves Vision coverage bottleneck

### Fixed / 修正

- **onnxruntime-node ABIミスマッチ解消**: onnxruntime-nodeバージョン固定でNode.js ABIバージョン不整合によるクラッシュを修正 / Pin onnxruntime-node version to fix Node.js ABI version mismatch crash
- **isBlankImage()ダークテーマ誤検出修正**: stddev単独判定からstddev + mean輝度の2条件判定に変更（avgStddev < 5.0 AND (avgMean > 245 OR avgMean < 10)）。ダークテーマサイトが白画像と誤検出される問題を解消 / Fix isBlankImage() dark theme false positive: changed from stddev-only to dual-condition check (stddev + mean brightness). Prevents dark theme sites from being incorrectly flagged as blank
- **actualScrollY clipY計算フォールバック追加**: clip_height_zeroリグレッションを修正 / Add fallback to actualScrollY clipY calculation, fixing clip_height_zero regression
- **Dynamic Fallbackバグ修正3件**: (1) acquireSectionCropBufferの構造的バグ修正（isBlank判定の論理反転: false→true）、(2) メモリ圧力回避のscreenshotBuffer明示的解放、(3) Rule 3にexcludeIds適用（Rule 4分割セクションの再マージ防止） / 3 Dynamic Fallback bug fixes: (1) isBlank logic inversion fix, (2) explicit screenshotBuffer release, (3) excludeIds applied to Rule 3
- **Pre-Return Pauseレースコンディション解消**: Worker計画的再起動時のPre-Return Pauseのレースコンディションを修正。startup recoveryのfetchNext呼び出しも修正 / Fix Pre-Return Pause race condition during planned worker restart + fix startup recovery fetchNext call
- **Worker path postProcessSections統合**: page.analyzeの非同期Worker処理にpostProcessSections(Rule 1-4)呼び出しを追加。saveSectionPatterns前に実行し、分割/マージされたセクションのtext_embeddingも正しく生成 / Added postProcessSections (Rule 1-4) to Worker path before saveSectionPatterns, ensuring correct text_embeddings for split/merged sections

### Changed / 変更

- **エージェント設計をv3.0に刷新**: 職種ベース（Backend Developer, ML Engineer等）から問題領域ベース（page-analyze-pipeline-engineer, playwright-capture-engineer等）に移行。全15エージェントをv3.0フォーマットに統一 / Agent architecture redesigned to v3.0: migrated from role-based (Backend Developer, ML Engineer, etc.) to problem-domain-based (page-analyze-pipeline-engineer, playwright-capture-engineer, etc.). All 15 agents unified to v3.0 format
  - 5ドメインエージェント新設: page-analyze-pipeline-engineer, playwright-capture-engineer, embedding-retrieval-engineer, search-relevance-engineer, worker-observability-engineer / 5 new domain agents
  - 症状→エージェントルーティング表を導入 / Symptom → Agent routing table introduced
  - Evidence-First原則と明示的ハンドオフパターンを全エージェントに適用 / Evidence-First principle and explicit handoff patterns applied to all agents
- Fallback viewport: 1280x800 → 1920x1080（ingest viewportと統一） / Fallback viewport unified to 1920x1080

### Documentation / ドキュメント

- Section Visual Embedding（v0.1.5）のドキュメント包括的アップデート / Comprehensive docs update for Section Visual Embedding (v0.1.5)
- Section Merge Post-Processor（v0.1.7-v0.1.8）のドキュメント追記 / Section Merge Post-Processor (v0.1.7-v0.1.8) docs added
- v0.1.9 Blank Image Detection + Dynamic Fallback / Section Split Rule 4のドキュメント追記 / v0.1.9 docs for Blank Image Detection, Dynamic Fallback, and Section Split Rule 4
- v0.1.9 Lazy Loading Scroll + Worker postProcessSections統合 + Dynamic Fallbackバグ修正のドキュメント追記 / v0.1.9 docs for Lazy Loading Scroll, Worker postProcessSections integration, and Dynamic Fallback bug fixes
- v0.1.10 Section Screenshot Fallback Multi-Tile + isBlankImage改善のドキュメント追記 / v0.1.10 docs for Multi-Tile Capture and isBlankImage improvement
- sub-agents.md v3.0更新、TEAM_STRUCTURE.md更新 / sub-agents.md v3.0 update, TEAM_STRUCTURE.md update

## [0.1.5] - 2026-03-12

### Added / 追加

- **Part-Level Analysis機能**（3つの新規MCPツール: `part.search`, `part.inspect`, `part.compare`） / **Part-Level Analysis** (3 new MCP tools: `part.search`, `part.inspect`, `part.compare`)
  - `part.search`: セマンティックUIパーツ検索（ハイブリッド: ベクトル + 全文検索 RRF）。16パーツタイプ対応、searchMode（visual/text/hybrid）、partType/webPageIdフィルタ / Semantic UI part search (hybrid: vector + fulltext RRF). 16 part types, searchMode (visual/text/hybrid), partType/webPageId filters
  - `part.inspect`: パーツ詳細取得（computedStyles, boundingBox, interactionInfo, cssClasses, attributes, piiRiskLevel）。オプション: includeHtml, includeEmbedding / Get detailed part info by ID with computed styles, bounding box, interaction info. Opt-in: includeHtml, includeEmbedding
  - `part.compare`: 2-5パーツの比較（スタイル、レイアウト、インタラクション、アクセシビリティ） / Compare 2-5 parts side by side on styles, layout, interaction, and accessibility
  - 16パーツタイプ: heading, button, link, image, icon, input, form, card, navigation, footer, badge, avatar, divider, modal, toast, tooltip / 16 part types
  - PII検出（piiRiskLevel: low/medium/high）で個人情報を含むパーツの自動分類 / PII detection with automatic classification of parts containing personal information
- **DINOv2 ViT-B/14 visual embedding**: パーツの視覚的特徴を768次元L2正規化ベクトルで表現。`part.search` のsearchMode `visual` / `hybrid` で利用可能 / DINOv2 ViT-B/14 visual embedding: 768-dim L2-normalized vectors representing visual features of parts. Available via `part.search` searchMode `visual` / `hybrid`
  - Phase 5 Embedding末尾で自動生成（e5-base dispose後にDINOv2ロード ~800MB、完了後dispose） / Auto-generated at end of Phase 5 Embedding (loads DINOv2 ~800MB after e5-base disposal, disposes after completion)
  - Graceful Degradation: screenshot無し/DINOv2失敗/bbox未解決時はtext_embeddingのみ / Graceful Degradation: text_embedding only when screenshot unavailable, DINOv2 fails, or bbox unresolved
  - piiRiskLevel='high'パーツはvisual embeddingスキップ / Skips visual embedding for piiRiskLevel='high' parts
  - 環境変数 `DINOV2_MODEL_PATH` でモデルパス指定可能 / Model path configurable via `DINOV2_MODEL_PATH` env var

### Fixed / 修正

- **JSDOM bounding box常時ゼロ問題を修正**: Part ExtractionがJSDOMベースのため`getBoundingClientRect()`が常に`{0,0,0,0}`を返す問題を、Phase 5冒頭でPlaywright（`PartBboxPlaywrightService`）により実bounding boxを後付け取得することで解決 / Fix JSDOM bounding box always zero: Part Extraction uses JSDOM where `getBoundingClientRect()` always returns `{0,0,0,0}`. Resolved by retroactively obtaining real bounding boxes via Playwright (`PartBboxPlaywrightService`) at the start of Phase 5
  - sharedBrowserの`isConnected()`チェック + 切断時はフォールバックとして独自Chromiumインスタンスを起動 / Checks sharedBrowser `isConnected()` and falls back to launching standalone Chromium if disconnected
  - SSRF対策（`validateExternalUrl()`）+ CSSインジェクション防御（`escapeCssIdentifier()`） / SSRF prevention (`validateExternalUrl()`) + CSS injection defense (`escapeCssIdentifier()`)
  - 39テスト追加（正常系、早期リターン、Graceful Degradation、リソースクリーンアップ、SSRF、CSSセレクタ） / 39 tests added (normal flow, early return, graceful degradation, resource cleanup, SSRF, CSS selectors)

### Changed / 変更

- MCPツール数: 23 → **26**（`part.search`, `part.inspect`, `part.compare`追加） / MCP tool count: 23 → **26** (added `part.search`, `part.inspect`, `part.compare`)
- Worker Pipeline Phase 5にStep 0（Playwright Bounding Box Resolution）を追加 / Added Step 0 (Playwright Bounding Box Resolution) to Worker Pipeline Phase 5

### Documentation / ドキュメント

- Part-Level Analysisのアーキテクチャ・ツール仕様ドキュメントを追加（` / Added Part-Level Analysis architecture and tool specification docs (` updated)

## [0.1.4] - 2026-03-11

### Fixed / 修正

- **WorkerパスでCSSスニペットがDB保存されない問題を修正**: worker-db-save → section_patternsに5 CSSフィールド（cssSnippet, externalCssContent, externalCssMeta, cssFramework, cssFrameworkMeta）を追加。page-analyze-workerでページレベルCSSをセクション単位に配布 / Fix CSS snippet data not saved in Worker path: added 5 CSS fields to section_patterns via worker-db-save, distributing page-level CSS to sections in page-analyze-worker
- **BullMQ obliterateを完全除去しwaiting/completedジョブを保護**: obliterate()がwaiting/completedジョブを破壊していた問題を修正 / Remove BullMQ obliterate entirely to protect waiting/completed jobs
- **コードレビュー指摘5件を修正**: 認証チェック、キュー管理、ポーリング間隔、ドキュメント整合性 / Fix 5 code review findings (auth checks, queue management, polling interval, docs consistency)
- **テスト修正3件**: layout-first-mode並列テストタイムアウト延長(120s)、system-health detectGpuMismatchモック追加、パフォーマンステスト閾値緩和 / Fix 3 test issues: extend parallel test timeout, add GPU mismatch mock, relax perf test threshold

### Security / セキュリティ

- **CVE-2026-0540**: DOMPurify 3.3.2に更新しXSS脆弱性を修正 / Update DOMPurify to 3.3.2 to fix XSS vulnerability
- **GHSA-qffp-2rhf-9h96**: tar overrideを>=7.5.10に更新しhardlinkパストラバーサルを修正 / Update tar override to fix hardlink path traversal
- **hono/node-server脆弱性4件を解消** / Fix 4 Dependabot vulnerabilities in hono/node-server

### Changed / 変更

- Glama MCPサーバーディレクトリ登録（`glama.json`追加、READMEにバッジ追加） / Register on Glama MCP server directory (add `glama.json` and badge to README)
- OSS版mcp-serverパッケージから`private:true`を自動除去 / Auto-remove `private:true` from OSS mcp-server package.json

### Documentation / ドキュメント

- README冒頭にペルソナ文とQuickstart誘導文を追加 / Add persona line and quickstart hook to README

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
