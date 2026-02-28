# Testing - Frame Analysis Detailed Guide

**Parent**: `.claude/rules/testing-requirements.md`

## フレームキャプチャ（アニメーション検証） / Frame Capture (Animation Verification)

### Reftrix Default Specification

| 項目 / Item | デフォルト値 / Default | 説明 / Description |
|------|-------------|------|
| Scroll Per Frame | **15px** | 基準値（アニメーション検出に最適化） / Baseline (optimized for animation detection) |
| Total Frames | totalScrollHeight / 15 | 例: 3000px → 200 frames / Example: 3000px → 200 frames |
| Frame Interval | 33ms | 30fps等価（1000ms/30） / 30fps equivalent (1000ms/30) |
| 出力フォーマット / Output Format | png | PNG推奨（ロスレス） / PNG recommended (lossless) |
| ファイル名パターン / Filename Pattern | `frame-{0000}.png` | ゼロパディング4桁 / Zero-padded 4 digits |

### 15px/frame の根拠 / Rationale for 15px/frame

- 60fps等価スクロール（216px/秒 ÷ 60 ≈ 3.6px）と50px/frameの中間
- IntersectionObserver閾値（0.1〜0.3）を確実に検出
- cubic-bezier easing曲線の解析に十分なサンプル数
- parallax微動（係数0.02〜0.05）の検出可能

Balanced between 60fps-equivalent scrolling (3.6px) and 50px/frame; ensures reliable IntersectionObserver threshold detection, sufficient samples for cubic-bezier analysis, and parallax micro-movement capture.

### video mode 使用例 / video mode Usage Examples

```typescript
import { test, expect } from '@playwright/test';

// video mode（デフォルト設定で使用）
test('モーションパターン検出（video mode）', async ({ page }) => {
  await page.goto('http://localhost:YOUR_APP_PORT');

  // motion.detectはデフォルトでvideo mode有効
  // enable_frame_capture: true（デフォルト）
  // 15px/frameでフレームキャプチャ
});

// video modeを無効化する場合
test('静的解析のみ（video mode無効）', async ({ page }) => {
  await page.goto('http://localhost:YOUR_APP_PORT');

  // video modeを無効化
  // await motion.detect({ html: content, enable_frame_capture: false });
});
```

### スクロールアニメーション検証（15px/frame） / Scroll Animation Verification (15px/frame)

```typescript
import { test, expect } from '@playwright/test';

test('スクロールアニメーション検証（15px/frame）', async ({ page }) => {
  await page.goto('http://localhost:YOUR_APP_PORT');

  // 1. 最初にtotalScrollHeightを取得
  const totalScrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  const maxScroll = totalScrollHeight - viewportHeight;

  // 2. 15pxごとに1フレームをキャプチャ
  const scrollStep = 15; // 15px per frame（標準設定）
  const frameCount = Math.ceil(maxScroll / scrollStep);

  for (let i = 0; i <= frameCount; i++) {
    const scrollY = Math.min(i * scrollStep, maxScroll);
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(33); // 33ms間隔（30fps等価）
    await page.screenshot({
      path: `/tmp/reftrix-frames/frame-${String(i).padStart(4, '0')}.png`
    });
  }
});
```

## フレーム画像分析（v0.1.0新機能） / Frame Image Analysis (v0.1.0 New Feature)

### 目的 / Purpose

CSS静的解析では捉えられない実際のアニメーション動作を分析

Analyzes actual animation behavior that CSS static analysis cannot capture.

### 主な用途 / Primary Use Cases

- **CLS検出 / CLS Detection**: Cumulative Layout Shift問題の視覚的特定（Core Web Vitals改善） / Visual identification of CLS issues (Core Web Vitals improvement)
- **差分解析 / Diff Analysis**: アニメーション変化の定量化（Pixelmatch使用） / Quantifying animation changes (using Pixelmatch)
- **パフォーマンス診断 / Performance Diagnosis**: 大きな再描画領域の可視化 / Visualizing large repaint areas

### パフォーマンス目標 / Performance Targets

- フレーム差分（1ペア） / Frame diff (1 pair): < 100ms
- 10フレームシーケンス / 10-frame sequence: < 5s
- 100フレームシーケンス / 100-frame sequence: < 30s
- メモリ使用量 / Memory usage: < 500MB

### 技術スタック / Tech Stack

- **Sharp**: 画像読み込み・前処理 / Image loading and preprocessing
- **Pixelmatch**: 高精度差分検出（perceptual diff） / High-precision diff detection (perceptual diff)

### 使用例（E2Eテスト内） / Usage Example (in E2E Tests)

```typescript
import { test } from '@playwright/test';

test('フレーム画像分析（CLS検出）', async ({ page }) => {
  await page.goto('http://localhost:YOUR_APP_PORT');

  // フレームキャプチャ実行
  const totalScrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  const maxScroll = totalScrollHeight - viewportHeight;
  const scrollStep = 15;
  const frameCount = Math.ceil(maxScroll / scrollStep);

  for (let i = 0; i <= frameCount; i++) {
    const scrollY = Math.min(i * scrollStep, maxScroll);
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(33);
    await page.screenshot({ path: `/tmp/reftrix-frames/frame-${String(i).padStart(4, '0')}.png` });
  }

  // フレーム画像分析はmotion.detect MCPツールで実行
  // Use MCP motion.detect tool for analysis
});
```

### CI環境での制約 / CI Environment Constraints

- `analyze_frames: false` 推奨（ローカルのみ実行） / Recommended to disable (run locally only)
- 解像度が高い場合は処理時間が増加 / Higher resolution increases processing time
- 大量フレーム処理時はメモリ使用量に注意 / Watch memory usage when processing many frames

### 注意事項 / Notes

- `prefers-reduced-motion` 対応を必ず検証 / Always verify `prefers-reduced-motion` support
- フレームキャプチャは CI では無効化推奨（ローカルのみ） / Disable frame capture in CI (local only)
- 大量のスクリーンショットでストレージ圧迫に注意 / Watch for storage pressure from many screenshots
- フレーム画像分析（v0.1.0新機能）はローカルのみ実行推奨（メモリ < 500MB目標） / Frame image analysis (v0.1.0) recommended for local execution only (memory target < 500MB)
