// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * 撮影前に有限のアニメーションの完了を待つ / Wait for finite animations before a screenshot
 *
 * 字ごとのフェードインのような有限の CSS / Web Animations が終わる前に撮ると、UI が写らない
 * （2026-11-08 kurokawawonderland.jp）。`document.getAnimations()` で document timeline 上の
 * 実行中かつ終了時刻が有限のアニメーションを集め、`finished` を上限付きで待つ。
 * 無限ループ・一時停止中・スクロール連動（document timeline 以外）のアニメーションは待たない。
 * 少し遅れて script が始めるアニメーションも拾うため、何も走っていない状態が
 * `QUIET_WINDOW_MS` 続いたら終える。
 *
 * Taking the shot before a finite fade-in finishes leaves the UI out of it. This collects
 * running animations on the document timeline whose end time is finite and waits for their
 * `finished` promises, bounded by a cap. Infinite, paused and scroll-driven (non-document
 * timeline) animations are skipped. To catch animations a script starts a moment later,
 * it returns only after nothing has been running for `QUIET_WINDOW_MS`.
 *
 * INV-CAPTURE-FINITE-ANIMATION-WAIT-001
 */

import type { Page } from "playwright";

/** 撮影前の待ちの既定上限(ms) / Default cap for the pre-screenshot wait (ms) */
export const FINITE_ANIMATION_WAIT_MAX_MS = 5000;

/** 何も走っていないと判断するまでの時間(ms) / Quiet time before the wait ends (ms) */
const QUIET_WINDOW_MS = 150;

/** Node 側の上限に足す余裕(ms) / Grace added to the Node-side cap (ms) */
const NODE_CAP_GRACE_MS = 1000;

export interface FiniteAnimationWaitResult {
  /** 待った有限アニメーションの数 / Number of finite animations waited for */
  animationCount: number;
  /** 待った時間(ms) / Time spent waiting (ms) */
  waitedMs: number;
  /** 上限で打ち切ったか / Whether the cap ended the wait */
  timedOut: boolean;
}

/**
 * 有限のアニメーションの完了を上限付きで待つ / Wait, with a cap, for finite animations to finish
 *
 * @param page - Playwright ページ / Playwright page
 * @param maxWaitMs - 待つ上限(ms)。0 以下なら待たない / Cap in ms; 0 or less skips the wait
 */
export async function waitForFiniteAnimations(
  page: Page,
  maxWaitMs: number = FINITE_ANIMATION_WAIT_MAX_MS
): Promise<FiniteAnimationWaitResult> {
  if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) {
    return { animationCount: 0, waitedMs: 0, timedOut: false };
  }

  // ブラウザ側の処理は文字列で渡す。tsx (esbuild keepNames) が関数内の名前付き binding に
  // `__name` を差し込み、ブラウザで ReferenceError になるのを避ける
  // (INV-PAGE-EVALUATE-NO-NAME-INJECTION-001)。引数は数値だけで、JSON で埋め込む。
  // The browser-side code is passed as a string so tsx (esbuild keepNames) cannot inject
  // `__name` into named bindings. Only numbers are embedded, via JSON.
  const script = `(async function (maxWait, quietMs) {
    var start = performance.now();
    var seen = new Set();
    function sleep(ms) { return new Promise(function (r) { setTimeout(r, Math.max(0, ms)); }); }
    function elapsed() { return performance.now() - start; }
    function running() {
      return document.getAnimations().filter(function (a) {
        if (!(a.timeline instanceof DocumentTimeline)) return false;
        if (a.playState !== "running") return false;
        var end = a.effect ? a.effect.getComputedTiming().endTime : undefined;
        return typeof end === "number" && isFinite(end);
      });
    }
    var quietSince = null;
    while (elapsed() < maxWait) {
      var list = running();
      if (list.length === 0) {
        if (quietSince === null) quietSince = elapsed();
        if (elapsed() - quietSince >= quietMs) {
          return { animationCount: seen.size, waitedMs: Math.round(elapsed()), timedOut: false };
        }
        await sleep(Math.min(50, maxWait - elapsed()));
        continue;
      }
      quietSince = null;
      list.forEach(function (a) { seen.add(a); });
      await Promise.race([
        Promise.allSettled(list.map(function (a) { return a.finished; })),
        sleep(maxWait - elapsed())
      ]);
    }
    return { animationCount: seen.size, waitedMs: Math.round(elapsed()), timedOut: true };
  })(${JSON.stringify(maxWaitMs)}, ${JSON.stringify(QUIET_WINDOW_MS)})`;

  // ページ内の時計やタイマーはページが書き換えられるので、上限は Node 側のタイマーでも守る
  // (SEC M-1、CWE-770)。時間切れなら打ち切ったものとして扱う。
  // The page can override its own clock and timers, so the cap is also enforced by a
  // Node-side timer (SEC M-1, CWE-770); hitting it counts as timed out.
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const nodeCap = new Promise<FiniteAnimationWaitResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ animationCount: 0, waitedMs: Date.now() - startedAt, timedOut: true }),
      maxWaitMs + NODE_CAP_GRACE_MS
    );
  });
  const evaluation = page.evaluate(script) as Promise<FiniteAnimationWaitResult>;
  // 打ち切った後に evaluate が失敗しても未処理の reject にしない / no unhandled rejection after the cap
  evaluation.catch(() => undefined);
  try {
    return await Promise.race([evaluation, nodeCap]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
