// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * clampExtractRegion() Unit Tests (T-S3A-04)
 *
 * `clampExtractRegion()` は PR-S3a の behaviour-invariant な code motion で
 * `cropAndResizePart()` のインライン 4 式から切り出された leaf helper であり、
 * **production の唯一の clamp 定義**である。
 * `INV-SHARP-PIPELINE-PARITY-001` の寸法軸 guard は本 helper を import して
 * 「実効 extract 寸法」を導出するため、本 helper の挙動が silent に変わると
 * guard 側が stale 化する。
 *
 * 本 test は S3a INV の JSDoc (BI-23 / BI-24 の補償実測) が既に pin している
 * 4 領域を **同じ 448x448 前提で unit 層にも固定**し、加えて barrel export
 * (`src/services/part/index.ts`) 経由で公開されていることを regex で pin する。
 *
 * `clampExtractRegion()` is the **single production clamp definition**, extracted
 * from the four inline expressions in `cropAndResizePart()` by a behaviour-invariant
 * code motion in PR-S3a. The `INV-SHARP-PIPELINE-PARITY-001` dimension-axis guard
 * imports it to derive the "effective extract dimensions", so a silent behaviour
 * change here would make that guard stale. These tests pin, at the unit layer, the
 * same four regions the S3a INV JSDoc already records (BI-23 / BI-24 compensating
 * measurement) under the same 448x448 assumption, plus a regex pin that the helper
 * is exposed through the part barrel.
 *
 * mutation 感度 (S3a INV JSDoc 由来) / Mutation sensitivity (from the S3a INV JSDoc):
 *   - mutation A (min-clamp を落とす): clamp binding 領域で left/top が負に漏れる
 *   - mutation B (`Math.round` -> `Math.floor`): 丸め 2 領域の結果が変わる
 * 本 test は A / B の双方を unit 層で loud に検知する。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// テスト対象のモジュール / Module under test
import { clampExtractRegion } from "../../../src/services/part/part-extraction.service";
// barrel 経由でも同一 helper が解決できること / same helper must resolve via the barrel
import { clampExtractRegion as clampFromBarrel } from "../../../src/services/part/index";

/** S3a INV fixture と同一の画像寸法 / same image size as the S3a INV fixture */
const IMG_W = 448;
const IMG_H = 448;

describe("clampExtractRegion() (T-S3A-04)", () => {
  describe("S3a INV JSDoc が pin する 4 領域 / the four regions pinned by the S3a INV JSDoc", () => {
    it("identity: 画像全体と一致する領域は恒等写像 (clamp 非 binding / 丸め非発生)", () => {
      // S3a INV の fixture bbox。clamp も丸めも効かないため drift に無感 = 他 3 件が load-bearing
      expect(clampExtractRegion({ x: 0, y: 0, width: 448, height: 448 }, IMG_W, IMG_H)).toEqual({
        left: 0,
        top: 0,
        width: 448,
        height: 448,
      });
    });

    it("clamp binding: 負座標 + 画像外はみ出しが両端でクランプされる", () => {
      // left: max(0, -10) = 0 / height: min(500, 448-5) = 443
      // mutation A (min-clamp 除去) では left=-10 が漏れてここが RED になる
      expect(clampExtractRegion({ x: -10, y: 5, width: 500, height: 500 }, IMG_W, IMG_H)).toEqual({
        left: 0,
        top: 5,
        width: 448,
        height: 443,
      });
    });

    it("丸め + clamp binding: 0.5 未満/以上の丸めと残り幅クランプが同時に効く", () => {
      // left: round(0.6)=1 / top: round(0.4)=0 / width: min(round(447.6)=448, 448-1=447) = 447
      // mutation B (round -> floor) では left が 1 -> 0 になりここが RED になる。
      // width は両変種とも 447 (floor 変種でも min(447, 448-0)=447、TDA harness 実測) ゆえ
      // 本ケースの弁別子は left のみ。
      expect(
        clampExtractRegion({ x: 0.6, y: 0.4, width: 447.6, height: 447.4 }, IMG_W, IMG_H)
      ).toEqual({
        left: 1,
        top: 0,
        width: 447,
        height: 447,
      });
    });

    it("丸めのみ: .5 は round-half-up される (clamp は非 binding)", () => {
      // round(100.5)=101 / round(200.5)=201 / round(300.5)=301 / round(150.5)=151
      // いずれも残り幅・高さの内側なので clamp は効かない
      expect(
        clampExtractRegion({ x: 100.5, y: 200.5, width: 300.5, height: 150.5 }, IMG_W, IMG_H)
      ).toEqual({
        left: 101,
        top: 201,
        width: 301,
        height: 151,
      });
    });
  });

  describe("clamp 契約の境界 / clamp contract boundaries", () => {
    it("完全に画像内の領域は clamp されない (no-op)", () => {
      expect(clampExtractRegion({ x: 10, y: 20, width: 100, height: 50 }, IMG_W, IMG_H)).toEqual({
        left: 10,
        top: 20,
        width: 100,
        height: 50,
      });
    });

    it("left/top は負にならない (mutation A の直接 pin)", () => {
      const r = clampExtractRegion({ x: -500, y: -500, width: 10, height: 10 }, IMG_W, IMG_H);
      expect(r.left).toBe(0);
      expect(r.top).toBe(0);
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeGreaterThanOrEqual(0);
    });

    it("width/height は最低 1 を下回らない (原点が画像外でも sharp に 0 を渡さない)", () => {
      // left が画像幅ちょうどに載る場合、残り幅は 0 だが max(1, ...) で 1 に持ち上がる
      const r = clampExtractRegion({ x: 448, y: 448, width: 100, height: 100 }, IMG_W, IMG_H);
      expect(r.width).toBeGreaterThanOrEqual(1);
      expect(r.height).toBeGreaterThanOrEqual(1);
    });

    it("戻り値は全て整数である (sharp .extract() の引数検証を満たす)", () => {
      const r = clampExtractRegion({ x: 0.6, y: 200.5, width: 447.6, height: 150.5 }, IMG_W, IMG_H);
      for (const v of [r.left, r.top, r.width, r.height]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    });
  });

  describe("barrel export pin (T-S3A-04)", () => {
    it("part barrel が clampExtractRegion を re-export している (source regex pin)", () => {
      const barrelSrc = readFileSync(
        join(__dirname, "../../../src/services/part/index.ts"),
        "utf8"
      );
      // export ブロック内に helper 名が並ぶこと + 供給元が part-extraction.service であること
      expect(barrelSrc).toMatch(/^\s*clampExtractRegion,$/m);
      expect(barrelSrc).toMatch(
        /export\s*\{[^}]*\bclampExtractRegion\b[^}]*\}\s*from\s*"\.\/part-extraction\.service"/s
      );
    });

    it("barrel 経由の import が service 直 import と同一関数を指す", () => {
      expect(clampFromBarrel).toBe(clampExtractRegion);
    });
  });
});
