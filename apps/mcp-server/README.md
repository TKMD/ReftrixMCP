# Reftrix MCP Server

AIエージェント（Claude等）がReftrixのWebデザイン分析機能と連携するためのModel Context Protocol (MCP) サーバー実装です。

A Model Context Protocol (MCP) server implementation that enables AI agents (such as Claude) to interact with Reftrix's web design analysis features.

## 概要 / Overview

Reftrix MCP Serverは、Webデザインのレイアウト分析・モーション検出・品質評価をMCPツールとして提供します。Claude Desktopなどのクライアントから自然言語でWebデザイン分析が可能になります。

Reftrix MCP Server provides web design layout analysis, motion detection, and quality evaluation as MCP tools. It enables natural language-based web design analysis from clients such as Claude Desktop.

### 主要機能 / Key Features

- **レイアウト分析**: Webページの構造解析、セクションパターン抽出
- **モーション検出**: CSSアニメーション/トランジション検出
- **品質評価**: デザイン品質3軸評価（独自性・技巧・文脈適合性）
- **コード生成**: セクションパターンからReact/Vue/HTML生成
- **統合Web分析**: `page.analyze` による Layout + Motion + Quality + Responsive 一括分析（非同期、BullMQ）+ opt-in Phase 7.5（`accessibilityOptions` / `performanceOptions` / `auto_snapshot`）
- **ナラティブ検索**: 世界観・レイアウト構成セマンティック検索
- **バックグラウンド検索**: BackgroundDesignセマンティック検索
- **横断検索**: `search.unified` による5サービス並列統合検索
- **画像類似検索**: `design.search_by_image` によるDINOv2 visual embedding検索
- **レート制限**: Token Bucket + Redis Lua、3ティア（analysis/search/default）
- **検索キャッシュ**: LRUキャッシュ（lru-cache v11、500エントリ、5分TTL）
- **SBOM**: CycloneDX 1.6自動生成

### 技術スタック / Tech Stack

| 技術 / Technology | バージョン / Version | 用途 / Purpose                                    |
| ----------------- | -------------------- | ------------------------------------------------- |
| MCP SDK           | 1.26.x               | Model Context Protocol実装                        |
| Node.js           | 20.x LTS             | ランタイム                                        |
| TypeScript        | 5.x                  | 型安全な開発                                      |
| Zod               | 3.24.x               | 入力バリデーション                                |
| BullMQ            | 5.66.x               | 非同期ジョブキュー（page.analyze）                |
| Redis             | -                    | BullMQジョブキューのバックエンド（ポート: 27379） |
| ONNX Runtime      | 1.21.x               | ML推論（Embedding生成、Worker Thread化）          |

## インストール / Installation

```bash
# モノレポルートから
pnpm install

# ビルド
cd apps/mcp-server
pnpm build
```

## 使用方法 / Usage

### 直接実行 / Direct Execution

```bash
# 開発モード
pnpm dev

# プロダクション
pnpm start
```

### Claude Desktop設定 / Claude Desktop Configuration

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) または該当パスに以下を追加:

```json
{
  "mcpServers": {
    "reftrix": {
      "command": "node",
      "args": ["/path/to/reftrix/apps/mcp-server/dist/index.js"],
      "env": {
        "NODE_ENV": "development",
        "DATABASE_URL": "postgresql://reftrix:change_me@localhost:26432/reftrix?schema=public",
        "REDIS_URL": "redis://localhost:27379"
      }
    }
  }
}
```

## MCPツール一覧（<!-- gen:tool-count -->35<!-- /gen:tool-count -->ツール） / MCP Tool List (<!-- gen:tool-count -->35<!-- /gen:tool-count --> Tools)

### Layoutツール（5ツール） / Layout Tools (5 Tools)

#### `layout.ingest` - Webページ取得 / Web Page Ingestion

URLからWebページのHTML・スクリーンショットを取得し、レイアウト解析用データを準備します。

Retrieves HTML and screenshots from a URL and prepares data for layout analysis.

**入力スキーマ / Input Schema**:

```typescript
{
  url: string;              // 取得対象URL（https/http、必須）
  source_type?: 'award_gallery' | 'user_provided';
  usage_scope?: 'inspiration_only' | 'owned_asset';
  options?: {
    viewport?: { width: number; height: number };
    full_page?: boolean;          // デフォルト: true
    timeout?: number;             // デフォルト: 30000 (30秒)
    save_to_db?: boolean;         // デフォルト: true（DB保存、motion.detect連携用）
    include_html?: boolean;       // デフォルト: false
    include_screenshot?: boolean; // デフォルト: false
  };
}
```

#### `layout.inspect` - レイアウト解析 / Layout Analysis

HTMLを解析し、セクション構成・グリッド・タイポグラフィ情報を抽出します。 / Analyzes HTML and extracts section structure, grid, and typography information.

**入力スキーマ**:

```typescript
{
  id?: string;              // WebページID（htmlと排他）
  html?: string;            // 直接HTML指定
  options?: {
    detectSections?: boolean;
    detectGrid?: boolean;
    analyzeTypography?: boolean;
    extractColors?: boolean;
  };
}
```

#### `layout.search` - レイアウトパターン検索 / Layout Pattern Search

セクションパターンを自然言語でセマンティック検索します。 / Performs semantic search on section patterns using natural language.

**入力スキーマ**:

```typescript
{
  query: string;            // 検索クエリ（1-500文字、必須）
  filters?: {
    sectionType?: 'hero' | 'feature' | 'cta' | 'testimonial' | 'pricing' | 'footer' | 'navigation' | 'about' | 'contact' | 'gallery' | 'partners' | 'portfolio' | 'team' | 'stories' | 'research' | 'subscribe' | 'stats' | 'faq';
    sourceType?: 'award_gallery' | 'user_provided';
    usageScope?: 'inspiration_only' | 'owned_asset';
  };
  limit?: number;           // 取得件数（1-50、デフォルト10）
  include_html?: boolean;   // HTMLを含めるか（デフォルトfalse）- snake_case正式形式
  includeHtml?: boolean;    // レガシー互換（include_html推奨）
}
```

#### `layout.generate_code` - コード生成 / Code Generation

セクションパターンからReact/Vue/HTMLコードを生成します。 / Generates React/Vue/HTML code from section patterns.

**入力スキーマ**:

```typescript
{
  patternId: string;        // パターンID（UUID形式、必須）
  options?: {
    framework?: 'react' | 'vue' | 'html';
    typescript?: boolean;
    tailwind?: boolean;
    componentName?: string;
  };
}
```

#### `layout.batch_ingest` - バッチWebページ取得 / Batch Web Page Ingestion

複数URLからWebページを一括取得します。 / Batch-retrieves web pages from multiple URLs.

**入力スキーマ**:

```typescript
{
  urls: string[];           // 取得対象URL配列（1-100件）
  options?: {
    save_to_db?: boolean;   // DB保存（デフォルトtrue）
    auto_analyze?: boolean; // 自動解析（デフォルトtrue）
    concurrency?: number;   // 並列数（1-10、デフォルト5）
    on_error?: 'skip' | 'abort'; // エラー時の動作（デフォルトskip）
  };
}
```

---

### Motionツール（2ツール） / Motion Tools (2 Tools)

#### `motion.detect` - モーション検出 / Motion Detection

Webページからモーション/アニメーションパターンを検出・分類します。 / Detects and classifies motion/animation patterns from web pages.

**入力スキーマ**:

```typescript
{
  pageId?: string;          // WebページID（htmlと排他、detection_mode='css'時に使用）
  html?: string;            // HTMLコンテンツ（最大10MB、detection_mode='css'時に使用）
  css?: string;             // 追加CSSコンテンツ
  url?: string;             // 対象URL（detection_mode='video'/'runtime'/'hybrid'時に必須）
  detection_mode?: 'css' | 'runtime' | 'hybrid' | 'video' | 'library_only';
                            // 検出モード（デフォルト: 'video'）
                            // - 'video': フレームキャプチャ+Lighthouse統合（urlが必須）
                            // - 'css': CSS静的解析（html/pageIdが必須）
                            // - 'runtime': JS駆動アニメーション検出（SPA/React/Vue、urlが必須）
                            // - 'hybrid': CSS+runtime複合（urlが必須）
                            // - 'library_only': WebGL/Three.js等のライブラリ専用
  save_to_db?: boolean;     // DB保存（デフォルト: true）
  includeWarnings?: boolean;
  includeSummary?: boolean;
  fetchExternalCss?: boolean;
  baseUrl?: string;         // 外部CSS解決用
}
```

**レスポンス**:

```typescript
{
  patterns: Array<{
    type: string;
    name: string;
    selector: string;
    properties: string[];
    duration: number;
    easing: string;
    trigger: string;
  }>;
  summary: {
    totalPatterns: number;
    byType: Record<string, number>;
    avgDuration: number;
  }
  warnings: Array<{ type: string; severity: string; message: string }>;
}
```

#### `motion.search` - モーションパターン検索 / Motion Pattern Search

モーションパターンを類似検索します。 / Performs similarity search on motion patterns.

**入力スキーマ**:

```typescript
{
  query?: string;           // 検索クエリ
  samplePattern?: {
    type?: 'animation' | 'transition' | 'transform' | 'scroll' | 'hover' | 'keyframe';
    duration?: number;
    easing?: string;
  };
  filters?: {
    type?: string;
    minDuration?: number;
    maxDuration?: number;
    trigger?: 'load' | 'hover' | 'scroll' | 'click' | 'focus' | 'custom';
  };
  limit?: number;
  minSimilarity?: number;
}
```

---

### Qualityツール（3ツール） / Quality Tools (3 Tools)

#### `quality.evaluate` - Webデザイン品質評価 / Web Design Quality Evaluation

Webデザインの品質を3軸（独自性・技巧・文脈適合性）で評価します。 / Evaluates web design quality on 3 axes (originality, craftsmanship, contextuality).

**入力スキーマ**:

```typescript
{
  action?: 'evaluate' | 'suggest_improvements';
                            // アクション（デフォルト: 'evaluate'）
                            // - 'evaluate': 品質評価
                            // - 'suggest_improvements': 評価結果に基づく改善提案生成
  pageId?: string;          // WebページID（htmlと排他）
  html?: string;            // HTMLコンテンツ（最大10MB）
  weights?: {
    originality?: number;   // 独自性の重み（0-1、デフォルト0.35）
    craftsmanship?: number; // 技巧の重み（0-1、デフォルト0.4）
    contextuality?: number; // 文脈適合性の重み（0-1、デフォルト0.25）
  };                        // 合計は1.0である必要あり
  strict?: boolean;
  includeRecommendations?: boolean;
  summary?: boolean;        // 軽量レスポンス（デフォルト: true）
  save_to_db?: boolean;     // 評価結果をDB保存（デフォルト: false、pageId指定時のみ有効）
}
```

**レスポンス**:

```typescript
{
  success: boolean;
  data: {
    overall: number;          // 総合スコア（0-100）
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
    originality: {            // 独自性スコア
      score: number;          // 0-100
      grade: string;
      details?: string[];
    };
    craftsmanship: {          // 技巧スコア
      score: number;
      grade: string;
      details?: string[];
    };
    contextuality: {          // 文脈適合性スコア
      score: number;
      grade: string;
      details?: string[];
    };
    clicheDetection?: {
      detected: boolean;
      count: number;
      patterns: Array<{ type: string; severity: string; description: string; location?: string }>;
    };
    recommendations?: Array<object>;
    patternAnalysis?: object; // パターン駆動評価結果（v0.1.0）
    axeAccessibility?: object; // aXe WCAG 2.1 AA結果（v0.1.0）
    evaluatedAt: string;      // ISO 8601
  };
}
```

> **Note**: Service層（`executeQualityEvaluate`）のレスポンスでは `overallScore`, `axisScores.originality.score` 等の形式で返却されます。MCPツールの生レスポンスは上記の `data.overall`, `data.originality.score` 形式です。

> **[REMOVED v0.3.0]** `quality.batch_evaluate` and `quality.getJobStatus` have been removed. Use `quality.evaluate` in a loop instead.

---

### Styleツール（1ツール） / Style Tools (1 Tool)

#### `style.get_palette` - ブランドパレット取得 / Brand Palette Retrieval

ブランドパレットを取得します。 / Retrieves brand palettes.

**入力スキーマ**:

```typescript
{
  id?: string;              // パレットID
  brand_name?: string;      // ブランド名で部分一致検索
  mode?: 'light' | 'dark' | 'both';
  include_gradients?: boolean;
}
```

---

### Briefツール（1ツール） / Brief Tools (1 Tool)

#### `brief.validate` - デザインブリーフ検証 / Design Brief Validation

デザインブリーフを検証し、完成度スコアと改善提案を返します。 / Validates design briefs and returns completeness scores and improvement suggestions.

---

### Pageツール（2ツール） / Page Tools (2 Tools)

#### `page.analyze` - 統合Web分析 / Unified Web Analysis

URLを指定して、Layout + Motion + Qualityを一括分析します。BullMQによる非同期処理で重負荷サイト（WebGL、大量アニメーション等）に対応します。

Performs unified Layout + Motion + Quality analysis for a given URL. Uses BullMQ async processing to handle heavy sites (WebGL, many animations, etc.).

**入力スキーマ**:

```typescript
{
  url: string;              // 分析対象URL
  summary?: boolean;        // 軽量レスポンス
  timeout?: number;
  features?: {
    layout?: boolean;
    motion?: boolean;
    quality?: boolean;
  };
}
```

#### `page.getJobStatus` - 非同期ジョブステータス確認 / Async Job Status

`page.analyze`の非同期モード（`async: true`）で実行したジョブのステータスを確認します。 / Checks the status of jobs executed in `page.analyze`'s async mode (`async: true`).

**入力スキーマ**:

```typescript
{
  job_id: string; // ジョブID（UUID形式、必須）
}
```

**レスポンス**:

```typescript
{
  state: 'waiting' | 'active' | 'completed' | 'failed';
  progress: number;         // 進捗率（0-100）
  result?: object;          // 完了時の結果
  error?: string;           // 失敗時のエラー詳細
}
```

---

### Narrativeツール（1ツール） / Narrative Tools (1 Tool)

#### `narrative.search` - ナラティブ検索 / Narrative Search

世界観・レイアウト構成をセマンティック検索します。 / Performs semantic search on worldview and layout composition.

---

### Backgroundツール（1ツール） / Background Tools (1 Tool)

#### `background.search` - バックグラウンドデザイン検索 / Background Design Search

BackgroundDesignをセマンティック検索します。 / Performs semantic search on background designs.

---

### Responsiveツール（1ツール） / Responsive Tools (1 Tool)

#### `responsive.search` - レスポンシブ分析検索 / Responsive Analysis Search

レスポンシブ分析結果（ビューポート差異、ブレークポイント、スクリーンショット差分）をセマンティック検索します。pgvector HNSW cosine similarity + JSONBフィルタ。

Semantic search over responsive analysis results (viewport differences, breakpoints, screenshot diffs). Uses pgvector HNSW cosine similarity + JSONB filters.

**入力スキーマ / Input Schema**:

```typescript
{
  query: string;              // 検索クエリ（自然言語、1-500文字） / Search query (natural language, 1-500 chars)
  filters?: {
    diffCategory?: string;    // 差異カテゴリ / Diff category: layout, typography, spacing, visibility, navigation, image, interaction, animation
    viewportPair?: string;    // ビューポートペア / Viewport pair: desktop-tablet, desktop-mobile, tablet-mobile
    breakpointRange?: { min?: number; max?: number }; // ブレークポイント範囲(px) / Breakpoint range (px)
    minDiffPercentage?: number; // 最小スクリーンショット差分率(0-100) / Min screenshot diff percentage
    webPageId?: string;       // WebページIDでフィルタ / Filter by web page UUID
  };
  limit?: number;             // 取得件数（1-50、デフォルト10） / Result limit (default: 10)
  offset?: number;            // オフセット / Pagination offset
}
```

---

### Preferenceツール（3ツール） / Preference Tools (3 Tools)

#### `preference.hear` - 嗜好ヒアリング / Preference Hearing

ユーザーのデザイン嗜好をインタラクティブにヒアリングします。ステートレス設計：フィードバックなし → Mode A（サンプル提示 + 進捗トラッキング）、フィードバックあり → Mode B（フィードバック記録 + プロファイル更新）。新規プロファイル作成時は `profiling_notice` を返却（GDPR Art.13/14対応）。

Interactively learns user design preferences. Stateless design: no feedback → Mode A (present samples with progress tracking), feedback present → Mode B (record feedback and update profile). Returns `profiling_notice` on new profile creation (GDPR Art.13/14 compliance).

**入力スキーマ / Input Schema**:

```typescript
{
  profile_id?: string;        // プロファイルID（省略時は新規作成） / Profile ID (creates new if omitted)
  feedback?: {
    sample_id: string;        // フィードバック対象のサンプルID / Target sample ID
    rating: 'positive' | 'negative' | 'neutral';
    comment?: string;         // 任意のコメント / Optional comment
  };
  exclude_ids?: string[];     // 除外するサンプルID（クライアント管理） / Sample IDs to exclude (client-managed)
}
```

#### `preference.get` - プロファイル取得 / Get Profile

嗜好プロファイルの詳細を取得します。GDPRデータポータビリティ（Art. 20）に対応し、`include_signals: true` で全フィードバックシグナルを含む構造化JSONをエクスポートできます。

Retrieves preference profile details. Supports GDPR data portability (Art. 20) — use `include_signals: true` to export structured JSON including all feedback signals.

**入力スキーマ / Input Schema**:

```typescript
{
  profile_id: string;         // プロファイルID（UUID形式、必須） / Profile ID (UUID, required)
  include_signals?: boolean;  // 全シグナルデータを含める（デフォルト: false） / Include all signal data (default: false)
}
```

#### `preference.reset` - プロファイルリセット / Reset Profile

嗜好プロファイルをリセットまたは完全削除します。ソフトリセット（デフォルト）は嗜好データをクリアしプロファイル枠を維持。`hard_delete: true` で完全に物理削除（GDPR Art. 17 忘れられる権利）。

Resets or permanently deletes a preference profile. Soft reset (default) clears preference data while keeping the profile shell. `hard_delete: true` permanently deletes all data (GDPR Art. 17 Right to Erasure).

**入力スキーマ / Input Schema**:

```typescript
{
  profile_id: string;         // プロファイルID（UUID形式、必須） / Profile ID (UUID, required)
  confirm: boolean;           // 確認フラグ（必須、trueで実行） / Confirmation flag (required, true to execute)
  hard_delete?: boolean;      // 完全削除（デフォルト: false） / Permanent deletion (default: false)
}
```

> **プライバシー / Privacy**: 嗜好プロファイリングの詳細は [PRIVACY.md](./PRIVACY.md) および [DATA_RETENTION.md](./DATA_RETENTION.md) を参照してください。 / See [PRIVACY.md](./PRIVACY.md) and [DATA_RETENTION.md](./DATA_RETENTION.md) for details on preference profiling.

---

### Partツール（3ツール） / Part Tools (3 Tools)

#### `part.search` - UIパーツ検索 / UI Part Search

UIパーツをセマンティック検索します（ハイブリッド: ベクトル + 全文 RRF）。16パーツタイプ対応、searchMode（visual/text/hybrid）切替可能。 / Performs semantic search on UI parts (hybrid: vector + fulltext RRF). Supports 16 part types, switchable searchMode (visual/text/hybrid).

**入力スキーマ / Input Schema**:

```typescript
{
  query: string;              // 検索クエリ（1-500文字、必須） / Search query (1-500 chars, required)
  searchMode?: 'visual' | 'text' | 'hybrid'; // 検索モード（デフォルト: 'hybrid'） / Search mode (default: 'hybrid')
  filters?: {
    partType?: string;        // パーツタイプフィルタ / Part type filter
    webPageId?: string;       // WebページIDフィルタ / Web page ID filter
  };
  limit?: number;             // 取得件数（1-50、デフォルト10） / Result limit (default: 10)
}
```

#### `part.inspect` - パーツ詳細取得 / Part Detail Inspection

IDを指定してパーツの詳細情報（computedStyles、boundingBox、interactionInfo、cssClasses、attributes、piiRiskLevel）を取得します。 / Retrieves detailed part information by ID (computedStyles, boundingBox, interactionInfo, cssClasses, attributes, piiRiskLevel).

**入力スキーマ / Input Schema**:

```typescript
{
  id: string;                 // パーツID（UUID形式、必須） / Part ID (UUID, required)
  includeHtml?: boolean;      // HTMLを含めるか（デフォルト: false） / Include HTML (default: false)
  includeEmbedding?: boolean; // Embeddingを含めるか（デフォルト: false） / Include embedding (default: false)
}
```

#### `part.compare` - パーツ比較 / Part Comparison

2〜5個のパーツをスタイル・レイアウト・インタラクション・アクセシビリティの観点で並列比較します。 / Compares 2-5 parts side by side on styles, layout, interaction, and accessibility aspects.

**入力スキーマ / Input Schema**:

```typescript
{
  partIds: string[];          // 比較対象パーツID配列（2-5件、UUID形式） / Part IDs to compare (2-5, UUID format)
  aspects?: ('styles' | 'layout' | 'interaction' | 'accessibility')[]; // 比較観点 / Comparison aspects
}
```

---

### Systemツール（1ツール） / System Tools (1 Tool)

#### `system.health` - システムヘルスチェック / System Health Check

MCPサーバーとReftrix Web APIの接続状態を確認します。 / Checks the connection status of MCP server and Reftrix Web API.

### Searchツール（1ツール） / Search Tools (1 Tool)

#### `search.unified` - 横断検索 / Cross-Service Unified Search

5検索サービス（Layout, Part, Motion, Background, Narrative）を統合したマルチモーダル横断検索。
Cross-service unified search integrating 5 search services (Layout, Part, Motion, Background, Narrative).

### Designツール（1ツール） / Design Tools (1 Tool)

#### `design.search_by_image` - 画像類似検索 / Image Similarity Search

DINOv2 visual embeddingによる画像ベースのデザイン類似検索。Base64画像またはURLから類似デザインを検索。
Image-based design similarity search using DINOv2 visual embeddings. Search similar designs from Base64 images or URLs.

---

## Worker Architecture / ワーカーアーキテクチャ

`page.analyze` は重負荷処理のため、WorkerSupervisor + BullMQ による非同期ワーカーアーキテクチャを採用しています。

`page.analyze` uses an async worker architecture with WorkerSupervisor + BullMQ for handling heavy processing.

### Pipeline Phases / パイプラインフェーズ

```
INGEST (0→15%)
  → LAYOUT (15→35%)
  → SCROLL_VISION capture (35→45%)    ← Phase 1.5: キャプチャのみ
  → MOTION (45→65%)
  → [browser close]
  → QUALITY (65→80%)
  → NARRATIVE (80→90%)                ← Phase 2.5: SCROLL_VISION_ANALYSIS（Vision LLM分析）をここで実行
  → EMBEDDING (90→100%)
```

> **Note**: SCROLL_VISION_ANALYSIS（Ollama Vision分析）はNARRATIVEフェーズ内で実行されます。ブラウザクローズ後に実行することでVRAM競合（Chromium + Ollama）を回避しています。

### WorkerSupervisor

OOM（メモリ不足）クラッシュを防ぐために、ワーカープロセスを自動管理します。 / Automatically manages worker processes to prevent OOM (out-of-memory) crashes.

- `child_process.fork` でワーカーを子プロセスとして起動
- N件のジョブ完了後にプロセスを再起動（メモリリーク蓄積を防止）
- クラッシュ時の自動再起動（exit code/signal 両対応）
- **Pre-Return Pause + 3-Phase Shutdown Protocol**: Processor return前に `worker.pause(true)` で次ジョブ取得を防止 → IPC 'shutdown' → SIGTERM → SIGKILL

### BullMQ Queue 設定 / BullMQ Queue Configuration

| パラメータ / Parameter | 値 / Value                   | 説明 / Description                 |
| ---------------------- | ---------------------------- | ---------------------------------- |
| Queue名                | `page-analyze`               | BullMQキュー名                     |
| concurrency            | 1                            | シングルトンブラウザとの競合防止   |
| lockDuration           | 2,400,000ms（40分）          | CPU負荷の高いEmbeddingフェーズ対応 |
| stalledInterval        | `max(60000, lockDuration/4)` | stall検出間隔                      |
| maxStalledCount        | 3                            | stall許容回数                      |

### Worker Thread ONNX

ONNX推論を `node:worker_threads` で別スレッドに分離し、BullMQ heartbeatをブロックしない設計です。

- デュアルモード: Worker Thread（デフォルト）/ In-Process Fallback（`EMBEDDING_WORKER_THREAD=false`）
- Crashリカバリ最大5回、タイムアウト120秒

### GPU Resource Manager

Ollama Vision（SCROLL_VISION_ANALYSISフェーズ）とONNX Embedding（EMBEDDINGフェーズ）間でGPUを動的に切り替えます。

- `acquireForVision()`: VRAM >= 8192MB を確認してからOllamaに割り当て
- `acquireForEmbedding()`: Ollamaをアンロードして ONNX CUDA を有効化
- GPU非搭載環境: graceful degradation（CPUモード）

### Tool Name Constants (SSoT)

`src/tools/tool-names.ts` — `allToolDefinitions` から `TOOL_NAMES` / `ALL_TOOL_NAMES` を自動導出。ツール追加/削除時の手動更新不要。`tools/index.ts` からの `_registerToolDefinitions()` による明示的登録 + CJS `require()` フォールバックの2段階初期化で、ESM（Vitest）/CJS（コンパイル済み）両環境に対応。

`src/tools/tool-names.ts` — Auto-derives `TOOL_NAMES` / `ALL_TOOL_NAMES` from `allToolDefinitions`. No manual updates needed when adding/removing tools. Uses two-stage initialization: explicit registration via `_registerToolDefinitions()` from `tools/index.ts` + CJS `require()` fallback, supporting both ESM (Vitest) and CJS (compiled) environments.

### User-Agent

Playwright Browser Contextで使用するUser-Agent文字列は `Reftrix/X.Y.Z` サフィックスを含みます。バージョンはpackage.jsonと同期してください。

The User-Agent string used in Playwright Browser Context includes a `Reftrix/X.Y.Z` suffix. Keep the version in sync with package.json.

### Embedding Backfill

パイプライン完了後にDB駆動で欠損Embeddingを自動修復します。

```bash
# Embedding欠損チェック
pnpm check:embeddings

# Embeddingバックフィル（手動実行）
pnpm backfill:embeddings
```

### 起動時孤立ジョブ回復 / Startup Orphan Job Recovery

ワーカー起動時に前回クラッシュで孤立したジョブを自動回復します。 / Automatically recovers orphaned jobs from previous crashes at worker startup.

| progress | カテゴリ / Category    | アクション / Action              |
| -------- | ---------------------- | -------------------------------- |
| = 0%     | never_started          | failed → retry（waiting に戻す） |
| 0〜90%   | processing_interrupted | failed に遷移                    |
| >= 90%   | db_saved_but_stuck     | completed に遷移                 |

---

## エラーハンドリング / Error Handling

### エラーコード一覧 / Error Code List

| コード / Code         | 説明 / Description           |
| --------------------- | ---------------------------- |
| `INTERNAL_ERROR`      | サーバー内部エラー           |
| `VALIDATION_ERROR`    | 入力バリデーションエラー     |
| `TOOL_NOT_FOUND`      | 指定されたツールが存在しない |
| `PAGE_NOT_FOUND`      | 指定されたページが存在しない |
| `TRANSFORM_FAILED`    | 変換処理失敗                 |
| `INVALID_QUERY`       | 無効な検索クエリ             |
| `NO_RESULTS`          | 検索結果なし                 |
| `RATE_LIMIT_EXCEEDED` | レート制限超過               |

---

## セキュリティガイドライン / Security Guidelines

### HTMLサニタイズ / HTML Sanitization

- DOMPurify 3.3.xによるXSS対策
- スクリプト要素の除去（whileループによるネスト完全除去）
- 外部リソース参照の制限

### SSRF対策 / SSRF Protection

- プライベートIP（localhost, 127.0.0.1, 192.168.x.x）へのアクセスをブロック
- クラウドメタデータサービス（169.254.x.x）へのアクセスをブロック
- Ollama URLはlocalhostのみに制限

### レート制限 / Rate Limiting

Token Bucket + Redis Lua（CWE-770 DoS対策）。全<!-- gen:tool-count -->35<!-- /gen:tool-count -->ツールに自動適用。
Token Bucket + Redis Lua (CWE-770 DoS prevention). Auto-applied to all <!-- gen:tool-count -->35<!-- /gen:tool-count --> tools.

| ティア / Tier | RPM | 対象ツール / Target Tools                                                                                                                                                                     |
| ------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| analysis      | 10  | page.analyze, layout.ingest, layout.batch_ingest, accessibility.audit, performance.evaluate, design.track_changes                                                                             |
| search        | 120 | layout.search, motion.search, narrative.search, background.search, responsive.search, part.search, search.unified, design.search_by_image, design.similar_site, design.compare, search.facets |
| default       | 60  | その他すべて / All others                                                                                                                                                                     |

Graceful Degradation: Redis未接続時はインメモリフォールバック / Falls back to in-memory when Redis unavailable

### エラーメッセージサニタイズ / Error Message Sanitization (CWE-209)

`sanitizeErrorMessage()` ユーティリティ（`utils/sanitize-error.ts`）で内部構造の漏洩を防止。<!-- gen:sanitize-usage-count -->63<!-- /gen:sanitize-usage-count -->ファイル・<!-- gen:tool-count -->35<!-- /gen:tool-count -->ツールに適用（<!-- gen:sanitize-import-count -->57<!-- /gen:sanitize-import-count -->ファイルでインポート）。
`sanitizeErrorMessage()` utility (`utils/sanitize-error.ts`) prevents internal structure leakage. Applied to <!-- gen:sanitize-usage-count -->63<!-- /gen:sanitize-usage-count --> files and <!-- gen:tool-count -->35<!-- /gen:tool-count --> tools (<!-- gen:sanitize-import-count -->57<!-- /gen:sanitize-import-count --> import files).

---

## パフォーマンスガイドライン / Performance Guidelines

### パフォーマンス目標 / Performance Targets

| 指標 / Metric                      | 目標値 / Target       |
| ---------------------------------- | --------------------- |
| ツールレスポンス（P95）            | < 5秒                 |
| サーバー起動時間                   | < 2秒                 |
| 検索レスポンス（キャッシュヒット） | < 100ms               |
| ベクトル検索速度                   | < 500ms for 10K items |

---

## Service層直接呼び出し / Direct Service Layer Invocation

MCPツールの機能はMCP経由だけでなく、TypeScriptから直接インポートして使用できます。

MCP tool functionality can be directly imported and used from TypeScript, not just via MCP protocol.

### インポート方法 / Import Method

```typescript
import {
  // Page Analyze
  executePageAnalyze,
  type PageAnalyzeInput,
  type PageAnalyzeOutput,

  // Layout Search
  executeLayoutSearch,
  type LayoutSearchInput,
  type LayoutSearchOutput,

  // Motion Search
  executeMotionSearch,
  type MotionSearchInput,
  type MotionSearchOutput,

  // Motion Detect
  executeMotionDetect,
  type MotionDetectInput,
  type MotionDetectOutput,

  // Quality Evaluate
  executeQualityEvaluate,
  type QualityEvaluateInput,
  type QualityEvaluateOutput,

  // Palette
  executeGetPalette,
  type GetPaletteInput,

  // Layout Generate Code
  executeLayoutGenerateCode,
  type LayoutToCodeInput,
  type LayoutToCodeOutput,
} from "@reftrixmcp/mcp-server";
```

### 使用例 / Usage Examples

#### Page Analyze

```typescript
const result = await executePageAnalyze({
  url: "https://example.com",
  summary: true,
  timeout: 60000,
  features: {
    layout: true,
    motion: true,
    quality: true,
  },
});

if (result.ok) {
  console.log("Analysis result:", result.data);
} else {
  console.error("Analysis failed:", result.error);
}
```

#### Layout Search

```typescript
const result = await executeLayoutSearch({
  query: "modern hero section with gradient",
  filters: {
    sectionType: "hero",
    sourceType: "award_gallery",
  },
  limit: 10,
  offset: 0,
});

if (result.success) {
  console.log("Search results:", result.data.results);
  console.log("Total:", result.data.total);
} else {
  console.error("Search failed:", result.error);
}
```

#### Motion Search

```typescript
const result = await executeMotionSearch({
  query: "smooth fade in animation",
  filters: {
    type: "animation",
    trigger: "scroll",
    minDuration: 200,
    maxDuration: 1000,
  },
  limit: 20,
  minSimilarity: 0.7,
});

if (result.success) {
  console.log("Motion patterns:", result.data.results);
} else {
  console.error("Search failed:", result.error);
}
```

#### Quality Evaluate

```typescript
const result = await executeQualityEvaluate({
  html: "<div>...</div>",
  options: {
    strict: true,
    targetIndustry: "technology",
    includeRecommendations: true,
    weights: {
      originality: 0.4,
      craftsmanship: 0.35,
      contextuality: 0.25,
    },
  },
});

if (result.success) {
  console.log("Overall score:", result.data.overallScore);
  console.log("Grade:", result.data.grade);
  console.log("Axis scores:", result.data.axisScores);
  console.log("Cliche count:", result.data.clicheCount);
} else {
  console.error("Evaluation failed:", result.error);
}
```

#### Layout Generate Code

```typescript
const result = await executeLayoutGenerateCode({
  patternId: "11111111-1111-1111-1111-111111111111",
  options: {
    framework: "react",
    typescript: true,
    tailwind: true,
    componentName: "HeroSection",
  },
});

if (result.success) {
  console.log("Generated code:", result.data.code);
  console.log("Framework:", result.data.framework);
  console.log("Component name:", result.data.componentName);
} else {
  console.error("Generation failed:", result.error);
}
```

---

## 開発 / Development

### テスト実行 / Running Tests

```bash
# ユニットテスト
pnpm test

# ウォッチモード
pnpm test:watch
```

### ワーカー単体起動 / Starting Workers Individually

```bash
# 全ワーカー起動
pnpm worker:start

# PageAnalyzeWorkerのみ起動
pnpm worker:start:page

# BatchQualityWorkerのみ起動
pnpm worker:start:quality
```

### ディレクトリ構造 / Directory Structure

```
apps/mcp-server/
├── src/
│   ├── index.ts              # エントリポイント
│   ├── server.ts             # MCPサーバー実装
│   ├── router.ts             # ツールルーティング
│   ├── transport.ts          # StdIOトランスポート
│   ├── api/                  # API（ヘルスチェック等）
│   │   └── health.ts
│   ├── config/               # 設定
│   │   ├── index.ts
│   │   └── redis.ts
│   ├── lib/                  # ライブラリ
│   │   ├── index.ts
│   │   └── project-context.ts
│   ├── middleware/            # ミドルウェア
│   │   ├── auth.ts                    # API認証（MCP_API_KEYS）
│   │   ├── args-type-coercion.ts      # 引数型変換
│   │   ├── light-response-controller.ts # レスポンスサイズ制御
│   │   └── response-size-warning.ts   # レスポンスサイズ警告
│   ├── schemas/              # 共有スキーマ
│   │   ├── creative/
│   │   │   ├── index.ts
│   │   │   └── palette.schema.ts
│   │   └── mood-brandtone-filters.ts
│   ├── types/                # 型定義
│   │   └── creative/
│   ├── tools/                # MCPツール実装
│   │   ├── layout/           # レイアウトツール
│   │   ├── motion/           # モーションツール
│   │   ├── quality/          # 品質評価ツール
│   │   ├── brief/            # ブリーフツール
│   │   ├── narrative/        # ナラティブツール
│   │   ├── background/       # バックグラウンドツール
│   │   ├── responsive/       # レスポンシブツール
│   │   ├── preference/       # 嗜好プロファイリングツール
│   │   ├── page/             # page.analyze ツール
│   │   └── schemas/          # 共有Zodスキーマ
│   ├── workers/              # BullMQワーカー
│   │   └── page-analyze-worker.ts   # page.analyze 非同期ワーカー
│   ├── queues/               # BullMQキュー定義
│   ├── scripts/              # スタンドアロン起動スクリプト
│   │   ├── start-workers.ts          # ワーカー起動エントリポイント
│   │   ├── backfill-embeddings.ts    # Embeddingバックフィル
│   │   └── check-embedding-coverage.ts # Embedding欠損チェック
│   ├── services/             # サービス層
│   │   ├── background/       # 背景デザイン検出
│   │   ├── brief/            # ブリーフ検証
│   │   ├── layout/           # レイアウト分析・セクション検出
│   │   ├── ml/               # Embedding生成（ONNX Runtime）
│   │   ├── motion/           # モーション・アニメーション検出
│   │   ├── narrative/        # ナラティブ分析
│   │   ├── page/             # ページ分析パイプライン
│   │   ├── quality/          # デザイン品質評価
│   │   ├── repositories/     # データアクセス層
│   │   ├── responsive/       # レスポンシブ検出
│   │   ├── search/           # 検索サービス（Hybrid/Vector/Full-text）
│   │   ├── storage/          # スクリーンショット保存
│   │   ├── style/            # スタイル・パレット抽出
│   │   ├── vision/           # Vision推論（Ollama連携）
│   │   ├── vision-adapter/   # Visionアダプタ（Mock/Ollama切替）
│   │   ├── visual/           # ビジュアル要素抽出
│   │   └── visual-extractor/ # ビジュアル詳細抽出
│   └── utils/
│       ├── errors.ts
│       └── logger.ts
├── tests/                    # テストファイル
├── package.json
└── tsconfig.json
```

---

## 環境変数 / Environment Variables

### 基本設定 / Basic Settings

| 変数名 / Variable  | 説明 / Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | デフォルト値 / Default | 必須 / Required |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------- |
| `NODE_ENV`         | 環境（development/test/production）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | -                      | Yes             |
| `DATABASE_URL`     | PostgreSQL接続URL（ポート: 26432）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | -                      | Yes             |
| `MCP_AUTH_ENABLED` | API認証有効化（本番ではtrueを強く推奨）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `false`                | No              |
| `MCP_API_KEYS`     | APIキー（`MCP_AUTH_ENABLED=true`時に必須、JSON配列形式）。例: `'[{"key":"reftrix_...","role":"ADMIN","userId":"user-1"}]'`。各キーに `role`（ADMIN/USER/VIEWER）、`userId`、オプションで `expiresAt`（ISO 8601）を指定。レガシー互換: `MCP_API_KEY`（単一キー文字列、環境変数フォールバック）も使用可 / API keys (required when `MCP_AUTH_ENABLED=true`, JSON array format). Example: `'[{"key":"reftrix_...","role":"ADMIN","userId":"user-1"}]'`. Each key specifies `role` (ADMIN/USER/VIEWER), `userId`, and optional `expiresAt` (ISO 8601). Legacy compat: `MCP_API_KEY` (single key string, env var fallback) also supported | -                      | Conditional     |
| `REDIS_URL`        | Redis接続URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | -                      | Conditional     |
| `REDIS_HOST`       | Redisホスト                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `localhost`            | No              |
| `REDIS_PORT`       | Redisポート（ポートオフセット: 21000）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `27379`                | No              |

### WorkerSupervisor設定 / WorkerSupervisor Settings

| 変数名 / Variable                | 説明 / Description                                 | デフォルト値 / Default |
| -------------------------------- | -------------------------------------------------- | ---------------------- |
| `WORKER_MAX_JOBS_BEFORE_RESTART` | N件完了後にワーカーを再起動（OOM防止）             | `1`                    |
| `WORKER_RESTART_DELAY_MS`        | 再起動間の最小間隔（ms）                           | `3000`                 |
| `WORKER_MAX_RESTART_ATTEMPTS`    | クラッシュ時の最大再起動試行回数                   | `10`                   |
| `WORKER_SHUTDOWN_TIMEOUT_MS`     | graceful shutdownタイムアウト（ms）                | `10000`                |
| `WORKER_SCRIPT_PATH`             | ワーカースクリプトの絶対パス（未設定時は自動解決） | -                      |

### BullMQ / ワーカー設定 / BullMQ / Worker Settings

| 変数名 / Variable                | 説明 / Description               | デフォルト値 / Default |
| -------------------------------- | -------------------------------- | ---------------------- |
| `BULLMQ_LOCK_DURATION`           | ジョブロック時間（ms、最小60秒） | `2400000`（40分）      |
| `BULLMQ_LOCK_EXTEND_INTERVAL_MS` | ロック延長間隔（ms、最小10秒）   | `300000`（5分）        |
| `PAGE_WORKER_CONCURRENCY`        | PageAnalyzeWorkerの並列数        | `1`                    |
| `WORKER_CONCURRENCY`             | BatchQualityWorkerの並列数       | `3`                    |

### ML / GPU設定 / ML / GPU Settings

| 変数名 / Variable         | 説明 / Description                              | デフォルト値 / Default |
| ------------------------- | ----------------------------------------------- | ---------------------- |
| `ONNX_EXECUTION_PROVIDER` | ONNX実行プロバイダ（`cuda`/`rocm`/未設定でCPU） | -                      |
| `EMBEDDING_WORKER_THREAD` | Worker Thread ONNX推論を有効化                  | `true`                 |
| `LD_LIBRARY_PATH`         | CUDA 12ライブラリパス（自動検出される）         | -                      |

### メモリ管理設定 / Memory Management Settings

| 変数名 / Variable              | 説明 / Description                                        | デフォルト値 / Default |
| ------------------------------ | --------------------------------------------------------- | ---------------------- |
| `WORKER_MEMORY_CRITICAL_MB`    | クリティカルRSS閾値（MB）、超過でDB保存フェーズにスキップ | `14336`（14GB）        |
| `WORKER_MEMORY_DEGRADATION_MB` | デグレードRSS閾値（MB）、超過でnarrative/vision無効化     | `12288`（12GB）        |
| `WORKER_HTML_LARGE_BYTES`      | Vision LLM無効化HTMLサイズ閾値（バイト）                  | `5000000`（5MB）       |
| `WORKER_HTML_HUGE_BYTES`       | narrative+vision無効化HTMLサイズ閾値（バイト）            | `10000000`（10MB）     |

### セキュリティに関する重要な注意事項 / Important Security Notes

**本番環境では以下の設定を強く推奨します**:

```bash
# 本番環境推奨設定 / Production recommended settings
NODE_ENV=production
MCP_AUTH_ENABLED=true

# MCP_API_KEYS: JSON配列形式（各キーは64文字以上を推奨）
# MCP_API_KEYS: JSON array format (each key should be 64+ characters)
MCP_API_KEYS='[{"key":"reftrix_your_64char_random_string_here...","role":"ADMIN","userId":"admin-1"},{"key":"reftrix_another_key...","role":"VIEWER","userId":"viewer-1","expiresAt":"2027-01-01T00:00:00Z"}]'

# レガシー互換: MCP_API_KEY（単一キー文字列）も使用可（リクエスト _meta にキーがない場合のフォールバック）
# Legacy compat: MCP_API_KEY (single key string) also supported (fallback when no key in request _meta)
# MCP_API_KEY=reftrix_single_key_fallback_string
```

`MCP_AUTH_ENABLED=false`かつ`NODE_ENV=production`の場合、サーバー起動時に警告ログが出力されます。

When `MCP_AUTH_ENABLED=false` and `NODE_ENV=production`, a warning log is output at server startup.

### page.analyze非同期モード / page.analyze Async Mode

`page.analyze`ツールでBullMQによるジョブキューを使用するためRedisが必要です:

```bash
REDIS_URL=redis://localhost:27379
# または
REDIS_HOST=localhost
REDIS_PORT=27379
```

Redisが未設定の場合、非同期モードは使用できません（同期モードのみ動作）。

---

## ライセンス / License

AGPL-3.0-only -- 詳細は [LICENSE](../../LICENSE) を参照 / See [LICENSE](../../LICENSE) for details

---

## 関連リンク / Related Links

- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- [MCP SDK](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
