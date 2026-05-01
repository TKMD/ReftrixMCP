# worker-lifecycle Standing Regression Suite

## Purpose / 目的

Worker 生存管理ドメインの常設不変条件を検証する standing regression suite。WorkerSupervisor (`maxJobsBeforeRestart=1`) による計画的再起動、Pre-Return Pause パターン (success path pause + failure path no-pause + RSS 閾値で resume vs exit 分岐)、Redis ベース二重稼働防止 (`WorkerActiveLockService` + `reftrix:worker:active:page` key + UUID nonce + 60s TTL + 30s heartbeat + Lua atomic release/extend)、discriminated union API (`tryAcquireLock` / `probeExistingLock`) による fail-open vs fail-closed の明示区別、IPC boundary (`child_process.fork` での Zod 再検証)、heartbeat timeout (60s)、3-phase shutdown を契約レベルで保証する。

Standing regression suite for the worker lifecycle domain. Guarantees contract-level invariants for: WorkerSupervisor planned restart (`maxJobsBeforeRestart=1`), the Pre-Return Pause pattern (success path pause + failure path no-pause + resume-vs-exit branch via RSS threshold), Redis-based dual-run prevention (`WorkerActiveLockService` + `reftrix:worker:active:page` key + UUID nonce + 60s TTL + 30s heartbeat + Lua atomic release/extend), explicit fail-open vs fail-closed distinction via discriminated union APIs (`tryAcquireLock` / `probeExistingLock`), IPC boundary (Zod re-validation in `child_process.fork`), heartbeat timeout (60s), and 3-phase shutdown.

## Invariants Covered / 対応不変条件

| INV-\*                                                 | 内容 / Content                                                                                                                                                                                                                                       | 関連 ADR / Related ADR                           | 実装ファイル / Test File                                                                                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-WORKER-LOCK-003-ACQ                                | `tryAcquireLock` 成功時に `reftrix:worker:active:page` が SET NX で atomic に書き込まれる / `tryAcquireLock` success path writes the key atomically via SET NX                                                                                       | ADR-0011                                         | `inv-worker-lock-003-acq.test.ts`                                                                                                                               |
| INV-WORKER-LOCK-003-REL                                | `releaseLock` は Lua atomic で **自 nonce 一致時のみ** key 削除 / `releaseLock` Lua-atomically deletes only on own-nonce match                                                                                                                       | ADR-0011                                         | `inv-worker-lock-003-rel.test.ts`                                                                                                                               |
| INV-WORKER-LOCK-003-EXT                                | `extendLock` は **自 nonce 一致時のみ** PEXPIRE で TTL 60s に refresh (30s heartbeat 周期) / `extendLock` PEXPIRE refreshes TTL to 60s only on own-nonce match (30s heartbeat cadence)                                                               | ADR-0011                                         | `inv-worker-lock-003-ext.test.ts`                                                                                                                               |
| INV-WORKER-LOCK-003-RACE / INV-WORKER-LOCK-003-UNREACH | RACE = 後発 = `already_held` (fail-closed) / UNREACH = Redis 到達不能 = `redis_unavailable` + `unavailable: true` (fail-open)。discriminated union で fail-open vs fail-closed を呼出側で明示区別 / discriminated union for fail-open vs fail-closed | ADR-0011 (PR7d-3 SEC M-1)                        | `inv-worker-lock-003-redis-fault.test.ts`                                                                                                                       |
| INV-SEC-M1-01 / INV-SEC-M1-02                          | SEC-M1 wiring 検証 — M1-01: `buildChildEnv()` が `filterTestOnlyEnvForChild()` 経由で env 構築 / M1-02: 3 entry point (`index.ts` / `server.ts` / `start-workers.ts`) で `assertNoTestOnlyEnvLeak()` 呼び出し / SEC-M1 wiring across 3 entry points  | ADR-0016 § Test-only Env Var Guard (SEC-Plan-01) | `inv-sec-m1-env-guard.test.ts` (production target: `src/workers/phases/shared/fork-common.ts`, `src/index.ts`, `src/server.ts`, `src/scripts/start-workers.ts`) |

**INV-WORKER-LIFECYCLE-003-PAUSE** (Pre-Return Pause) は team-lead Task #2 のスコープ外 (本 task は INV-WORKER-LOCK-003-\* 5 sub-invariants + SEC-M1-01/02 のみ)。Pre-Return Pause パターンは v0.4.0 PR7e-β2 で `applyPostJobMemoryGate` にリネームされ、pause/resume を完全削除して RSS 閾値ゲートのみとなっている (ADR-0009 参照、`apps/mcp-server/src/workers/shared/post-job-lifecycle.ts`)。後続 milestone で本ドメインに INV を追加する場合は ADR-0016 Amendment 経由で範囲拡張する。

**INV-WORKER-LIFECYCLE-003-PAUSE** is out of scope for the team-lead's Task #2 (which covers only the 5 INV-WORKER-LOCK-003-\* sub-invariants and SEC-M1-01/02). The Pre-Return Pause pattern was renamed to `applyPostJobMemoryGate` in v0.4.0 PR7e-β2 (pause/resume removed; only the RSS-threshold exit remains; see ADR-0009 and `apps/mcp-server/src/workers/shared/post-job-lifecycle.ts`). Future milestones may extend this domain via an ADR-0016 Amendment.

**M2 完了状態 / M2 completion**: M1 stub `inv-worker-lock-003.stub.test.ts` を削除し、`INV-WORKER-LOCK-003-ACQ/REL/EXT/RACE+UNREACH` の 4 INV file (ADR-0016 § Sub-invariant Split Policy 上限 4 内) と SEC-M1 wiring 検証 1 file の合計 5 file に置換済。各 INV file は testcontainer Redis (`REDIS_URL` via `globalSetup`) を直接使用し、`WorkerActiveLockService` の semantics を bit-for-bit 検証する。

**M2 completion**: The M1 stub `inv-worker-lock-003.stub.test.ts` has been removed and replaced with 4 INV files (within the ADR-0016 § Sub-invariant Split Policy cap of 4) plus 1 SEC-M1 wiring verification file. Each INV file consumes the testcontainer Redis directly via `REDIS_URL` (set by `globalSetup`) and verifies `WorkerActiveLockService` semantics bit-for-bit.

## Owner Agents / 担当エージェント

- **Primary**: `pipeline-engineer` (WorkerSupervisor、Pre-Return Pause、Redis dual-run lock、IPC boundary、3-phase shutdown)
- **Co-reviewer**: なし (本ドメインは pipeline-engineer 単独 owner、ただし IPC sanitize は `security-engineer` の協議推奨) / None (single owner; IPC sanitization should consult `security-engineer`)

## How to Run / 実行方法

```bash
# 全 standing regression suite 実行 / Run full standing suite
pnpm test:regression:standing

# worker-lifecycle domain のみ実行 / Run worker-lifecycle domain only
pnpm test:regression:standing --filter worker-lifecycle
```

CI workflow: `.github/workflows/regression-standing.yml` — 単一 job `Standing Regression (4 domains)` で 4 ドメインを連続実行 (matrix 並列ではなく単一 runner 15 分以内) + nightly 1 連 + weekly 10 連 flaky monitor / single job `Standing Regression (4 domains)` executes all 4 domains sequentially on one runner within 15 minutes (not matrix-parallel) + nightly 1-run + weekly 10-run flaky monitor.

## Failure Response / 失敗時の対応

standing regression の失敗は **P0 incident** 扱い:

Standing regression failure is treated as a **P0 incident**:

1. **即時 merge block** — IO は該当 PR を自動 BLOCK (`.claude/agents/integration-owner.md` 参照) / Immediate merge block
2. **即時エスカレーション** — `pipeline-engineer` (primary) に通知。Redis lock の race / fail-open / fail-closed が関わる場合は `security-engineer` を巻き込む / Immediate escalation to `pipeline-engineer`; involve `security-engineer` for Redis lock race / fail-open / fail-closed issues
3. **一時的 disable 禁止** — `.skip` / `.todo` / `describe.skip` での回避は禁止 / No `.skip` / `.todo` / `describe.skip` workaround allowed
4. **race 非決定論回避** — `vi.useFakeTimers()` + atomic Lua 保証 (ADR-0016 § Risks R3) / Race nondeterminism mitigation via `vi.useFakeTimers()` + atomic Lua guarantees
5. **対応経路** — fail 原因を修正するか、INV-\* を改訂する場合は ADR-0016 Amendment を発行 / Fix the root cause, or issue ADR-0016 Amendment to revise INV-\*

## Existing Test Migration / 既存テスト移行履歴

ADR-0016 § Existing Test Migration Mapping より該当 row を抜粋。**方針**: 既存 regression test は **保持し、standing/ は新規作成**。既存は実装詳細検証、standing は契約レベル不変条件検証という責務分離。

Excerpts from ADR-0016 § Existing Test Migration Mapping. **Policy**: existing tests are **retained**; standing/ is **newly created**.

| 既存 test / Existing Test                                | 関連 INV-\* / Related INV-\*   | 扱い / Treatment                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/workers/phases/phase-5-terminate-respawn.test.ts` | INV-WORKER-LIFECYCLE-003-PAUSE | 保持 (再起動詳細)、standing/ は Pre-Return Pause 契約 / Retained (restart details); standing/ covers Pre-Return Pause contract                                    |
| `tests/services/worker-active-lock.service.test.ts`      | INV-WORKER-LOCK-003-\*         | 保持 (API unit test)、standing/ は multi-process race + discriminated union / Retained (API unit test); standing/ covers multi-process race + discriminated union |

**重複監視 / Duplicate monitoring**: CI で standing と既存の両方が green を要求。両方 fail したら P0 incident、一方のみ fail なら P1 として triage。

## Related Documents / 関連ドキュメント

- [ADR-0016: Standing Regression Suite](../../../../../ — 本 suite の上位契約 / parent contract for this suite
- [ADR-0011: Worker Dual-run Prevention](../../../../../ — Redis dual-run lock + discriminated union API の背景 / background for Redis dual-run lock + discriminated union API
- [ADR-0009: Pre-Return Pause + Screenshot TTL](../../../../../ — Pre-Return Pause パターン (success/failure/resume 分岐) の背景 / background for Pre-Return Pause pattern
- `CLAUDE.md` § 常設 Regression Suite / Standing Regression Suite — 4 ドメインの不変条件カテゴリ表 / 4-domain invariant category table
- `CLAUDE.md` § Worker設定（WorkerSupervisor） — `maxJobsBeforeRestart=1`、`REFTRIX_ALLOW_MANUAL_WORKER`、`REFTRIX_WORKER_IS_CHILD` 等 / Worker configuration env vars
- ` § Standing Regression Suite — 運用ルール、CI-failing 要件、P0 incident 対応 / operational rules
- `tests/regression/standing/_setup/` — testcontainers / global-setup / per-file-setup / fixture-lifecycle / inv-assert helper
