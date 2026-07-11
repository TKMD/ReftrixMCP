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
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SERVER_CONFIG } from "../src/server";
import { HealthCheckService } from "../src/api/health";

describe("SERVER_CONFIG.version ↔ package.json.version coherence", () => {
  it("SERVER_CONFIG.version equals apps/mcp-server/package.json version", () => {
    const pkgPath = path.resolve(__dirname, "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };

    expect(typeof pkg.version).toBe("string");
    expect(SERVER_CONFIG.version).toBe(pkg.version);
  });
});

/**
 * HealthCheckService version surface coherence (TPA-DF-L-01)
 *
 * `HealthCheckService`（`src/api/health.ts`）はもう一つの version surface を
 * 持つ。その既定値がハードコードされた `"0.1.0"` リテラルだと、リリース時に
 * `SERVER_CONFIG.version` / `package.json.version` から drift する（TPA-DF-L-01
 * が flag した「第 3 の version surface」）。本テストは既定 version が
 * `SERVER_CONFIG.version` と一致することを毎 CI で検証し、divergent-literal の
 * 再混入を閉じる（ハードコード `"0.1.0"` に戻すと RED 化する非空虚な drift
 * detector）。
 *
 * `HealthCheckService` version surface coherence: its default version must equal
 * `SERVER_CONFIG.version`, closing the divergent-literal drift class TPA-DF-L-01
 * flagged. Non-vacuous: reverting the default to a hardcoded `"0.1.0"` turns this
 * RED.
 */
describe("HealthCheckService version surface coherence (TPA-DF-L-01)", () => {
  it("default version equals SERVER_CONFIG.version (no stale hardcoded literal)", async () => {
    const service = new HealthCheckService();
    const basic = await service.checkBasicHealth();

    expect(basic.version).toBe(SERVER_CONFIG.version);
  });
});
