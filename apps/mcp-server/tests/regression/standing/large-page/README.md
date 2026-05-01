# large-page Standing Regression Suite

## Purpose / 目的

大規模ページ処理ドメインの常設不変条件を検証する standing regression suite。`page.analyze` で 100 parts を超える Web ページを処理した際、Phase 5 の embedding が同期処理で完結せず、必ず BullMQ `embedding-backfill` Queue 経由で非同期 backfill worker が `completed` / `failed` / `skipped_memory_pressure` / `skipped_fork_error` のいずれかの **終端状態** に到達することを保証する。Phase 5 の child_process.fork 分離 (ONNX Runtime OOM 対策)、RSS 閾値 (warn 2.5GB / kill 4GB)、Pre-Return Pause パターンに依存する契約レベルの不変条件を扱う。

Standing regression suite for the large-page processing domain. Guarantees that when `page.analyze` processes a page with more than 100 parts, Phase 5 embedding does not complete synchronously and must instead reach a **terminal state** (`completed` / `failed` / `skipped_memory_pressure` / `skipped_fork_error`) via the asynchronous BullMQ `embedding-backfill` Queue worker. Covers contract-level invariants depending on Phase 5 child_process.fork isolation (ONNX Runtime OOM mitigation), RSS thresholds (warn 2.5GB / kill 4GB), and the Pre-Return Pause pattern.

## Invariants Covered / 対応不変条件

| INV-\*                                                 | 内容 / Content                                                                                                                                          | 関連 ADR / Related ADR  | 関連実装ファイル / Related Implementation                                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-PAGE-QUEUE-001                                     | page.analyze >100 parts → backfill Queue 経由で `completed/failed/skipped_*` 終端 / >100 parts must reach terminal state via Queue                      | ADR-0007, ADR-0015      | `apps/mcp-server/src/workers/embedding-backfill-worker.ts`<br>`apps/mcp-server/src/workers/phases/phase-5-embedding.ts`<br>`apps/mcp-server/src/workers/phases/embedding-backfill-fork-orchestrator.ts` |
| INV-PAGE-QUEUE-001-B                                   | Phase 5 fork child RSS kill → `skipped_memory_pressure` 終端、parent SIGKILL / RSS kill must terminate as `skipped_memory_pressure` with parent SIGKILL | ADR-0015                | `apps/mcp-server/src/workers/phases/phase-5-fork-orchestrator.ts`                                                                                                                                       |
| (M3 追加候補) INV-PAGE-QUEUE-001-D 他 / (M3 candidate) | M3 で追加する sub-invariant (具体内容は M3 ADR Amendment で確定) / Additional sub-invariants (defined in M3 ADR Amendment)                              | (M3 で確定 / TBD in M3) | -                                                                                                                                                                                                       |

**M2 実装完了 / M2 implementation complete**: M1 stub (`inv-page-queue-001.stub.test.ts`) は削除され、以下 2 ファイルに分割実装された (ADR-0016 § Sub-invariant Split Policy、上限 4 file 以内):

**M2 complete**: the M1 stub has been replaced with the following 2 split implementation files (within the 4-file cap per ADR-0016 § Sub-invariant Split Policy):

- `inv-page-queue-001.test.ts` — INV-PAGE-QUEUE-001 primary contract (testcontainer postgres + Redis + 実 BullMQ Queue + 実 `EmbeddingBackfillWorker` 統合、Queue → Worker → DB terminal transition を検証 / testcontainer postgres + Redis + real BullMQ Queue + real `EmbeddingBackfillWorker` integration verifying Queue → Worker → DB terminal transition)
- `inv-page-queue-001-b-rss-kill.test.ts` — INV-PAGE-QUEUE-001-B Phase 5 RSS kill → `skipped_memory_pressure` terminal state assertion (M2 は DB 状態閉包性で検証、M3 で実 RSS injection を追加候補 / M2 verifies DB-state closure; M3 candidate adds real RSS injection)
- `_fixtures/seed-large-page.ts` — >100 ComponentParts を事前 embedding 投入で seed する helper (backfill no-op 経路で Queue → terminal 遷移のみ検証) / seeding helper that pre-populates embeddings so backfill is a no-op, isolating the Queue → terminal transition

M2 で global-setup に `prisma db push` による schema 適用が追加された (`_setup/database-migrate.ts`)。これは 4 ドメイン共通 infra として他 standing test からも利用可能。

M2 adds `prisma db push` schema apply to global-setup (`_setup/database-migrate.ts`). This is shared 4-domain infra and available to the other standing tests.

## Owner Agents / 担当エージェント

- **Primary**: `pipeline-engineer` (Phase 5 fork orchestrator、BullMQ `embedding-backfill` Queue、RSS 閾値、Pre-Return Pause 契約)
- **Co-reviewer**: `capture-embedding-engineer` (DINOv2 / e5-base ONNX 推論、screenshot persistence、part bbox resolution)

## How to Run / 実行方法

```bash
# 全 standing regression suite 実行 / Run full standing suite
pnpm test:regression:standing

# large-page domain のみ実行 / Run large-page domain only
pnpm test:regression:standing --filter large-page
```

CI workflow: `.github/workflows/regression-standing.yml` — 単一 job `Standing Regression (4 domains)` で 4 ドメインを連続実行 (matrix 並列ではなく単一 runner 15 分以内) + nightly 1 連 + weekly 10 連 flaky monitor / single job `Standing Regression (4 domains)` executes all 4 domains sequentially on one runner within 15 minutes (not matrix-parallel) + nightly 1-run + weekly 10-run flaky monitor.

## Failure Response / 失敗時の対応

standing regression の失敗は **P0 incident** 扱い:

Standing regression failure is treated as a **P0 incident**:

1. **即時 merge block** — IO は該当 PR を自動 BLOCK (`.claude/agents/integration-owner.md` 参照) / Immediate merge block — IO automatically BLOCKs the PR
2. **即時エスカレーション** — `pipeline-engineer` (primary) に通知、必要に応じて `capture-embedding-engineer` (co-reviewer) を巻き込む / Immediate escalation to `pipeline-engineer`, escalate to `capture-embedding-engineer` if needed
3. **一時的 disable 禁止** — `.skip` / `.todo` / `describe.skip` での回避は禁止 (`vitest/no-disabled-tests` + `vitest/no-focused-tests` を `tests/regression/standing/**` scope で error 適用) / No `.skip` / `.todo` / `describe.skip` workaround allowed (enforced by ESLint scope-limited rules)
4. **対応経路** — fail 原因を修正するか、INV-\* を改訂する場合は ADR-0016 Amendment を発行 (LCC sign-off 必須の SLA 緩和を含む場合) / Fix the root cause, or issue ADR-0016 Amendment to revise INV-\* (with LCC sign-off if SLA relaxation is involved)

## Existing Test Migration / 既存テスト移行履歴

ADR-0016 § Existing Test Migration Mapping より該当 row を抜粋。**方針**: 既存 regression test は **保持し、standing/ は新規作成**。既存は実装詳細検証、standing は契約レベル不変条件検証という責務分離。

Excerpts from ADR-0016 § Existing Test Migration Mapping. **Policy**: existing tests are **retained**; standing/ is **newly created**. Existing tests verify implementation details; standing/ verifies contract-level invariants.

| 既存 test / Existing Test                                   | 関連 INV-\* / Related INV-\* | 扱い / Treatment                                                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/workers/phases/phase-5-rss-delta-regression.test.ts` | INV-PAGE-QUEUE-001-B         | 保持 (実装詳細: RSS delta 境界値)、standing/ は契約レベル (`skipped_memory_pressure` 終端) / Retained (RSS delta boundaries); standing/ covers contract-level terminal state |
| `tests/workers/phases/phase-5-fork-orchestrator.test.ts`    | INV-PAGE-QUEUE-001           | 保持 (fork IPC 詳細)、standing/ は Queue 終端状態 / Retained (fork IPC details); standing/ covers Queue terminal state                                                       |

**重複監視 / Duplicate monitoring**: CI で standing と既存の両方が green を要求。両方 fail したら P0 incident、一方のみ fail なら P1 として triage。

CI requires both standing and existing tests to be green. Both failing → P0; one failing → triage as P1.

## Related Documents / 関連ドキュメント

- [ADR-0016: Standing Regression Suite](../../../../../ — 本 suite の上位契約 / parent contract for this suite
- [ADR-0007: Phase 5 Queue-based Backfill](../../../../../ — large-page domain の背景 / background for large-page domain
- [ADR-0015: Embedding Backfill Fork Extension](../../../../../ — Phase 5 fork orchestrator + RSS 閾値の背景 / background for Phase 5 fork orchestrator + RSS thresholds
- `CLAUDE.md` § 常設 Regression Suite / Standing Regression Suite — 4 ドメインの不変条件カテゴリ表 / 4-domain invariant category table
- ` § Standing Regression Suite — 運用ルール、CI-failing 要件、P0 incident 対応 / operational rules, CI-failing requirements, P0 incident response
- `tests/regression/standing/_setup/` — testcontainers / global-setup / per-file-setup / fixture-lifecycle / inv-assert helper
