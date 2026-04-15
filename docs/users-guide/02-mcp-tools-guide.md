# Reftrix MCPツール完全ガイド / Reftrix MCP Tools Complete Guide

**Last Updated**: 2026-03-25
**Version**: 0.3.0
**対象読者 / Target Audience**: Reftrixプラットフォームのエンドユーザー、デザイナー、開発者 / End users, designers, and developers of the Reftrix platform

---

## はじめに / Introduction

Reftrixは **WebDesign専用プラットフォーム** です。このガイドでは、**<!-- gen:tool-count -->39<!-- /gen:tool-count -->のWebDesign専用MCPツール**を活用して、Webページの解析・品質評価・コード生成・嗜好プロファイリング・横断検索・画像類似検索・アクセシビリティ監査・パフォーマンス評価・デザイン変更追跡を行う方法を解説します。

Reftrix is a **WebDesign-specialized platform**. This guide explains how to use **<!-- gen:tool-count -->39<!-- /gen:tool-count --> WebDesign-focused MCP tools** to analyze web pages, evaluate design quality, generate code, personalize search results through preference profiling, perform unified cross-service search, find visually similar designs, audit accessibility, evaluate performance, and track design changes.

> **重要 / Important**: v0.1.0でSVG機能は削除されました。本ガイドはWebDesign専用ツールのみを扱います。
> All SVG features were removed in v0.1.0. This guide covers WebDesign-only tools.

### このガイドで学べること / What You Will Learn

- Webページレイアウトの解析と検索（セマンティックサーチ）/ Web page layout analysis and search (semantic search)
- CSSアニメーション・モーションパターンの検出とフレーム画像分析 / CSS animation and motion pattern detection with frame image analysis
- デザイン品質の3軸評価（Originality, Craftsmanship, Contextuality）/ Design quality evaluation on 3 axes (Originality, Craftsmanship, Contextuality)
- ブランドカラーパレットの取得と適用 / Brand color palette retrieval and application
- プロジェクト管理とデザインブリーフの検証 / Project management and design brief verification

---

## 目次

1. [クイックスタート](#1-クイックスタート)
2. [ツールカテゴリ概要](#2-ツールカテゴリ概要)
3. [Layout（レイアウト）ツール](#3-layoutレイアウトツール)
4. [Motion（モーション）ツール](#4-motionモーションツール)
5. [Quality（品質）ツール](#5-quality品質ツール)
6. [Style（スタイル）ツール](#6-styleスタイルツール)
7. [Brief（ブリーフ）ツール](#7-briefブリーフツール)
8. [Page（ページ）ツール](#8-pageページツール)
9. [System（システム）ツール](#9-systemシステムツール)
10. [Narrative（ナラティブ）ツール](#10-narrativeナラティブツール)
11. [Background（背景）ツール](#11-background背景ツール)
12. [Responsive（レスポンシブ）ツール](#12-responsiveレスポンシブツール)
13. [Preference（嗜好プロファイリング）ツール](#13-preference嗜好プロファイリングツール)
14. [Part（パーツ）ツール](#14-partパーツツール)
15. [Search（横断検索）ツール](#15-search横断検索ツール)
16. [Design（デザイン）ツール](#16-designデザインツール)
17. [Accessibility（アクセシビリティ）ツール](#17-accessibilityアクセシビリティツール)
18. [Performance（パフォーマンス）ツール](#18-performanceパフォーマンスツール)
19. [Embedding（品質モニタリング）ツール](#19-embedding品質モニタリングツール)
20. [Data（データ管理）ツール](#20-dataデータ管理ツール)
21. [Audit（監査）ツール](#21-audit監査ツール)
22. [実践ワークフロー](#22-実践ワークフロー)
23. [パフォーマンス最適化](#23-パフォーマンス最適化)
24. [トラブルシューティング](#24-トラブルシューティング)

---

## 1. クイックスタート / Quick Start

### 最初の一歩: Webページを解析する / First Step: Analyze a Web Page

```typescript
// URLを指定するだけで、レイアウト・モーション・品質を一括解析
const result = await page.analyze({
  url: "https://example.com",
  summary: true, // 軽量レスポンス（推奨）
  features: {
    layout: true,
    motion: true,
    quality: true,
  },
});

// 結果には以下が含まれます:
// - セクション構造（hero, feature, cta等）
// - CSSアニメーション・トランジション
// - デザイン品質スコア（0-100）
```

### 推奨される最初のステップ / Recommended First Steps

1. **システムヘルスチェック / System Health Check**（セッション開始時に必ず実行 / Always run at session start）

   ```typescript
   await system.health({ detailed: true });
   ```

2. **ページ解析 / Page Analysis**（興味のあるサイトを解析 / Analyze sites of interest）

   ```typescript
   await page.analyze({
     url: "https://awwwards.com/sites/example",
     summary: true,
   });
   ```

3. **品質評価 / Quality Evaluation**（自分のデザインを評価 / Evaluate your own design）
   ```typescript
   await quality.evaluate({
     html: myHtml,
     action: "evaluate",
   });
   ```

---

## 2. ツールカテゴリ概要 / Tool Category Overview

### WebDesign MCPツール（<!-- gen:tool-count -->39<!-- /gen:tool-count -->ツール） / WebDesign MCP Tools (<!-- gen:tool-count -->39<!-- /gen:tool-count --> Tools)

| カテゴリ / Category | ツール数 / Count | 主な用途 / Primary Purpose                                                                                                                   |
| ------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **System**          | 1                | ヘルスチェック / Health check                                                                                                                |
| **Style**           | 1                | ブランドパレット取得 / Brand palette retrieval                                                                                               |
| **Brief**           | 1                | デザインブリーフ検証 / Design brief verification                                                                                             |
| **Layout**          | 5                | Webページ構造の収集・解析・検索・コード生成・バッチ処理 / Web page structure collection, analysis, search, code generation, batch processing |
| **Motion**          | 2                | CSSアニメーション検出・セマンティック検索 / CSS animation detection and semantic search                                                      |
| **Quality**         | 1                | デザイン品質評価・改善提案 / Design quality evaluation and improvement suggestions                                                           |
| **Page**            | 2                | 統合ページ解析・非同期ジョブステータス / Unified page analysis and async job status                                                          |
| **Narrative**       | 1                | 世界観・レイアウト構成セマンティック検索 / Worldview and layout semantic search                                                              |
| **Background**      | 1                | バックグラウンドデザインパターン検索 / Background design pattern search                                                                      |
| **Responsive**      | 2                | レスポンシブ分析検索・マルチデバイスキャプチャ / Responsive analysis search and multi-device capture                                         |
| **Preference**      | 3                | 嗜好プロファイリング・検索パーソナライズ / Preference profiling and search personalization                                                   |
| **Part**            | 3                | UIパーツ検索・詳細取得・比較 / UI part search, inspection, and comparison                                                                    |
| **Search**          | 2                | 横断検索・ファセット検索 / Cross-service unified search and facet search                                                                     |
| **Design**          | 4                | 画像類似検索・類似サイト・デザイン比較・変更追跡 / Image similarity, similar sites, design comparison, and change tracking                   |
| **Accessibility**   | 1                | WCAG 2.1 AAアクセシビリティ監査 / WCAG 2.1 AA accessibility audit                                                                            |
| **Performance**     | 1                | Core Web Vitalsパフォーマンス評価 / Core Web Vitals performance evaluation                                                                   |
| **Embedding**       | 1                | Embedding品質モニタリング / Embedding quality monitoring                                                                                     |
| **Data**            | 2                | GDPR準拠データ削除・エクスポート / GDPR-compliant data deletion and export                                                                   |
| **Audit**           | 1                | 監査ログ検索 / Audit log query                                                                                                               |

### ツール選択のフローチャート / Tool Selection Flowchart

```
目的は何ですか？

├─ Webページを理解したい
│  └─ page.analyze（統合解析）
│     │
│     ├─ レイアウト構造を詳しく → layout.inspect
│     ├─ アニメーションを調べる → motion.detect
│     └─ 品質を評価する → quality.evaluate
│
├─ 過去の類似デザインを探したい
│  ├─ レイアウトパターン → layout.search
│  ├─ モーションパターン → motion.search
│  ├─ 世界観・構成 → narrative.search
│  ├─ 背景パターン → background.search
│  └─ レスポンシブ差異 → responsive.search
│
├─ コードを生成したい
│  └─ layout.generate_code（React/Vue/HTML/Svelte/Astro）
│
├─ デザインを改善したい
│  └─ 品質評価 → quality.evaluate
│
├─ 検索結果を自分好みにしたい
│  ├─ 嗜好ヒアリング → preference.hear
│  ├─ プロファイル確認 → preference.get
│  └─ リセット/削除 → preference.reset
│
├─ デザインを比較・追跡したい
│  ├─ 類似サイト検索 → design.similar_site
│  ├─ デザイン比較 → design.compare
│  └─ 変更追跡 → design.track_changes
│
├─ 品質監査を行いたい
│  ├─ アクセシビリティ → accessibility.audit
│  ├─ パフォーマンス → performance.evaluate
│  └─ Embedding品質 → embedding.quality
│
├─ データ管理
│  ├─ データ削除（GDPR） → data.delete
│  ├─ データエクスポート → data.export
│  └─ 監査ログ → audit.query
│
└─ その他
   ├─ ブランドパレット → style.get_palette
   ├─ ブリーフ検証 → brief.validate
   └─ レスポンシブキャプチャ → responsive.capture
```

---

## 3. Layout（レイアウト）ツール / Layout Tools

レイアウトツールは、Webページの構造を収集・解析・検索し、React/Vue/HTMLコードを生成します。

Layout tools collect, analyze, and search web page structures, and generate React/Vue/HTML code.

### 3.1 layout.ingest - Webページの収集 / Web Page Collection

**用途 / Purpose**: URLからHTML・スクリーンショットを取得し、データベースに保存（オプション）/ Retrieve HTML and screenshots from a URL and save to database (optional)

**基本的な使い方 / Basic Usage**

```typescript
// 最小構成: URLを指定するだけ（デフォルトでDB保存＋自動解析）
const result = await layout.ingest({
  url: "https://example.com",
});

// レスポンス（{ success: true, data: { ... } } 形式）:
// - id: WebPageテーブルのID（save_to_db: trueがデフォルト）
// - metadata: { title: ページタイトル, ... }
// - html: HTML全文（include_html: true指定時のみ）
// - screenshot: Base64スクリーンショット（include_screenshot: true指定時のみ）
```

**セマンティック検索に対応させる**

```typescript
// デフォルトでsave_to_db: true, auto_analyze: trueのため、
// URLを指定するだけで自動的に検索可能になります
const result = await layout.ingest({
  url: "https://example.com",
  // save_to_db: true（デフォルト）→ WebPageテーブルへ保存
  // auto_analyze: true（デフォルト）→ セクション解析＋Embedding生成
});

// この後、layout.searchで検索可能になります
```

**主要パラメータ**

| パラメータ                   | 型      | デフォルト | 説明                                          |
| ---------------------------- | ------- | ---------- | --------------------------------------------- |
| `url`                        | string  | （必須）   | 収集対象URL                                   |
| `options.save_to_db`         | boolean | true       | DB保存（検索には必須）                        |
| `options.auto_analyze`       | boolean | true       | セクション解析＋Embedding生成（検索には必須） |
| `options.full_page`          | boolean | true       | フルページスクリーンショット                  |
| `options.include_html`       | boolean | false      | HTMLを含める                                  |
| `options.include_screenshot` | boolean | false      | スクリーンショットを含める                    |
| `options.timeout`            | number  | 30000      | タイムアウト（ms）                            |

**ベストプラクティス**

- アワードサイトのデザインを収集する際は明示的にメタデータを記録
- `include_html` と `include_screenshot` はデフォルトで `false`（必要時のみ `true` に設定）
- `id` を保存して、後続の `layout.inspect` で再利用

---

### 3.2 layout.inspect - HTML構造の解析 / HTML Structure Analysis

**用途 / Purpose**: HTMLを解析し、セクション構造・グリッド・タイポグラフィ・色を抽出 / Analyze HTML to extract section structure, grid, typography, and colors

**基本的な使い方 / Basic Usage**

```typescript
const result = await layout.inspect({
  html: myHtml,
  options: {
    detectSections: true, // セクション検出
    detectGrid: true, // グリッド検出
    analyzeTypography: true, // タイポグラフィ解析
    extractColors: true, // 色抽出
  },
});

// レスポンス:
// - sections: [{ type: 'hero', heading: '...', description: '...' }]
// - grid: { columns: 12, gap: '1rem' }
// - typography: { headings: [...], bodyText: [...] }
// - colors: { primary: '#...', accent: '#...' }
```

**WebPage IDから解析**

```typescript
// layout.ingestで保存したページを解析
const result = await layout.inspect({
  id: "webPageId", // layout.ingestのidを指定
  options: {
    detectSections: true,
  },
});
```

**ユースケース**

- デザインシステムのグリッド仕様を抽出
- タイポグラフィスケールを分析
- カラーパレットの自動生成

---

### 3.3 layout.search - セマンティック検索 / Semantic Search

**用途 / Purpose**: 自然言語クエリでセクションパターンを検索（768次元ベクトル検索）/ Search section patterns using natural language queries (768-dimension vector search)

**基本的な使い方 / Basic Usage**

```typescript
const results = await layout.search({
  query: "modern hero section with video background",
  limit: 10,
  include_html: false, // HTMLスニペットを含めない（推奨）
});

// レスポンス:
// - results: [{
//     id: '...',
//     type: 'hero',
//     similarity: 0.89,
//     preview: { heading: '...', thumbnail: '...' }
//   }]
```

**フィルター機能**

```typescript
const results = await layout.search({
  query: "pricing section",
  filters: {
    sectionType: "pricing", // セクションタイプ
    sourceType: "award_gallery", // アワードサイトのみ
    usageScope: "inspiration_only", // インスピレーション用途
  },
  limit: 20,
  offset: 0,
  include_html: true, // HTMLスニペットを含める（必要時のみ）
});
```

**サポートされるセクションタイプ**

- `hero` - ヒーローセクション
- `feature` - 機能紹介
- `cta` - Call-to-Action
- `testimonial` - お客様の声
- `pricing` - 料金表
- `footer` - フッター
- `navigation` - ナビゲーション
- `about` - 会社概要
- `contact` - お問い合わせ
- `gallery` - ギャラリー
- `partners` - パートナー・クライアントロゴ
- `portfolio` - ポートフォリオ・実績
- `team` - チーム紹介
- `stories` - ストーリー・ブログ
- `research` - リサーチ・ケーススタディ
- `subscribe` - ニュースレター・購読
- `stats` - 統計・数値データ
- `faq` - よくある質問

**ベストプラクティス**

- 検索前に必ず `layout.ingest({ save_to_db: true, auto_analyze: true })` を実行
- 日本語・英語のクエリに対応（multilingual-e5-baseモデル使用）
- `include_html: false` で検索速度を向上（デフォルト）
- `limit` は 10〜20 を推奨

---

### 3.4 layout.generate_code - コード生成 / Code Generation

**用途 / Purpose**: セクションパターンからReact/Vue/HTMLコードを生成 / Generate React/Vue/HTML code from section patterns

**基本的な使い方**

```typescript
const code = await layout.generate_code({
  patternId: "section-pattern-id", // layout.searchで取得したID
  options: {
    framework: "react", // react | vue | html
    typescript: true, // TypeScript出力
    tailwind: true, // Tailwind CSS使用
  },
});

// レスポンス:
// - code: "export const HeroSection: React.FC = () => { ... }"
// - framework: 'react'
// - language: 'typescript'
```

**ブランドパレットを適用**

```typescript
const code = await layout.generate_code({
  patternId: "section-pattern-id",
  options: {
    framework: "react",
    typescript: true,
    tailwind: true,
    paletteId: "brand-palette-id", // style.get_paletteで取得
  },
});

// 生成されたコードにブランドカラーが反映されます
```

**カスタムコンポーネント名**

```typescript
const code = await layout.generate_code({
  patternId: "section-pattern-id",
  options: {
    framework: "react",
    componentName: "LandingHero", // PascalCase形式
  },
});
```

---

### 3.5 layout.batch_ingest - バッチWebページ取得 / Batch Web Page Collection

**用途 / Purpose**: 複数URLからWebページを一括取得（最大100件）/ Batch collect web pages from multiple URLs (up to 100)

**基本的な使い方**

```typescript
const result = await layout.batch_ingest({
  urls: [
    "https://awwwards.com/sites/site1",
    "https://awwwards.com/sites/site2",
    "https://awwwards.com/sites/site3",
  ],
  options: {
    save_to_db: true, // デフォルト: true
    auto_analyze: true, // デフォルト: true
    concurrency: 5, // 並列数（デフォルト: 5）
  },
});

// レスポンス:
// - succeeded: [{ url: '...', page_id: '...' }, ...]
// - failed: [{ url: '...', error: '...' }]
// - stats: { total: 3, succeeded: 3, failed: 0, duration_ms: 15000 }
```

**エラーハンドリング**

```typescript
const result = await layout.batch_ingest({
  urls: urls,
  options: {
    on_error: "skip", // skip（デフォルト）| abort
  },
});

// 'skip': 失敗したURLをスキップして続行
// 'abort': 最初のエラーで中断
```

**ベストプラクティス**

- 大量収集時は `concurrency: 5`（デフォルト）以下を推奨（サーバー負荷軽減）
- `on_error: 'skip'` で部分的な失敗を許容
- 結果の `failed` 配列で失敗したURLを確認

---

## 4. Motion（モーション）ツール / Motion Tools

モーションツールは、CSSアニメーション・トランジション・キーフレームを検出・分類し、セマンティック検索を提供します。

Motion tools detect and classify CSS animations, transitions, and keyframes, and provide semantic search.

### 4.1 motion.detect - CSSアニメーション検出 / CSS Animation Detection

**用途 / Purpose**: HTMLからCSSアニメーション・トランジション・キーフレームを検出 / Detect CSS animations, transitions, and keyframes from HTML

**基本的な使い方**

```typescript
const result = await motion.detect({
  html: myHtml,
  includeWarnings: true, // パフォーマンス・アクセシビリティ警告
  includeSummary: true, // サマリー情報
});

// レスポンス:
// - patterns: [{
//     type: 'css_animation',
//     name: 'fadeIn',
//     category: 'entrance',
//     duration: 500,
//     easing: 'ease-in-out'
//   }]
// - warnings: [{ code: 'PERF_LAYOUT_TRIGGER', severity: 'warning' }]
```

**検索可能にする（重要）**

```typescript
const result = await motion.detect({
  html: myHtml,
  save_to_db: true, // ★必須: MotionPattern + Embedding自動生成
});

// この後、motion.searchで検索可能になります
```

---

#### detection_mode（検出モード）

`detection_mode` パラメータでアニメーション検出方式を指定できます。

`detection_mode` parameter specifies the animation detection method.

| モード / Mode  | 説明 / Description                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `css`          | CSS静的解析のみ / CSS static analysis only                                                                                |
| `runtime`      | ブラウザでの実行時検出 / Runtime detection in browser                                                                     |
| `hybrid`       | CSS解析 + 実行時検出の組み合わせ / CSS analysis + runtime detection                                                       |
| `video`        | フレームキャプチャによる検出（**デフォルト**） / Frame capture detection (**default**)                                    |
| `library_only` | JSライブラリ検出のみ（GSAP, Three.js, Framer Motion等） / JS library detection only (e.g., GSAP, Three.js, Framer Motion) |

```typescript
const result = await motion.detect({
  html: myHtml,
  detection_mode: "hybrid", // CSS + ランタイム両方で検出
});
```

---

#### video mode（フレームキャプチャ）

Reftrixの**デフォルト設定では video mode が有効**です。スクロール時のアニメーションを15px/frameでキャプチャします。

**デフォルト設定**

| パラメータ                | デフォルト値         | 説明                                                  |
| ------------------------- | -------------------- | ----------------------------------------------------- |
| `enable_frame_capture`    | **true**             | デフォルトで有効                                      |
| `analyze_frames`          | **true**             | フレーム画像分析デフォルト有効                        |
| `scroll_px_per_frame`     | **15px**             | 基準値（アニメーション検出に最適化）※サービス層で適用 |
| `frame_rate`              | 30 fps               | フレームレート ※サービス層で適用                      |
| `frame_interval_ms`       | 33ms                 | フレーム間隔（1000/30）                               |
| `scroll_speed_px_per_sec` | 450 px/sec           | スクロール速度（15 × 30）                             |
| `output_format`           | png                  | PNG推奨（ロスレス）                                   |
| `output_dir`              | /tmp/reftrix-frames/ | 出力ディレクトリ                                      |

**15px/frame の根拠**:

- 60fps等価スクロール（216px/秒 ÷ 60 ≈ 3.6px）と50px/frameの中間
- IntersectionObserver閾値（0.1〜0.3）を確実に検出
- cubic-bezier easing曲線の解析に十分なサンプル数
- parallax微動（係数0.02〜0.05）の検出可能

**使用例**

```typescript
// video mode（デフォルト設定で使用）
const result = await motion.detect({
  html: myHtml,
  // enable_frame_capture: true（デフォルト）
  // analyze_frames: true（デフォルト）
  // scroll_px_per_frame: 15（デフォルト）
});

// video modeを無効化する場合
const result = await motion.detect({
  html: myHtml,
  enable_frame_capture: false,
});

// CLS問題特定（Core Web Vitals改善）
const result = await motion.detect({
  html: myHtml,
  enable_frame_capture: true,
  analyze_frames: true,
  frame_analysis_options: {
    diff_threshold: 0.1, // ピクセル差分しきい値
    cls_threshold: 0.05, // Core Web Vitals閾値
    motion_threshold: 50, // モーション検出しきい値
    parallel: true, // Worker Thread並列処理
  },
});
```

**フレーム画像分析 / Frame Image Analysis**

**目的**: CSS静的解析では捉えられない実際のアニメーション動作を分析

**Purpose**: Analyze actual animation behavior that CSS static analysis cannot capture

**主な機能 / Main Features**:

1. **Worker Thread並列処理 / Worker Thread Parallel Processing**
   - `FrameWorkerPool` による10ペア超の並列diff計算
   - CPUコア数に応じたワーカー数自動調整（デフォルト: CPUコア数 - 1）
   - タスクキューによる効率的な並列処理

   `FrameWorkerPool` enables parallel diff computation for 10+ pairs. Worker count auto-adjusts to CPU cores (default: cores - 1). Efficient parallel processing via task queue.

2. **CLS計算 / CLS Calculation（Core Web Vitals準拠）**
   - `layout_shift_score = impact_fraction * distance_fraction`
   - 分類閾値: good (< 0.1), needs-improvement (0.1-0.25), poor (>= 0.25)
   - 原因推定: `image_load`（画像読み込み）, `font_swap`（フォント差し替え）, `dynamic_content`（動的コンテンツ挿入）

   CLS calculation compliant with Core Web Vitals. Classification: good (< 0.1), needs-improvement (0.1-0.25), poor (>= 0.25). Root cause estimation: image_load, font_swap, dynamic_content.

3. **色変化検出 / Color Change Detection**
   - 4x4グリッドサンプリングによるドミナントカラー抽出
   - fade-in / fade-out / 色遷移 / 明度変化の検出
   - フレーム間の色距離計算（RGB/HSL）

   4x4 grid sampling for dominant color extraction. Detects fade-in, fade-out, color transitions, and brightness changes. Inter-frame color distance calculation (RGB/HSL).

**主な用途 / Primary Use Cases**:

- **CLS検出**: Cumulative Layout Shift問題の視覚的特定（Core Web Vitals改善）
- **差分解析**: アニメーション変化の定量化（Pixelmatch使用）
- **パフォーマンス診断**: 大きな再描画領域の可視化
- **色変化分析**: フェード効果やカラートランジションの定量化

**パフォーマンス目標**:

- フレーム差分（1ペア）: < 100ms
- 10フレームシーケンス: < 5s（Worker Thread並列処理）
- 100フレームシーケンス: < 30s（Worker Thread並列処理）
- メモリ使用量: < 500MB

**CLS検出の使用例 / CLS Detection Example**

```typescript
const result = await motion.detect({
  html: myHtml,
  enable_frame_capture: true,
  analyze_frames: true,
  frame_analysis_options: {
    diff_threshold: 0.1, // ピクセル差分しきい値
    cls_threshold: 0.1, // Core Web Vitals 'good' 閾値
    motion_threshold: 50, // モーション検出しきい値
    parallel: true, // Worker Thread並列処理（色変化検出含む）
  },
});

// レスポンス:
// - frameAnalysis: {
//     cls: {
//       score: 0.08,
//       classification: 'good',   // 'good' | 'needs-improvement' | 'poor'
//       shifts: [{
//         impactFraction: 0.15,
//         distanceFraction: 0.05,
//         score: 0.0075,
//         cause: 'image_load'      // 原因推定
//       }]
//     },
//     colorChanges: [{
//       type: 'fade-in',
//       region: { x: 0, y: 100, width: 400, height: 200 },
//       dominantColors: [{ hex: '#1a0533', percentage: 0.45 }]
//     }]
//   }
```

**注意事項**:

- **video modeはデフォルトで有効**（無効化する場合は明示的に `enable_frame_capture: false` を指定）
- CI環境では`analyze_frames: false`推奨（ローカルのみ実行）
- 10ペア超の差分計算は `FrameWorkerPool` により自動的にWorker Thread並列化される
- 大量フレーム処理時はメモリ使用量に注意
- 解像度が高い場合は処理時間が増加

---

**検出カテゴリ**

| カテゴリ            | 説明                                 |
| ------------------- | ------------------------------------ |
| `scroll_trigger`    | IntersectionObserver、スクロール連動 |
| `hover_effect`      | ホバーエフェクト                     |
| `page_transition`   | ページ遷移                           |
| `loading_state`     | ローディング・スピナー               |
| `entrance`          | フェードイン・スライドイン           |
| `exit`              | フェードアウト・スライドアウト       |
| `micro_interaction` | 短いインタラクション                 |

**警告タイプ**

| コード                     | 重大度  | 説明                           |
| -------------------------- | ------- | ------------------------------ |
| `PERF_LAYOUT_TRIGGER`      | warning | レイアウト再計算プロパティ使用 |
| `PERF_TOO_MANY_ANIMATIONS` | warning | 20個以上のアニメーション       |
| `A11Y_NO_REDUCED_MOTION`   | warning | prefers-reduced-motion未対応   |
| `A11Y_INFINITE_ANIMATION`  | info    | 無限ループアニメーション       |

**ベストプラクティス**

- `save_to_db: true` で検索可能な状態にする
- `includeWarnings: true` でパフォーマンス・アクセシビリティ問題を早期発見
- CI環境では `analyze_frames: false` を推奨（ローカルのみ実行）

---

### 4.2 motion.search - セマンティック検索 / Semantic Search

**用途 / Purpose**: 自然言語クエリまたはサンプルパターンでモーションを検索 / Search motions using natural language queries or sample patterns

**自然言語検索**

```typescript
const results = await motion.search({
  query: "smooth fade in animation on scroll",
  limit: 10,
  minSimilarity: 0.7, // 類似度閾値（0-1）
});

// レスポンス:
// - results: [{
//     id: '...',
//     name: 'fadeInOnScroll',
//     similarity: 0.89,
//     animation: { duration: 500, easing: 'ease-out' },
//     raw_css: '...'
//   }]
```

**サンプルパターンで検索**

```typescript
const results = await motion.search({
  samplePattern: {
    type: "transition",
    duration: 300,
    easing: "cubic-bezier(0.4, 0, 0.2, 1)",
    properties: ["opacity", "transform"],
  },
  limit: 10,
});
```

**フィルター機能**

```typescript
const results = await motion.search({
  query: "scroll animation",
  filters: {
    type: "animation", // animation | transition | transform | scroll | hover | keyframe
    trigger: "scroll", // scroll | hover | click | load | focus | custom
    minDuration: 200,
    maxDuration: 1000,
  },
});
```

---

## 5. Quality（品質）ツール / Quality Tools

品質ツールは、Webデザインの品質を3軸（originality, craftsmanship, contextuality）で評価し、改善提案を生成します。

Quality tools evaluate web design quality on 3 axes (originality, craftsmanship, contextuality) and generate improvement suggestions.

### 5.1 quality.evaluate - 品質評価 / Quality Evaluation

**用途 / Purpose**: Webデザインの品質評価と改善提案 / Web design quality evaluation and improvement suggestions

**基本的な使い方**

```typescript
const result = await quality.evaluate({
  html: myHtml,
  action: "evaluate", // evaluate（デフォルト）| 'suggest_improvements'
});

// レスポンス:
// レスポンス（{ success: true, data: { ... } } 形式）:
// - overall: 78（0-100）
// - grade: 'B'（A | B | C | D | F）
// - originality: { score: 75, grade: 'B', details: [...] }
// - craftsmanship: { score: 82, grade: 'B', details: [...] }
// - contextuality: { score: 76, grade: 'B', details: [...] }
```

> **`action` パラメータ**: `'evaluate'`（デフォルト）で品質評価、`'suggest_improvements'` で改善提案生成を行います。省略時は自動的に `'evaluate'` として扱われます。

**改善提案の取得（v0.1.0統合機能）**

```typescript
const result = await quality.evaluate({
  html: myHtml,
  action: "suggest_improvements", // 改善提案生成
  categories: ["originality", "accessibility"],
  minPriority: "high",
  maxSuggestions: 10,
});

// レスポンス:
// - improvements: [{
//     category: 'originality',
//     priority: 'high',
//     title: 'Avoid generic gradient backgrounds',
//     suggested_code: '...'
//   }]
```

**評価軸のカスタマイズ**

```typescript
const result = await quality.evaluate({
  html: myHtml,
  weights: {
    originality: 0.35, // デフォルト: 0.35
    craftsmanship: 0.4, // デフォルト: 0.4
    contextuality: 0.25, // デフォルト: 0.25
  },
  strict: true, // 厳格モード（AI cliche検出を強化）
});
```

**業界・ターゲット層を指定**

```typescript
const result = await quality.evaluate({
  html: myHtml,
  targetIndustry: "healthcare",
  targetAudience: "medical professionals",
});

// contextualityスコアに反映されます
```

**3つの評価軸**

| 軸                | 説明       | 主な評価基準                         |
| ----------------- | ---------- | ------------------------------------ |
| **Originality**   | 独創性     | AI cliche回避、ユニークな表現        |
| **Craftsmanship** | 職人性     | タイポグラフィ、グリッド、余白の精度 |
| **Contextuality** | 文脈適合性 | 業界・ターゲット層との適合           |

**ベストプラクティス**

- 定期的に評価を実行してデザインの質を維持
- `strict: true` でAI生成特有のクリシェ表現を検出
- 改善提案の`suggested_code`を参考に修正

---

## 6. Style（スタイル）ツール / Style Tools

スタイルツールは、ブランドカラーパレットの取得と適用を提供します。

Style tools provide brand color palette retrieval and application.

### 6.1 style.get_palette - パレット取得 / Palette Retrieval

**用途 / Purpose**: ブランドパレットの取得 / Retrieve brand palettes

**ID指定で詳細取得**

```typescript
const result = await style.get_palette({
  id: "palette-id",
  include_gradients: true,
});

// レスポンス:
// - name: 'Brand Palette'
// - mode: 'light' | 'dark' | 'both'
// - tokens: [{ token_name: 'primary', oklch_l: 0.5, oklch_c: 0.1, oklch_h: 200 }]
// - gradients: [{ name: 'hero-gradient', stops: [...] }]
```

**ブランド名で検索**

```typescript
const result = await style.get_palette({
  brand_name: "Reftrix",
  mode: "light", // light | dark | both
});
```

**パレット一覧**

```typescript
const result = await style.get_palette({});

// レスポンス:
// - palettes: [{ id: '...', name: '...', mode: '...' }]
```

---

## 7. Brief（ブリーフ）ツール / Brief Tools

### 7.1 brief.validate - ブリーフ検証 / Brief Verification

**用途 / Purpose**: デザインブリーフの完成度と品質を評価 / Evaluate design brief completeness and quality

**基本的な使い方**

```typescript
const result = await brief.validate({
  brief: {
    projectName: "New Landing Page",
    description: "A modern landing page for SaaS product...",
    targetAudience: "B2B software developers",
    industry: "technology",
    tone: ["professional", "minimal"],
    colorPreferences: {
      primary: "#3B82F6",
      secondary: "#10B981",
    },
    references: [{ url: "https://example.com", note: "Love the hero section" }],
  },
});

// レスポンス:
// レスポンス（{ success: true, data: { ... } } 形式）:
// - isValid: true（エラーなし）
// - completenessScore: 85（0-100）
// - readyForDesign: true（isValid && score >= 60）
// - issues: []
// - suggestions: ['Add more reference sites']
```

**厳格モード**

```typescript
const result = await brief.validate({
  brief: { ... },
  strictMode: true  // description≥100文字、references≥2件必須
});
```

**完成度スコアのフィールド別Weight**

| フィールド       | Weight | 達成条件               |
| ---------------- | ------ | ---------------------- |
| projectName      | 10     | 3文字以上              |
| description      | 20     | 50文字以上             |
| targetAudience   | 15     | 20文字以上             |
| industry         | 10     | 非空                   |
| tone             | 15     | 非空配列               |
| colorPreferences | 15     | primary色あり          |
| references       | 10     | 非空配列               |
| constraints      | 5      | mustHave/mustAvoidあり |

---

## 8. Page（ページ）ツール / Page Tools

### 8.1 page.analyze - 統合ページ解析 / Unified Page Analysis

**用途 / Purpose**: URLを指定してlayout/motion/qualityの3分析を並列実行 / Specify a URL and run layout/motion/quality analyses in parallel

**基本的な使い方**

```typescript
const result = await page.analyze({
  url: "https://example.com",
  summary: true, // デフォルト: false。軽量レスポンスには明示的にtrueを指定（推奨）
  features: {
    layout: true,
    motion: true,
    quality: true,
  },
});

// レスポンス:
// - layout: { section_count: 7, section_types: { hero: 1, feature: 3 } }
// - motion: { pattern_count: 12, category_breakdown: { scroll_trigger: 5 } }
// - quality: { overall: 78, grade: 'B' }
```

> **注意**: `summary` のデフォルトは `false`（詳細レスポンス）です。トークン消費を抑えるため、概要確認には `summary: true` の明示的な指定を推奨します。

**詳細レスポンス**

```typescript
const result = await page.analyze({
  url: "https://example.com",
  summary: false, // 詳細レスポンス
  timeout: 600000, // 10分（デフォルト）
  features: {
    layout: true,
    motion: true,
    quality: true,
  },
});

// レスポンス:
// - layout: { html: '...', screenshot: {...}, sections: [...] }
// - motion: { patterns: [...], warnings: [...] }
// - quality: { recommendations: [...] }
```

**video mode（page.analyzeでの使用）**

**重要**: page.analyzeでは `enable_frame_capture` のデフォルトは `false`（パフォーマンス考慮）。

```typescript
const result = await page.analyze({
  url: "https://example.com",
  summary: true,
  features: {
    motion: true,
  },
  motionOptions: {
    enable_frame_capture: true, // 明示的に有効化
    analyze_frames: true, // フレーム画像分析（CLS検出）
  },
});
```

**パラメータ: `layoutOptions.useVision`（v0.1.0+）**

| パラメータ / Parameter    | 型 / Type | デフォルト / Default | 説明 / Description                                                                                                                                                                                                                      |
| ------------------------- | --------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layoutOptions.useVision` | boolean   | `true`               | Ollama Vision（llama3.2-vision）を使用したリッチなレイアウト解析を有効化。`false` の場合はHTML静的解析のみ。 / Enable rich layout analysis using Ollama Vision (llama3.2-vision). When `false`, only HTML static analysis is performed. |

```typescript
const result = await page.analyze({
  url: "https://example.com",
  layoutOptions: {
    useVision: true, // デフォルト: true（Ollama Vision使用）
  },
});
```

**レスポンスフィールド: `visionUsed`（v0.1.2+）**

レスポンスに `visionUsed: boolean` フィールドが含まれ、実際にOllama Visionが使用されたかを正確に返します。Ollamaが未起動の場合やVision分析がスキップされた場合は `false` になります。

The response includes a `visionUsed: boolean` field that accurately indicates whether Ollama Vision was actually used. Returns `false` when Ollama is not running or Vision analysis was skipped.

```typescript
// レスポンス例:
{
  layout: { section_count: 7, ... },
  visionUsed: true  // Ollama Visionが実際に使用された / Ollama Vision was actually used
}
```

**環境別タイムアウト動作（v0.1.2+） / Environment-specific Timeout Behavior (v0.1.2+)**

- **Apple Silicon（Metal GPU）**: Metal GPUが自動検出され、GPU用タイムアウト（60秒）が適用されます。手動設定は不要です。 / Metal GPU is auto-detected and GPU timeout (60s) is applied. No manual configuration needed.
- **CPU-only環境**: タイムアウトが `calculateEffectiveTimeout()` により自動延長されます（最大25分）。 / Timeout is automatically extended via `calculateEffectiveTimeout()` (up to 25 minutes).
- **NVIDIA GPU**: VRAM容量に基づいてGPU用タイムアウトが適用されます。 / GPU timeout is applied based on VRAM capacity.

**ベストプラクティス**

- 初回は `summary: true` で概要を確認
- 詳細が必要な場合のみ `summary: false`
- video modeを有効にする場合は明示的に指定
- `visionUsed` フィールドでVision分析の実行有無を確認 / Check `visionUsed` field to verify Vision analysis execution

---

### 8.2 page.getJobStatus - 非同期ジョブステータス確認 / Async Job Status Check

**用途 / Purpose**: `page.analyze` の非同期モード（`async: true`）で実行したジョブのステータスを確認 / Check the status of jobs executed in async mode (`async: true`) of `page.analyze`

**基本的な使い方**

```typescript
// 非同期モードでpage.analyzeを実行
const job = await page.analyze({
  url: "https://example.com",
  async: true, // 非同期モード
});

// ジョブステータスを確認
const status = await page.getJobStatus({
  job_id: job.job_id, // UUID形式
});

// レスポンス:
// レスポンス（{ success: true, data: { ... } } 形式）:
// - status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown'
// - progress: 0-100（進捗率）
// - result: { ... }（完了時の結果）
// - failedReason: 'エラー詳細'（失敗時）
```

**ポーリングによる完了待機**

```typescript
async function waitForCompletion(jobId: string, maxWait = 120000): Promise<unknown> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const status = await page.getJobStatus({ job_id: jobId });
    if (status.status === "completed") return status.result;
    if (status.status === "failed") throw new Error(status.failedReason);
    await new Promise((r) => setTimeout(r, 2000)); // 2秒間隔
  }
  throw new Error("Timeout waiting for job completion");
}
```

**注意事項**

- 非同期モードを使用するにはRedis（BullMQ）が必要
- ジョブは24時間後に自動削除されます

### 8.3 page.batch_analyze - バッチ一括分析 / Batch Analysis (v0.4.0)

**用途 / Purpose**: 複数URLを一括分析する（競合調査、デザインシステム監査等）/ Analyze multiple URLs in batch (competitive research, design system audits, etc.)

```typescript
// 複数URLの一括分析
const batch = await page.batch_analyze({
  urls: ["https://example.com", "https://example.org", "https://example.net"],
  concurrency: 3, // バッチ内並列数 (1-5, default: 3)
  timeout: 1800000, // バッチ全体タイムアウト (default: 30分)
  respect_robots_txt: true, // robots.txt尊重 (default: true)
  on_error: "skip", // 失敗時はスキップして継続 (default: "skip")
});
// → { success: true, data: { batchId: "...", totalUrls: 3, jobIds: [...] } }
```

**制限事項 / Limits**:

- 最大50 URL/バッチ / Max 50 URLs per batch
- 同時1バッチ制限（CWE-770 DoS対策）/ Max 1 concurrent batch (CWE-770)
- analysis tier (10 RPM) レート制御 / analysis tier rate limiting
- 全URLにSSRF事前検証 / SSRF pre-validation on all URLs

### 8.4 page.getBatchStatus - バッチステータス確認 / Batch Status Check (v0.4.0)

**用途 / Purpose**: `page.batch_analyze` で投入したバッチジョブの進捗確認・結果取得 / Check progress and retrieve results of batch jobs submitted via `page.batch_analyze`

```typescript
const status = await page.getBatchStatus({
  batch_id: batch.data.batchId,
});
// → { success: true, data: { state: "completed", progress: 100, summary: {...}, jobs: [...] } }
```

**注意事項**:

- read-only、冪等（何度呼んでも同じ結果）/ Read-only, idempotent
- バッチメタデータは48時間後にRedisから自動削除 / Batch metadata auto-expires after 48h

---

## 9. System（システム）ツール / System Tools

### 9.1 system.health - ヘルスチェック / Health Check

**用途 / Purpose**: システムの健全性チェック / System health check

**基本的な使い方**

```typescript
const result = await system.health({
  detailed: true,
});

// レスポンス:
// - status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
// - database: { status: 'HEALTHY', latency_ms: 5 }
// - mcp_tools: { total_tools: 35, available: 35 }
// - system_resources: { cpu_usage: 0.25, memory_usage: 0.45 }
```

**特定コンポーネントのみチェック**

```typescript
const result = await system.health({
  component: "database", // database | system_resources | mcp_tools
});
```

**ベストプラクティス**

- セッション開始時に必ず `detailed: true` で実行
- 定期的にヘルスチェックを実行（30分ごと推奨）

---

## 10. Narrative（ナラティブ）ツール / Narrative Tools

ナラティブツールは、Webデザインの世界観（WorldView）とレイアウト構成（LayoutStructure）をセマンティック検索します。ムードカテゴリ・色彩印象・グリッドシステム・視覚的階層などの観点で類似デザインを発見できます。

Narrative tools provide semantic search for web design worldview (WorldView) and layout structure (LayoutStructure). You can discover similar designs based on mood category, color impression, grid system, and visual hierarchy.

### 10.1 narrative.search - 世界観・構成セマンティック検索 / Worldview and Layout Semantic Search

**用途 / Purpose**: 自然言語クエリまたは768次元Embeddingで、世界観・レイアウト構成が類似するデザインを検索 / Search for designs with similar worldview and layout structure using natural language queries or 768-dimension embeddings

**実装詳細 / Implementation Details**: `NarrativeSearchService` はPrisma + pgvector（HNSW cosine similarity）による本実装です。以下の4つの検索メソッドを提供します。

`NarrativeSearchService` is a full implementation using Prisma + pgvector (HNSW cosine similarity). It provides the following 4 search methods:

| メソッド / Method        | 説明 / Description                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `search()`               | ベクトル検索（768次元embedding） / Vector search (768-dim embedding)                                         |
| `searchHybrid()`         | RRF（60% vector + 40% full-text）によるハイブリッド検索 / Hybrid search via RRF (60% vector + 40% full-text) |
| `searchByVector()`       | embedding直接指定によるベクトル検索 / Vector search with direct embedding input                              |
| `searchByMoodCategory()` | MoodCategoryフィルター検索 / Filter search by MoodCategory                                                   |

**基本的な使い方（ハイブリッド検索）/ Basic Usage (Hybrid Search)**

```typescript
const results = await narrative.search({
  query: "サイバーセキュリティ感のあるダークなデザイン",
  options: {
    limit: 10,
    searchMode: "hybrid", // vector | hybrid（デフォルト）
  },
});

// レスポンス:
// - results: [{
//     id: '...',
//     webPageId: '...',
//     sourceUrl: 'https://...',
//     similarity: 0.89,
//     worldView: {
//       moodCategory: 'tech',
//       moodDescription: '...',
//       overallTone: '...'
//     },
//     layoutStructure: {
//       gridType: 'css-grid',
//       columns: 12
//     },
//     confidence: 0.85
//   }]
// - searchInfo: { query: '...', searchMode: 'hybrid', totalResults: 10, searchTimeMs: 120 }
```

**ベクトル検索のみ / Vector Search Only**

```typescript
const results = await narrative.search({
  query: "minimalist tech landing page",
  options: {
    searchMode: "vector", // pgvector cosine similarity のみ
    limit: 10,
    minSimilarity: 0.7,
  },
});
```

**embedding直接指定 / Direct Embedding Input**

```typescript
// 事前に生成済みの768次元embeddingで検索
const results = await narrative.search({
  embedding: precomputedVector, // number[768]
  options: {
    limit: 10,
  },
});
```

**MoodCategoryフィルター検索 / MoodCategory Filter Search**

```typescript
const results = await narrative.search({
  query: "clean corporate design",
  filters: {
    moodCategory: "professional", // 単一のムードカテゴリを指定
    minConfidence: 0.7,
  },
  options: {
    limit: 20,
  },
});
```

**フィルター機能（全オプション）/ Filter Options (All)**

```typescript
const results = await narrative.search({
  query: "elegant minimal design",
  filters: {
    moodCategory: "elegant", // 単一のムードカテゴリを指定
    minConfidence: 0.7, // 最小信頼度（0-1）
  },
  options: {
    limit: 20,
    minSimilarity: 0.7, // 最小類似度（デフォルト: 0.6）
    searchMode: "hybrid",
    vectorWeight: 0.6, // Vector検索の重み（デフォルト: 0.6）
    fulltextWeight: 0.4, // Full-text検索の重み（デフォルト: 0.4）
  },
});
```

**主要パラメータ**

| パラメータ               | 型       | デフォルト                      | 説明                                 |
| ------------------------ | -------- | ------------------------------- | ------------------------------------ |
| `query`                  | string   | （query/embeddingいずれか必須） | 自然言語検索クエリ（1-500文字）      |
| `embedding`              | number[] | （query/embeddingいずれか必須） | 768次元Embedding直接指定             |
| `filters.moodCategory`   | string   | -                               | ムードカテゴリフィルター（単一指定） |
| `filters.minConfidence`  | number   | -                               | 最小信頼度（0-1）                    |
| `options.limit`          | number   | 10                              | 結果数（1-50）                       |
| `options.minSimilarity`  | number   | 0.6                             | 最小類似度（0-1）                    |
| `options.searchMode`     | string   | hybrid                          | 検索モード（vector / hybrid）        |
| `options.vectorWeight`   | number   | 0.6                             | Vector検索の重み（RRF結合時）        |
| `options.fulltextWeight` | number   | 0.4                             | Full-text検索の重み（RRF結合時）     |

**検索アーキテクチャ / Search Architecture**

```
narrative.search({ query, searchMode: 'hybrid' })
  │
  ├─ Vector Search (60%)
  │   ├─ query → multilingual-e5-base → 768D embedding
  │   ├─ pgvector HNSW cosine similarity
  │   └─ design_narrative_embeddings.embedding <=> query_vector
  │
  ├─ Full-text Search (40%)
  │   ├─ query → PostgreSQL plainto_tsquery
  │   └─ design_narrative_embeddings.search_vector @@ tsquery
  │
  └─ RRF (Reciprocal Rank Fusion)
      ├─ score = vectorWeight / (k + vector_rank) + fulltextWeight / (k + fulltext_rank)
      └─ ソート: RRFスコア降順 → minSimilarityでフィルター
```

**サポートされるムードカテゴリ**

| カテゴリ       | 説明                   |
| -------------- | ---------------------- |
| `professional` | ビジネス、企業         |
| `playful`      | 遊び心、カジュアル     |
| `premium`      | 高級、ラグジュアリー   |
| `tech`         | テクノロジー、先進的   |
| `organic`      | 自然、オーガニック     |
| `minimal`      | ミニマル、シンプル     |
| `bold`         | 大胆、インパクト       |
| `elegant`      | 上品、洗練             |
| `friendly`     | 親しみやすい           |
| `artistic`     | アート、クリエイティブ |
| `trustworthy`  | 信頼、安心             |
| `energetic`    | エネルギッシュ、活発   |

**ベストプラクティス**

- 検索前に `page.analyze` で対象ページを解析・保存しておく
- 日本語・英語のクエリに対応（multilingual-e5-baseモデル使用）
- `hybrid` モードがデフォルトで推奨（Vector + Full-text のRRF統合）
- `limit` は 10〜20 を推奨
- `moodCategory` フィルターは単一カテゴリを指定（12種類のenumから選択）
- 事前計算済みembeddingがある場合は `embedding` パラメータで直接指定すると高速

---

## 11. Background（背景）ツール / Background Tools

背景ツールは、BackgroundDesign（グラデーション、グラスモーフィズム、パターン背景等）をセマンティック検索します。

Background tools provide semantic search for BackgroundDesign patterns (gradients, glassmorphism, pattern backgrounds, etc.).

### 11.1 background.search - 背景デザインパターン検索 / Background Design Pattern Search

**用途 / Purpose**: 自然言語クエリで背景デザインパターンをベクトル検索 / Vector search for background design patterns using natural language queries

**基本的な使い方**

```typescript
const results = await background.search({
  query: "dark gradient with purple tones",
  limit: 10,
});

// レスポンス:
// - results: [{
//     id: '...',
//     designType: 'linear_gradient',
//     cssValue: 'linear-gradient(135deg, #1a0533, #2d1b69)',
//     similarity: 0.92,
//     source: { webPageId: '...' },
//     name: '...',
//     selector: 'body',
//     colorInfo: { ... },
//     textRepresentation: '...'
//   }]
// - total: 25
// - query: 'dark gradient with purple tones'
// - searchTimeMs: 85
```

**フィルター機能**

```typescript
const results = await background.search({
  query: "glassmorphism effect",
  limit: 20,
  offset: 0,
  filters: {
    designType: "glassmorphism", // デザインタイプでフィルター
    webPageId: "page-uuid", // 特定ページの背景のみ
  },
});
```

**主要パラメータ**

| パラメータ           | 型     | デフォルト | 説明                             |
| -------------------- | ------ | ---------- | -------------------------------- |
| `query`              | string | （必須）   | 検索クエリ（1-500文字）          |
| `limit`              | number | 10         | 取得件数（1-50）                 |
| `offset`             | number | 0          | オフセット（ページネーション用） |
| `filters.designType` | string | -          | デザインタイプでフィルター       |
| `filters.webPageId`  | string | -          | WebページIDでフィルター          |

**サポートされるデザインタイプ（14種類）**

| タイプ               | 説明                         |
| -------------------- | ---------------------------- |
| `solid_color`        | 単色背景                     |
| `linear_gradient`    | 線形グラデーション           |
| `radial_gradient`    | 放射状グラデーション         |
| `conic_gradient`     | 円錐グラデーション           |
| `mesh_gradient`      | メッシュグラデーション       |
| `image_background`   | 画像背景                     |
| `pattern_background` | パターン背景                 |
| `video_background`   | 動画背景                     |
| `animated_gradient`  | アニメーショングラデーション |
| `glassmorphism`      | グラスモーフィズム           |
| `noise_texture`      | ノイズテクスチャ             |
| `svg_background`     | SVG背景                      |
| `multi_layer`        | 多層背景                     |
| `unknown`            | 未分類                       |

**ベストプラクティス**

- 検索前に `page.analyze` または `layout.ingest` でページを収集・解析しておく
- `designType` フィルターで特定の背景タイプに絞り込み可能
- `offset` を使ったページネーションで大量の結果を段階的に取得
- 日本語・英語のクエリに対応（multilingual-e5-baseモデル使用）

---

## 12. Responsive（レスポンシブ）ツール / Responsive Tools

レスポンシブツールは、レスポンシブ分析結果（ビューポート差異、ブレークポイント、スクリーンショット差分）をセマンティック検索します。pgvector HNSW cosine similarity + JSONBフィルタを使用します。

Responsive tools provide semantic search over responsive analysis results (viewport differences, breakpoints, screenshot diffs). Uses pgvector HNSW cosine similarity + JSONB filters.

### 12.1 responsive.search - レスポンシブ分析検索 / Responsive Analysis Search

**用途 / Purpose**: 自然言語クエリでレスポンシブ分析結果をベクトル検索 / Vector search for responsive analysis results using natural language queries

**基本的な使い方 / Basic Usage**

```typescript
const results = await responsive.search({
  query: "navigation layout changes between mobile and desktop",
  limit: 10,
});

// レスポンス / Response:
// - results: [{
//     id: '...',
//     similarity: 0.85,
//     webPageId: '...',
//     viewportDifferences: [...],
//     breakpoints: [...],
//     screenshotDiffs: [...]
//   }]
// - total: 5
// - searchTimeMs: 12
```

**フィルター機能 / Filtering**

```typescript
const results = await responsive.search({
  query: "typography size differences",
  filters: {
    diffCategory: "typography", // 差異カテゴリ / Diff category
    viewportPair: "desktop-mobile", // ビューポートペア / Viewport pair
    breakpointRange: { min: 768, max: 1440 }, // ブレークポイント範囲(px) / Breakpoint range
    minDiffPercentage: 5, // 最小差分率(%) / Min diff percentage
    webPageId: "page-uuid", // WebページIDでフィルタ / Filter by web page
  },
  limit: 20,
  offset: 0,
});
```

**主要パラメータ / Key Parameters**

| パラメータ / Parameter      | 型 / Type | デフォルト / Default | 説明 / Description                                                                                               |
| --------------------------- | --------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `query`                     | string    | （必須 / required）  | 検索クエリ（1-500文字） / Search query (1-500 chars)                                                             |
| `limit`                     | number    | 10                   | 取得件数（1-50） / Result limit                                                                                  |
| `offset`                    | number    | 0                    | オフセット / Pagination offset                                                                                   |
| `filters.diffCategory`      | string    | -                    | 差異カテゴリ / Diff category: layout, typography, spacing, visibility, navigation, image, interaction, animation |
| `filters.viewportPair`      | string    | -                    | ビューポートペア / Viewport pair: desktop-tablet, desktop-mobile, tablet-mobile                                  |
| `filters.breakpointRange`   | object    | -                    | ブレークポイント範囲 `{min, max}` (px) / Breakpoint range                                                        |
| `filters.minDiffPercentage` | number    | -                    | 最小スクリーンショット差分率(0-100) / Min screenshot diff percentage                                             |
| `filters.webPageId`         | string    | -                    | WebページIDでフィルタ / Filter by web page UUID                                                                  |

**データライフサイクル / Data Lifecycle**: 同一URLの再分析時は clean-slate（`deleteMany` → `create`）で旧データを上書きします。 / On re-analysis of the same URL, old data is overwritten via clean-slate (`deleteMany` → `create`).

**ベストプラクティス / Best Practices**

- 検索前に `page.analyze` でページを収集・解析しておく（レスポンシブ分析はpage.analyzeで自動実行） / Collect and analyze pages with `page.analyze` first (responsive analysis runs automatically)
- `diffCategory` フィルターで特定の差異タイプに絞り込み可能 / Use `diffCategory` filter to narrow down specific difference types
- 日本語・英語のクエリに対応（multilingual-e5-baseモデル使用） / Supports Japanese and English queries (multilingual-e5-base model)

---

### 12.2 responsive.capture - マルチデバイス同時キャプチャ / Multi-Device Simultaneous Capture

**用途 / Purpose**: 3ビューポート（desktop 1920x1080, tablet 768x1024, mobile 375x812）でWebページを同時キャプチャし、レスポンシブレイアウトの差分を分析 / Simultaneously capture a web page across 3 viewports (desktop 1920x1080, tablet 768x1024, mobile 375x812) and analyze responsive layout differences

**基本的な使い方 / Basic Usage**

```typescript
// デフォルト3ビューポートでキャプチャ / Capture with default 3 viewports
const result = await responsive.capture({
  url: "https://example.com",
});

// レスポンス / Response:
// - captures: [{ viewport: 'desktop', width: 1920, height: 1080, ... }, ...]
// - diff: { score: 0.85, changes: [...] }
// - captureTimeMs: 3200
```

**カスタムビューポート / Custom Viewports**

```typescript
const result = await responsive.capture({
  url: "https://example.com",
  viewports: [
    { name: "wide", width: 2560, height: 1440 },
    { name: "mobile-small", width: 320, height: 568 },
  ],
  include_screenshots: true, // スクリーンショットサイズ情報を含める
  include_diff: true, // 差分分析を含める（デフォルト: true）
});
```

**主要パラメータ / Key Parameters**

| パラメータ / Parameter | 型 / Type | デフォルト / Default                   | 説明 / Description                                                    |
| ---------------------- | --------- | -------------------------------------- | --------------------------------------------------------------------- |
| `url`                  | string    | （必須 / required）                    | キャプチャ対象URL / Target URL                                        |
| `viewports`            | array     | desktop/tablet/mobile（3ビューポート） | カスタムビューポート（最大4つ） / Custom viewports (max 4)            |
| `include_screenshots`  | boolean   | false                                  | スクリーンショットサイズ情報を含めるか / Include screenshot size info |
| `include_diff`         | boolean   | true                                   | レスポンシブ差分分析を含めるか / Include responsive diff analysis     |

**ベストプラクティス / Best Practices**

- レスポンシブデザインの検証にはデフォルトの3ビューポートで十分 / Default 3 viewports are sufficient for responsive design verification
- `responsive.search` と組み合わせて、類似のレスポンシブパターンを検索可能 / Combine with `responsive.search` to find similar responsive patterns

---

## 13. Preference（嗜好プロファイリング）ツール / Preference (Profiling) Tools

嗜好プロファイリングツールは、ユーザーのデザイン嗜好をインタラクティブに学習し、検索結果をパーソナライズします。フィードバックセッションを通じて嗜好プロファイルを構築し、全検索ツール（layout/motion/background/narrative/responsive search）にpreference rerankingを適用します。

Preference profiling tools interactively learn user design preferences and personalize search results. They build preference profiles through feedback sessions and apply preference reranking across all search tools (layout/motion/background/narrative/responsive search).

> **プライバシー / Privacy**: 嗜好プロファイリングはGDPR準拠で設計されています。新規プロファイル作成時にはArt.13/14に基づく通知が返却されます。詳細は [PRIVACY.md](../../apps/mcp-server/PRIVACY.md) および [DATA_RETENTION.md](../../apps/mcp-server/DATA_RETENTION.md) を参照してください。
>
> Preference profiling is designed with GDPR compliance. A notification based on Art.13/14 is returned when a new profile is created. See [PRIVACY.md](../../apps/mcp-server/PRIVACY.md) and [DATA_RETENTION.md](../../apps/mcp-server/DATA_RETENTION.md) for details.

### 13.1 preference.hear - 嗜好ヒアリング / Preference Hearing

**用途 / Purpose**: ユーザーのデザイン嗜好をインタラクティブにヒアリング / Interactively learn user design preferences

**動作モード / Operation Modes**:

| モード / Mode                | トリガー / Trigger | 動作 / Behavior                                                                                                                      |
| ---------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Mode A（サンプル提示）       | フィードバックなし | DBからサンプルデザインを提示し、2因子confidence進捗をトラッキング / Present sample designs from DB with 2-factor confidence tracking |
| Mode B（フィードバック記録） | フィードバックあり | フィードバックを記録し、嗜好プロファイルを更新 / Record feedback and update preference profile                                       |

**基本的な使い方 / Basic Usage**

```typescript
// ステップ1: ヒアリング開始（サンプル取得） / Step 1: Start hearing (get samples)
const result = await preference.hear({});
// → Mode A: サンプルデザインと新規profile_idが返却
// → 初回はprofiling_noticeも含まれる（GDPR Art.13/14）

// ステップ2: フィードバック送信 / Step 2: Send feedback
const result2 = await preference.hear({
  profile_id: result.data.profile_id,
  feedback: {
    sample_id: result.data.samples[0].id,
    rating: "positive",
    comment: "このグラデーション背景が好き",
  },
  exclude_ids: [result.data.samples[0].id],
});

// ステップ3: confidence閾値（0.8）に達するまで繰り返し（最大15回）
// Step 3: Repeat until confidence threshold (0.8) reached (max 15 hearings)
```

**confidenceモデル / Confidence Model**

| 因子 / Factor           | 重み / Weight | 説明 / Description                                                                                  |
| ----------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| MoodCategory Coverage   | 0.6           | 多様なデザインカテゴリへのフィードバック網羅率 / Feedback coverage across diverse design categories |
| Interaction Sufficiency | 0.4           | フィードバック回数の十分性 / Sufficiency of feedback count                                          |
| 閾値 / Threshold        | 0.8           | プロファイル完成判定 / Profile completion threshold                                                 |

---

### 13.2 preference.get - プロファイル取得 / Get Profile

**用途 / Purpose**: 嗜好プロファイルの詳細取得・データエクスポート / Retrieve profile details and export data

**基本的な使い方 / Basic Usage**

```typescript
// プロファイル概要取得 / Get profile summary
const profile = await preference.get({
  profile_id: "<uuid>",
});

// 全シグナルデータ含むエクスポート（GDPR Art. 20 データポータビリティ）
// Export with all signal data (GDPR Art. 20 Data Portability)
const exportData = await preference.get({
  profile_id: "<uuid>",
  include_signals: true,
});
```

---

### 13.3 preference.reset - プロファイルリセット / Reset Profile

**用途 / Purpose**: 嗜好プロファイルのリセットまたは完全削除 / Reset or permanently delete preference profile

**基本的な使い方 / Basic Usage**

```typescript
// ソフトリセット（嗜好データクリア、プロファイル枠は維持）
// Soft reset (clear preference data, keep profile shell)
await preference.reset({
  profile_id: "<uuid>",
  confirm: true,
});

// 完全削除（GDPR Art. 17 忘れられる権利）
// Hard delete (GDPR Art. 17 Right to Erasure)
await preference.reset({
  profile_id: "<uuid>",
  confirm: true,
  hard_delete: true,
});
```

**ベストプラクティス / Best Practices**

- ヒアリングは5-10回のフィードバックで十分なconfidenceに到達可能 / 5-10 feedback rounds typically reach sufficient confidence
- `exclude_ids` で既に表示したサンプルを除外し、重複を防止 / Use `exclude_ids` to exclude already-shown samples and prevent duplicates
- プロファイル完成後は全検索ツール（layout/motion/background/narrative/responsive search）で自動的にリランキングが適用 / After profile completion, reranking is automatically applied across all search tools
- ユーザーのデータ権利（アクセス・エクスポート・削除）はすべてMCPツール経由で行使可能 / All user data rights (access, export, deletion) can be exercised via MCP tools

---

## 14. Part（パーツ）ツール / Part Tools

Part-Level Analysis（v0.1.5）で追加されたUIパーツ検索・詳細取得・比較ツールです。`page.analyze` で分析されたWebページのパーツ（ボタン、ナビゲーション、カード等）を16タイプに分類し、セマンティック検索や比較が可能です。

Part tools added in Part-Level Analysis (v0.1.5) for UI part search, inspection, and comparison. Parts (buttons, navigation, cards, etc.) from web pages analyzed via `page.analyze` are classified into 16 types, enabling semantic search and comparison.

### 14.1 part.search — パーツ検索 / Part Search

UIパーツをセマンティック検索します。visual/text/hybridの3つの検索モードに対応しています。

Semantic search for UI parts. Supports 3 search modes: visual, text, and hybrid.

```typescript
// テキスト検索 / Text search
const results = await mcp__reftrix__part_search({
  query: "CTAボタン グラデーション背景",
  search_mode: "text",
  limit: 10,
});

// パーツタイプフィルター付き / With part type filter
const buttons = await mcp__reftrix__part_search({
  query: "primary action button",
  part_type: "button",
  search_mode: "hybrid",
  limit: 5,
});
```

### 14.2 part.inspect — パーツ詳細取得 / Part Inspection

パーツIDを指定して、スタイル・バウンディングボックス・インタラクション情報等の詳細を取得します。

Retrieve detailed information for a part by ID, including computed styles, bounding box, and interaction info.

```typescript
const detail = await mcp__reftrix__part_inspect({
  part_id: "part-uuid-here",
  include_html: true,
  include_embedding: false,
});
```

### 14.3 part.compare — パーツ比較 / Part Comparison

2-5個のパーツをスタイル・レイアウト・インタラクション・アクセシビリティの観点で並列比較します。

Compare 2-5 parts side by side on styles, layout, interaction, and accessibility aspects.

```typescript
const comparison = await mcp__reftrix__part_compare({
  part_ids: ["part-uuid-1", "part-uuid-2", "part-uuid-3"],
});
```

---

## 15. Search（横断検索）ツール / Search (Unified Search) Tools

横断検索ツールは、layout/part/motion/background/narrativeの5つの検索サービスを並列で実行し、類似度マージで統合結果を返却します。

The unified search tool executes 5 search services (layout, part, motion, background, narrative) in parallel and returns merged results by similarity.

### 15.1 search.unified -- 横断検索 / Unified Search

```typescript
// 横断検索: 全サービスを一度に検索
// Unified search: search all services at once
const results = await mcp__reftrix__search_unified({
  query: "modern hero section with parallax animation",
  limit: 10,
});

// 結果には各サービスのマッチが類似度順で統合されます
// Results include matches from each service merged by similarity
```

---

### 15.2 search.facets -- ファセット検索 / Facet Search

**用途 / Purpose**: 検索結果をsectionType・industry・audience・tagsで分類し、各値の件数を返却。UIでの絞り込みフィルター構築に活用 / Classify search results by sectionType, industry, audience, and tags with counts. Useful for building filter UIs

**基本的な使い方 / Basic Usage**

```typescript
// 全ファセットフィールドのカウントを取得
// Get counts for all facet fields
const result = await search.facets({
  query: "modern hero section",
});

// レスポンス / Response:
// - facets: {
//     sectionType: [{ value: 'hero', count: 15 }, { value: 'feature', count: 8 }],
//     industry: [{ value: 'technology', count: 12 }],
//     audience: [...],
//     tags: [...]
//   }
// - total_results: 42
```

**特定フィールドのみ取得 / Get Specific Fields Only**

```typescript
const result = await search.facets({
  query: "gradient background",
  facet_fields: ["sectionType", "industry"], // 特定のフィールドのみ
  limit: 20,
  industry: "technology", // 業種フィルター
});
```

**主要パラメータ / Key Parameters**

| パラメータ / Parameter | 型 / Type | デフォルト / Default | 説明 / Description                                                          |
| ---------------------- | --------- | -------------------- | --------------------------------------------------------------------------- |
| `query`                | string    | （必須 / required）  | 検索クエリ（1-500文字） / Search query (1-500 chars)                        |
| `facet_fields`         | string[]  | all                  | ファセットフィールド (sectionType, industry, audience, tags) / Facet fields |
| `limit`                | number    | 50                   | 取得件数（1-50） / Result limit                                             |
| `webPageId`            | string    | -                    | WebページIDでフィルター / Filter by web page UUID                           |
| `industry`             | string    | -                    | 業種フィルター（max 100文字） / Industry filter                             |
| `audience`             | string    | -                    | ターゲットオーディエンスフィルター（max 100文字） / Target audience filter  |
| `tags`                 | string[]  | -                    | タグフィルター（max 10） / Tag filter                                       |

---

## 16. Design（デザイン）ツール / Design Tools

デザインツールは、画像類似検索・類似サイト検索・デザイン比較・デザイン変更追跡の4つの機能を提供します。

Design tools provide 4 capabilities: image similarity search, similar site search, design comparison, and design change tracking.

### 16.1 design.search_by_image -- 画像類似検索 / Image Similarity Search

**用途 / Purpose**: Base64画像またはURLからDINOv2 visual embeddingを生成し、HNSW + RRF 3ソースで類似デザインを検索 / Generate DINOv2 visual embeddings from Base64 images or URLs and search for similar designs via HNSW + RRF 3-source fusion

```typescript
// URL指定で類似デザイン検索
// Search similar designs by URL
const results = await design.search_by_image({
  image: "https://example.com/screenshot.png",
  limit: 10,
});

// Base64画像で類似デザイン検索
// Search similar designs by Base64 image
const results = await design.search_by_image({
  image: "data:image/png;base64,...",
  limit: 5,
});
```

---

### 16.2 design.similar_site -- 類似サイト検索 / Similar Site Search

**用途 / Purpose**: URLを入力として、DB内の類似デザインのWebサイトを検索。ページレベルのembedding mean pooling + HNSW検索 / Search for visually similar websites in the database using page-level embedding mean pooling + HNSW search

**基本的な使い方 / Basic Usage**

```typescript
// 類似サイト検索（URLはDB内に存在する必要があります）
// Similar site search (URL must exist in the database)
const result = await design.similar_site({
  url: "https://example.com",
  limit: 5,
});

// レスポンス / Response:
// - similar_sites: [{
//     url: 'https://similar-site.com',
//     title: 'Similar Site',
//     similarity_score: 0.87
//   }]
// - total: 5
```

**詳細情報付き / With Details**

```typescript
const result = await design.similar_site({
  url: "https://example.com",
  limit: 10,
  include_details: true, // 共通パターンと差分を含める
});

// - similar_sites: [{
//     url: '...',
//     similarity_score: 0.87,
//     common_patterns: ['hero section', 'grid layout'],
//     differences: ['color scheme', 'typography']
//   }]
```

**主要パラメータ / Key Parameters**

| パラメータ / Parameter | 型 / Type | デフォルト / Default | 説明 / Description                                                     |
| ---------------------- | --------- | -------------------- | ---------------------------------------------------------------------- |
| `url`                  | string    | （必須 / required）  | 検索対象URL（DB内に存在する必要あり） / Target URL (must exist in DB)  |
| `limit`                | number    | 5                    | 取得件数（1-20） / Result limit                                        |
| `include_details`      | boolean   | false                | 共通パターン・差分を含めるか / Include common patterns and differences |

---

### 16.3 design.compare -- デザイン比較 / Design Comparison

**用途 / Purpose**: 2-5件のWebページをレイアウト・視覚・品質・カラーの4軸で比較し、ペアワイズ類似度スコア（0-1）を算出 / Compare 2-5 web pages across 4 dimensions (layout, visual, quality, color) and calculate pairwise similarity scores (0-1)

**基本的な使い方 / Basic Usage**

```typescript
const result = await design.compare({
  page_ids: ["page-uuid-1", "page-uuid-2", "page-uuid-3"],
});

// レスポンス / Response:
// - pages: [{ id: '...', url: '...', title: '...' }]
// - comparisons: [{
//     pair: ['page-uuid-1', 'page-uuid-2'],
//     scores: { layout: 0.85, visual: 0.72, quality: 0.90, color: 0.65 },
//     overall: 0.78
//   }]
```

**比較次元のカスタマイズ / Customize Comparison Dimensions**

```typescript
const result = await design.compare({
  page_ids: ["page-uuid-1", "page-uuid-2"],
  dimensions: ["layout", "color"], // レイアウトとカラーのみ比較
  include_details: true, // 共通パターンと差分ポイントを含める
});
```

**主要パラメータ / Key Parameters**

| パラメータ / Parameter | 型 / Type | デフォルト / Default           | 説明 / Description                                                                 |
| ---------------------- | --------- | ------------------------------ | ---------------------------------------------------------------------------------- |
| `page_ids`             | string[]  | （必須 / required）            | 比較対象ページID（2-5件、UUID） / Page IDs to compare (2-5, UUID format)           |
| `dimensions`           | string[]  | layout, visual, quality, color | 比較次元 / Comparison dimensions                                                   |
| `include_details`      | boolean   | false                          | 共通パターン・差分ポイントを含めるか / Include common patterns and key differences |

---

### 16.4 design.track_changes -- デザイン変更追跡 / Design Change Tracking

**用途 / Purpose**: 同一URLのデザイン変更を時系列で追跡。スナップショット保存、差分比較、履歴管理、自動変更検出 / Track design changes for the same URL over time. Supports snapshot saving, diff comparison, history management, and automatic change detection

**スナップショット保存 / Save Snapshot**

```typescript
// 現在のデザイン状態をスナップショットとして保存
// Save current design state as a snapshot
const result = await design.track_changes({
  url: "https://example.com",
  action: "snapshot",
});

// レスポンス / Response:
// - snapshot: { id: 'snapshot-uuid', createdAt: '2026-04-01T...' }
```

**スナップショット間の比較 / Compare Snapshots**

```typescript
const result = await design.track_changes({
  url: "https://example.com",
  action: "compare",
  snapshot_ids: ["snapshot-uuid-1", "snapshot-uuid-2"],
});

// レスポンス / Response:
// - comparison: { similarity_score: 0.75, changes: [...] }
```

**変更履歴の取得 / Get Change History**

```typescript
const result = await design.track_changes({
  url: "https://example.com",
  action: "history",
  limit: 20,
});
```

**自動変更検出 / Automatic Change Detection**

```typescript
const result = await design.track_changes({
  url: "https://example.com",
  action: "detect", // 最新のスナップショットと現在の状態を自動比較
});
```

**主要パラメータ / Key Parameters**

| パラメータ / Parameter | 型 / Type | デフォルト / Default | 説明 / Description                                                                                         |
| ---------------------- | --------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `url`                  | string    | （必須 / required）  | 対象URL / Target URL                                                                                       |
| `action`               | string    | （必須 / required）  | アクション: snapshot, compare, history, detect / Action type                                               |
| `snapshot_ids`         | string[]  | -                    | compare時の比較対象スナップショットID（2件） / Snapshot IDs for comparison (2 required for compare action) |
| `limit`                | number    | 10                   | history時の取得件数（1-50） / Result limit for history action                                              |
| `auto_snapshot`        | boolean   | false                | page.analyze完了後に自動スナップショット生成するか / Auto-generate snapshot after page.analyze             |

**ベストプラクティス / Best Practices**

- 定期的に `action: "snapshot"` でデザイン状態を記録 / Regularly record design state with `action: "snapshot"`
- `page.analyze` の `auto_snapshot: true` オプションで自動記録も可能 / Use `auto_snapshot: true` in `page.analyze` for automatic recording
- `action: "detect"` で前回からの変更を自動検出 / Use `action: "detect"` to automatically detect changes since last snapshot

---

## 17. Accessibility（アクセシビリティ）ツール / Accessibility Tools

アクセシビリティツールは、WCAG 2.1準拠のアクセシビリティ監査を実行し、スコア・違反・コントラスト問題を報告します。

Accessibility tools perform WCAG 2.1-compliant accessibility audits, reporting scores, violations, and contrast issues.

### 17.1 accessibility.audit -- WCAG監査 / WCAG Audit

**用途 / Purpose**: axe-coreを使用してWCAG 2.1アクセシビリティ監査を実行し、OKLCHコントラスト比チェックも併せて実施 / Run WCAG 2.1 accessibility audit using axe-core with OKLCH contrast ratio checking

**基本的な使い方 / Basic Usage**

```typescript
// URLを指定して監査 / Audit by URL
const result = await accessibility.audit({
  url: "https://example.com",
});

// レスポンス / Response:
// - score: 85 (0-100)
// - level: 'AA'
// - violations: [{ id: 'color-contrast', impact: 'serious', ... }]
// - summary: { critical: 0, serious: 2, moderate: 1, minor: 3 }
```

**HTMLコンテンツを直接監査 / Audit HTML Content Directly**

```typescript
const result = await accessibility.audit({
  html: myHtmlContent,
  level: "AAA", // WCAG AAA基準で監査
  include_passes: true, // パスしたルールも含める
});
```

**主要パラメータ / Key Parameters**

| パラメータ / Parameter | 型 / Type | デフォルト / Default | 説明 / Description                                                               |
| ---------------------- | --------- | -------------------- | -------------------------------------------------------------------------------- |
| `url`                  | string    | -                    | 監査対象URL（htmlと排他） / URL to audit (mutually exclusive with html)          |
| `html`                 | string    | -                    | 監査対象HTMLコンテンツ（urlと排他） / HTML content (mutually exclusive with url) |
| `level`                | string    | AA                   | WCAG適合レベル: A, AA, AAA / WCAG conformance level                              |
| `include_contrast`     | boolean   | true                 | OKLCHコントラスト比チェックを含めるか / Include OKLCH contrast ratio check       |
| `include_passes`       | boolean   | false                | パスしたルールを結果に含めるか / Include passed rules in results                 |

> **注意 / Note**: `page.analyze` の `accessibilityOptions: { enabled: true }` でも同等の監査を統合パイプラインの一部として実行できます。スタンドアロンで詳細な監査が必要な場合はこのツールを使用してください。
>
> You can also run equivalent audits as part of the integrated pipeline via `page.analyze` with `accessibilityOptions: { enabled: true }`. Use this standalone tool when you need detailed audits.

---

## 18. Performance（パフォーマンス）ツール / Performance Tools

パフォーマンスツールは、Core Web Vitals（LCP, FID, CLS, INP, TTFB）を測定し、パフォーマンススコアと改善提案を提供します。

Performance tools measure Core Web Vitals (LCP, FID, CLS, INP, TTFB) and provide performance scores with improvement recommendations.

### 18.1 performance.evaluate -- パフォーマンス評価 / Performance Evaluation

**用途 / Purpose**: Playwright PerformanceObserver APIを使用してCore Web Vitalsを測定し、Google推奨基準に基づいてスコア・グレードを算出 / Measure Core Web Vitals using Playwright PerformanceObserver API and calculate scores/grades based on Google's recommended thresholds

**基本的な使い方 / Basic Usage**

```typescript
const result = await performance.evaluate({
  url: "https://example.com",
});

// レスポンス / Response:
// - score: 82 (0-100)
// - grade: 'B'
// - metrics: {
//     lcp: { value: 2100, rating: 'good' },
//     fid: { value: 50, rating: 'good' },
//     cls: { value: 0.05, rating: 'good' },
//     inp: { value: 180, rating: 'needs-improvement' },
//     ttfb: { value: 600, rating: 'good' }
//   }
```

**詳細情報と改善提案 / Details and Recommendations**

```typescript
const result = await performance.evaluate({
  url: "https://example.com",
  include_details: true,
  budget: {
    lcp_ms: 2000, // カスタムLCPバジェット（デフォルト: 2500ms）
    cls: 0.05, // カスタムCLSバジェット（デフォルト: 0.1）
  },
});

// - budgetComparisons: [{ metric: 'lcp', budget: 2000, actual: 2100, passed: false }]
// - recommendations: ['Optimize largest contentful paint...']
```

**主要パラメータ / Key Parameters**

| パラメータ / Parameter | 型 / Type | デフォルト / Default | 説明 / Description                                                              |
| ---------------------- | --------- | -------------------- | ------------------------------------------------------------------------------- |
| `url`                  | string    | （必須 / required）  | 評価対象URL / Target URL                                                        |
| `include_details`      | boolean   | false                | Budget比較・改善提案を含めるか / Include budget comparisons and recommendations |
| `budget.lcp_ms`        | number    | 2500                 | LCPバジェット (ms) / LCP budget                                                 |
| `budget.cls`           | number    | 0.1                  | CLSバジェット / CLS budget                                                      |
| `budget.fid_ms`        | number    | 100                  | FIDバジェット (ms) / FID budget                                                 |
| `budget.ttfb_ms`       | number    | 800                  | TTFBバジェット (ms) / TTFB budget                                               |
| `budget.inp_ms`        | number    | 200                  | INPバジェット (ms) / INP budget                                                 |

> **注意 / Note**: `page.analyze` の `performanceOptions: { enabled: true }` でも同等の評価を統合パイプラインの一部として実行できます。
>
> You can also run equivalent evaluations as part of the integrated pipeline via `page.analyze` with `performanceOptions: { enabled: true }`.

---

## 19. Embedding（品質モニタリング）ツール / Embedding (Quality Monitoring) Tools

Embeddingツールは、DINOv2/e5-baseのEmbedding品質をモニタリングし、カバレッジ・異常検出・ドリフト検出を実行します。

Embedding tools monitor DINOv2/e5-base embedding quality, performing coverage analysis, anomaly detection, and drift detection.

### 19.1 embedding.quality -- Embedding品質モニタリング / Embedding Quality Monitoring

**用途 / Purpose**: セクション・パーツのEmbedding品質を監視し、カバレッジ不足や異常ベクトルを検出 / Monitor embedding quality for sections and parts, detecting coverage gaps and anomalous vectors

**基本的な使い方 / Basic Usage**

```typescript
const result = await embedding.quality({});

// レスポンス / Response:
// - coverage: { sections: { total: 150, withEmbedding: 142, rate: 0.947 }, parts: { ... } }
// - anomalies: [{ id: '...', type: 'zero_vector', ... }]
```

**特定ページに限定 / Scope to Specific Page**

```typescript
const result = await embedding.quality({
  scope: "sections", // sections のみ監視
  web_page_id: "page-uuid",
  include_distribution: true, // 分布統計を含める
});

// - distribution: { mean: 0.42, std: 0.15, min: 0.01, max: 0.98, l2_norm: { ... } }
```

**主要パラメータ / Key Parameters**

| パラメータ / Parameter | 型 / Type | デフォルト / Default | 説明 / Description                                                                   |
| ---------------------- | --------- | -------------------- | ------------------------------------------------------------------------------------ |
| `scope`                | string    | all                  | 監視スコープ: all, sections, parts / Monitoring scope                                |
| `web_page_id`          | string    | -                    | 特定ページに限定（UUID） / Scope to specific page (UUID)                             |
| `include_distribution` | boolean   | false                | 分布統計を含めるか（mean, std, min, max, L2 norm） / Include distribution statistics |

---

## 20. Data（データ管理）ツール / Data (Management) Tools

データ管理ツールは、GDPR（一般データ保護規則）に準拠したデータ削除・エクスポート機能を提供します。

Data management tools provide GDPR-compliant data deletion and export capabilities.

> **プライバシーポリシー / Privacy Policy**: データ処理の詳細については [PRIVACY_POLICY.md](../legal/PRIVACY_POLICY.md) を参照してください。
>
> For details on data processing, see [PRIVACY_POLICY.md](../legal/PRIVACY_POLICY.md).

### 20.1 data.delete -- データ削除 / Data Deletion

**用途 / Purpose**: GDPR Art.17（忘れられる権利）に基づくデータ削除。ページ単位・プロファイル単位・ユーザー全データの削除に対応 / GDPR Art.17 (Right to Erasure) compliant data deletion. Supports page-level, profile-level, and all-user-data deletion

**基本的な使い方 / Basic Usage**

```typescript
// ページデータの削除 / Delete page data
await data.delete({
  target: "page",
  id: "page-uuid",
  reason: "User requested data deletion",
  confirm: true, // 削除確認フラグ（必須: true）
});

// 嗜好プロファイルの削除 / Delete preference profile
await data.delete({
  target: "profile",
  id: "profile-uuid",
  reason: "Profile no longer needed",
  confirm: true,
});

// ユーザーの全データ削除 / Delete all user data
await data.delete({
  target: "all_user_data",
  id: "profile-uuid",
  reason: "Complete data erasure request",
  confirm: true,
  page_ids: ["page-uuid-1", "page-uuid-2"], // 関連ページも削除
});
```

**主要パラメータ / Key Parameters**

| パラメータ / Parameter | 型 / Type | デフォルト / Default | 説明 / Description                                                                               |
| ---------------------- | --------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| `target`               | string    | （必須 / required）  | 削除対象: page, profile, all_user_data / Deletion target                                         |
| `id`                   | string    | （必須 / required）  | 対象ID（UUID形式） / Target ID (UUID format)                                                     |
| `reason`               | string    | （必須 / required）  | 削除理由（GDPR監査要件、1-500文字） / Deletion reason (GDPR audit requirement)                   |
| `confirm`              | boolean   | （必須 / required）  | 削除確認フラグ（`true`必須） / Deletion confirmation (must be `true`)                            |
| `page_ids`             | string[]  | -                    | ページID配列（target=all_user_data時、最大100件） / Page IDs (for all_user_data target, max 100) |

---

### 20.2 data.export -- データエクスポート / Data Export

**用途 / Purpose**: GDPR Art.20（データポータビリティ）に基づくデータエクスポート。ページデータまたは嗜好プロファイルをJSON形式でエクスポート / GDPR Art.20 (Data Portability) compliant data export. Export page data or preference profiles in JSON format

**基本的な使い方 / Basic Usage**

```typescript
// ページデータのエクスポート / Export page data
const result = await data.export({
  target: "page",
  id: "page-uuid",
});

// 嗜好プロファイルのエクスポート / Export preference profile
const result = await data.export({
  target: "profile",
  id: "profile-uuid",
});
```

**主要パラメータ / Key Parameters**

| パラメータ / Parameter | 型 / Type | デフォルト / Default | 説明 / Description                              |
| ---------------------- | --------- | -------------------- | ----------------------------------------------- |
| `target`               | string    | （必須 / required）  | エクスポート対象: page, profile / Export target |
| `id`                   | string    | （必須 / required）  | 対象ID（UUID形式） / Target ID (UUID format)    |

---

## 21. Audit（監査）ツール / Audit Tools

監査ツールは、GDPR Art.30（処理活動の記録）に基づく監査ログの検索・閲覧機能を提供します。

Audit tools provide audit log search and viewing based on GDPR Art.30 (Records of Processing Activities).

> **プライバシーポリシー / Privacy Policy**: 監査ログの保持期間等については [PRIVACY_POLICY.md](../legal/PRIVACY_POLICY.md) を参照してください。
>
> For audit log retention periods and policies, see [PRIVACY_POLICY.md](../legal/PRIVACY_POLICY.md).

### 21.1 audit.query -- 監査ログ検索 / Audit Log Query

**用途 / Purpose**: 監査ログを検索し、データ処理活動の記録を閲覧。アクション・ターゲットタイプ・日時範囲でフィルタリング可能 / Search audit logs to view records of data processing activities. Filter by action, target type, and date range

**基本的な使い方 / Basic Usage**

```typescript
// 最近の監査ログを取得 / Get recent audit logs
const result = await audit.query({});

// レスポンス / Response:
// - logs: [{
//     id: '...',
//     timestamp: '2026-04-01T...',
//     action: 'data.delete',
//     target_type: 'web_page',
//     target_id: 'page-uuid',
//     details: { reason: '...' },
//     result: 'success'
//   }]
// - count: 15
```

**フィルタリング / Filtering**

```typescript
// 特定アクションの監査ログを検索 / Search logs for specific action
const result = await audit.query({
  action: "data.delete",
  target_type: "web_page",
  start_date: "2026-03-01T00:00:00Z",
  end_date: "2026-04-01T00:00:00Z",
  limit: 50,
});
```

**主要パラメータ / Key Parameters**

| パラメータ / Parameter | 型 / Type | デフォルト / Default | 説明 / Description                                                                |
| ---------------------- | --------- | -------------------- | --------------------------------------------------------------------------------- |
| `action`               | string    | -                    | アクションフィルタ（例: data.delete, page.analyze） / Action filter               |
| `target_type`          | string    | -                    | ターゲットタイプフィルタ（例: web_page, preference_profile） / Target type filter |
| `start_date`           | string    | -                    | 開始日時（ISO 8601形式） / Start date (ISO 8601)                                  |
| `end_date`             | string    | -                    | 終了日時（ISO 8601形式） / End date (ISO 8601)                                    |
| `limit`                | number    | 20                   | 結果上限（最大100） / Result limit (max 100)                                      |

---

## 22. 実践ワークフロー / Practical Workflows

### ワークフロー1: アワードサイトを参考にデザインを作成 / Workflow 1: Create Design Based on Award Sites

```typescript
// ステップ1: アワードサイトを収集
await layout.ingest({
  url: "https://awwwards.com/sites/example",
  options: {
    save_to_db: true,
    auto_analyze: true,
  },
});

// ステップ2: 類似レイアウトを検索
const layouts = await layout.search({
  query: "modern hero section with animation",
  limit: 10,
  include_html: false,
});

// ステップ3: モーションパターンを検索
const motions = await motion.search({
  query: "smooth scroll animation",
  limit: 5,
});

// ステップ4: コード生成
const code = await layout.generate_code({
  patternId: layouts.results[0].id,
  options: {
    framework: "react",
    typescript: true,
    tailwind: true,
  },
});

// ステップ5: 品質評価
const quality = await quality.evaluate({
  html: code.code,
  action: "evaluate",
});
```

---

### ワークフロー2: 既存デザインの品質改善 / Workflow 2: Improve Existing Design Quality

```typescript
// ステップ1: 現在のデザインを評価（推奨事項付き）
const evaluation = await quality.evaluate({
  html: currentHtml,
  strict: true,
  includeRecommendations: true,
});

// ステップ2: 推奨事項に基づいて手動で改善
// evaluation.recommendations には具体的な改善提案が含まれる
// - 参照パターンID
// - ソースURL
// - パターンインサイト

// ステップ3: 改善後に再評価
const reEvaluation = await quality.evaluate({
  html: improvedHtml,
  includeRecommendations: true,
});
```

---

### ワークフロー3: ブランドパレットを適用したデザイン生成 / Workflow 3: Generate Design with Brand Palette

```typescript
// ステップ1: ブランドパレットを取得
const palette = await style.get_palette({
  brand_name: "Reftrix",
  mode: "light",
});

// ステップ2: レイアウトパターンを検索
const layouts = await layout.search({
  query: "landing page hero",
  limit: 5,
});

// ステップ3: パレット適用してコード生成
const code = await layout.generate_code({
  patternId: layouts.results[0].id,
  options: {
    framework: "react",
    typescript: true,
    tailwind: true,
    paletteId: palette.id,
  },
});
```

---

## 23. パフォーマンス最適化 / Performance Optimization

### summary=true の活用 / Leveraging summary=true

**トークン削減率**:

```typescript
layout.search({ summary: true }); // 詳細なHTMLスニペットを省略
motion.detect({ includeSummary: true }); // サマリー情報を含める（デフォルトtrue）
quality.evaluate({ summary: true }); // 詳細な改善提案を省略
```

**推奨される使い方**:

1. 初回は `summary: true` で概要確認
2. 詳細が必要な場合のみ `summary: false`
3. 一覧系は常に `summary: true`

---

### limit を適切に設定

```typescript
// ✅ 推奨
layout.search({ query: "...", limit: 10 });
motion.search({ query: "...", limit: 10 });

// ❌ 非推奨（レスポンスサイズ大）
layout.search({ query: "...", limit: 100 });
```

---

### 並列処理を活用

```typescript
// ✅ 推奨: 並列実行
const [layoutResult, motionResult, qualityResult] = await Promise.all([
  layout.search({ query: "hero section" }),
  motion.search({ query: "fade in" }),
  quality.evaluate({ html: myHtml }),
]);

// ❌ 非推奨: 逐次実行
const layoutResult = await layout.search({ query: "hero section" });
const motionResult = await motion.search({ query: "fade in" });
const qualityResult = await quality.evaluate({ html: myHtml });
```

---

### レスポンスサイズの削減

```typescript
// ✅ 推奨: 不要なデータを除外
await layout.ingest({
  url: "https://example.com",
  options: {
    include_html: false, // HTML不要
    include_screenshot: false, // スクリーンショット不要
  },
});

// ✅ 推奨: 検索時もHTMLを除外
await layout.search({
  query: "hero section",
  include_html: false, // デフォルトでfalse（明示的に指定推奨）
});
```

---

## 24. トラブルシューティング / Troubleshooting

### よくある問題と解決策 / Common Issues and Solutions

#### 1. layout.searchで結果が0件

**原因**: `layout.ingest` で `save_to_db: false` または `auto_analyze: false` を明示的に指定している、あるいはまだページを収集していない

**解決策**:

```typescript
// ✅ 正しい方法（デフォルトでsave_to_db: true, auto_analyze: true）
await layout.ingest({
  url: "https://example.com",
  // save_to_db: true（デフォルト）
  // auto_analyze: true（デフォルト）
});
```

---

#### 2. motion.searchで結果が0件

**原因**: `motion.detect` で `save_to_db: true` を指定していない

**解決策**:

```typescript
// ✅ 正しい方法
await motion.detect({
  html: myHtml,
  save_to_db: true, // ★必須
});
```

---

#### 3. page.analyzeがタイムアウト

**原因**: デフォルトタイムアウト（600秒/10分）を超えている

**解決策**:

```typescript
// タイムアウトを延長（デフォルト: 600000ms = 10分）
await page.analyze({
  url: "https://heavy-page.com",
  timeout: 900000, // 15分
});

// または summary: true で軽量化
await page.analyze({
  url: "https://heavy-page.com",
  summary: true,
});
```

---

#### 4. レスポンスサイズが大きすぎる

**原因**: `include_html: true`, `include_screenshot: true` を明示的に指定している

**解決策**:

```typescript
// ✅ 軽量化（デフォルトでinclude_html/include_screenshotはfalse）
await layout.ingest({
  url: "https://example.com",
  // include_html: false（デフォルト）
  // include_screenshot: false（デフォルト）
});

// summary: true を使用
await layout.search({
  query: "hero section",
  include_html: false, // デフォルトでfalse
});
```

---

#### 5. video modeでメモリ不足

**原因**: 大量のフレームキャプチャ

**解決策**:

```typescript
// CI環境では無効化
await motion.detect({
  html: myHtml,
  enable_frame_capture: false,
});

// ローカルでは解像度を下げる
await page.analyze({
  url: "https://example.com",
  motionOptions: {
    enable_frame_capture: true,
    frame_capture_options: {
      scroll_px_per_frame: 30, // 15→30で半分のフレーム数
    },
  },
});
```

---

## まとめ / Summary

このガイドでは、Reftrixの<!-- gen:tool-count -->39<!-- /gen:tool-count --> WebDesign MCPツールを活用してWebページの解析・品質評価・コード生成・嗜好プロファイリング・アクセシビリティ監査・パフォーマンス評価・デザイン変更追跡を行う方法を解説しました。

This guide explained how to use Reftrix's <!-- gen:tool-count -->39<!-- /gen:tool-count --> WebDesign MCP tools for web page analysis, quality evaluation, code generation, preference profiling, accessibility auditing, performance evaluation, and design change tracking.

### 次のステップ / Next Steps

1. **実際に試す / Try it out**: `page.analyze` で好きなサイトを解析してみる / Analyze your favorite site with `page.analyze`
2. **品質改善 / Improve quality**: 自分のデザインを `quality.evaluate` で評価 / Evaluate your design with `quality.evaluate`
3. **コード生成 / Generate code**: `layout.generate_code` でReactコンポーネントを生成 / Generate React components with `layout.generate_code`

### 関連ドキュメント / Related Documentation

- このリポジトリの `apps/mcp-server/src/tools/` - 各ツールの実装コード・Zodスキーマ定義 / Implementation code and Zod schema definitions for each tool

---

**Last Updated**: 2026-03-25
**Version**: 0.3.0

---

## 関連ガイド / Related Guides

- [はじめに / Getting Started](./01-getting-started.md)
- [MCPツール使用ガイド / MCP Tools Guide](./02-mcp-tools-guide.md)
- [page.analyze詳細ガイド / page.analyze Deep Dive](./03-page-analyze-deep-dive.md)
- [トラブルシューティング / Troubleshooting](./04-troubleshooting.md)
