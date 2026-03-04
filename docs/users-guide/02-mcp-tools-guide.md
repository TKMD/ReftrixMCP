# Reftrix MCPツール完全ガイド / Reftrix MCP Tools Complete Guide

**Last Updated**: 2026-03-05
**Version**: 0.1.2
**対象読者 / Target Audience**: Reftrixプラットフォームのエンドユーザー、デザイナー、開発者 / End users, designers, and developers of the Reftrix platform

---

## はじめに / Introduction

Reftrixは **WebDesign専用プラットフォーム** です。このガイドでは、**20のWebDesign専用MCPツール**を活用して、Webページの解析・品質評価・コード生成を行う方法を解説します。

Reftrix is a **WebDesign-specialized platform**. This guide explains how to use **20 WebDesign-focused MCP tools** to analyze web pages, evaluate design quality, and generate code.

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
8. [Project（プロジェクト）ツール](#8-projectプロジェクトツール)
9. [Page（ページ）ツール](#9-pageページツール)
10. [System（システム）ツール](#10-systemシステムツール)
11. [Narrative（ナラティブ）ツール](#11-narrativeナラティブツール)
12. [Background（背景）ツール](#12-background背景ツール)
13. [Responsive（レスポンシブ）ツール](#13-responsiveレスポンシブツール)
14. [実践ワークフロー](#14-実践ワークフロー)
15. [パフォーマンス最適化](#15-パフォーマンス最適化)
16. [トラブルシューティング](#16-トラブルシューティング)

---

## 1. クイックスタート / Quick Start

### 最初の一歩: Webページを解析する / First Step: Analyze a Web Page

```typescript
// URLを指定するだけで、レイアウト・モーション・品質を一括解析
const result = await page.analyze({
  url: 'https://example.com',
  summary: true,  // 軽量レスポンス（推奨）
  features: {
    layout: true,
    motion: true,
    quality: true
  }
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
     url: 'https://awwwards.com/sites/example',
     summary: true
   });
   ```

3. **品質評価 / Quality Evaluation**（自分のデザインを評価 / Evaluate your own design）
   ```typescript
   await quality.evaluate({
     html: myHtml,
     action: 'evaluate'
   });
   ```

---

## 2. ツールカテゴリ概要 / Tool Category Overview

### WebDesign MCPツール（20ツール） / WebDesign MCP Tools (20 Tools)

| カテゴリ / Category | ツール数 / Count | 主な用途 / Primary Purpose |
|---------|---------|---------|
| **System** | 1 | ヘルスチェック / Health check |
| **Project** | 2 | プロジェクト管理 / Project management |
| **Style** | 1 | ブランドパレット取得 / Brand palette retrieval |
| **Brief** | 1 | デザインブリーフ検証 / Design brief verification |
| **Layout** | 5 | Webページ構造の収集・解析・検索・コード生成・バッチ処理 / Web page structure collection, analysis, search, code generation, batch processing |
| **Motion** | 2 | CSSアニメーション検出・セマンティック検索 / CSS animation detection and semantic search |
| **Quality** | 3 | デザイン品質評価・バッチ評価・ジョブステータス確認 / Design quality evaluation, batch evaluation, job status check |
| **Page** | 2 | 統合ページ解析・非同期ジョブステータス / Unified page analysis and async job status |
| **Narrative** | 1 | 世界観・レイアウト構成セマンティック検索 / Worldview and layout semantic search |
| **Background** | 1 | バックグラウンドデザインパターン検索 / Background design pattern search |
| **Responsive** | 1 | レスポンシブ分析結果のセマンティック検索 / Responsive analysis semantic search |

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
│  └─ layout.generate_code（React/Vue/HTML）
│
├─ デザインを改善したい
│  └─ 品質評価 → quality.evaluate
│
└─ プロジェクト管理
   ├─ ブランドパレット → style.get_palette
   └─ ブリーフ検証 → brief.validate
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
  url: 'https://example.com'
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
  url: 'https://example.com'
  // save_to_db: true（デフォルト）→ WebPageテーブルへ保存
  // auto_analyze: true（デフォルト）→ セクション解析＋Embedding生成
});

// この後、layout.searchで検索可能になります
```

**主要パラメータ**

| パラメータ | 型 | デフォルト | 説明 |
|-----------|---|-----------|------|
| `url` | string | （必須） | 収集対象URL |
| `options.save_to_db` | boolean | true | DB保存（検索には必須） |
| `options.auto_analyze` | boolean | true | セクション解析＋Embedding生成（検索には必須） |
| `options.full_page` | boolean | true | フルページスクリーンショット |
| `options.include_html` | boolean | false | HTMLを含める |
| `options.include_screenshot` | boolean | false | スクリーンショットを含める |
| `options.timeout` | number | 30000 | タイムアウト（ms） |

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
    detectSections: true,       // セクション検出
    detectGrid: true,           // グリッド検出
    analyzeTypography: true,    // タイポグラフィ解析
    extractColors: true         // 色抽出
  }
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
  id: 'webPageId',  // layout.ingestのidを指定
  options: {
    detectSections: true
  }
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
  query: 'modern hero section with video background',
  limit: 10,
  include_html: false  // HTMLスニペットを含めない（推奨）
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
  query: 'pricing section',
  filters: {
    sectionType: 'pricing',           // セクションタイプ
    sourceType: 'award_gallery',      // アワードサイトのみ
    usageScope: 'inspiration_only'    // インスピレーション用途
  },
  limit: 20,
  offset: 0,
  include_html: true  // HTMLスニペットを含める（必要時のみ）
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
  patternId: 'section-pattern-id',  // layout.searchで取得したID
  options: {
    framework: 'react',     // react | vue | html
    typescript: true,       // TypeScript出力
    tailwind: true          // Tailwind CSS使用
  }
});

// レスポンス:
// - code: "export const HeroSection: React.FC = () => { ... }"
// - framework: 'react'
// - language: 'typescript'
```

**ブランドパレットを適用**

```typescript
const code = await layout.generate_code({
  patternId: 'section-pattern-id',
  options: {
    framework: 'react',
    typescript: true,
    tailwind: true,
    paletteId: 'brand-palette-id'  // style.get_paletteで取得
  }
});

// 生成されたコードにブランドカラーが反映されます
```

**カスタムコンポーネント名**

```typescript
const code = await layout.generate_code({
  patternId: 'section-pattern-id',
  options: {
    framework: 'react',
    componentName: 'LandingHero'  // PascalCase形式
  }
});
```

---

### 3.5 layout.batch_ingest - バッチWebページ取得 / Batch Web Page Collection

**用途 / Purpose**: 複数URLからWebページを一括取得（最大100件）/ Batch collect web pages from multiple URLs (up to 100)

**基本的な使い方**

```typescript
const result = await layout.batch_ingest({
  urls: [
    'https://awwwards.com/sites/site1',
    'https://awwwards.com/sites/site2',
    'https://awwwards.com/sites/site3'
  ],
  options: {
    save_to_db: true,      // デフォルト: true
    auto_analyze: true,    // デフォルト: true
    concurrency: 5         // 並列数（デフォルト: 5）
  }
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
    on_error: 'skip'       // skip（デフォルト）| abort
  }
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
  includeWarnings: true,  // パフォーマンス・アクセシビリティ警告
  includeSummary: true    // サマリー情報
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
  save_to_db: true  // ★必須: MotionPattern + Embedding自動生成
});

// この後、motion.searchで検索可能になります
```

---

#### detection_mode（検出モード）

`detection_mode` パラメータでアニメーション検出方式を指定できます。

`detection_mode` parameter specifies the animation detection method.

| モード / Mode | 説明 / Description |
|---|---|
| `css` | CSS静的解析のみ / CSS static analysis only |
| `runtime` | ブラウザでの実行時検出 / Runtime detection in browser |
| `hybrid` | CSS解析 + 実行時検出の組み合わせ / CSS analysis + runtime detection |
| `video` | フレームキャプチャによる検出（**デフォルト**） / Frame capture detection (**default**) |
| `library_only` | JSライブラリ検出のみ（GSAP, Three.js, Framer Motion等） / JS library detection only (e.g., GSAP, Three.js, Framer Motion) |

```typescript
const result = await motion.detect({
  html: myHtml,
  detection_mode: 'hybrid'  // CSS + ランタイム両方で検出
});
```

---

#### video mode（フレームキャプチャ）

Reftrixの**デフォルト設定では video mode が有効**です。スクロール時のアニメーションを15px/frameでキャプチャします。

**デフォルト設定**

| パラメータ | デフォルト値 | 説明 |
|-----------|-------------|------|
| `enable_frame_capture` | **true** | デフォルトで有効 |
| `analyze_frames` | **true** | フレーム画像分析デフォルト有効 |
| `scroll_px_per_frame` | **15px** | 基準値（アニメーション検出に最適化）※サービス層で適用 |
| `frame_rate` | 30 fps | フレームレート ※サービス層で適用 |
| `frame_interval_ms` | 33ms | フレーム間隔（1000/30） |
| `scroll_speed_px_per_sec` | 450 px/sec | スクロール速度（15 × 30） |
| `output_format` | png | PNG推奨（ロスレス） |
| `output_dir` | /tmp/reftrix-frames/ | 出力ディレクトリ |

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
  enable_frame_capture: false
});

// CLS問題特定（Core Web Vitals改善）
const result = await motion.detect({
  html: myHtml,
  enable_frame_capture: true,
  analyze_frames: true,
  frame_analysis_options: {
    diff_threshold: 0.1,          // ピクセル差分しきい値
    cls_threshold: 0.05,          // Core Web Vitals閾値
    motion_threshold: 50,         // モーション検出しきい値
    parallel: true                // Worker Thread並列処理
  }
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
    diff_threshold: 0.1,           // ピクセル差分しきい値
    cls_threshold: 0.1,            // Core Web Vitals 'good' 閾値
    motion_threshold: 50,          // モーション検出しきい値
    parallel: true                 // Worker Thread並列処理（色変化検出含む）
  }
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

| カテゴリ | 説明 |
|---------|------|
| `scroll_trigger` | IntersectionObserver、スクロール連動 |
| `hover_effect` | ホバーエフェクト |
| `page_transition` | ページ遷移 |
| `loading_state` | ローディング・スピナー |
| `entrance` | フェードイン・スライドイン |
| `exit` | フェードアウト・スライドアウト |
| `micro_interaction` | 短いインタラクション |

**警告タイプ**

| コード | 重大度 | 説明 |
|--------|--------|------|
| `PERF_LAYOUT_TRIGGER` | warning | レイアウト再計算プロパティ使用 |
| `PERF_TOO_MANY_ANIMATIONS` | warning | 20個以上のアニメーション |
| `A11Y_NO_REDUCED_MOTION` | warning | prefers-reduced-motion未対応 |
| `A11Y_INFINITE_ANIMATION` | info | 無限ループアニメーション |

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
  query: 'smooth fade in animation on scroll',
  limit: 10,
  minSimilarity: 0.7  // 類似度閾値（0-1）
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
    type: 'transition',
    duration: 300,
    easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
    properties: ['opacity', 'transform']
  },
  limit: 10
});
```

**フィルター機能**

```typescript
const results = await motion.search({
  query: 'scroll animation',
  filters: {
    type: 'animation',          // animation | transition | transform | scroll | hover | keyframe
    trigger: 'scroll',          // scroll | hover | click | load | focus | custom
    minDuration: 200,
    maxDuration: 1000
  }
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
  action: 'evaluate'  // evaluate（デフォルト）| 'suggest_improvements'
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
  action: 'suggest_improvements',  // 改善提案生成
  categories: ['originality', 'accessibility'],
  minPriority: 'high',
  maxSuggestions: 10
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
    originality: 0.35,     // デフォルト: 0.35
    craftsmanship: 0.4,    // デフォルト: 0.4
    contextuality: 0.25    // デフォルト: 0.25
  },
  strict: true  // 厳格モード（AI cliche検出を強化）
});
```

**業界・ターゲット層を指定**

```typescript
const result = await quality.evaluate({
  html: myHtml,
  targetIndustry: 'healthcare',
  targetAudience: 'medical professionals'
});

// contextualityスコアに反映されます
```

**3つの評価軸**

| 軸 | 説明 | 主な評価基準 |
|----|------|-------------|
| **Originality** | 独創性 | AI cliche回避、ユニークな表現 |
| **Craftsmanship** | 職人性 | タイポグラフィ、グリッド、余白の精度 |
| **Contextuality** | 文脈適合性 | 業界・ターゲット層との適合 |

**ベストプラクティス**

- 定期的に評価を実行してデザインの質を維持
- `strict: true` でAI生成特有のクリシェ表現を検出
- 改善提案の`suggested_code`を参考に修正

---

### 5.2 quality.batch_evaluate - 一括評価 / Batch Evaluation

**用途 / Purpose**: 複数ページのデザイン品質を一括評価 / Batch evaluate design quality of multiple pages

```typescript
const result = await quality.batch_evaluate({
  items: [
    { page_id: 'page-1' },
    { html: '<html>...</html>' },
    { page_id: 'page-2' }
  ],
  strict: true,
  batch_size: 10,
  on_error: 'skip'  // skip | abort
});

// レスポンス:
// - results: [{ overall: 78, grade: 'B' }, ...]
// - stats: { avg_score: 75, pass_rate: 0.8 }
```

---

### 5.3 quality.getJobStatus - バッチ評価ジョブステータス確認 / Batch Evaluation Job Status Check

**用途 / Purpose**: `quality.batch_evaluate` で実行したバッチ評価ジョブのステータスを確認 / Check the status of batch evaluation jobs executed with `quality.batch_evaluate`

**パラメータ / Parameters**

| パラメータ / Parameter | 型 / Type | 必須 / Required | 説明 / Description |
|-----------|---|------|------|
| `job_id` | string | 必須 / Required | `quality.batch_evaluate` で返されたジョブID / Job ID returned by `quality.batch_evaluate` |

**基本的な使い方 / Basic Usage**

```typescript
// バッチ評価を実行 / Execute batch evaluation
const job = await quality.batch_evaluate({
  items: [
    { page_id: 'page-1' },
    { page_id: 'page-2' },
    { page_id: 'page-3' }
  ],
  strict: true
});

// ジョブステータスを確認 / Check job status
const status = await quality.getJobStatus({
  job_id: job.job_id
});

// レスポンス / Response:
// - status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed' | 'unknown'
// - progress: 0-100（進捗率 / progress percentage）
// - result: { results: [...], stats: { avg_score, pass_rate } }（完了時 / when completed）
// - failedReason: 'エラー詳細'（失敗時 / when failed）
```

**ポーリングによる完了待機 / Polling for Completion**

```typescript
async function waitForBatchEvaluation(jobId: string, maxWait = 120000): Promise<unknown> {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    const status = await quality.getJobStatus({ job_id: jobId });
    if (status.status === 'completed') return status.result;
    if (status.status === 'failed') throw new Error('Batch evaluation failed');
    await new Promise(r => setTimeout(r, 2000)); // 2秒間隔 / 2-second interval
  }
  throw new Error('Timeout waiting for batch evaluation');
}
```

**注意事項 / Notes**

- ジョブIDは `quality.batch_evaluate` のレスポンスに含まれます / Job ID is included in the `quality.batch_evaluate` response
- ジョブは24時間後に自動削除されます / Jobs are automatically deleted after 24 hours
- 非同期処理にはRedis（BullMQ）が必要です / Redis (BullMQ) is required for async processing

---

## 6. Style（スタイル）ツール / Style Tools

スタイルツールは、ブランドカラーパレットの取得と適用を提供します。

Style tools provide brand color palette retrieval and application.

### 6.1 style.get_palette - パレット取得 / Palette Retrieval

**用途 / Purpose**: ブランドパレットの取得 / Retrieve brand palettes

**ID指定で詳細取得**

```typescript
const result = await style.get_palette({
  id: 'palette-id',
  include_gradients: true
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
  brand_name: 'Reftrix',
  mode: 'light'  // light | dark | both
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
    projectName: 'New Landing Page',
    description: 'A modern landing page for SaaS product...',
    targetAudience: 'B2B software developers',
    industry: 'technology',
    tone: ['professional', 'minimal'],
    colorPreferences: {
      primary: '#3B82F6',
      secondary: '#10B981'
    },
    references: [
      { url: 'https://example.com', note: 'Love the hero section' }
    ]
  }
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

| フィールド | Weight | 達成条件 |
|-----------|--------|----------|
| projectName | 10 | 3文字以上 |
| description | 20 | 50文字以上 |
| targetAudience | 15 | 20文字以上 |
| industry | 10 | 非空 |
| tone | 15 | 非空配列 |
| colorPreferences | 15 | primary色あり |
| references | 10 | 非空配列 |
| constraints | 5 | mustHave/mustAvoidあり |

---

## 8. Project（プロジェクト）ツール / Project Tools

### 8.1 project.get - プロジェクト取得 / Project Retrieval

**用途 / Purpose**: プロジェクト詳細の取得 / Retrieve project details

```typescript
const result = await project.get({
  id: 'project-id',
  summary: true  // 軽量モード（id, name, statusのみ）
});

// レスポンス（summary: false時）:
// - id, name, slug, description, status
// - createdAt, updatedAt
// - brandSetting: { id, brandId, paletteId }
//
// レスポンス（summary: true時）:
// - id, name, status
```

---

### 8.2 project.list - プロジェクト一覧 / Project List

**用途 / Purpose**: プロジェクト一覧の取得 / Retrieve project list

```typescript
const result = await project.list({
  status: 'in_progress',  // draft | in_progress | review | completed | archived
  limit: 20,
  offset: 0,
  summary: true
});

// レスポンス:
// - projects: [{ id, name, status }]
// - total: 45
```

---

## 9. Page（ページ）ツール / Page Tools

### 9.1 page.analyze - 統合ページ解析 / Unified Page Analysis

**用途 / Purpose**: URLを指定してlayout/motion/qualityの3分析を並列実行 / Specify a URL and run layout/motion/quality analyses in parallel

**基本的な使い方**

```typescript
const result = await page.analyze({
  url: 'https://example.com',
  summary: true,  // デフォルト: false。軽量レスポンスには明示的にtrueを指定（推奨）
  features: {
    layout: true,
    motion: true,
    quality: true
  }
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
  url: 'https://example.com',
  summary: false,  // 詳細レスポンス
  timeout: 600000,  // 10分（デフォルト）
  features: {
    layout: true,
    motion: true,
    quality: true
  }
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
  url: 'https://example.com',
  summary: true,
  features: {
    motion: true
  },
  motionOptions: {
    enable_frame_capture: true,  // 明示的に有効化
    analyze_frames: true         // フレーム画像分析（CLS検出）
  }
});
```

**パラメータ: `layoutOptions.useVision`（v0.1.0+）**

| パラメータ / Parameter | 型 / Type | デフォルト / Default | 説明 / Description |
|-----------|---|------|------|
| `layoutOptions.useVision` | boolean | `true` | Ollama Vision（llama3.2-vision）を使用したリッチなレイアウト解析を有効化。`false` の場合はHTML静的解析のみ。 / Enable rich layout analysis using Ollama Vision (llama3.2-vision). When `false`, only HTML static analysis is performed. |

```typescript
const result = await page.analyze({
  url: 'https://example.com',
  layoutOptions: {
    useVision: true   // デフォルト: true（Ollama Vision使用）
  }
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

### 9.2 page.getJobStatus - 非同期ジョブステータス確認 / Async Job Status Check

**用途 / Purpose**: `page.analyze` の非同期モード（`async: true`）で実行したジョブのステータスを確認 / Check the status of jobs executed in async mode (`async: true`) of `page.analyze`

**基本的な使い方**

```typescript
// 非同期モードでpage.analyzeを実行
const job = await page.analyze({
  url: 'https://example.com',
  async: true  // 非同期モード
});

// ジョブステータスを確認
const status = await page.getJobStatus({
  job_id: job.job_id  // UUID形式
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
    if (status.status === 'completed') return status.result;
    if (status.status === 'failed') throw new Error(status.failedReason);
    await new Promise(r => setTimeout(r, 2000)); // 2秒間隔
  }
  throw new Error('Timeout waiting for job completion');
}
```

**注意事項**

- 非同期モードを使用するにはRedis（BullMQ）が必要
- ジョブは24時間後に自動削除されます

---

## 10. System（システム）ツール / System Tools

### 10.1 system.health - ヘルスチェック / Health Check

**用途 / Purpose**: システムの健全性チェック / System health check

**基本的な使い方**

```typescript
const result = await system.health({
  detailed: true
});

// レスポンス:
// - status: 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY'
// - database: { status: 'HEALTHY', latency_ms: 5 }
// - mcp_tools: { total_tools: 20, available: 20 }
// - system_resources: { cpu_usage: 0.25, memory_usage: 0.45 }
```

**特定コンポーネントのみチェック**

```typescript
const result = await system.health({
  component: 'database'  // database | system_resources | mcp_tools
});
```

**ベストプラクティス**

- セッション開始時に必ず `detailed: true` で実行
- 定期的にヘルスチェックを実行（30分ごと推奨）

---

## 11. Narrative（ナラティブ）ツール / Narrative Tools

ナラティブツールは、Webデザインの世界観（WorldView）とレイアウト構成（LayoutStructure）をセマンティック検索します。ムードカテゴリ・色彩印象・グリッドシステム・視覚的階層などの観点で類似デザインを発見できます。

Narrative tools provide semantic search for web design worldview (WorldView) and layout structure (LayoutStructure). You can discover similar designs based on mood category, color impression, grid system, and visual hierarchy.

### 11.1 narrative.search - 世界観・構成セマンティック検索 / Worldview and Layout Semantic Search

**用途 / Purpose**: 自然言語クエリまたは768次元Embeddingで、世界観・レイアウト構成が類似するデザインを検索 / Search for designs with similar worldview and layout structure using natural language queries or 768-dimension embeddings

**実装詳細 / Implementation Details**: `NarrativeSearchService` はPrisma + pgvector（HNSW cosine similarity）による本実装です。以下の4つの検索メソッドを提供します。

`NarrativeSearchService` is a full implementation using Prisma + pgvector (HNSW cosine similarity). It provides the following 4 search methods:

| メソッド / Method | 説明 / Description |
|---|---|
| `search()` | ベクトル検索（768次元embedding） / Vector search (768-dim embedding) |
| `searchHybrid()` | RRF（60% vector + 40% full-text）によるハイブリッド検索 / Hybrid search via RRF (60% vector + 40% full-text) |
| `searchByVector()` | embedding直接指定によるベクトル検索 / Vector search with direct embedding input |
| `searchByMoodCategory()` | MoodCategoryフィルター検索 / Filter search by MoodCategory |

**基本的な使い方（ハイブリッド検索）/ Basic Usage (Hybrid Search)**

```typescript
const results = await narrative.search({
  query: 'サイバーセキュリティ感のあるダークなデザイン',
  options: {
    limit: 10,
    searchMode: 'hybrid'  // vector | hybrid（デフォルト）
  }
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
  query: 'minimalist tech landing page',
  options: {
    searchMode: 'vector',  // pgvector cosine similarity のみ
    limit: 10,
    minSimilarity: 0.7
  }
});
```

**embedding直接指定 / Direct Embedding Input**

```typescript
// 事前に生成済みの768次元embeddingで検索
const results = await narrative.search({
  embedding: precomputedVector,  // number[768]
  options: {
    limit: 10
  }
});
```

**MoodCategoryフィルター検索 / MoodCategory Filter Search**

```typescript
const results = await narrative.search({
  query: 'clean corporate design',
  filters: {
    moodCategory: 'professional',                // 単一のムードカテゴリを指定
    minConfidence: 0.7
  },
  options: {
    limit: 20
  }
});
```

**フィルター機能（全オプション）/ Filter Options (All)**

```typescript
const results = await narrative.search({
  query: 'elegant minimal design',
  filters: {
    moodCategory: 'elegant',      // 単一のムードカテゴリを指定
    minConfidence: 0.7             // 最小信頼度（0-1）
  },
  options: {
    limit: 20,
    minSimilarity: 0.7,           // 最小類似度（デフォルト: 0.6）
    searchMode: 'hybrid',
    vectorWeight: 0.6,            // Vector検索の重み（デフォルト: 0.6）
    fulltextWeight: 0.4           // Full-text検索の重み（デフォルト: 0.4）
  }
});
```

**主要パラメータ**

| パラメータ | 型 | デフォルト | 説明 |
|-----------|---|-----------|------|
| `query` | string | （query/embeddingいずれか必須） | 自然言語検索クエリ（1-500文字） |
| `embedding` | number[] | （query/embeddingいずれか必須） | 768次元Embedding直接指定 |
| `filters.moodCategory` | string | - | ムードカテゴリフィルター（単一指定） |
| `filters.minConfidence` | number | - | 最小信頼度（0-1） |
| `options.limit` | number | 10 | 結果数（1-50） |
| `options.minSimilarity` | number | 0.6 | 最小類似度（0-1） |
| `options.searchMode` | string | hybrid | 検索モード（vector / hybrid） |
| `options.vectorWeight` | number | 0.6 | Vector検索の重み（RRF結合時） |
| `options.fulltextWeight` | number | 0.4 | Full-text検索の重み（RRF結合時） |

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

| カテゴリ | 説明 |
|---------|------|
| `professional` | ビジネス、企業 |
| `playful` | 遊び心、カジュアル |
| `premium` | 高級、ラグジュアリー |
| `tech` | テクノロジー、先進的 |
| `organic` | 自然、オーガニック |
| `minimal` | ミニマル、シンプル |
| `bold` | 大胆、インパクト |
| `elegant` | 上品、洗練 |
| `friendly` | 親しみやすい |
| `artistic` | アート、クリエイティブ |
| `trustworthy` | 信頼、安心 |
| `energetic` | エネルギッシュ、活発 |

**ベストプラクティス**

- 検索前に `page.analyze` で対象ページを解析・保存しておく
- 日本語・英語のクエリに対応（multilingual-e5-baseモデル使用）
- `hybrid` モードがデフォルトで推奨（Vector + Full-text のRRF統合）
- `limit` は 10〜20 を推奨
- `moodCategory` フィルターは単一カテゴリを指定（12種類のenumから選択）
- 事前計算済みembeddingがある場合は `embedding` パラメータで直接指定すると高速

---

## 12. Background（背景）ツール / Background Tools

背景ツールは、BackgroundDesign（グラデーション、グラスモーフィズム、パターン背景等）をセマンティック検索します。

Background tools provide semantic search for BackgroundDesign patterns (gradients, glassmorphism, pattern backgrounds, etc.).

### 12.1 background.search - 背景デザインパターン検索 / Background Design Pattern Search

**用途 / Purpose**: 自然言語クエリで背景デザインパターンをベクトル検索 / Vector search for background design patterns using natural language queries

**基本的な使い方**

```typescript
const results = await background.search({
  query: 'dark gradient with purple tones',
  limit: 10
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
  query: 'glassmorphism effect',
  limit: 20,
  offset: 0,
  filters: {
    designType: 'glassmorphism',  // デザインタイプでフィルター
    webPageId: 'page-uuid'        // 特定ページの背景のみ
  }
});
```

**主要パラメータ**

| パラメータ | 型 | デフォルト | 説明 |
|-----------|---|-----------|------|
| `query` | string | （必須） | 検索クエリ（1-500文字） |
| `limit` | number | 10 | 取得件数（1-50） |
| `offset` | number | 0 | オフセット（ページネーション用） |
| `filters.designType` | string | - | デザインタイプでフィルター |
| `filters.webPageId` | string | - | WebページIDでフィルター |

**サポートされるデザインタイプ（14種類）**

| タイプ | 説明 |
|-------|------|
| `solid_color` | 単色背景 |
| `linear_gradient` | 線形グラデーション |
| `radial_gradient` | 放射状グラデーション |
| `conic_gradient` | 円錐グラデーション |
| `mesh_gradient` | メッシュグラデーション |
| `image_background` | 画像背景 |
| `pattern_background` | パターン背景 |
| `video_background` | 動画背景 |
| `animated_gradient` | アニメーショングラデーション |
| `glassmorphism` | グラスモーフィズム |
| `noise_texture` | ノイズテクスチャ |
| `svg_background` | SVG背景 |
| `multi_layer` | 多層背景 |
| `unknown` | 未分類 |

**ベストプラクティス**

- 検索前に `page.analyze` または `layout.ingest` でページを収集・解析しておく
- `designType` フィルターで特定の背景タイプに絞り込み可能
- `offset` を使ったページネーションで大量の結果を段階的に取得
- 日本語・英語のクエリに対応（multilingual-e5-baseモデル使用）

---

## 13. Responsive（レスポンシブ）ツール / Responsive Tools

レスポンシブツールは、レスポンシブ分析結果（ビューポート差異、ブレークポイント、スクリーンショット差分）をセマンティック検索します。pgvector HNSW cosine similarity + JSONBフィルタを使用します。

Responsive tools provide semantic search over responsive analysis results (viewport differences, breakpoints, screenshot diffs). Uses pgvector HNSW cosine similarity + JSONB filters.

### 13.1 responsive.search - レスポンシブ分析検索 / Responsive Analysis Search

**用途 / Purpose**: 自然言語クエリでレスポンシブ分析結果をベクトル検索 / Vector search for responsive analysis results using natural language queries

**基本的な使い方 / Basic Usage**

```typescript
const results = await responsive.search({
  query: 'navigation layout changes between mobile and desktop',
  limit: 10
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
  query: 'typography size differences',
  filters: {
    diffCategory: 'typography',           // 差異カテゴリ / Diff category
    viewportPair: 'desktop-mobile',       // ビューポートペア / Viewport pair
    breakpointRange: { min: 768, max: 1440 }, // ブレークポイント範囲(px) / Breakpoint range
    minDiffPercentage: 5,                 // 最小差分率(%) / Min diff percentage
    webPageId: 'page-uuid'                // WebページIDでフィルタ / Filter by web page
  },
  limit: 20,
  offset: 0
});
```

**主要パラメータ / Key Parameters**

| パラメータ / Parameter | 型 / Type | デフォルト / Default | 説明 / Description |
|-----------|---|-----------|------|
| `query` | string | （必須 / required） | 検索クエリ（1-500文字） / Search query (1-500 chars) |
| `limit` | number | 10 | 取得件数（1-50） / Result limit |
| `offset` | number | 0 | オフセット / Pagination offset |
| `filters.diffCategory` | string | - | 差異カテゴリ / Diff category: layout, typography, spacing, visibility, navigation, image, interaction, animation |
| `filters.viewportPair` | string | - | ビューポートペア / Viewport pair: desktop-tablet, desktop-mobile, tablet-mobile |
| `filters.breakpointRange` | object | - | ブレークポイント範囲 `{min, max}` (px) / Breakpoint range |
| `filters.minDiffPercentage` | number | - | 最小スクリーンショット差分率(0-100) / Min screenshot diff percentage |
| `filters.webPageId` | string | - | WebページIDでフィルタ / Filter by web page UUID |

**データライフサイクル / Data Lifecycle**: 同一URLの再分析時は clean-slate（`deleteMany` → `create`）で旧データを上書きします。 / On re-analysis of the same URL, old data is overwritten via clean-slate (`deleteMany` → `create`).

**ベストプラクティス / Best Practices**

- 検索前に `page.analyze` でページを収集・解析しておく（レスポンシブ分析はpage.analyzeで自動実行） / Collect and analyze pages with `page.analyze` first (responsive analysis runs automatically)
- `diffCategory` フィルターで特定の差異タイプに絞り込み可能 / Use `diffCategory` filter to narrow down specific difference types
- 日本語・英語のクエリに対応（multilingual-e5-baseモデル使用） / Supports Japanese and English queries (multilingual-e5-base model)

---

## 14. 実践ワークフロー / Practical Workflows

### ワークフロー1: アワードサイトを参考にデザインを作成 / Workflow 1: Create Design Based on Award Sites

```typescript
// ステップ1: アワードサイトを収集
await layout.ingest({
  url: 'https://awwwards.com/sites/example',
  options: {
    save_to_db: true,
    auto_analyze: true
  }
});

// ステップ2: 類似レイアウトを検索
const layouts = await layout.search({
  query: 'modern hero section with animation',
  limit: 10,
  include_html: false
});

// ステップ3: モーションパターンを検索
const motions = await motion.search({
  query: 'smooth scroll animation',
  limit: 5
});

// ステップ4: コード生成
const code = await layout.generate_code({
  patternId: layouts.results[0].id,
  options: {
    framework: 'react',
    typescript: true,
    tailwind: true
  }
});

// ステップ5: 品質評価
const quality = await quality.evaluate({
  html: code.code,
  action: 'evaluate'
});
```

---

### ワークフロー2: 既存デザインの品質改善 / Workflow 2: Improve Existing Design Quality

```typescript
// ステップ1: 現在のデザインを評価（推奨事項付き）
const evaluation = await quality.evaluate({
  html: currentHtml,
  strict: true,
  includeRecommendations: true
});

// ステップ2: 推奨事項に基づいて手動で改善
// evaluation.recommendations には具体的な改善提案が含まれる
// - 参照パターンID
// - ソースURL
// - パターンインサイト

// ステップ3: 改善後に再評価
const reEvaluation = await quality.evaluate({
  html: improvedHtml,
  includeRecommendations: true
});
```

---

### ワークフロー3: ブランドパレットを適用したデザイン生成 / Workflow 3: Generate Design with Brand Palette

```typescript
// ステップ1: ブランドパレットを取得
const palette = await style.get_palette({
  brand_name: 'Reftrix',
  mode: 'light'
});

// ステップ2: レイアウトパターンを検索
const layouts = await layout.search({
  query: 'landing page hero',
  limit: 5
});

// ステップ3: パレット適用してコード生成
const code = await layout.generate_code({
  patternId: layouts.results[0].id,
  options: {
    framework: 'react',
    typescript: true,
    tailwind: true,
    paletteId: palette.id
  }
});
```

---

## 15. パフォーマンス最適化 / Performance Optimization

### summary=true の活用 / Leveraging summary=true

**トークン削減率**:
```typescript
layout.search({ summary: true });   // 詳細なHTMLスニペットを省略
motion.detect({ includeSummary: true });   // サマリー情報を含める（デフォルトtrue）
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
layout.search({ query: '...', limit: 10 });
motion.search({ query: '...', limit: 10 });

// ❌ 非推奨（レスポンスサイズ大）
layout.search({ query: '...', limit: 100 });
```

---

### 並列処理を活用

```typescript
// ✅ 推奨: 並列実行
const [layoutResult, motionResult, qualityResult] = await Promise.all([
  layout.search({ query: 'hero section' }),
  motion.search({ query: 'fade in' }),
  quality.evaluate({ html: myHtml })
]);

// ❌ 非推奨: 逐次実行
const layoutResult = await layout.search({ query: 'hero section' });
const motionResult = await motion.search({ query: 'fade in' });
const qualityResult = await quality.evaluate({ html: myHtml });
```

---

### レスポンスサイズの削減

```typescript
// ✅ 推奨: 不要なデータを除外
await layout.ingest({
  url: 'https://example.com',
  options: {
    include_html: false,       // HTML不要
    include_screenshot: false  // スクリーンショット不要
  }
});

// ✅ 推奨: 検索時もHTMLを除外
await layout.search({
  query: 'hero section',
  include_html: false  // デフォルトでfalse（明示的に指定推奨）
});
```

---

## 16. トラブルシューティング / Troubleshooting

### よくある問題と解決策 / Common Issues and Solutions

#### 1. layout.searchで結果が0件

**原因**: `layout.ingest` で `save_to_db: false` または `auto_analyze: false` を明示的に指定している、あるいはまだページを収集していない

**解決策**:
```typescript
// ✅ 正しい方法（デフォルトでsave_to_db: true, auto_analyze: true）
await layout.ingest({
  url: 'https://example.com'
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
  save_to_db: true  // ★必須
});
```

---

#### 3. page.analyzeがタイムアウト

**原因**: デフォルトタイムアウト（600秒/10分）を超えている

**解決策**:
```typescript
// タイムアウトを延長（デフォルト: 600000ms = 10分）
await page.analyze({
  url: 'https://heavy-page.com',
  timeout: 900000  // 15分
});

// または summary: true で軽量化
await page.analyze({
  url: 'https://heavy-page.com',
  summary: true
});
```

---

#### 4. レスポンスサイズが大きすぎる

**原因**: `include_html: true`, `include_screenshot: true` を明示的に指定している

**解決策**:
```typescript
// ✅ 軽量化（デフォルトでinclude_html/include_screenshotはfalse）
await layout.ingest({
  url: 'https://example.com'
  // include_html: false（デフォルト）
  // include_screenshot: false（デフォルト）
});

// summary: true を使用
await layout.search({
  query: 'hero section',
  include_html: false  // デフォルトでfalse
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
  enable_frame_capture: false
});

// ローカルでは解像度を下げる
await page.analyze({
  url: 'https://example.com',
  motionOptions: {
    enable_frame_capture: true,
    frame_capture_options: {
      scroll_px_per_frame: 30  // 15→30で半分のフレーム数
    }
  }
});
```

---

## まとめ / Summary

このガイドでは、Reftrixの20 WebDesign MCPツールを活用してWebページの解析・品質評価・コード生成を行う方法を解説しました。

This guide explained how to use Reftrix's 20 WebDesign MCP tools for web page analysis, quality evaluation, and code generation.

### 次のステップ / Next Steps

1. **実際に試す / Try it out**: `page.analyze` で好きなサイトを解析してみる / Analyze your favorite site with `page.analyze`
2. **品質改善 / Improve quality**: 自分のデザインを `quality.evaluate` で評価 / Evaluate your design with `quality.evaluate`
3. **コード生成 / Generate code**: `layout.generate_code` でReactコンポーネントを生成 / Generate React components with `layout.generate_code`

### 関連ドキュメント / Related Documentation

- このリポジトリの `apps/mcp-server/src/tools/` - 各ツールの実装コード・Zodスキーマ定義 / Implementation code and Zod schema definitions for each tool

---

**Last Updated**: 2026-03-05
**Version**: 0.1.2

---

## 関連ガイド / Related Guides

- [はじめに / Getting Started](./01-getting-started.md)
- [MCPツール使用ガイド / MCP Tools Guide](./02-mcp-tools-guide.md)
- [page.analyze詳細ガイド / page.analyze Deep Dive](./03-page-analyze-deep-dive.md)
- [トラブルシューティング / Troubleshooting](./04-troubleshooting.md)
