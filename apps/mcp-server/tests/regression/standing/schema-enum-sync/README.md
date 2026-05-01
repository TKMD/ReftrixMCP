# schema-enum-sync Standing Regression Suite

## Purpose / 目的

Schema-enum 同期ドメインの常設不変条件を検証する standing regression suite。`EmbeddingSkipReason` (12 値、`dispatch_phase_failed` 含む) と `EmbeddingBackfillStatus` (8 値: `not_required` / `queued` / `in_progress` / `completed` / `failed` / `skipped_memory_pressure` / `skipped_fork_error` / `skipped_screenshot_missing`、最後の値は PR7d-1 で追加された repair 用終端状態) が **Prisma schema ↔ TypeScript type ↔ Zod schema ↔ MCP tool spec の 4 箇所で完全一致** していること、`skipReason` field 型が `EmbeddingSkipReason` への named import 参照であること (手書き union literal 禁止)、exhaustive switch 網羅を契約レベルで保証する。enum value drift は CI で型不一致として即 fail する。

Standing regression suite for the schema-enum sync domain. Guarantees contract-level invariants for: `EmbeddingSkipReason` (12 values including `dispatch_phase_failed`) and `EmbeddingBackfillStatus` (8 values: `not_required` / `queued` / `in_progress` / `completed` / `failed` / `skipped_memory_pressure` / `skipped_fork_error` / `skipped_screenshot_missing`, with the last added in PR7d-1 as a repair-only terminal state) being **identical across 4 locations — Prisma schema ↔ TypeScript type ↔ Zod schema ↔ MCP tool spec**, the `skipReason` field type referencing `EmbeddingSkipReason` via named import (no hand-written union literals), and exhaustive-switch coverage. CI fails immediately on enum value drift via type mismatch.

## Invariants Covered / 対応不変条件

| INV-\*                | 内容 / Content                                                                                                                                                                                             | 関連 ADR / Related ADR                                     | 関連実装ファイル / Related Implementation                                                                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-SCHEMA-ENUM-004   | `EmbeddingSkipReason` 12 値が Prisma ↔ TS ↔ Zod ↔ MCP tool spec の 4 箇所で完全一致 (`dispatch_phase_failed` 必須) / 12-value 4-way exhaustive sync (`dispatch_phase_failed` required)                     | (PR2 silent-skip)                                          | `apps/mcp-server/src/workers/phases/types.ts` (`EmbeddingSkipReason`)<br>`apps/mcp-server/src/tools/page/output.schemas.ts` (Zod `skipReason`)<br>`apps/mcp-server/prisma/schema.prisma` (enum)<br>`apps/mcp-server/src/tools/page/analyze.tool.ts` (MCP tool spec) |
| INV-SCHEMA-ENUM-004-B | `EmbeddingBackfillStatus` 8 値が 4 箇所で完全一致 + exhaustive switch / 8-value 4-way sync + exhaustive switch                                                                                             | (PR4 backfill queue + PR7d-1 `skipped_screenshot_missing`) | `apps/mcp-server/src/workers/phases/types.ts` (`EmbeddingBackfillStatus`)<br>`apps/mcp-server/prisma/schema.prisma` (`embeddingBackfillStatus` column)<br>関連 Zod schema および MCP response 型 / related Zod schema and MCP response types                        |
| INV-SCHEMA-ENUM-004-C | `skipReason` field 型が `EmbeddingSkipReason` への named import 参照 (手書き union literal 禁止) / `skipReason` field type must be a named import of `EmbeddingSkipReason` (no hand-written union literal) | (PR2 silent-skip)                                          | `apps/mcp-server/src/tools/page/output.schemas.ts` (`skipReason` field)                                                                                                                                                                                             |

**M1 stub の現状 / M1 stub status**: 本ドメインでは現在 1 stub test (`inv-schema-enum-004.stub.test.ts`) が `INV-SCHEMA-ENUM-004` で意図的に fail する。M2 で test-qa-engineer + backend-api-developer が ts-morph AST helper (既存依存 `^27.0.2`) を使って 4-way enum sync を verify する本体実装に置換する。`INV-SCHEMA-ENUM-004` / `-004-B` / `-004-C` は独立 file (1 INV → N file 分割上限 4) に分割する。

**M1 stub status**: 1 stub test (`inv-schema-enum-004.stub.test.ts`) currently fails intentionally on `INV-SCHEMA-ENUM-004`. M2 will replace with real implementation using ts-morph AST helper (existing dependency `^27.0.2`) to verify 4-way enum sync. `INV-SCHEMA-ENUM-004` / `-004-B` / `-004-C` will be split across independent files (max 4 per INV).

## Owner Agents / 担当エージェント

- **Primary**: `backend-api-developer` (Zod schema、MCP tool spec、ts-morph AST helper 設計)
- **Co-reviewer**: `platform-engineer` (Prisma schema、migration、enum drift CI 検出)

## How to Run / 実行方法

```bash
# 全 standing regression suite 実行 / Run full standing suite
pnpm test:regression:standing

# schema-enum-sync domain のみ実行 / Run schema-enum-sync domain only
pnpm test:regression:standing --filter schema-enum-sync
```

CI workflow: `.github/workflows/regression-standing.yml` — 単一 job `Standing Regression (4 domains)` で 4 ドメインを連続実行 (matrix 並列ではなく単一 runner 15 分以内) + nightly 1 連 + weekly 10 連 flaky monitor / single job `Standing Regression (4 domains)` executes all 4 domains sequentially on one runner within 15 minutes (not matrix-parallel) + nightly 1-run + weekly 10-run flaky monitor.

## Failure Response / 失敗時の対応

standing regression の失敗は **P0 incident** 扱い:

Standing regression failure is treated as a **P0 incident**:

1. **即時 merge block** — IO は該当 PR を自動 BLOCK (`.claude/agents/integration-owner.md` 参照) / Immediate merge block
2. **即時エスカレーション** — `backend-api-developer` (primary) と `platform-engineer` (co-reviewer) に通知 / Immediate escalation to `backend-api-developer` and `platform-engineer`
3. **一時的 disable 禁止** — `.skip` / `.todo` / `describe.skip` での回避は禁止 / No `.skip` / `.todo` / `describe.skip` workaround allowed
4. **enum drift 既検出時の対応順序** — drift 修正 PR を**先行**マージし、その後 standing regression を green に戻す (ADR-0016 § Risks R6) / If enum drift is already present in main: merge the drift-fix PR **first**, then restore standing regression to green
5. **対応経路** — fail 原因 (enum 追加忘れ、Prisma migration 未生成、Zod schema 未更新等) を修正するか、enum 値の改廃の場合は ADR-0016 Amendment + 関連 PR ADR を発行 / Fix the root cause (forgotten enum addition, missing Prisma migration, stale Zod schema, etc.), or issue ADR-0016 Amendment + related PR ADR for enum changes

## Existing Test Migration / 既存テスト移行履歴

ADR-0016 § Existing Test Migration Mapping にて本ドメイン (schema-enum-sync) に対する既存 regression test mapping は **記載なし**。本 standing suite は M2 で **新規作成** され、既存 unit test (`tests/workers/phases/types.test.ts` 等の enum 単体検証) と並走する。

ADR-0016 § Existing Test Migration Mapping does **not list any existing regression test** for this domain (schema-enum-sync). This standing suite is **newly created** in M2 and will run alongside existing unit tests (e.g., enum verification in `tests/workers/phases/types.test.ts`).

**重複監視 / Duplicate monitoring**: M2 実装後、CI で standing と既存 unit test の両方が green を要求。両方 fail したら P0 incident、一方のみ fail なら P1 として triage。

After M2 implementation, CI will require both standing and existing unit tests to be green. Both failing → P0; one failing → triage as P1.

## Related Documents / 関連ドキュメント

- [ADR-0016: Standing Regression Suite](../../../../../ — 本 suite の上位契約 / parent contract for this suite
- [ADR-0007: Phase 5 Queue-based Backfill](../../../../../ — `EmbeddingBackfillStatus` enum 導入の背景 / background for `EmbeddingBackfillStatus` enum
- [ADR-0015: Embedding Backfill Fork Extension](../../../../../ — `EmbeddingSkipReason` extension の背景 / background for `EmbeddingSkipReason` extensions
- `CLAUDE.md` § 常設 Regression Suite / Standing Regression Suite — 4 ドメインの不変条件カテゴリ表 / 4-domain invariant category table
- `CLAUDE.md` § Phase 5 サイレント skip 観測性（v0.4.0 PR2） — `EmbeddingSkipReason` 12 値 / `dispatch_phase_failed` の文脈 / context for 12 enum values
- `CLAUDE.md` § Queue-based Embedding Backfill（v0.4.0 PR4） — `EmbeddingBackfillStatus` 8 値の文脈 (PR4: 7 値、PR7d-1: +`skipped_screenshot_missing`) / context for 8 enum values (PR4: 7 values, PR7d-1: +`skipped_screenshot_missing`)
- ` § Standing Regression Suite — 運用ルール、CI-failing 要件、P0 incident 対応 / operational rules
- `tests/regression/standing/_setup/` — testcontainers / global-setup / per-file-setup / fixture-lifecycle / inv-assert helper
