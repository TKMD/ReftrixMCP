# page.analyze 詳細ガイド / page.analyze Deep Dive - Web分析フローとデータ構造 / Web Analysis Flow and Data Structure

**Version**: 0.1.0 | **Last Updated**: 2026-03-01

このドキュメントでは、`page.analyze` MCPツールがWebページを分析する際の詳細なフロー、分析内容、およびデータベースに保存されるデータ構造を、実際の分析例（https://www.spaceandtime.io/）を用いて解説します。

This document explains the detailed flow, analysis content, and database data structures when the `page.analyze` MCP tool analyzes web pages, using an actual analysis example (https://www.spaceandtime.io/).

---

## 目次

1. [概要](#1-概要)
2. [分析フロー全体像](#2-分析フロー全体像)
3. [Phase 1: INGEST — ページ取得](#3-phase-1-ingest--ページ取得)
4. [Phase 2: LAYOUT — レイアウト分析](#4-phase-2-layout--レイアウト分析)
5. [Phase 3: SCROLL_VISION — スクロールキャプチャ](#5-phase-3-scroll_vision--スクロールキャプチャ)
6. [Phase 4: MOTION — モーション検出](#6-phase-4-motion--モーション検出)
7. [Phase 5: QUALITY — 品質評価](#7-phase-5-quality--品質評価)
8. [Phase 6: NARRATIVE — ナラティブ分析](#8-phase-6-narrative--ナラティブ分析)
9. [Phase 7: EMBEDDING — Embedding生成](#9-phase-7-embedding--embedding生成)
10. [データベース保存構造](#10-データベース保存構造)
11. [保存データの活用方法](#11-保存データの活用方法)
12. [実例: spaceandtime.io の分析結果](#12-実例-spaceandtimeio-の分析結果)

---

## 1. 概要 / Overview

`page.analyze` は、Reftrix MCPサーバーが提供する統合Web分析ツールです。単一のURL入力から、7つのフェーズを**順次実行**し、Webページの構造・モーション・品質を包括的に分析します：

`page.analyze` is the unified web analysis tool provided by the Reftrix MCP server. From a single URL input, it **sequentially executes** 7 phases to comprehensively analyze web page structure, motion, and quality:

| Phase | 名称 / Name | 進捗 / Progress | 主な出力 / Main Output |
|-------|------|------|---------|
| 1 | **INGEST** | 0-15% | ページ取得・HTML取得（web_pages） |
| 2 | **LAYOUT** | 15-35% | セクション構造解析（section_patterns） |
| 3 | **SCROLL_VISION** | 35-45% | スクロールキャプチャ（Phase 1.5: キャプチャのみ） |
| 4 | **MOTION** | 45-65% | CSS/JSアニメーション検出（motion_patterns） |
| 5 | **QUALITY** | 65-80% | デザイン品質スコアリング（quality_evaluations） |
| 6 | **NARRATIVE** | 80-90% | ナラティブ分析（Ollama Vision、Phase 2.5） |
| 7 | **EMBEDDING** | 90-100% | Embedding生成（multilingual-e5-base） |

> **Note**: ブラウザはMOTIONフェーズ完了後にクローズされます。SCROLL_VISION分析（Phase 2.5）はブラウザクローズ後にNARRATIVEフェーズ内で実行されます。

---

## 2. 分析フロー全体像 / Overall Analysis Flow

7つのフェーズが**順次実行**されます。各フェーズはBullMQジョブの進捗（0-100%）として追跡されます。

7 phases are **executed sequentially**. Each phase is tracked as BullMQ job progress (0-100%).

```
┌─────────────────────────────────────────────────────────────────┐
│                      page.analyze 開始                          │
│                   URL: https://example.com/                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 1: INGEST（0-15%）                                       │
│  ─────────────────────────────────────────────────────────────  │
│  Playwright Chromiumでページ取得、HTML取得・サニタイズ            │
│  スクリーンショット取得、外部CSS取得                              │
│  → web_pages テーブルに保存                                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 2: LAYOUT（15-35%）                                      │
│  ─────────────────────────────────────────────────────────────  │
│  セクション構造検出・分類（SectionDetector）                      │
│  CSS Framework検出、Vision分析（Ollama llama3.2-vision）         │
│  → section_patterns テーブルに保存                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 3: SCROLL_VISION（35-45%）— Phase 1.5: キャプチャのみ    │
│  ─────────────────────────────────────────────────────────────  │
│  スクロールしながらフレームキャプチャ（15px/frame）               │
│  ※ Vision分析はPhase 6（NARRATIVE）でブラウザクローズ後に実行     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 4: MOTION（45-65%）                                      │
│  ─────────────────────────────────────────────────────────────  │
│  CSS静的解析、JSアニメーション検出（CDP + Web Animations API）   │
│  ライブラリ検出（GSAP, Framer Motion, Three.js等）              │
│  → motion_patterns テーブルに保存                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                      ┌───────┴───────┐
                      │ Browser Close │
                      └───────┬───────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 5: QUALITY（65-80%）                                     │
│  ─────────────────────────────────────────────────────────────  │
│  デザイン品質スコアリング（Originality/Craftsmanship/Context）  │
│  AIクリシェ検出、パターン駆動評価                                │
│  → quality_evaluations（レスポンスに含む）                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 6: NARRATIVE（80-90%）— Phase 2.5: Vision分析実行        │
│  ─────────────────────────────────────────────────────────────  │
│  SCROLL_VISIONキャプチャのOllama Vision分析（ブラウザ不要）      │
│  ナラティブ構造分析                                              │
│  ※ ブラウザクローズ後のためVRAM競合なし                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Phase 7: EMBEDDING（90-100%）                                  │
│  ─────────────────────────────────────────────────────────────  │
│  multilingual-e5-base による768次元ベクトル生成                  │
│  Section/Motion/Background/JSAnimation Embedding                │
│  チャンク化処理（30件ごとにdispose+GC）                          │
│  → section_embeddings, motion_embeddings テーブルに保存          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    統合レスポンス返却                            │
│  - layout: セクション数、タイプ別内訳、CSS Framework            │
│  - motion: パターン数、カテゴリ別内訳、JSライブラリ検出         │
│  - quality: Overall Score、Grade、軸別スコア、推奨事項          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Phase 1: INGEST -- ページ取得 / Page Retrieval

### 3.1 処理内容 / Processing Details

1. **Playwright Chromium起動**
   - Headlessモードでブラウザを起動
   - Viewport: 1440x900（デフォルト）

2. **ページナビゲーション**
   - URLにアクセス
   - 待機戦略: `networkidle`（デフォルト）、`load`、`domcontentloaded`
   - タイムアウト: 60秒（デフォルト）

3. **HTML取得とサニタイズ**
   - `document.documentElement.outerHTML` でHTML取得
   - DOMPurifyで危険なスクリプト・イベントハンドラを除去
   - SSRF対策: プライベートIP、メタデータサービスをブロック

4. **スクリーンショット取得**
   - フルページスクリーンショット（PNG形式）
   - Base64エンコードして保存

5. **外部CSS取得**
   - `<link rel="stylesheet">` タグから外部CSSのURLを抽出
   - 並列フェッチ（最大5同時、各5秒タイムアウト）
   - 最大20ファイル、各5MBまで

### 3.2 web_pages テーブルへの保存

```sql
INSERT INTO web_pages (
  id,                    -- UUIDv7
  url,                   -- 正規化されたURL
  title,                 -- <title>タグの内容
  description,           -- meta descriptionの内容
  html,                  -- サニタイズ済みHTML
  screenshot,            -- Base64エンコードされたスクリーンショット
  source_type,           -- 'user_provided' | 'award_gallery'
  usage_scope,           -- 'inspiration_only' | 'owned_asset'
  created_at,
  updated_at
) VALUES (...);
```

---

## 4. Phase 2: LAYOUT -- レイアウト分析 / Layout Analysis

### 4.1 HTML解析（SectionDetector） / HTML Analysis (SectionDetector)

HTMLを解析し、以下のセレクタでセクションを検出：

```javascript
const SECTION_SELECTORS = [
  'section',
  '[class*="section"]',
  '[class*="hero"]',
  '[class*="feature"]',
  '[class*="cta"]',
  '[class*="testimonial"]',
  '[class*="pricing"]',
  '[class*="footer"]',
  '[class*="navigation"]',
  '[class*="gallery"]',
  '[class*="about"]',
  '[class*="contact"]',
  '[data-section]',
  '[data-component]',
  // ... 他多数
];
```

### 4.2 セクションタイプ分類 / Section Type Classification

検出されたセクションを以下のタイプに分類：

Detected sections are classified into the following types:

| タイプ / Type | 検出ロジック / Detection Logic |
|-------|-------------|
| `hero` | 最初のセクション、大きな見出し、CTA要素 |
| `navigation` | nav要素、ヘッダー内のリンク集合 |
| `feature` | アイコン+テキストのグリッド |
| `testimonial` | 引用、顔写真、会社ロゴ |
| `pricing` | 価格表示、プランカード |
| `cta` | ボタン、フォーム、アクション誘導 |
| `gallery` | 画像グリッド |
| `footer` | ページ末尾、著作権表示 |
| `contact` | フォーム、連絡先情報 |
| `unknown` | 分類不能 |

### 4.3 Vision分析（Ollama llama3.2-vision） / Vision Analysis (Ollama llama3.2-vision)

スクリーンショットをAIで分析し、セクション構造を視覚的に検出：

Analyze screenshots with AI to visually detect section structure:

```json
{
  "visionAnalysis": {
    "success": true,
    "features": [
      {"type": "layout_structure", "confidence": 0.8, "description": "grid-type layout"},
      {"type": "color_palette", "confidence": 0.8},
      {"type": "section_boundaries", "confidence": 0.7}
    ],
    "modelName": "llama3.2-vision",
    "processingTimeMs": 15348,
    "textRepresentation": "Layout: grid-type layout with areas: section1, section2..."
  }
}
```

### 4.4 CSS Framework検出

```javascript
const CSS_FRAMEWORKS = {
  'tailwind': ['class*="flex"', 'class*="grid"', 'class*="p-"', 'class*="m-"'],
  'bootstrap': ['class*="container"', 'class*="row"', 'class*="col-"'],
  'css_modules': ['class*="_"', 'class*="__"'],  // BEM-like patterns
  'styled_components': ['class*="sc-"'],
  'vanilla': []  // デフォルト
};
```

### 4.5 section_patterns テーブルへの保存

```sql
INSERT INTO section_patterns (
  id,                    -- UUIDv7
  web_page_id,           -- 親WebPageへのFK
  section_type,          -- 'hero' | 'feature' | 'cta' | ...
  section_name,          -- セクション名（オプション）
  position_index,        -- ページ内での順序
  layout_info,           -- JSONB: Vision分析結果含む
  components,            -- JSONB: 検出されたコンポーネント
  visual_features,       -- JSONB: 視覚的特徴
  html_snippet,          -- セクションのHTML
  css_snippet,           -- 関連CSS（<style>タグ + 外部CSS参照）
  css_framework,         -- 'tailwind' | 'bootstrap' | 'vanilla' | ...
  css_framework_meta,    -- JSONB: 検出根拠
  external_css_content,  -- 取得した外部CSSの内容
  external_css_meta,     -- JSONB: フェッチ結果メタデータ
  tags,                  -- TEXT[]: タグ配列
  metadata,              -- JSONB: その他メタデータ
  created_at,
  updated_at
) VALUES (...);
```

**layout_info の構造例:**

```json
{
  "type": "hero",
  "confidence": 0.85,
  "visionAnalysis": {
    "success": true,
    "features": [
      {"type": "layout_structure", "confidence": 0.8, "description": "grid-type layout"},
      {"type": "color_palette", "confidence": 0.8},
      {"type": "section_boundaries", "confidence": 0.7}
    ],
    "modelName": "llama3.2-vision",
    "processingTimeMs": 15348,
    "textRepresentation": "Layout: grid-type layout..."
  }
}
```

### 4.6 section_embeddings テーブルへの保存

> **Note**: Embedding生成はPhase 7（EMBEDDING）で実行されます。LAYOUTフェーズではセクション検出・保存のみを行います。

各セクションパターンに対して、Phase 7で768次元のベクトル埋め込みが生成されます：

```sql
INSERT INTO section_embeddings (
  id,                    -- UUIDv7
  section_pattern_id,    -- 親SectionPatternへのFK（UNIQUE）
  text_embedding,        -- vector(768): テキスト表現からの埋め込み
  vision_embedding,      -- vector(768): Vision分析からの埋め込み
  combined_embedding,    -- vector(768): 統合埋め込み
  text_representation,   -- 埋め込み生成に使用したテキスト
  model_version,         -- 'multilingual-e5-base'
  embedding_timestamp,
  created_at,
  updated_at
) VALUES (...);
```

**HNSWインデックス設定:**

```sql
CREATE INDEX idx_section_embeddings_text_hnsw
  ON section_embeddings
  USING hnsw (text_embedding vector_cosine_ops)
  WITH (m=16, ef_construction=64);
```

---

## 5. Phase 3: SCROLL_VISION -- スクロールキャプチャ / Scroll Capture

### 5.1 処理内容

ブラウザが開いている間にスクロールキャプチャを実行します（Phase 1.5）。

1. **フレームキャプチャ**
   - 15px/frameでスクロールしながらスクリーンショットを連続取得
   - 30fps等価（33ms間隔）
   - 出力: PNG形式（ロスレス）

2. **キャプチャのみ実行**
   - このフェーズではキャプチャのみを行い、Vision分析は実行しない
   - Vision分析（Phase 2.5）はブラウザクローズ後にPhase 6（NARRATIVE）内で実行
   - VRAM競合回避のため（Chromium + Ollama > RTX 3060 12GB）

3. **フレーム画像分析（Worker Thread並列処理）/ Frame Image Analysis (Worker Thread Parallel)**
   - `FrameWorkerPool` が10ペア超の差分計算をWorker Threadで並列処理
   - CPUコア数に応じたワーカー数自動調整（デフォルト: CPUコア数 - 1）
   - **CLS計算**: `impact_fraction * distance_fraction` でCore Web Vitals準拠のCLSスコアを算出
   - **色変化検出**: 4x4グリッドサンプリングによるドミナントカラー抽出、fade-in/fade-out/色遷移/明度変化を検出
   - 原因推定: `image_load`（画像読み込み）, `font_swap`（フォント差し替え）, `dynamic_content`（動的コンテンツ挿入）

   `FrameWorkerPool` parallelizes diff computation for 10+ pairs using Worker Threads. Worker count auto-adjusts to CPU cores (default: cores - 1). CLS calculation: `impact_fraction * distance_fraction` for Core Web Vitals-compliant CLS scoring. Color change detection: 4x4 grid sampling for dominant color extraction; detects fade-in, fade-out, color transitions, and brightness changes. Root cause estimation: image_load, font_swap, dynamic_content.

### 5.2 出力

- フレーム画像（`/tmp/reftrix-frames/frame-{0000}.png`）
- キャプチャメタデータ（フレーム数、スクロール量等）
- フレーム差分分析結果（CLS計算結果、色変化検出結果）

---

## 6. Phase 4: MOTION -- モーション検出 / Motion Detection

### 6.1 CSS静的解析

HTMLとCSSから以下のパターンを検出：

1. **CSS Animations**
   - `@keyframes` ルール
   - `animation-*` プロパティ

2. **CSS Transitions**
   - `transition-*` プロパティ
   - `:hover`, `:focus` 疑似クラス

3. **Transform**
   - `transform` プロパティ
   - `translate`, `rotate`, `scale` 関数

### 6.2 JSアニメーション検出（CDP + Web Animations API）

Playwright経由でブラウザ内のJSアニメーションを検出：

#### CDP（Chrome DevTools Protocol）

```javascript
// Animation.animationStarted イベントを購読
cdpSession.on('Animation.animationStarted', (event) => {
  // CSS Animation, CSS Transition, Web Animation を検出
});
```

#### Web Animations API

```javascript
// document.getAnimations() でアクティブなアニメーションを取得
const animations = await page.evaluate(() => {
  return document.getAnimations().map(anim => ({
    id: anim.id,
    playState: anim.playState,
    target: anim.effect?.target?.className,
    timing: anim.effect?.getTiming(),
    keyframes: anim.effect?.getKeyframes()
  }));
});
```

#### ライブラリ検出

| ライブラリ | 検出方法 |
|-----------|---------|
| GSAP | `window.gsap`, `window.TweenMax` |
| Framer Motion | `data-framer-*` 属性 |
| anime.js | `window.anime` |
| Three.js | `window.THREE` |
| Lottie | `window.lottie`, `window.bodymovin` |

### 6.3 motion_patterns テーブルへの保存

```sql
INSERT INTO motion_patterns (
  id,                    -- UUIDv7
  web_page_id,           -- 親WebPageへのFK
  name,                  -- 'transition-0', 'keyframe-fade-in' 等
  type,                  -- 'css_animation' | 'css_transition' | 'keyframes' | 'library_animation' | 'video_motion'
  category,              -- 'hover_effect' | 'scroll_trigger' | 'loading_state' | ...
  trigger_type,          -- 'hover' | 'scroll' | 'load' | 'click' | 'focus'
  trigger_config,        -- JSONB: トリガー詳細設定
  animation,             -- JSONB: {duration, easing, delay, iterations, ...}
  properties,            -- JSONB: アニメーション対象プロパティ
  implementation,        -- JSONB: CSS/JS実装コード
  accessibility,         -- JSONB: アクセシビリティ情報
  performance,           -- JSONB: パフォーマンス警告
  source_url,
  usage_scope,
  tags,
  metadata,
  created_at,
  updated_at
) VALUES (...);
```

**animation の構造例:**

```json
{
  "duration": 500,
  "easing": "ease-in-out",
  "delay": 0,
  "iterations": 1,
  "direction": "normal",
  "fill": "forwards"
}
```

### 6.4 motion_embeddings テーブルへの保存

> **Note**: Embedding生成はPhase 7（EMBEDDING）で実行されます。MOTIONフェーズではモーション検出・保存のみを行います。

```sql
INSERT INTO motion_embeddings (
  id,                    -- UUIDv7
  motion_pattern_id,     -- 親MotionPatternへのFK（UNIQUE）
  embedding,             -- vector(768)
  text_representation,   -- 埋め込み生成に使用したテキスト
  model_version,         -- 'multilingual-e5-base'
  created_at,
  updated_at
) VALUES (...);
```

---

## 7. Phase 5: QUALITY -- 品質評価 / Quality Evaluation

### 7.1 評価軸

| 軸 | 重み | 評価内容 |
|----|------|---------|
| **Originality** | 35% | 独自性、AIクリシェ回避 |
| **Craftsmanship** | 40% | アクセシビリティ、セマンティックHTML、パフォーマンス |
| **Contextuality** | 25% | 業界適合性、ターゲットオーディエンス適合性 |

### 7.2 評価フロー

1. **静的分析**
   - HTML構造分析（見出し階層、セマンティック要素）
   - アクセシビリティチェック（ARIA、alt属性）
   - AIクリシェ検出（グラデーション球、汎用イラスト等）

2. **パターン駆動評価（v0.1.0）**
   - 類似セクションパターンとの比較
   - 高品質ベンチマーク（Score ≥ 85）との類似度
   - ユニークネススコア計算

### 7.3 スコアリング

```javascript
const calculateScore = (staticScore, patternAnalysis) => {
  let originality = staticScore.originality;
  let craftsmanship = staticScore.craftsmanship;
  let contextuality = staticScore.contextuality;

  // パターン類似度による調整
  if (patternAnalysis.uniquenessScore >= 70) {
    originality += Math.min(10, (patternAnalysis.uniquenessScore - 70) * 0.33);
  }

  if (patternAnalysis.benchmarkSimilarity >= 0.8) {
    craftsmanship += Math.min(10, (patternAnalysis.benchmarkSimilarity - 0.8) * 50);
  }

  const overall =
    originality * 0.35 +
    craftsmanship * 0.40 +
    contextuality * 0.25;

  return {
    overall: Math.round(overall),
    grade: overall >= 90 ? 'A' : overall >= 80 ? 'B' : overall >= 70 ? 'C' : 'D',
    originality,
    craftsmanship,
    contextuality
  };
};
```

### 7.4 レスポンス構造

```json
{
  "quality": {
    "success": true,
    "overallScore": 88,
    "grade": "B",
    "axisScores": {
      "originality": 100,
      "craftsmanship": 84,
      "contextuality": 78
    },
    "clicheCount": 0,
    "processingTimeMs": 2,
    "recommendations": [
      {
        "id": "rec-1",
        "category": "craftsmanship",
        "priority": "high",
        "title": "アクセシビリティを改善する",
        "description": "ARIA属性、セマンティックHTML、画像のalt属性を追加してください"
      }
    ]
  }
}
```

---

## 8. Phase 6: NARRATIVE -- ナラティブ分析 / Narrative Analysis

### 8.1 処理内容

ブラウザクローズ後に実行されるフェーズです。SCROLL_VISIONフェーズ（Phase 3）で取得したキャプチャ画像をOllama Visionで分析します（Phase 2.5）。

1. **ScrollVision分析**
   - Phase 3で取得したフレームキャプチャを入力
   - Ollama llama3.2-visionで視覚的な変化を分析
   - CLS（Cumulative Layout Shift）検出: `impact_fraction * distance_fraction` でCore Web Vitals準拠のスコアを算出
   - 差分解析: `FrameWorkerPool` によるWorker Thread並列処理（10ペア超で自動並列化）
   - 色変化検出: 4x4グリッドサンプリング、fade-in/fade-out/色遷移/明度変化

   CLS detection: `impact_fraction * distance_fraction` for Core Web Vitals-compliant scoring. Diff analysis: Worker Thread parallel processing via `FrameWorkerPool` (auto-parallelized for 10+ pairs). Color change detection: 4x4 grid sampling; fade-in, fade-out, color transitions, brightness changes.

2. **ナラティブ構造分析**
   - ページ全体のストーリーテリング構造を分析
   - セクション間の関係性とフローを評価
   - 分析結果は `design_narratives` テーブルに保存
   - `NarrativeSearchService` によるセマンティック検索に対応（`narrative.search` ツール）

   Analysis results are saved to the `design_narratives` table. Supports semantic search via `NarrativeSearchService` (`narrative.search` tool).

3. **narrative.search 検索対応**
   - Phase 7でEmbedding生成後、`narrative.search` ツールで検索可能
   - ベクトル検索（768次元embedding）、ハイブリッド検索（RRF: 60% vector + 40% full-text）
   - MoodCategoryフィルター、embedding直接指定による検索もサポート

   After Embedding generation in Phase 7, searchable via `narrative.search` tool. Vector search (768-dim embedding), hybrid search (RRF: 60% vector + 40% full-text). MoodCategory filter and direct embedding search also supported.

> **VRAM競合回避**: ブラウザクローズ後に実行するため、ChromiumとOllamaのVRAM競合が発生しません（RTX 3060 12GB環境）。GPU Resource Managerが`acquireForVision()`でVRAM確保を管理します。

---

## 9. Phase 7: EMBEDDING -- Embedding生成 / Embedding Generation

### 9.1 処理内容

全分析結果に対して、multilingual-e5-baseモデルで768次元のベクトル埋め込みを生成します。

1. **Section Embedding** -- section_patterns → section_embeddings
2. **Motion Embedding** -- motion_patterns → motion_embeddings
3. **Background Design Embedding** -- background_designs → background_design_embeddings
4. **JSAnimation Embedding** -- js_animations → js_animation_embeddings
5. **ScrollVision Embedding** -- scroll_visionキャプチャ分析結果

### 9.2 チャンク化処理

大量のEmbedding生成時のOOM防止のため、チャンク化処理を適用：

- **チャンクサイズ**: 30件（`EMBEDDING_CHUNK_SIZE = 30`）
- **チャンク間処理**: `disposeEmbeddingPipeline()` + `tryGarbageCollect()`
- **メモリ圧力時**: チャンクサイズ半減（最小5件）、critical時はループ停止
- **ONNX Worker Thread**: メインスレッドのイベントループをブロックしないため、BullMQ heartbeatが保証される

### 9.3 プレフィックス（e5モデル要件）

| 用途 | プレフィックス |
|------|---------------|
| 保存時（passage） | `passage: ` |
| 検索時（query） | `query: ` |

### 9.4 保存先テーブル

| 入力 | 保存先テーブル | インデックス |
|------|---------------|-------------|
| section_patterns | section_embeddings | HNSW (m=16, ef_construction=64) |
| motion_patterns | motion_embeddings | HNSW |
| background_designs | background_design_embeddings | HNSW |
| js_animations | js_animation_embeddings | HNSW |

> **Note**: progress >= 90% のジョブはDB保存済みとみなされます（`DB_SAVED_PROGRESS_THRESHOLD = 90`）。Stall Recovery時、progress >= 90のジョブは`moveToCompleted`で回復されます。

---

## 10. データベース保存構造 / Database Storage Structure

### 10.1 ER図

```
┌─────────────────┐
│   web_pages     │
│─────────────────│
│ id (PK)         │
│ url             │
│ title           │
│ html            │
│ screenshot      │
│ source_type     │
│ usage_scope     │
└────────┬────────┘
         │
         │ 1:N
         ▼
┌─────────────────┐      ┌─────────────────┐
│section_patterns │      │ motion_patterns │
│─────────────────│      │─────────────────│
│ id (PK)         │      │ id (PK)         │
│ web_page_id(FK) │      │ web_page_id(FK) │
│ section_type    │      │ name            │
│ layout_info     │      │ category        │
│ html_snippet    │      │ trigger_type    │
│ css_snippet     │      │ animation       │
└────────┬────────┘      └────────┬────────┘
         │                        │
         │ 1:1                    │ 1:1
         ▼                        ▼
┌─────────────────┐      ┌─────────────────┐
│section_embeddings│     │motion_embeddings│
│─────────────────│      │─────────────────│
│ id (PK)         │      │ id (PK)         │
│ section_pattern │      │ motion_pattern  │
│   _id (FK,UQ)   │      │   _id (FK,UQ)   │
│ text_embedding  │      │ embedding       │
│ vision_embedding│      │ text_repr       │
│ combined_embed  │      │ model_version   │
└─────────────────┘      └─────────────────┘
```

### 10.2 インデックス構成

| テーブル | インデックス | タイプ | 用途 |
|---------|-------------|-------|------|
| section_patterns | web_page_id | B-tree | FK検索 |
| section_patterns | section_type | B-tree | タイプ別フィルタ |
| section_patterns | css_framework | B-tree | フレームワーク別検索 |
| section_embeddings | text_embedding | HNSW | ベクトル類似検索 |
| section_embeddings | vision_embedding | HNSW | Vision類似検索 |
| section_embeddings | combined_embedding | HNSW | 統合類似検索 |
| motion_patterns | category | B-tree | カテゴリ別フィルタ |
| motion_patterns | type | B-tree | モーションタイプ別フィルタ |
| motion_patterns | trigger_type | B-tree | トリガー別検索 |
| motion_embeddings | embedding | HNSW | ベクトル類似検索 |

---

## 11. 保存データの活用方法 / How to Use Saved Data

### 11.1 セマンティック検索（layout.search）

```typescript
// 日本語クエリで類似セクションを検索
const results = await mcp.layout.search({
  query: "モダンなダークテーマのヒーローセクション",
  filters: {
    sectionType: "hero"
  },
  limit: 10
});

// 結果例
[
  {
    id: "019ba63b-df29-7754-999d-4acf1a49c734",
    sectionType: "hero",
    similarity: 0.89,
    sourceUrl: "https://www.spaceandtime.io/"
  }
]
```

### 11.2 コード生成（layout.generate_code）

```typescript
// 検索結果のパターンからReactコンポーネントを生成
const code = await mcp.layout.generate_code({
  patternId: "019ba63b-df29-7754-999d-4acf1a49c734",
  options: {
    framework: "react",
    typescript: true,
    tailwind: true
  }
});

// 出力例
`
import React from 'react';

interface HeroSectionProps {
  title: string;
  subtitle: string;
  ctaText: string;
}

export const HeroSection: React.FC<HeroSectionProps> = ({
  title,
  subtitle,
  ctaText
}) => {
  return (
    <section className="min-h-screen bg-[#100217] flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-5xl font-bold text-white mb-4">{title}</h1>
        <p className="text-xl text-gray-300 mb-8">{subtitle}</p>
        <button className="px-8 py-3 bg-purple-600 text-white rounded-lg">
          {ctaText}
        </button>
      </div>
    </section>
  );
};
`
```

### 11.3 モーション検索（motion.search）

```typescript
// ホバーエフェクトを検索
const results = await mcp.motion.search({
  query: "スムーズなホバーエフェクト",
  filters: {
    trigger: "hover"
  },
  include_js_animations: true
});
```

---

## 12. 実例: spaceandtime.io の分析結果 / Example: spaceandtime.io Analysis Results

### 12.1 分析サマリー

| 項目 | 値 |
|------|-----|
| URL | https://www.spaceandtime.io/ |
| Title | Space and Time \| The Data Blockchain Securing Onchain Finance |
| 分析時間 | 403,828ms（約6分47秒） |
| CSS Framework | vanilla (confidence: 0.3) |
| Quality Score | 88/100 (Grade B) |

### 12.2 実際のページレイアウト（ASCII Art表現）

spaceandtime.ioの実際のページ構造を視覚化したものです。検出された388セクションのうち、主要な構造を表現しています。

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           NAVIGATION (262件検出)                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ [Logo: Space and Time]  [Products▼] [Solutions▼] [Docs]  [Sign In]  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                             HERO SECTION (25件検出)                         │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                                                                    │    │
│  │                   ███████████████████████████████                  │    │
│  │                   █                           █                   │    │
│  │                   █  The Data Blockchain      █                   │    │
│  │                   █  Securing Onchain Finance █                   │    │
│  │                   █                           █                   │    │
│  │                   █  [Get Started] [Docs]     █                   │    │
│  │                   █                           █                   │    │
│  │                   ███████████████████████████████                  │    │
│  │                                                                    │    │
│  │         背景: ダークテーマ (#100217相当)                            │    │
│  │         グラデーション効果 + アニメーション付き                       │    │
│  └────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  CSS Framework: vanilla                                                    │
│  Vision分析: "grid-type layout" (confidence: 0.8)                          │
│  セマンティック: <section>, <h1>, <p>, <button>                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                          FEATURE SECTION (11件検出)                         │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                                                                    │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │    │
│  │  │   [Icon]     │  │   [Icon]     │  │   [Icon]     │            │    │
│  │  │              │  │              │  │              │            │    │
│  │  │  Feature 1   │  │  Feature 2   │  │  Feature 3   │            │    │
│  │  │  Description │  │  Description │  │  Description │            │    │
│  │  │              │  │              │  │              │            │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘            │    │
│  │                                                                    │    │
│  │  Layout: CSS Grid (3カラム)                                        │    │
│  │  アイコン + テキストのカード型レイアウト                             │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                       TESTIMONIAL SECTION (42件検出)                        │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                                                                    │    │
│  │  "Space and Time has revolutionized our blockchain data..."       │    │
│  │                                                                    │    │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐                  │    │
│  │  │  [Photo]   │  │  [Photo]   │  │  [Photo]   │                  │    │
│  │  │  Name      │  │  Name      │  │  Name      │                  │    │
│  │  │  Company   │  │  Company   │  │  Company   │                  │    │
│  │  └────────────┘  └────────────┘  └────────────┘                  │    │
│  │                                                                    │    │
│  │  検出要素: 引用符、顔写真、会社ロゴ                                 │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GALLERY SECTION (5件検出)                         │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                                                                    │    │
│  │  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐                      │    │
│  │  │img1│ │img2│ │img3│ │img4│ │img5│ │img6│                      │    │
│  │  └────┘ └────┘ └────┘ └────┘ └────┘ └────┘                      │    │
│  │                                                                    │    │
│  │  Layout: CSS Grid (6カラム、レスポンシブ)                          │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CTA SECTION (1件検出)                            │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                                                                    │    │
│  │                 Ready to Get Started?                              │    │
│  │                                                                    │    │
│  │           [Start Building]  [Talk to Sales]                       │    │
│  │                                                                    │    │
│  │  背景色: アクセントカラー（パープル系）                              │    │
│  │  ボタンアニメーション: hover_effect (transition: 5000000ms)         │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                      ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FOOTER SECTION (41件検出)                         │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                                                                    │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐          │    │
│  │  │ Products │  │ Solutions│  │ Resources│  │  Company │          │    │
│  │  │ Link1    │  │ Link1    │  │ Link1    │  │  Link1   │          │    │
│  │  │ Link2    │  │ Link2    │  │ Link2    │  │  Link2   │          │    │
│  │  │ Link3    │  │ Link3    │  │ Link3    │  │  Link3   │          │    │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘          │    │
│  │                                                                    │    │
│  │  [Social Icons] © 2024 Space and Time. All rights reserved.       │    │
│  │                                                                    │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
```

**検出されたセクション総数: 388件**
- navigation: 262件（ネストされたナビゲーション要素、サブメニュー含む）
- hero: 25件（メインヒーロー + 各セクションのヒーロー風レイアウト）
- testimonial: 42件（顧客事例、レビュー要素）
- footer: 41件（フッター内の各セクション、リンクグループ）
- feature: 11件（機能紹介カード）
- gallery: 5件（画像ギャラリー）
- cta: 1件（メインCTAセクション）
- unknown: 1件（分類不能）

### 12.3 セクション検出フローの視覚化

以下は、SectionDetectorがHTMLをどのように解析し、セクションを分類してDBに保存するかを示したものです。

```
┌──────────────────────────────────────────────────────────────────────┐
│  HTML入力（DOMPurifyでサニタイズ済み）                                │
│  <section class="hero">                                              │
│    <h1>The Data Blockchain</h1>                                      │
│    <button>Get Started</button>                                      │
│  </section>                                                          │
└──────────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────────┐
│  SectionDetector: セレクタマッチング                                  │
│  ─────────────────────────────────────────────────────────────────  │
│  ✓ section[class*="hero"] → マッチ                                    │
│  ✓ 内部に <h1> 存在 → ヒーローセクション候補                          │
│  ✓ <button> 存在 → CTA要素検出                                        │
│  ✓ ページ上部（position_index: 0-10） → 確信度向上                    │
└──────────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────────┐
│  分類ロジック: セクションタイプ決定                                   │
│  ─────────────────────────────────────────────────────────────────  │
│  判定: section_type = "hero"                                         │
│  理由:                                                               │
│    - 最初のセクション（position_index: 0）                            │
│    - 大きな見出し（h1）+ CTA要素（button）                            │
│    - クラス名に"hero"を含む                                           │
│                                                                      │
│  信頼度（confidence）: 0.95                                          │
└──────────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────────┐
│  Vision分析（Ollama llama3.2-vision）                                │
│  ─────────────────────────────────────────────────────────────────  │
│  入力: フルページスクリーンショット（PNG）                             │
│  処理時間: 15,348ms                                                  │
│                                                                      │
│  検出された特徴:                                                      │
│  ┌────────────────────────────────────────────────────────────┐      │
│  │ 1. layout_structure: "grid-type layout" (confidence: 0.8) │      │
│  │ 2. color_palette: "#333333, #333333, #333333" (0.8)       │      │
│  │ 3. section_boundaries: "0-300px, 300-600px" (0.7)         │      │
│  └────────────────────────────────────────────────────────────┘      │
│                                                                      │
│  テキスト表現:                                                        │
│  "Layout: grid-type layout with areas: section1, section2..."       │
└──────────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────────┐
│  CSS Framework検出                                                   │
│  ─────────────────────────────────────────────────────────────────  │
│  チェック:                                                            │
│  ✗ Tailwind (class*="flex", "grid", "p-", "m-") → 未検出            │
│  ✗ Bootstrap (class*="container", "row", "col-") → 未検出           │
│  ✗ CSS Modules (class*="_", "__") → 未検出                           │
│                                                                      │
│  判定: css_framework = "vanilla"                                     │
│  信頼度: 0.3（低い = フレームワーク不使用の可能性高）                  │
└──────────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────────┐
│  Embedding生成（multilingual-e5-base）                               │
│  ─────────────────────────────────────────────────────────────────  │
│  テキスト表現作成:                                                    │
│  "Hero section with heading 'The Data Blockchain Securing          │
│   Onchain Finance' and CTA button 'Get Started'. Dark theme        │
│   with purple accents. Grid layout."                                │
│                                                                      │
│  プレフィックス: "passage: " （e5モデル要件）                         │
│                                                                      │
│  ↓ ONNX Runtime処理（47ms）                                          │
│                                                                      │
│  出力: 768次元ベクトル（L2正規化済み）                                │
│  [0.0234, -0.0156, 0.0891, ..., 0.0023]                            │
│                                                                      │
│  保存先: section_embeddings.text_embedding                           │
└──────────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────────┐
│  データベース保存                                                     │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                      │
│  1️⃣ section_patterns テーブル                                        │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │ id: 019ba63b-df29-7754-999d-4acf1a49c734                 │      │
│  │ web_page_id: 019ba63b-ddfe-701a-9295-6fe1d64b0d0e        │      │
│  │ section_type: "hero"                                     │      │
│  │ position_index: 0                                        │      │
│  │ layout_info: {                                           │      │
│  │   type: "hero",                                          │      │
│  │   confidence: 0.95,                                      │      │
│  │   visionAnalysis: { ... }                                │      │
│  │ }                                                        │      │
│  │ css_framework: "vanilla"                                 │      │
│  │ html_snippet: "<section class=\"hero\">...</section>"    │      │
│  └──────────────────────────────────────────────────────────┘      │
│                                                                      │
│  2️⃣ section_embeddings テーブル                                      │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │ id: 019ba63b-e123-7890-abcd-1234567890ab                 │      │
│  │ section_pattern_id: 019ba63b-df29-7754-999d-4acf1a49c734 │      │
│  │ text_embedding: vector(768) [0.0234, -0.0156, ...]      │      │
│  │ vision_embedding: vector(768) [0.0189, 0.0234, ...]     │      │
│  │ combined_embedding: vector(768) [0.0211, 0.0039, ...]   │      │
│  │ model_version: "multilingual-e5-base"                    │      │
│  └──────────────────────────────────────────────────────────┘      │
│                                                                      │
│  3️⃣ HNSWインデックスに自動登録                                        │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │ CREATE INDEX idx_section_embeddings_text_hnsw            │      │
│  │   ON section_embeddings                                  │      │
│  │   USING hnsw (text_embedding vector_cosine_ops)          │      │
│  │   WITH (m=16, ef_construction=64);                       │      │
│  │                                                          │      │
│  │ → 以降のlayout.search()で高速セマンティック検索が可能     │      │
│  └──────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────┘
```

### 12.4 HNSW Indexによるベクトル検索の仕組み

保存されたEmbeddingは、pgvectorのHNSW（Hierarchical Navigable Small World）インデックスを用いて高速検索されます。

```
┌──────────────────────────────────────────────────────────────────────┐
│  layout.search({ query: "ダークテーマのヒーローセクション" })          │
└──────────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────────┐
│  1. クエリのEmbedding生成                                             │
│  ─────────────────────────────────────────────────────────────────  │
│  プレフィックス: "query: " （e5モデル要件）                           │
│  入力: "query: ダークテーマのヒーローセクション"                       │
│                                                                      │
│  ↓ ONNX Runtime処理（46ms）                                          │
│                                                                      │
│  出力: 768次元ベクトル                                                │
│  query_vector = [0.0456, -0.0234, 0.0712, ..., 0.0089]             │
└──────────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────────┐
│  2. HNSW Index検索（PostgreSQL）                                     │
│  ─────────────────────────────────────────────────────────────────  │
│  SELECT                                                              │
│    sp.id,                                                            │
│    sp.section_type,                                                  │
│    sp.layout_info,                                                   │
│    1 - (se.text_embedding <=> $1) AS similarity                     │
│  FROM section_patterns sp                                            │
│  JOIN section_embeddings se ON sp.id = se.section_pattern_id        │
│  WHERE sp.section_type = 'hero'                                      │
│  ORDER BY se.text_embedding <=> $1                                  │
│  LIMIT 10;                                                           │
│                                                                      │
│  HNSW Index設定:                                                     │
│    - m=16 (グラフ接続数: 検索精度とメモリのバランス)                   │
│    - ef_construction=64 (インデックス構築品質)                        │
│    - vector_cosine_ops (コサイン距離演算子)                           │
│                                                                      │
│  処理時間: 10.66ms (P95)                                             │
└──────────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────────┐
│  3. 検索結果（類似度順）                                              │
│  ─────────────────────────────────────────────────────────────────  │
│  [                                                                   │
│    {                                                                 │
│      id: "019ba63b-df29-7754-999d-4acf1a49c734",                    │
│      sectionType: "hero",                                            │
│      similarity: 0.89,  ← コサイン類似度                              │
│      sourceUrl: "https://www.spaceandtime.io/",                     │
│      layoutInfo: {                                                   │
│        type: "hero",                                                 │
│        visionAnalysis: {                                             │
│          features: ["grid-type layout", "dark theme"],              │
│          colors: ["#100217", "#6B46C1"]                             │
│        }                                                             │
│      }                                                               │
│    },                                                                │
│    { similarity: 0.85, ... },                                       │
│    { similarity: 0.82, ... }                                        │
│  ]                                                                   │
└──────────────────────────────────────────────────────────────────────┘
```

**HNSW Indexの利点**:
- **高速検索**: 線形検索（O(n)）に対し、O(log n)で近似最近傍探索
- **高精度**: ef_construction=64により、真の最近傍を高確率で発見
- **スケーラビリティ**: 数百万ベクトルでも10ms以下でクエリ可能

### 12.5 保存されたデータ

#### web_pages テーブル

| カラム | 値 |
|--------|-----|
| id | `019ba63b-ddfe-701a-9295-6fe1d64b0d0e` |
| url | `https://www.spaceandtime.io/` |
| title | `Space and Time \| The Data Blockchain Securing Onchain Finance` |
| source_type | `user_provided` |
| usage_scope | `inspiration_only` |

#### section_patterns テーブル（388件）

| セクションタイプ | 件数 | 説明 |
|-----------------|------|------|
| navigation | 262 | ナビゲーション要素 |
| testimonial | 42 | 証言・レビュー |
| footer | 41 | フッター要素 |
| hero | 25 | ヒーローセクション |
| feature | 11 | 機能紹介 |
| gallery | 5 | ギャラリー |
| cta | 1 | CTA要素 |
| unknown | 1 | 分類不能 |

#### motion_patterns テーブル（4件）

| 名前 | カテゴリ | トリガー | Duration |
|------|---------|---------|----------|
| transition-0 | hover_effect | hover | 5000000ms |
| transition-1 | unknown | load | - |

#### section_embeddings テーブル（388件）

- 各セクションに対して768次元ベクトル埋め込み
- モデル: multilingual-e5-base
- HNSWインデックス: m=16, ef_construction=64

#### motion_embeddings テーブル（2件）

- 各モーションパターンに対して768次元ベクトル埋め込み

### 12.6 Vision分析結果

```json
{
  "success": true,
  "features": [
    {
      "type": "layout_structure",
      "confidence": 0.8,
      "description": "grid-type layout"
    },
    {
      "type": "color_palette",
      "confidence": 0.8
    },
    {
      "type": "section_boundaries",
      "confidence": 0.7
    }
  ],
  "textRepresentation": "Layout: grid-type layout with areas: section1, section2. grid-type layout\nColors: #333333, #333333, #333333. Mood: dark. Contrast: medium.\nSections: section1 (0-300px), section2 (300-600px)."
}
```

### 12.7 品質評価結果

| 軸 | スコア |
|----|--------|
| Originality | 100/100 |
| Craftsmanship | 84/100 |
| Contextuality | 78/100 |
| **Overall** | **88/100 (Grade B)** |

AIクリシェ検出: 0件（クリーン）

---

## 付録: デフォルトオプション

> **重要 / Important**: `summary` パラメータのデフォルトは `false`（詳細レスポンス）です。LLMのコンテキストウィンドウを効率的に使用するため、通常は `summary: true` を指定することを推奨します。環境変数 `MCP_DEFAULT_SUMMARY_MODE` でデフォルト値を変更することも可能です。
>
> The `summary` parameter defaults to `false` (detailed response). To use the LLM context window efficiently, specifying `summary: true` is recommended. You can also change the default via the `MCP_DEFAULT_SUMMARY_MODE` environment variable.

```typescript
// page.analyze のデフォルトオプション
{
  summary: false,    // 推奨: true（軽量レスポンス）/ Recommended: true (lightweight response)
  features: {
    layout: true,
    motion: true,
    quality: true
  },
  layoutOptions: {
    saveToDb: true,
    autoAnalyze: true,
    useVision: true,       // Ollama Vision有効
    includeHtml: false,    // レスポンスにHTML含めない
    includeScreenshot: false,
    viewport: { width: 1440, height: 900 },
    fullPage: true
  },
  motionOptions: {
    saveToDb: true,
    detect_js_animations: true,  // JSアニメーション検出有効
    maxPatterns: 100,
    includeWarnings: true
  },
  qualityOptions: {
    strict: true,  // デフォルト: true / default: true
    includeRecommendations: true,
    weights: {
      originality: 0.35,
      craftsmanship: 0.40,
      contextuality: 0.25
    }
  },
  timeout: 600000,  // 10分（デフォルト）/ 10 minutes (default)
  waitUntil: 'networkidle'  // page.analyzeデフォルト / page.analyze default (layout.ingestは'load')
}
```

---

## 関連ドキュメント

- [MCPツールガイド](./02-mcp-tools-guide.md)

---

**Last Updated**: 2026-03-01 | **Author**: Reftrix Team

---

## 関連ガイド

- [はじめに](./01-getting-started.md)
- [MCPツール使用ガイド](./02-mcp-tools-guide.md)
- [page.analyze詳細ガイド](./03-page-analyze-deep-dive.md)
- [トラブルシューティング](./04-troubleshooting.md)
