// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SHARP-PIPELINE-PARITY-001 (H)
 *
 * `sharp` / `@img/sharp-libvips` / bundled libvips の bump が、索引側 6 経路 +
 * クエリ側 1 経路 = **7 経路**の画像変換出力を変えていないことを **2 層**で pin する。
 * Pins, in **two layers**, that a `sharp` / `@img/sharp-libvips` / bundled-libvips
 * bump does not change the output of the **7 covered paths** (6 index-side + 1 query-side).
 *
 * ## 対象 7 経路 / The 7 covered paths
 *
 * | # | Layer | entry                                                              | form                                                        |
 * | - | ----- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
 * | 1 | B     | `workers/phases/phase-5-embedding.ts` (raw / png / fallback 3 分岐) | `.extract()` → `cover`/`cubic` → `srgb` → `.raw()`         |
 * | 2 | B     | `workers/phases/phase-5-embedding.ts` (dynamic fallback)           | `cover`/`cubic` → `srgb` → `.raw()`                        |
 * | 3 | B     | `workers/phases/phase-5-raw-decode.ts`                             | 同上 / same                                                 |
 * | 4 | B     | `workers/phases/types.ts` (fallback)                               | 同上 / same                                                 |
 * | 5 | B     | `workers/phases/types.ts` (in-range)                               | 同上 / same                                                 |
 * | 6 | **A** | `services/part/part-extraction.service.ts` (`cropAndResizePart`)   | `.extract()` → `cover`/`cubic` → `srgb` → **`.toBuffer()`** |
 * | 7 | B     | `tools/design/search-by-image.tool.ts` (query side)                | `fill`/`center` → **colorspace 変換なし** → `.raw()`       |
 *
 * **経路 2-5 は変換チェーンが完全に同一**であるため baseline を 1 枚共有する
 * (「経路ごとに 1 枚」を字義通りに実装すると byte 同一の baseline を 4 枚 commit することになる)。
 * Paths 2-5 share one baseline because their chains are byte-identical.
 * なお **`baseline-path1.png` と `baseline-path2345.png` も byte 同一** (sha `514fb55e…`、1,742 B) —
 * 経路 1 の `.extract({0,0,448,448})` が 448×448 fixture 上で恒等写像になる構造的帰結であり、
 * 検知力の欠損ではない (両 leg は独立に比較され、寸法 guard が 1:1 を排除する)。別 file で保持するのは
 * leg 単位の addressing のため。Paths 1 and 2-5 are byte-identical on this fixture as well.
 *
 * ## Layer A (byte-exact、経路 6 のみ) / Layer A, path 6 only
 *
 * 経路 6 の出力は production 側で `computeVisualSignature()` = **SHA-256** に渡され
 * `component_parts.visual_signature` に永続化されて `@@unique([sectionPatternId, visualSignature])`
 * の一意キーになる。**SHA-256 に対して「閾値内」は定義上 非検知**であり、drift は UNIQUE 制約下の
 * **新規行の silent 重複挿入**として現れて失敗シグナルが出ない。したがって byte-exact で pin する。
 * **assert は exported `cropAndResizePart()` → exported `computeVisualSignature()` を経由し、
 * テスト内で変換チェーンを再実装しない** (BI-16) — 再実装すると production 側のチェーン変更
 * (`.png({compressionLevel})` の追加 / clamp 変更 / `cropSize` 既定の変更) がテストを緑のまま通過し、
 * production の `visual_signature` だけが全変化する **production-code drift 軸**が空く。
 *
 * ## Layer B (tolerance、経路 1-5 + 7) / Layer B, the remaining 6
 *
 * これらの出力は `.raw()` → DINOv2 float 埋め込みへ流れ、**production 側に byte-hash 契約は無い**。
 * 閾値内の pixel 差は契約違反ではなく、byte-hash 化すれば legitimate な libvips patch bump を
 * すべて P0 incident に変えてしまう。よって pixelmatch の diff pixel 数 + `stats()` の
 * mean / stddev を数値 tolerance で assert する。
 * `baseline-stats.json` の `stats` 数値は **informational** であり assert には使わない — 本 test が
 * JSON から読むのは `capturedWith` のみで、比較される mean / stddev は baseline PNG を実走時に
 * decode して算出する。The `stats` numbers are informational; asserted values come from the PNGs.
 * `pixelmatch` は **RGBA (4ch) 必須**である一方 pin 対象は全て `.removeAlpha()` 済 = 3ch のため、
 * **比較用コピーにのみ `.ensureAlpha()` を適用**する (alpha は定数 255、RGB は production と同一)。
 * **production の 3ch 形状は一切変更しない**。
 *
 * **accepted-risk (F-S3A-L-09、非対称の明示)**: Layer B は経路 1-5 + 7 のチェーンを test / baseline
 * 生成 script 側で**再実装**しており、Layer A の BI-16 (再実装禁止) と異なり `kernel` / `fit` の
 * production source-pin が無い — **production が kernel を変えても Layer B は自前チェーンで baseline と
 * 一致し GREEN のまま**である。本 INV の宣言目的は bump parity (同一チェーンに対する libvips 出力の
 * 不変) であり再実装でも達成されるため gap ではない。A production kernel/fit change is out of scope here.
 *
 * ## resampler exercise の機械 guard (BI-19 / BI-21 / BI-22)
 *
 * **寸法軸 (2 軸)**: 各経路の「実効 resize 入力寸法」が resize 先と一致したら fail。
 * `.extract()` を伴う経路では **extract 領域の width/height**、伴わない経路では
 * **`sharp()` に渡した入力の寸法** (PNG なら decode 寸法、raw なら `raw` メタ) が定義であり、
 * **経路 1 は `raw` メタと `.extract()` 領域の双方**を対象に含める — raw 入力分岐では
 * `sharp()` が受理する画像寸法を決めるのは buffer 長ではなく `raw` メタであり、**どちらか一方だけを
 * 見る guard は等倍 (1:1) の silent 再導入を素通しする**ためである (SEC 実測: 602,112 B の buffer に
 * stale な `{224,224,3}` メタを添えても throw せず、4 kernel が同一 hash になる)。
 * Layer A の実効 extract 寸法は **production の `clampExtractRegion()` を import して**得る —
 * guard 側で clamp 式を複製すると production の clamp 変更で guard が silent に stale 化し、
 * BI-16 が Layer A assert に課した「再実装禁止」と同 class の drift surface を guard 層に新設する。
 *
 * **内容軸 (BI-22)**: 寸法軸だけでは不足である。SEC 実測では **単色 (128,128,128) の 448×448 を
 * 真に 2:1 縮小しても 4 kernel が同一 hash になる**ため、平坦な fixture では寸法 guard が緑のまま
 * parity INV が vacuous-green になりうる。よって fixture を高周波に限定するだけでなく、
 * **`cubic` / `nearest` / `lanczos3` / `mitchell` の出力が互いに一致しないこと**を assert する。
 *
 * **guard は閾値ではないため緩和の対象にしない**。guard が RED のとき parity INV の緑は
 * 「bump が出力を変えなかった」ことを意味しない。
 *
 * ## baseline 採取時点 / When the baseline was captured
 *
 * **bump 前 tree (`sharp@0.34.5` / `@img/sharp-libvips@1.2.4`) で採取して commit し、その後に
 * bump を適用して INV を実走する** (PR-S3 gate Stage 1 → Stage 2)。**post-bump 出力で baseline を
 * 確定させてはならない** — assert が bump に対して構造的に vacuous-green になり、U-6 の解決手段が
 * 履行不能になる。baseline は `scripts/generate-sharp-parity-baseline.ts` でのみ生成し、
 * **本 test は baseline 不在時に RED になる (自動生成しない)**。
 *
 * ## baseline 更新手順 (BI-1b) / Baseline-update procedure
 *
 * ```text
 * RED は「dedup identity drift の調査」を意味する。「とりあえず baseline を更新する」ことは禁止する。
 * 1. drift 源の切り分け — production code の変更 か / sharp・@img/sharp-libvips・bundled libvips の
 *    bump か を実測で確定する。
 * 2. データ影響の評価 — 既存 component_parts.visual_signature 行は旧 hash のまま残る。同一 crop の
 *    再抽出が新 hash になると @@unique([sectionPatternId, visualSignature]) 下で dedup が働かず
 *    「重複行の挿入」になる。既存コーパスへの影響件数を実測してから判断する。計測手法は plan v5 §4
 *    「step 2 の計測手法」に従う (即興しない)。
 * 3. 判断の記録 — 1/2 の結果と採る対処を記録し、security-engineer の sign-off を得る。
 * 4. 上記 3 を経た場合に限り baseline hash を更新する。
 *
 * platform 前提が異なる環境 (musl / 別 arch) では legitimate な差が出うるため、RED は
 * 「その環境向け baseline の生成が必要」を示すシグナルとして扱い、skip はしない。
 * ```
 *
 * ## provenance (採取時 / 実走時 / 更新時 を必ず分けて記録する)
 *
 * ```text
 * [baseline 採取時 / captured on]   2026-09-02 / sharp 0.34.5 / @img/sharp-libvips 1.2.4 /
 *                                   bundled libvips 8.17.3 / linux-x64 (glibc) / node v22.16.0
 * [INV 実走時 / run on]             実走時の sharp.versions から実測する (下記 machine assert)
 * [更新時 / updated on] (条件付き)  post-RED 更新を行った場合にのみ追記する。更新理由 /
 *                                   更新時点の sharp・@img/sharp-libvips・bundled libvips の実解決版 /
 *                                   security-engineer の sign-off 参照 / step 2 の影響件数記録への参照。
 *                                   **現時点では存在しない (BASELINE_PROVENANCE.updatedOn === null)。**
 *
 * [helper 抽出の補償実測 / helper-extraction parity]   ← BI-23 / BI-24 の記録先 (Stage 1、抽出 commit)
 *   `clampExtractRegion()` を `cropAndResizePart()` から leaf helper へ抽出した前後で、
 *   同一 fixture (448×448 checkerboard block 3px、PNG 4,565 B) に対する `cropAndResizePart()`
 *   出力 SHA-256 が **4/4 の bbox で一致**することを実測した (behaviour-invariant な code motion)。
 *   実測時 sharp 0.34.5 / bundled libvips 8.17.3 / @img/sharp-libvips 1.2.4 / linux-x64 / node v22.16.0。
 *
 *     bbox                                      抽出前 = 抽出後 SHA-256 (先頭 16 hex)   性質
 *     {x:0,y:0,w:448,h:448}                     ed4c49f1e9458612                        identity (INV fixture、clamp 恒等)
 *     {x:-10,y:5,w:500,h:500}                   82adac4994532f42                        **clamp binding** (負座標 + 画像外はみ出し)
 *     {x:0.6,y:0.4,w:447.6,h:447.4}             f5299c52f76c7b06                        **丸め + clamp binding**
 *     {x:100.5,y:200.5,w:300.5,h:150.5}         8d24d2a0b4cfa82b                        **丸めのみ** (clamp 非 binding)
 *
 *   **この bbox 集合が binding であることの controlled mutation 実測 (非空虚性の証明)**:
 *     - mutation A (min-clamp を落とす): clamp binding bbox で
 *       `Expected integer for left but received -10 of type number` を throw = loud に検知
 *       (clamp を外すと left=-10 が sharp の引数検証で弾かれる)。identity bbox では検知されない。
 *       The quoted text is the verbatim measured message (sharp 0.34.5 / bundled libvips 8.17.3).
 *     - mutation B (`Math.round` → `Math.floor`): 丸め 2 件の SHA-256 が変化 (f5299c52→d346a010 /
 *       8d24d2a0→4ea77f9a) = 検知。identity bbox と clamp binding bbox (整数座標) では **不変**。
 *   すなわち **INV 指定の fixture bbox `{0,0,448,448}` だけでは clamp / 丸めのドリフトに構造的に無感**
 *   であり、BI-23 が要求する「clamp binding ≥1 + 丸め ≥1」の追加が実際に load-bearing である。
 * ```
 *
 * **machine assert (人手確認に依存しない) / Machine asserts**:
 *   - 採取時欄 == 実走時欄 かつ 更新時欄なし → fail (**run-time が post-bump の場合に限る、下記注記**)
 *   - 採取時欄の sharp が >= 0.35 かつ 更新時欄なし → fail
 *   - 更新時欄あり → 更新時欄の版 == 実走時欄の版 を assert
 *
 * **第 1 assert の post-bump 限定について (伏せない) / On the qualifier of the first assert**:
 * 第 1 assert を無条件に実装すると **Stage 1 (bump 前 tree) で必ず fail する** — Stage 1 では採取時と
 * 実走時が同一 tree (どちらも 0.34.5) になるのが**正しい状態**だからであり、plan v5 §3 Stage 1 の
 * 判定基準「生成物に対し INV が緑になることを確認」と両立しない。第 1 assert の目的は
 * 「**bump 後に baseline を採り直した**」ことの検知であるため、run-time が post-bump
 * (`sharp >= 0.35`) のときにのみ発火させる。**Stage 2 (post-bump) では run-time が必ず >= 0.35 なので
 * 無条件形と挙動が完全に一致し、検知力の低下は 0 である** — 変わるのは Stage 1 の false-RED のみ。
 * 実際の bump 検知器である第 2 assert は**無条件**で実装している。
 * Implementing the first assert unconditionally would make it fail at Stage 1 by construction
 * (capture-time and run-time are the same pre-bump tree there, which is the correct state), which
 * contradicts the Stage 1 pass criterion. It is therefore gated on the run-time tree being
 * post-bump; at Stage 2 the run-time is always `>= 0.35`, so the gated and ungated forms are
 * behaviourally identical and **no detection power is lost** — only the Stage 1 false-RED changes.
 * The second assert (the actual bump detector) is implemented **unconditionally**.
 */

// INV-SHARP-PIPELINE-PARITY-001

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  clampExtractRegion,
  computeVisualSignature,
  cropAndResizePart,
} from "../../../../src/services/part/part-extraction.service";
import { DEFAULT_PART_EXTRACTION_CONFIG } from "../../../../src/services/part/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_MCP_SERVER = join(HERE, "..", "..", "..", "..");
const FIXTURE_DIR = join(HERE, "_fixtures", "sharp-parity");

// ---------------------------------------------------------------------------
// 固定パラメータ (plan v5 §4 fixture 表で plan 側が指定した値)
// Fixed parameters, specified plan-side in the §4 fixture table
// ---------------------------------------------------------------------------

/** 入力 fixture の寸法。resize 先 224 の 2 倍 → 等倍 (1:1) を構造的に排除する (BI-19) */
const FIXTURE_SIZE = 448;

/** Layer B の resize 先。SSOT は `packages/ml/src/dinov2/service.ts` の `DINOV2_INPUT_SIZE` */
const DINOV2_INPUT_SIZE = 224;

/** Layer A の bbox / cropSize。cropSize の SSOT は `DEFAULT_PART_EXTRACTION_CONFIG.cropSize` */
const LAYER_A_BBOX = { x: 0, y: 0, width: FIXTURE_SIZE, height: FIXTURE_SIZE };
const LAYER_A_CROP_SIZE = DEFAULT_PART_EXTRACTION_CONFIG.cropSize;

/**
 * 経路 1 の raw 入力分岐のメタと extract 領域。
 * **guard と leg が同一の定数を参照する**ことで、どちらかを 224 に戻した瞬間に guard が発火する。
 */
const PATH1_RAW_META = { width: FIXTURE_SIZE, height: FIXTURE_SIZE, channels: 3 as const };
const PATH1_EXTRACT = { left: 0, top: 0, width: FIXTURE_SIZE, height: FIXTURE_SIZE };

/** Layer A baseline — bump 前 tree で採取した SHA-256 hex 定数 (バイナリ成果物を追加しない) */
const LAYER_A_BASELINE_SHA256 = "ed4c49f1e9458612b0d335e59f766bf649e5dffa00ddd01fa144143530aa87fd";

/** 閾値 (plan v5 §4「閾値の初期値と platform 前提」)。**緩和しない** */
const PIXELMATCH_THRESHOLD = 0.1;
const MAX_DIFF_PIXELS = Math.floor(DINOV2_INPUT_SIZE * DINOV2_INPUT_SIZE * 0.001); // 0.1% = 50 px
const STATS_TOLERANCE = 0.5;

/** post-bump 判定の境界 (`sharp` 宣言 `^0.34.5` → `^0.35.3`) */
const POST_BUMP_SHARP_MINOR = 35;

/** baseline provenance。JSDoc の provenance ブロックはこの定数を逐語で写している (drift pin 済) */
const BASELINE_PROVENANCE = {
  capturedOn: {
    date: "2026-09-02",
    sharp: "0.34.5",
    imgSharpLibvips: "1.2.4",
    bundledLibvips: "8.17.3",
    platform: "linux-x64 (glibc)",
    node: "v22.16.0",
  },
  /** post-RED 更新を行った場合にのみ非 null にする (BI-1b の手順 1-4 を経ること) */
  updatedOn: null as null | { sharp: string; bundledLibvips: string },
} as const;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readFixtureOrThrow(name: string): Buffer {
  const p = join(FIXTURE_DIR, name);
  if (!existsSync(p)) {
    // baseline 不在は RED。自動生成しない (plan v5 §3「baseline 生成経路の性格」(b))
    throw new Error(
      `INV-SHARP-PIPELINE-PARITY-001: baseline artifact missing: ${p}. ` +
        `This test NEVER auto-generates it — run scripts/generate-sharp-parity-baseline.ts ` +
        `on the PRE-BUMP tree (see BI-1b before regenerating).`
    );
  }
  return readFileSync(p);
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function sharpMinor(version: string): number {
  const m = /^(\d+)\.(\d+)\./.exec(version);
  if (!m) throw new Error(`unparsable sharp version: ${version}`);
  return Number(m[1]) * 1000 + Number(m[2]);
}

const POST_BUMP_BOUNDARY = 0 * 1000 + POST_BUMP_SHARP_MINOR;

/** 経路 1: raw 入力 + `.extract()` (production `phase-5-embedding.ts` と同型) */
async function path1Rgba(fixturePng: Buffer): Promise<Buffer> {
  const decoded = await sharp(fixturePng).removeAlpha().raw().toBuffer();
  return sharp(decoded, { raw: PATH1_RAW_META })
    .extract(PATH1_EXTRACT)
    .resize(DINOV2_INPUT_SIZE, DINOV2_INPUT_SIZE, { fit: "cover", kernel: "cubic" })
    .removeAlpha()
    .toColorspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/** 経路 2-5: チェーン同一 → baseline 共有 */
async function path2345Rgba(fixturePng: Buffer): Promise<Buffer> {
  return sharp(fixturePng)
    .resize(DINOV2_INPUT_SIZE, DINOV2_INPUT_SIZE, { fit: "cover", kernel: "cubic" })
    .removeAlpha()
    .toColorspace("srgb")
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/** 経路 7: クエリ側 (`fill` / `center` / colorspace 変換なし) */
async function path7Rgba(fixturePng: Buffer): Promise<Buffer> {
  return sharp(fixturePng)
    .resize(DINOV2_INPUT_SIZE, DINOV2_INPUT_SIZE, { fit: "fill", position: "center" })
    .removeAlpha()
    .ensureAlpha()
    .raw()
    .toBuffer();
}

async function decodeBaselineRgba(name: string): Promise<Buffer> {
  // baseline は比較側と同じく 4ch として decode する (3ch のままだと pixelmatch が長さ不一致で throw)
  return sharp(readFixtureOrThrow(name)).ensureAlpha().raw().toBuffer();
}

async function statsOfRgba(rgba: Buffer): Promise<Array<{ mean: number; stdev: number }>> {
  const s = await sharp(rgba, {
    raw: { width: DINOV2_INPUT_SIZE, height: DINOV2_INPUT_SIZE, channels: 4 },
  }).stats();
  return s.channels.map((c) => ({ mean: c.mean, stdev: c.stdev }));
}

// ---------------------------------------------------------------------------

describe("INV-SHARP-PIPELINE-PARITY-001", () => {
  // =========================================================================
  // resampler exercise guard — 寸法軸 (BI-19 / BI-21)
  // =========================================================================
  describe("guard: 実効 resize 入力寸法 ≠ resize 先 (寸法軸) / effective resize input != target", () => {
    it("Layer A (経路 6): clampExtractRegion の実効 extract 寸法が cropSize と一致しない", async () => {
      const meta = await sharp(readFixtureOrThrow("fixture-448.png")).metadata();
      expect(meta.width).toBe(FIXTURE_SIZE);
      expect(meta.height).toBe(FIXTURE_SIZE);

      // production の SSOT helper を import して実効寸法を得る (clamp 式を複製しない)
      const region = clampExtractRegion(LAYER_A_BBOX, meta.width ?? 0, meta.height ?? 0);

      expect(region.width).not.toBe(LAYER_A_CROP_SIZE);
      expect(region.height).not.toBe(LAYER_A_CROP_SIZE);
      // 2 倍縮小であることまで固定する (等倍の silent 再導入を構造的に排除)
      expect(region.width).toBe(LAYER_A_CROP_SIZE * 2);
      expect(region.height).toBe(LAYER_A_CROP_SIZE * 2);
    });

    it("Layer B 経路 1: raw メタ と .extract() 領域 の双方が resize 先と一致しない", () => {
      // 片方だけを見る guard は等倍の silent 再導入を素通しするため、双方を assert する
      expect(PATH1_RAW_META.width).not.toBe(DINOV2_INPUT_SIZE);
      expect(PATH1_RAW_META.height).not.toBe(DINOV2_INPUT_SIZE);
      expect(PATH1_EXTRACT.width).not.toBe(DINOV2_INPUT_SIZE);
      expect(PATH1_EXTRACT.height).not.toBe(DINOV2_INPUT_SIZE);
    });

    it("Layer B 経路 2-5 / 7: sharp() 入力の decode 寸法が resize 先と一致しない", async () => {
      const meta = await sharp(readFixtureOrThrow("fixture-448.png")).metadata();
      expect(meta.width).not.toBe(DINOV2_INPUT_SIZE);
      expect(meta.height).not.toBe(DINOV2_INPUT_SIZE);
    });

    it("経路 1 の raw メタは decode 済 buffer の実長と整合する (stale メタは silent 1:1 になる)", async () => {
      const decoded = await sharp(readFixtureOrThrow("fixture-448.png"))
        .removeAlpha()
        .raw()
        .toBuffer();
      expect(decoded.length).toBe(
        PATH1_RAW_META.width * PATH1_RAW_META.height * PATH1_RAW_META.channels
      );
    });
  });

  // =========================================================================
  // resampler exercise guard — 内容軸 (BI-22)
  // =========================================================================
  describe("guard: fixture が resampler を discriminate する (内容軸 / BI-22)", () => {
    it("4 kernel (cubic / nearest / lanczos3 / mitchell) の出力が互いに一致しない", async () => {
      const fixturePng = readFixtureOrThrow("fixture-448.png");
      const kernels = ["cubic", "nearest", "lanczos3", "mitchell"] as const;

      const hashes = await Promise.all(
        kernels.map(async (kernel) =>
          sha256(
            await sharp(fixturePng)
              .extract(PATH1_EXTRACT)
              .resize(DINOV2_INPUT_SIZE, DINOV2_INPUT_SIZE, { fit: "cover", kernel })
              .removeAlpha()
              .toColorspace("srgb")
              .toBuffer()
          )
        )
      );

      // 単色 / 低周波 fixture では 4 kernel が同一 hash になり、寸法 guard は緑のまま
      // parity INV が vacuous-green になる。相互非一致がその失敗モードを閉じる。
      expect(new Set(hashes).size).toBe(kernels.length);
    });
  });

  // =========================================================================
  // provenance machine asserts (BI-15)
  // =========================================================================
  describe("baseline provenance (BI-15)", () => {
    it("採取時欄の sharp が post-bump (>= 0.35) かつ 更新時欄なし → fail (無条件)", () => {
      if (BASELINE_PROVENANCE.updatedOn === null) {
        expect(sharpMinor(BASELINE_PROVENANCE.capturedOn.sharp)).toBeLessThan(POST_BUMP_BOUNDARY);
      }
    });

    it("採取時欄 == 実走時欄 かつ 更新時欄なし → fail (run-time が post-bump のときのみ発火)", () => {
      const runtimeSharp = sharp.versions.sharp;
      const runtimeIsPostBump = sharpMinor(runtimeSharp) >= POST_BUMP_BOUNDARY;

      if (runtimeIsPostBump && BASELINE_PROVENANCE.updatedOn === null) {
        expect(BASELINE_PROVENANCE.capturedOn.sharp).not.toBe(runtimeSharp);
      } else {
        // Stage 1 (pre-bump): 採取時 == 実走時 が正しい状態。ここでは採取時が pre-bump であることを pin
        expect(sharpMinor(BASELINE_PROVENANCE.capturedOn.sharp)).toBeLessThan(POST_BUMP_BOUNDARY);
      }
    });

    it("更新時欄あり → 更新時欄の版 == 実走時欄の版", () => {
      const updated = BASELINE_PROVENANCE.updatedOn;
      if (updated !== null) {
        expect(updated.sharp).toBe(sharp.versions.sharp);
        expect(updated.bundledLibvips).toBe(sharp.versions.vips);
      } else {
        expect(updated).toBeNull();
      }
    });

    it("JSDoc の provenance ブロックが BASELINE_PROVENANCE と一致する (drift pin)", () => {
      const src = readFileSync(join(HERE, "inv-sharp-pipeline-parity-001.test.ts"), "utf8");
      const jsdoc = src.slice(0, src.indexOf("// INV-SHARP-PIPELINE-PARITY-001"));

      // 3 欄のラベルが provenance ブロックに存在する
      expect(jsdoc).toContain("[baseline 採取時 / captured on]");
      expect(jsdoc).toContain("[INV 実走時 / run on]");
      expect(jsdoc).toContain("[更新時 / updated on]");
      // BI-24 の記録先 (helper 抽出の補償実測) が存在する
      expect(jsdoc).toContain("[helper 抽出の補償実測 / helper-extraction parity]");

      // 採取時の版が JSDoc と定数で一致する (どちらかを直し忘れたら RED)
      expect(jsdoc).toContain(`sharp ${BASELINE_PROVENANCE.capturedOn.sharp}`);
      expect(jsdoc).toContain(
        `@img/sharp-libvips ${BASELINE_PROVENANCE.capturedOn.imgSharpLibvips}`
      );
      expect(jsdoc).toContain(`bundled libvips ${BASELINE_PROVENANCE.capturedOn.bundledLibvips}`);
      expect(jsdoc).toContain(BASELINE_PROVENANCE.capturedOn.date);
    });

    it("BI-24: helper 抽出の補償実測が clamp binding / 丸め の双方を記録している", () => {
      const src = readFileSync(join(HERE, "inv-sharp-pipeline-parity-001.test.ts"), "utf8");
      const jsdoc = src.slice(0, src.indexOf("// INV-SHARP-PIPELINE-PARITY-001"));

      expect(jsdoc).toContain("clamp binding");
      expect(jsdoc).toContain("丸め");
      // Layer A baseline と同じ SHA が identity 行に記録されている (帰属の一貫性)
      expect(jsdoc).toContain(LAYER_A_BASELINE_SHA256.slice(0, 16));
    });
  });

  // =========================================================================
  // Layer A — byte-exact (経路 6 のみ)
  // =========================================================================
  describe("Layer A (byte-exact、経路 6 のみ)", () => {
    it("exported cropAndResizePart() → exported computeVisualSignature() が baseline hash と完全一致", async () => {
      const fixturePng = readFixtureOrThrow("fixture-448.png");

      // BI-16: チェーンを再実装せず、production の SSOT 関数を経由する
      const cropBuffer = await cropAndResizePart(fixturePng, LAYER_A_BBOX, LAYER_A_CROP_SIZE);
      const signature = computeVisualSignature(cropBuffer);

      expect(signature).toBe(LAYER_A_BASELINE_SHA256);
    });

    it("経路 6 の終端は .toBuffer() = エンコード後バイトである (drift 面が PNG encoder にも及ぶ)", async () => {
      const fixturePng = readFixtureOrThrow("fixture-448.png");
      const cropBuffer = await cropAndResizePart(fixturePng, LAYER_A_BBOX, LAYER_A_CROP_SIZE);

      // raw ではなくエンコード後バイトであること: raw なら 224*224*3 = 150,528 B になる
      expect(cropBuffer.length).not.toBe(DINOV2_INPUT_SIZE * DINOV2_INPUT_SIZE * 3);
      const meta = await sharp(cropBuffer).metadata();
      expect(meta.width).toBe(LAYER_A_CROP_SIZE);
      expect(meta.height).toBe(LAYER_A_CROP_SIZE);
    });
  });

  // =========================================================================
  // Layer B — tolerance (経路 1-5 + 7)
  // =========================================================================
  describe("Layer B (tolerance、経路 1-5 + 7)", () => {
    const legs: Array<{
      label: string;
      baseline: string;
      run: (fixturePng: Buffer) => Promise<Buffer>;
    }> = [
      { label: "経路 1 (raw 入力 + extract)", baseline: "baseline-path1.png", run: path1Rgba },
      { label: "経路 2-5 (共有)", baseline: "baseline-path2345.png", run: path2345Rgba },
      { label: "経路 7 (クエリ側)", baseline: "baseline-path7.png", run: path7Rgba },
    ];

    for (const leg of legs) {
      it(`${leg.label}: pixel diff <= ${MAX_DIFF_PIXELS} px`, async () => {
        const fixturePng = readFixtureOrThrow("fixture-448.png");
        const actual = await leg.run(fixturePng);
        const baseline = await decodeBaselineRgba(leg.baseline);

        expect(actual.length).toBe(baseline.length);
        const diff = pixelmatch(baseline, actual, null, DINOV2_INPUT_SIZE, DINOV2_INPUT_SIZE, {
          threshold: PIXELMATCH_THRESHOLD,
        });

        expect(diff).toBeLessThanOrEqual(MAX_DIFF_PIXELS);
      });

      it(`${leg.label}: stats() mean / stddev が ±${STATS_TOLERANCE} 以内`, async () => {
        const fixturePng = readFixtureOrThrow("fixture-448.png");
        const actualStats = await statsOfRgba(await leg.run(fixturePng));
        const baselineStats = await statsOfRgba(await decodeBaselineRgba(leg.baseline));

        expect(actualStats.length).toBe(baselineStats.length);
        for (let i = 0; i < actualStats.length; i++) {
          expect(Math.abs(actualStats[i].mean - baselineStats[i].mean)).toBeLessThanOrEqual(
            STATS_TOLERANCE
          );
          expect(Math.abs(actualStats[i].stdev - baselineStats[i].stdev)).toBeLessThanOrEqual(
            STATS_TOLERANCE
          );
        }
      });
    }

    it("baseline-stats.json の採取時版が provenance と一致する", () => {
      const json = JSON.parse(readFixtureOrThrow("baseline-stats.json").toString("utf8")) as {
        capturedWith: { sharp: string; libvips: string };
      };
      expect(json.capturedWith.sharp).toBe(BASELINE_PROVENANCE.capturedOn.sharp);
      expect(json.capturedWith.libvips).toBe(BASELINE_PROVENANCE.capturedOn.bundledLibvips);
    });
  });

  // =========================================================================
  // SSOT source-pin (import せずに定数の一致を pin する)
  // =========================================================================
  describe("SSOT source-pin", () => {
    it("DINOV2_INPUT_SIZE の SSOT が本 test の定数と一致する", () => {
      const mlSrc = readFileSync(
        join(REPO_MCP_SERVER, "..", "..", "packages", "ml", "src", "dinov2", "service.ts"),
        "utf8"
      );
      const m = /export const DINOV2_INPUT_SIZE\s*=\s*(\d+)/.exec(mlSrc);
      expect(m).not.toBeNull();
      expect(Number(m?.[1])).toBe(DINOV2_INPUT_SIZE);
    });

    it("cropSize の SSOT (DEFAULT_PART_EXTRACTION_CONFIG) が 224 である", () => {
      expect(LAYER_A_CROP_SIZE).toBe(224);
    });

    it("clampExtractRegion / cropAndResizePart / computeVisualSignature が part barrel から export されている", () => {
      const barrel = readFileSync(
        join(REPO_MCP_SERVER, "src", "services", "part", "index.ts"),
        "utf8"
      );
      expect(barrel).toContain("clampExtractRegion");
      expect(barrel).toContain("cropAndResizePart");
      expect(barrel).toContain("computeVisualSignature");
    });

    it("production の clamp は clampExtractRegion 単一定義である (guard の複製を排除)", () => {
      const svc = readFileSync(
        join(REPO_MCP_SERVER, "src", "services", "part", "part-extraction.service.ts"),
        "utf8"
      );
      // clamp の 4 式が helper の中にのみ存在する = cropAndResizePart 側に複製が残っていない
      const occurrences = svc.split("Math.max(0, Math.round(boundingBox.x))").length - 1;
      expect(occurrences).toBe(1);
      expect(svc).toContain("clampExtractRegion(boundingBox, imgWidth, imgHeight)");
    });
  });
});
