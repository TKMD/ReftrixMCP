// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SERVER_CONFIG.version ↔ package.json.version coherence
 *
 * `SERVER_CONFIG.version`（`src/server.ts`）は MCP handshake の
 * `serverInfo.version` として返却される。この値は publishable
 * `apps/mcp-server/package.json.version` とハードコードで二重管理されており、
 * リリース時に片方だけ更新すると drift する（v0.6.0 リリースサイクルで
 * 実際に `0.3.0` の stale 値が残存し、MCP クライアントに誤ったバージョンが
 * 見えていた）。
 *
 * 本テストは両者の equality を **毎 CI 実行**で検証し、ハードコード drift の
 * クラスを閉じる。SSOT-derive（静的 JSON import / 実行時読込）は build 契約
 * （`rootDir: ./src` 外の package.json）を壊す/起動 I/O fragility を生むため
 * 採用せず、代わりに本 equality テストで drift を検出する（`src/server.ts`
 * `SERVER_CONFIG` の JSDoc 参照）。
 *
 * This test asserts equality between `SERVER_CONFIG.version` (the MCP handshake
 * `serverInfo.version`) and the publishable `apps/mcp-server/package.json.version`
 * on every CI run, closing the hardcode-drift class (in the v0.6.0 release cycle
 * a stale `0.3.0` literal actually persisted, so MCP clients saw the wrong
 * version). SSOT-derive is intentionally not used (it breaks the build contract
 * or adds startup-I/O fragility); this equality test is the drift detector.
 *
 * ---
 *
 * ## R1 — HealthCheckService version surface removed / HealthCheckService の version surface 撤去
 *
 * 以前は `HealthCheckService`（`src/api/health.ts`）を「第 3 の version surface」
 * として本テストで併せて検証していた（TPA-DF-L-01）。その後 R1 の評価で
 * `HealthCheckService`（および `api/health.ts` の全 export）が src 内 construction
 * site ゼロの dead code（stdio MCP サーバーに HTTP `GET /api/health` を配線する
 * 経路が存在しない vestigial endpoint）であることを確認したため、`api/health.ts`
 * ごと削除した。dead surface を防御配線（`?? SERVER_CONFIG.version`）で残すより、
 * surface 自体を消す方が drift のクラスを構造的に閉じる（strictly better）。
 * よって本テストの HealthCheckService leg も撤去した。実 version surface は
 * MCP handshake（`SERVER_CONFIG.version`）のみであり、`system.health` ツール
 * （`src/tools/system-health.ts`）は version を報告しない。
 *
 * Previously this test also verified `HealthCheckService` (`src/api/health.ts`)
 * as a "3rd version surface" (TPA-DF-L-01). The R1 evaluation then confirmed
 * `HealthCheckService` (and every export of `api/health.ts`) was dead code — a
 * vestigial HTTP `GET /api/health` endpoint with zero construction sites, never
 * wired into the stdio MCP server — so `api/health.ts` was deleted. Removing the
 * surface closes the drift class structurally (strictly better than keeping the
 * dead surface behind a defensive `?? SERVER_CONFIG.version` fallback). The
 * HealthCheckService leg of this test was therefore removed too. The only real
 * version surface is the MCP handshake (`SERVER_CONFIG.version`); the
 * `system.health` tool (`src/tools/system-health.ts`) reports no version.
 *
 * ---
 *
 * ## TPA-DF-L-02 — test placement (plain unit vs standing INV) / テスト配置の評価
 *
 * 評価結果: 本テストは **plain unit test のまま維持**する（standing regression
 * schema-enum-sync domain へは昇格しない）。
 *
 * Evaluation outcome: this test is **kept as a plain unit test** (NOT promoted to
 * the standing regression schema-enum-sync domain).
 *
 * 根拠 / Rationale:
 * 1. **毎 `pnpm test` 実行が本テストの本質価値** — default `vitest.config.mts` は
 *    `tests/regression/standing/**` を exclude する。standing へ昇格すると、この
 *    `SERVER_CONFIG.version ↔ package.json.version` equality が local `pnpm test`
 *    および default CI unit job から外れ、別 job（`regression-standing`、Docker /
 *    testcontainer boot gate 付き）でしか走らなくなる。本テストの目的は「code literal
 *    が package.json を追従しない drift を **どのコミットでも即座に** 検出する」こと
 *    であり、~1ms の純 fs + import チェックを重い testcontainer harness の背後に置くのは
 *    アーキテクチャ的に不適切。
 *    The every-`pnpm test` execution is this test's essential value — the default
 *    config excludes `tests/regression/standing/**`, so promotion would drop this
 *    equality from local `pnpm test` and the default CI unit job, leaving it only in
 *    the separate Docker/testcontainer-gated `regression-standing` job. Its purpose
 *    is to catch code-literal-vs-package.json drift on *every* commit; putting a
 *    ~1ms pure fs+import check behind the heavy testcontainer harness is wrong.
 * 2. **既存 `INV-RELEASE-VERSION-COHERENCE-001` との補完関係** — schema-enum-sync
 *    domain には既に `INV-RELEASE-VERSION-COHERENCE-001`（`tests/regression/standing/
 *    schema-enum-sync/inv-release-version-coherence-001.test.ts`）があり、
 *    `git tag --points-at HEAD`（vX.Y.Z）↔ publishable `package.json.version` の
 *    equality を **release-tag commit でのみ** 検証する（非 release commit では skip）。
 *    本テストは `SERVER_CONFIG.version`（code literal）↔ `package.json.version` を
 *    **毎コミット** 検証する。両者は version-coherence chain の別 leg
 *    （code ↔ pkg / pkg ↔ tag）であり補完的。standing へ複製すると重複、単独移動すると
 *    毎コミットの code-literal drift 検出を失う。
 *    Complementary to `INV-RELEASE-VERSION-COHERENCE-001` (schema-enum-sync) which
 *    verifies `git tag --points-at HEAD` ↔ publishable `package.json.version` *only at
 *    release-tag commits* (skips non-release commits). This test verifies
 *    `SERVER_CONFIG.version` (code literal) ↔ `package.json.version` on *every* commit.
 *    They are the two legs of the same version-coherence chain (code ↔ pkg / pkg ↔ tag).
 *    Duplicating into standing is redundant; single-moving loses the every-commit leg.
 *
 * @see src/server.ts `SERVER_CONFIG` JSDoc (drift-detector contract)
 * @see tests/regression/standing/schema-enum-sync/inv-release-version-coherence-001.test.ts
 *      (complementary release-time pkg ↔ tag leg)
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SERVER_CONFIG } from "../src/server";

describe("SERVER_CONFIG.version ↔ package.json.version coherence", () => {
  it("SERVER_CONFIG.version equals apps/mcp-server/package.json version", () => {
    const pkgPath = path.resolve(__dirname, "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };

    expect(typeof pkg.version).toBe("string");
    expect(SERVER_CONFIG.version).toBe(pkg.version);
  });
});
