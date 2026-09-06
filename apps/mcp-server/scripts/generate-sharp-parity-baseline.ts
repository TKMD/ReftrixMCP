// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `INV-SHARP-PIPELINE-PARITY-001` — baseline 生成専用スクリプト
 * Generation-only script for the sharp pipeline parity baselines.
 *
 * **standing test の外に置く理由 (plan v5 §3 「baseline 生成経路の性格」 (a)/(b))**:
 * 生成モードを standing test 内の env flag として持たせると、(i) BI-1b が禁じる
 * 「とりあえず baseline を更新する」を 1 コマンドで実行できる経路が assert と同居し、
 * (ii) CI で baseline が欠落したときに **post-bump 出力で silent に生成**されて
 * Stage 1 / Stage 2 の分離が無効化され vacuous-green が再発する。したがって生成は
 * ここにのみ存在し、**standing test は baseline 不在時に RED になる (自動生成しない)**。
 *
 * Kept OUTSIDE the standing test on purpose (plan v5 §3, "the character of the
 * baseline-generation path", (a)/(b)): an env-flagged generation mode co-located
 * with the assert would put the "just update the baseline" action BI-1b forbids
 * one command away, and a baseline missing in CI would be silently regenerated
 * from post-bump output — collapsing the Stage 1 / Stage 2 separation. The
 * standing test therefore goes **RED** on a missing baseline and never generates.
 *
 * **実行が許されるのは 2 場面のみ (plan v5 §3 (c))**:
 *   1. Stage 1 の初回採取 (bump 前 tree、`sharp` 宣言が `^0.34.5` のまま)
 *   2. §4 JSDoc の手順 (1)-(4) を経た post-RED 更新
 *
 * Usage:
 *   pnpm --filter @reftrixmcp/mcp-server exec tsx scripts/generate-sharp-parity-baseline.ts
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { cropAndResizePart } from "../src/services/part/part-extraction.service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(
  HERE,
  "..",
  "tests",
  "regression",
  "standing",
  "large-page",
  "_fixtures",
  "sharp-parity"
);

/**
 * 入力 fixture の固定パラメータ (plan v5 §4 fixture 表)。
 * 448 = resize 先 224 の 2 倍 → 等倍 (1:1) を構造的に排除する (BI-19)。
 * 内容は高周波 (2 色チェッカーボード block 3px) — 単色 / 低周波では 4 kernel が
 * 同一 hash になり guard が緑のまま vacuous-green になる (BI-22 内容軸)。
 */
const FIXTURE_SIZE = 448;
const FIXTURE_BLOCK = 3;
const RESIZE_TARGET = 224;

function buildCheckerboardRaw(): Buffer {
  const raw = Buffer.alloc(FIXTURE_SIZE * FIXTURE_SIZE * 3);
  for (let y = 0; y < FIXTURE_SIZE; y++) {
    for (let x = 0; x < FIXTURE_SIZE; x++) {
      const on = (Math.floor(x / FIXTURE_BLOCK) + Math.floor(y / FIXTURE_BLOCK)) % 2 === 0;
      const v = on ? 0 : 255;
      const i = (y * FIXTURE_SIZE + x) * 3;
      raw[i] = v;
      raw[i + 1] = v;
      raw[i + 2] = v;
    }
  }
  return raw;
}

/** 経路 1 (raw 入力分岐 + `.extract()`) の比較用コピー / path 1 comparison copy */
async function path1Rgba(fixturePng: Buffer): Promise<Buffer> {
  const decoded = await sharp(fixturePng).removeAlpha().raw().toBuffer();
  return sharp(decoded, {
    raw: { width: FIXTURE_SIZE, height: FIXTURE_SIZE, channels: 3 },
  })
    .extract({ left: 0, top: 0, width: FIXTURE_SIZE, height: FIXTURE_SIZE })
    .resize(RESIZE_TARGET, RESIZE_TARGET, { fit: "cover", kernel: "cubic" })
    .removeAlpha()
    .toColorspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/** 経路 2-5 (チェーン同一 → baseline 共有) の比較用コピー / paths 2-5 comparison copy */
async function path2345Rgba(fixturePng: Buffer): Promise<Buffer> {
  return sharp(fixturePng)
    .resize(RESIZE_TARGET, RESIZE_TARGET, { fit: "cover", kernel: "cubic" })
    .removeAlpha()
    .toColorspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/** 経路 7 (クエリ側: fill / center / colorspace 変換なし) の比較用コピー / path 7 */
async function path7Rgba(fixturePng: Buffer): Promise<Buffer> {
  return sharp(fixturePng)
    .resize(RESIZE_TARGET, RESIZE_TARGET, { fit: "fill", position: "center" })
    .removeAlpha()
    .ensureAlpha()
    .raw()
    .toBuffer();
}

async function statsOfRgba(rgba: Buffer): Promise<Array<{ mean: number; stdev: number }>> {
  const s = await sharp(rgba, {
    raw: { width: RESIZE_TARGET, height: RESIZE_TARGET, channels: 4 },
  }).stats();
  return s.channels.map((c) => ({ mean: c.mean, stdev: c.stdev }));
}

async function rgbaToPng(rgba: Buffer): Promise<Buffer> {
  return sharp(rgba, { raw: { width: RESIZE_TARGET, height: RESIZE_TARGET, channels: 4 } })
    .png()
    .toBuffer();
}

async function main(): Promise<void> {
  mkdirSync(FIXTURE_DIR, { recursive: true });

  // --- 入力 fixture ---
  const fixturePng = await sharp(buildCheckerboardRaw(), {
    raw: { width: FIXTURE_SIZE, height: FIXTURE_SIZE, channels: 3 },
  })
    .png()
    .toBuffer();
  writeFileSync(join(FIXTURE_DIR, "fixture-448.png"), fixturePng);

  // --- Layer A (経路 6) : SHA-256 hex 定数として test source へ貼る ---
  const layerAOut = await cropAndResizePart(
    fixturePng,
    { x: 0, y: 0, width: FIXTURE_SIZE, height: FIXTURE_SIZE },
    RESIZE_TARGET
  );
  const layerASha = createHash("sha256").update(layerAOut).digest("hex");

  // --- Layer B (経路 1 / 2-5 / 7) ---
  const legs: Array<{ name: string; rgba: Buffer }> = [
    { name: "baseline-path1", rgba: await path1Rgba(fixturePng) },
    { name: "baseline-path2345", rgba: await path2345Rgba(fixturePng) },
    { name: "baseline-path7", rgba: await path7Rgba(fixturePng) },
  ];

  const stats: Record<string, Array<{ mean: number; stdev: number }>> = {};
  for (const leg of legs) {
    writeFileSync(join(FIXTURE_DIR, `${leg.name}.png`), await rgbaToPng(leg.rgba));
    stats[leg.name] = await statsOfRgba(leg.rgba);
  }

  writeFileSync(
    join(FIXTURE_DIR, "baseline-stats.json"),
    `${JSON.stringify(
      {
        _comment:
          "Generated by scripts/generate-sharp-parity-baseline.ts on the PRE-BUMP tree. Do NOT hand-edit; see BI-1b.",
        capturedWith: {
          sharp: sharp.versions.sharp,
          libvips: sharp.versions.vips,
          platform: `${process.platform}-${process.arch}`,
          node: process.version,
        },
        stats,
      },
      null,
      2
    )}\n`
  );

  console.log(`fixture-448.png            ${fixturePng.length} B`);
  for (const leg of legs) {
    console.log(`${leg.name}.png  (rgba ${leg.rgba.length} B raw)`);
  }
  console.log(`\nsharp ${sharp.versions.sharp} / libvips ${sharp.versions.vips}`);
  console.log(`\nLAYER A SHA-256 (paste into the test source constant):\n${layerASha}`);
}

void main();
