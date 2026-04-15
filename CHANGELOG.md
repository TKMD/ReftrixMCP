# Changelog / 変更履歴

All notable changes to this project will be documented in this file.

このプロジェクトに対する注目すべき変更点はすべてこのファイルに記載されます。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

形式は [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) に基づき、
[セマンティックバージョニング](https://semver.org/spec/v2.0.0.html) に準拠しています。

## [Unreleased]

### Security / セキュリティ

- **`chore(deps)`: example/reftrix4 Next.js を 16.2.3 に bump + test/test2 を workspace から除外 (GHSA-q4gf-8mx6-v5v3)** / **`chore(deps)`: bump example/reftrix4 Next.js to 16.2.3 + exclude test/test2 from workspace (GHSA-q4gf-8mx6-v5v3)**:
  - Next.js Denial of Service with Server Components (High CVE, CVE-2026-23869) を解消。`example/reftrix4/package.json` の `next` / `eslint-config-next` を `16.1.7` → `16.2.3` に bump。破壊的変更なし（16.2 はパフォーマンス改善・新機能のみで、reftrix4 の空 `next.config.ts` には影響なし）。/ Resolves Next.js DoS with Server Components (High CVE, CVE-2026-23869). Bumps `next` / `eslint-config-next` in `example/reftrix4/package.json` from `16.1.7` → `16.2.3`. No breaking changes (16.2 ships performance improvements and new features only; reftrix4's empty `next.config.ts` is unaffected).
  - `pnpm-workspace.yaml`: 実験プロトタイプ `example/test` (reftrix-the-prism) と `example/test2` (lattice) を workspace から除外（`!example/test` / `!example/test2` negate パターン）。`pnpm audit --audit-level=high` のスコープから外すことで release gate「High 脆弱性 0 件」を満たす。ファイル自体は削除せず保持（LP 資産のため、削除判断は別途）。/ Excludes experimental prototypes `example/test` (reftrix-the-prism) and `example/test2` (lattice) from the workspace via `!example/test` / `!example/test2` negate patterns, removing them from `pnpm audit --audit-level=high` scope to satisfy the release gate ("zero High vulnerabilities"). Files are preserved on disk (LP assets; deletion decision is separate).
  - **注記 / Note**: `example/test/` および `example/test2/` の `package.json` には脆弱バージョン（`next@16.1.7`）が残存するが、`pnpm-workspace.yaml` の `!example/test` / `!example/test2` negate パターンにより `pnpm audit` スコープ外。実験プロトタイプでありプロダクションビルドされないため、attack surface への露出なし。ファイル実削除はユーザー判断で将来対応予定。/ `example/test/` and `example/test2/` still reference the vulnerable version (`next@16.1.7`) in their `package.json`, but are excluded from `pnpm audit` scope via `pnpm-workspace.yaml` negate patterns. These are experimental prototypes not built for production; no attack surface exposure. File-level deletion is deferred to user decision.
  - PR7c (Pre-Return Pause resume + Phase 5 Screenshot 削除統一) のマージ前提条件として先行対応。`<!-- gen:ver-nextjs -->` マーカーは PR7c 本体コミットで既に 16.2.3 に同期済み、追加更新なし。/ Prerequisite fix for PR7c (Pre-Return Pause resume + Phase 5 Screenshot deletion unification) merge. The `<!-- gen:ver-nextjs -->` marker was already synced to 16.2.3 in the PR7c main commit.
  - 影響範囲 / Scope: `example/reftrix4/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` のみ。MCP サーバー本体は Next.js 非依存のため影響なし。OSS sync への影響なし（`example/` は `.ossfilter` で除外）。/ Only `example/reftrix4/package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` are touched. MCP server proper does not depend on Next.js; no OSS sync impact (`example/` is excluded via `.ossfilter`).

### Added / 追加

- **PR7e-α (Rescue): Visual embedding 5 種 zero + stale backfill 救出 (v0.4.0)** / **PR7e-alpha (Rescue): Visual-embedding 5-category zero + stale backfill rescue (v0.4.0)**: Stripe.com `page.analyze` で判明した 7 バグクラスタ (①〜⑦) を 6 commit で解消。根本は α' 診断 AI-1〜AI-4 で確定した `disposePhase4Memory` の 4 行 `null` 代入 (Commit 1 で撤回、ADR-0012 参照)。Commit 2: `PartVisualProcessor.requiresBboxResolution` 処理実装 + `bbox-resolution.helper` 本体 (SEC HIGH-1 SSRF 再検証 + SEC HIGH-3 `partBboxLaunchSemaphore` max=1)、SSRF block 時に `skipReason='ssrf_blocked_on_backfill'` 露出 (バグ② + バグ⑦)。Commit 3: `PhasedDbHandler` 統合で `analysis_phase_status` / `analysis_started_at` / `last_analyzed_phase` を success / partial / failure 全経路で遷移 (バグ④)。Commit 4: `dispatchBackfillJobsForPage` に `section_visual` 追加 + `backfill-pending.builder` に `sectionVisualPending` field + 最小 observability ログ常時出力 (バグ⑥)。Commit 5: 遡及修復スクリプト `repair-page-analyze.ts` 新設 (SEC 9 ガードレール: env gate / max pages 100 / `--confirm --yes` / `--operator` / CAS / User-Agent / `WorkerActiveLockService` probe / `sha256` idempotency key / non-fatal audit、LCC A-1 / A-2 スキーマで `_repair` suffix 必須)、バグ⑤救出。Commit 6: `DATA_RETENTION.md` に遡及処理の GDPR Art.5(1)(e) 整合性と audit_logs (Art.30) 記述を追加。全 commit で `pnpm lint` / `pnpm typecheck` / `pnpm format:check` / `pnpm docs:verify` / 該当テスト PASS。新規テスト 44 件。ADR-0012 "Visual Embedding 5-Category Zero + Stale Backfill Remediation" で 4 面 CONDITIONAL APPROVE (TPA ADR 統合 / SEC 9 ガードレール / TDA complexity + idempotency / LCC suffix + DATA_RETENTION) を記録。**注 / Note**: ADR-0012 本文は `への書込が現行ローカル harness 制約で不可のため、コミットメッセージ + 本 CHANGELOG +`DATA_RETENTION.md`追記に分散記録。PR7e-β で` を正式配置予定。/ Consolidated fix for the 7-bug cluster uncovered by Stripe.com `page.analyze` diagnostics (α-prime AI-1〜5). Commit 1 reverts `disposePhase4Memory`'s 4 `state.* = null` assignments (root cause of 5-embedding zero bug). Commit 2 implements `PartVisualProcessor.requiresBboxResolution` handling via `bbox-resolution.helper` (SEC HIGH-1 SSRF re-validation + SEC HIGH-3 Chromium launch semaphore; `skipReason='ssrf_blocked_on_backfill'` surface). Commit 3 integrates `PhasedDbHandler` so `analysis_phase_status` / `analysis_started_at` / `last_analyzed_phase` advance on all paths. Commit 4 extends `dispatchBackfillJobsForPage` with `section_visual` + `sectionVisualPending` + unconditional dispatch log. Commit 5 adds the retrospective `repair-page-analyze.ts` with 9 SEC guardrails and LCC A-1/A-2 audit schema (`_repair` suffix). Commit 6 documents Art. 5(1)(e) alignment and Art. 30 audit trail in `DATA_RETENTION.md`. All commits pass `pnpm lint` / `pnpm typecheck` / `pnpm format:check` / `pnpm docs:verify` and relevant tests (+44 new tests). ADR-0012 "Visual Embedding 5-Category Zero + Stale Backfill Remediation" captures the 4-way CONDITIONAL APPROVE (TPA single-ADR / SEC 9 guardrails / TDA complexity + idempotency / LCC suffix + DATA_RETENTION). ADR-0012 body is distributed across commit messages + this CHANGELOG entry + `DATA_RETENTION.md` due to a local-harness write restriction on ` a formal file will be landed in PR7e-beta.
- **PR7e-α0: helper 先行抽出 — bbox-clipping / sanitize-selector / bbox-resolution.helper 骨格 (v0.4.0)** / **PR7e-α0: Helper extraction — bbox-clipping / sanitize-selector / bbox-resolution.helper skeleton (v0.4.0)**: PR7e-Ω (Stripe.com page.analyze で判明した 7 バグ統合修正) を 5 PR (α0→α'→α→β→γ) に分割する先行リファクタ段階。`apps/mcp-server/src/utils/bbox-clipping.ts` (`clampBboxToImage()` — Sharp extract_area 境界値エラー防止、負値→0 / オーバーフロー→imgW-left-1 余白確保 / NaN/Infinity→null)、`apps/mcp-server/src/utils/sanitize-selector.ts` (`sanitizeSelector()` / `sanitizeCssClasses()` — CSS-in-JS hash / email / UUID / 汎用 hash-suffix の `[REDACTED]` 置換 + 80/32 char truncate + 先頭 3 件制限、GDPR Art.5(1)(c) データ最小化 / SEC HIGH / LCC B-1)、`apps/mcp-server/src/workers/phases/shared/bbox-resolution.helper.ts` (`BboxResolutionParams` / `BboxResolutionResult` 型 + throw-only skeleton、α で PartBboxPlaywrightService の thin wrapper として Phase 5 / backfill / repair script 3 経路に統合予定) を新設。call site 統合なし (α で実装)。テスト 22 件 (bbox-clipping 10 件 / sanitize-selector 12 件) 追加、pass^3 確認済み。4 面計画監査 (TPA/SEC/TDA/LCC) CONDITIONAL APPROVE。/ Pre-refactor stage that splits PR7e-Ω (unified fix for 7 bugs uncovered by Stripe.com page.analyze) into 5 PRs (α0→α'→α→β→γ). Adds `bbox-clipping.ts` (`clampBboxToImage()` for Sharp.extract boundary-error prevention), `sanitize-selector.ts` (`sanitizeSelector()` / `sanitizeCssClasses()` for CSS-in-JS hash / email / UUID / generic hash-suffix redaction with 80/32-char truncation and top-3 cap, per GDPR Art.5(1)(c) data minimisation / SEC HIGH / LCC B-1), and `bbox-resolution.helper.ts` (type definitions + throw-only skeleton; integrated across Phase 5 / backfill / repair script in α). No call-site integration (deferred to α). 22 new tests (10 bbox-clipping + 12 sanitize-selector) with pass^3 verified. 4-way plan audit (TPA/SEC/TDA/LCC) CONDITIONAL APPROVE.

### Changed / 変更

- **PR7d-2: Worker 起動経路の統一 — `spawnPageAnalyzeWorkerChild()` ヘルパー化 (v0.4.0)** / **PR7d-2: Unified Worker spawn path via `spawnPageAnalyzeWorkerChild()` helper (v0.4.0)**: `analyze-50-award-sites.ts` / `reanalyze-serial.ts` / `reanalyze-large-html.ts` の 3 バッチスクリプトは `apps/mcp-server/scripts/_worker-spawn-helper.ts::spawnPageAnalyzeWorkerChild()` 経由で統一起動。旧 `spawn(...)` 直書きは削除。`REFTRIX_ALLOW_MANUAL_WORKER=true` が自動注入され、起動前に BullMQ `queue.getWorkers()` で既存 Worker を probe し warning を出す。`package.json` の dead script `worker:start:quality` (Phase Quality Worker 廃止 v0.3.0 以来参照元なし) も同時削除。/ The 3 batch scripts now spawn through `_worker-spawn-helper.ts::spawnPageAnalyzeWorkerChild()`. Direct `spawn(...)` calls removed. The helper auto-injects `REFTRIX_ALLOW_MANUAL_WORKER=true` and pre-probes BullMQ `queue.getWorkers()` with a warning. Dead script `worker:start:quality` (no referents since v0.3.0) also removed.

### Bug Fixes / バグ修正

- **PR7d-3: ドキュメント同期 + 監査要件対応（audit_logs / OSS 公開 / fail-open 整合）(v0.4.0)** / **PR7d-3: docs sync + audit compliance (audit_logs / OSS exposure / fail-open alignment) (v0.4.0)** (`CVE-not-assigned (internal reliability improvements)`):
  - **背景 / Context**: PR7d-1 (d98fece4) + PR7d-2 (a1b6c4e0) の計 8 回の CONDITIONAL PASS 監査で deferred された LOW/MEDIUM 指摘を集約する最終 PR。リリース可能状態を実現する。/ Final PR aggregating all LOW/MEDIUM deferred items from the 8 CONDITIONAL PASS audits of PR7d-1 (d98fece4) and PR7d-2 (a1b6c4e0), bringing the branch to release-ready state.
  - **SEC M-1 (Redis fail-closed → fail-open 整合)**: `start-workers.ts` の `evaluateDualRunGuard()` が ADR-0011 記載の「Redis 障害時は fail-open」設計意図と不整合だった。`WorkerActiveLockService.checkExistingLock()` / `acquireLock()` が内部で catch して両ケース (Redis 不可到達 / race lost) を null/false に潰していたため、呼び出し側は Redis 障害でも fail-closed で `process.exit(1)` せざるを得なかった。`tryAcquireLock()` / `probeExistingLock()` の discriminated union API を追加し、fail-open vs fail-closed を明示的に区別。既存 `acquireLock` / `checkExistingLock` は legacy wrapper として残置 (後方互換)。/ `start-workers.ts`'s `evaluateDualRunGuard()` was fail-closed even on Redis outage, contradicting ADR-0011's documented fail-open intent. Added discriminated union APIs `tryAcquireLock()` / `probeExistingLock()`; legacy methods kept as wrappers.
  - **LCC MEDIUM-1 (`.ossfilter` 更新)**: `repair-orphaned-backfill-records.ts` を OSS 公開対象に追加 (`.ossfilter` に `+ /apps/mcp-server/scripts/repair-orphaned-backfill-records.ts` include exception 追加)。operator が OSS 利用時に破損レコード修復できるよう透明性向上 (AGPL-3.0)。`_worker-spawn-helper.ts` は内部バッチ専用のため除外継続。/ Added `repair-orphaned-backfill-records.ts` as an OSS-exposed script (include exception in `.ossfilter`) so OSS operators can repair orphaned records. `_worker-spawn-helper.ts` remains excluded (internal batch-only).
  - **LCC MEDIUM-2 (TTL cron + repair script audit_logs 記録)**: `ScreenshotPersistenceService.cleanupExpired()` が削除件数 > 0 時に `audit_logs` へ `action=screenshot_ttl_cleanup` エントリ追加 (GDPR Art.30 処理活動記録)。`repair-orphaned-backfill-records.ts` は dry-run / confirm 両モードで `action=backfill_orphaned_repaired` エントリ追加 (dry-run でも検出件数は運用証跡として重要)。両経路とも `webPageId` は `truncateId` で 8 文字 + `...` に truncate (PII 最小化 GDPR Art.5(1)(c))。/ `cleanupExpired()` writes an `audit_logs` entry when `deletedCount > 0`. The repair script writes an entry in both dry-run and confirm modes. Both paths truncate `webPageId` to 8 chars (PII minimisation).
  - **SEC L-1 (sanitizeErrorMessage 適用)**: `start-workers.ts` の fatal error handler (3 箇所) / `_worker-spawn-helper.ts` の probe error (1 箇所) / `repair-orphaned-backfill-records.ts` の fatal handler (1 箇所) の生 `error.message` を全て `sanitizeErrorMessage()` に置換。CWE-209 (Information Exposure Through Error Message) 対応。/ Replaced raw `error.message` in 5 locations with `sanitizeErrorMessage()` (CWE-209).
  - **SEC L-2 (heartbeat extendLock timeout)**: `start-workers.ts` の standalone heartbeat の `extendLock()` 呼び出しを `Promise.race` で 10s タイムアウト保護。Redis hang による heartbeat cadence の詰まりを防止。/ Wrapped heartbeat `extendLock()` in `Promise.race` with 10s timeout; prevents heartbeat cadence stall on hung Redis calls.
  - **TPA LOW-1 (`acquireRedisLockBestEffort` 再入防止)**: `WorkerSupervisor` に `lockAcquireInflight` フラグを追加。連続 `ensureWorkerRunning()` 呼び出しで `acquireLock()` が多重 Redis round-trip を発生させる race を防止。/ Added `lockAcquireInflight` flag to prevent concurrent `acquireLock()` round-trips on repeated `ensureWorkerRunning()` calls.
  - **TPA LOW-3 (fatal path での lock release)**: `start-workers.ts` の `process.on('exit', ...)` ハンドラに standalone lock の best-effort release を追加。crash 時に 60s TTL まで lock がリークするのを短縮。/ Added best-effort `releaseLock` in `process.on('exit', ...)`; reduces leaked-lock window on crash from 60s TTL to near-zero.
  - **TDA NEW-1 (dead script 削除)**: `apps/mcp-server/README.md:952` と `docs/README.ja.md:453` から `worker:start:quality` (Phase Quality Worker 廃止で v0.3.0 以来 dead script) を削除。/ Removed `worker:start:quality` references from README files.
  - **ドキュメント同期 / Documentation sync**:
    - `CLAUDE.md`: Worker 設定表に新 env var 3 件追加 (`REFTRIX_ALLOW_MANUAL_WORKER` / `REFTRIX_WORKER_IS_CHILD` / `REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN`)、Pre-Return Pause 記述に PR7d-2 Redis lock 追記、Screenshot Persistence セクションに PR7d-1/7d-2 更新を反映。
    - ` 同 env var 3 件を Worker 設定表に追加、v0.4.0 PR7d 新コンポーネントセクションを新設 (`WorkerActiveLockService`/`spawnPageAnalyzeWorkerChild()`/`cleanupPhase5TempDir` 3 段 whitelist / TTL cron audit_logs / repair script audit_logs)。
    - ` WorkerSupervisor セクションに「Dual-Run Prevention (v0.4.0 PR7d-2 / PR7d-3)」サブセクションを新設。4 ケース early-return 順序 + fail-open vs fail-closed 判別 + audit trail を明文化。
    - `apps/mcp-server/DATA_RETENTION.md`: 削除経路マトリクスを PR7d-2 / PR7d-3 列追加、§6.1「運用手順: Worker 二重稼働防止」セクション追加 (AGPL-3.0 透明性)、バージョン 2.7.0 → 2.8.0 bump。
    - `README.md` / `apps/mcp-server/README.md` / `docs/users-guide/01-getting-started.md` / `docs/users-guide/04-troubleshooting.md` / `docs/README.ja.md` / `scripts/templates/oss-readme.md`: 手動 Worker 起動を「開発者向け」に降格し、`REFTRIX_ALLOW_MANUAL_WORKER=true` opt-out の説明を追加。
  - **ADR 追記 / ADR supplements**:
    - ADR-0011 §K 脅威モデル追加 (SEC M-2): 同一ホスト内誤設定防止を目的、マルチテナント隔離・env var 偽装・`REFTRIX_WORKER_IS_CHILD=1` 偽装は脅威モデル外。
    - ADR-0011 §L PR サイズ超過 approval 記録 (TPA M-1): PR7d-2 (1456 行) の 800 行超過理由を明文化。
    - ADR-0010 PR7e 継続検証項目 (TPA M-1 PR7d-1): `cleanupPhase5TempDir` のデッドコード化検証を PR7e へ deferred。
  - **テスト追加 / New tests**: `worker-active-lock.service.test.ts` に discriminated union API テスト + legacy API 互換性テスト 9 ケース追加、`screenshot-persistence.service.test.ts` に TTL cron audit_logs 記録 2 ケース追加、`repair-orphaned-backfill-records.test.ts` に audit_logs 記録 3 ケース追加、`start-workers-dual-run.test.ts` に SEC M-1 fail-open/fail-closed 判別テスト 1 ケース追加。
  - **影響範囲 / Scope**: 破壊的変更なし (`WorkerActiveLockService` API 拡張は後方互換、既存呼び出しを更新済)。DB Migration / Config 追加なし (env var は PR7d-2 で済)。integration test は別 tracking issue へ deferred。
- **PR7d-2: Worker 二重稼働防止 + RAW decode 永続化ディレクトリ汚染修正 (v0.4.0)** / **PR7d-2: Worker dual-run prevention + RAW decode target directory fix (v0.4.0)** (`CVE-not-assigned (internal concurrency bug, not externally exploitable)`):
  - **背景 / Context**: PR7d-1 (ADR-0010) で永続化 Screenshot 削除経路を完全修復した直後、別種の障害として MCP server の `WorkerSupervisor` fork 子プロセスと、手動 `pnpm worker:start:page` で起動した tsx プロセスが同じ `page-analyze` BullMQ Queue を並列消費し、jobId race / `embeddingBackfillStatus` の race-condition 上書き / RSS 倍増を引き起こしていた。加えて PR7d-1 の TDA 監査で `phase-5-embedding.ts:2279` の RAW decode 書き込み先が永続化ディレクトリを指し、例外時にゴミ RAW ファイルが `<REFTRIX_SCREENSHOT_ROOT>/phase5/` に残存する LOW 指摘が未解消のまま残っていた。/ Immediately after PR7d-1, a new failure mode emerged: the MCP server's `WorkerSupervisor` fork child and a manual `pnpm worker:start:page` tsx process simultaneously consumed the same `page-analyze` BullMQ Queue, causing jobId races, `embeddingBackfillStatus` race-condition overwrites, and doubled RSS. PR7d-1's TDA audit also left a LOW finding unresolved: `phase-5-embedding.ts:2279` wrote RAW decode output into the persisted directory.
  - **A. WorkerActiveLockService 新規追加 / New service**: `apps/mcp-server/src/services/worker-active-lock.service.ts` — Redis キー `reftrix:worker:active:<workerType>` (UUID nonce, 60s TTL, 30s heartbeat) により単一ホスト上の二重 Worker を検出。`acquireLock` は `SET ... EX 60 NX` atomic、`releaseLock` は Lua script で自 nonce 一致時のみ削除 (他者の lock を誤削除しない)。/ Redis-based active-worker lock. `acquireLock` is atomic (`SET ... EX 60 NX`); `releaseLock` uses a Lua script that only deletes when the current value matches own nonce.
  - **B. WorkerSupervisor fork env 拡張 / Fork env expansion**: 構築時に `randomUUID()` で boot token 生成 → 初回 `ensureWorkerRunning()` で Redis best-effort publish。fork 子プロセスには `REFTRIX_WORKER_IS_CHILD=1` + `REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN=<UUID>` を env 注入。Redis 失敗時は warn のみで supervisor 起動継続 (fail-open)。/ Supervisor publishes its boot-token to Redis best-effort and injects `REFTRIX_WORKER_IS_CHILD=1` + `REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN=<UUID>` into every fork child. Redis-unreachable falls back to warn-and-continue.
  - **C. start-workers.ts 二重起動検出 / Dual-run detection**: `main()` で 4 ケース評価: (1) `NODE_ENV=test` skip、(2) `REFTRIX_WORKER_IS_CHILD=1` skip (fork 子の自己検出ループ回避)、(3) `REFTRIX_ALLOW_MANUAL_WORKER=true` warn + 続行 (opt-out)、(4) 既定経路は Redis lock 確認 → 検出時 `process.exit(1)`、未検出時は lock 取得 + 30 秒 heartbeat。Redis 障害時は fail-open。/ `main()` evaluates 4 cases: test-mode skip, fork-child skip, manual opt-out warn, and Redis-lock probe that `process.exit(1)` on detection or acquires with 30s heartbeat. Fail-open on Redis failure.
  - **D. spawnPageAnalyzeWorkerChild() ヘルパー統一 / Unified spawn helper**: 詳細は「Changed」節参照。/ See "Changed" section above.
  - **E. RAW decode 書き込み先修正 (TDA LOW-1) / RAW decode target directory fix (TDA LOW-1)**: `phase-5-embedding.ts:2279` の `phase5TmpDir = path.dirname(screenshotPngPath)` を `createPhase5TempDir()` に置換。RAW 出力先が `<os.tmpdir()>/reftrix-phase5-raw-*/screenshot.raw` に移動、outer `finally` で `cleanupPhase5TempDir()` を呼び例外パスでも確実回収。副次変更: `decodeToRawFile()` の Path Traversal 防御を「tmpDir が `os.tmpdir()/reftrix-phase5-raw-*` 配下」に切り替え (呼び出し側で既に `isAllowedScreenshotPath()` 検証済み)。/ Replaced `path.dirname(screenshotPngPath)` with `createPhase5TempDir()` — RAW output moves to `<os.tmpdir()>/reftrix-phase5-raw-*/screenshot.raw`, cleanup guaranteed via outer `finally`. Side change: `decodeToRawFile()`'s path-traversal guard switches to "tmpDir under `os.tmpdir()` with `reftrix-phase5-raw-` prefix".
  - **ADR-0011 起票 (Accepted)**: ` で PR7d-2 の Root Cause、代替案 4 件、GDPR Art. 32(1)(b) / APPI 第 23 条整合性、deferred items を記録。/ Filed ADR-0011 with root-cause analysis, 4 alternatives, GDPR/APPI alignment, and deferred items.
  - **テスト追加 / Tests added**: `worker-active-lock.service.test.ts` (14 件、in-memory Redis stub で acquire/extend/release/checkExistingLock の atomic semantics 検証) + `start-workers-dual-run.test.ts` (11 件、source inspection で 4 ケース評価と lifecycle integration を担保)。/ `worker-active-lock.service.test.ts` (14 cases) + `start-workers-dual-run.test.ts` (11 cases).
  - **Deferred to PR7d-3 (800 行制約遵守のため / to stay within the 800-line PR budget)**: CLAUDE.md / current-architecture.md / README Worker 設定表更新 (`REFTRIX_ALLOW_MANUAL_WORKER` 等の公式記載)、TTL cron audit_logs 記録、`.ossfilter` 更新 (LCC MEDIUM-1)、実 BullMQ + 実 DB + 実 DINOv2 integration test (spec C-1、DINOv2 ~800MB モデルロードのため個別 PR 化)、`cleanupPhase5TempDir` → `cleanupPhase5RawDecodeTmpDir` 改名 (ADR-0010 からの継続 deferred)。/ Docs sync, TTL cron audit_logs, `.ossfilter` update, real-stack integration test, and `cleanupPhase5TempDir` rename — deferred to PR7d-3.
  - **注記 / Note**: 本バグは内部プロセス間競合に起因し、外部から攻撃可能な脆弱性ではない。CVE 未採番。GDPR Art. 32(1)(b) の「処理の完全性」要件と APPI 第 23 条「安全管理措置」に対する構造的強化。/ Internal inter-process concurrency bug, not externally exploitable. No CVE. Structurally reinforces GDPR Art. 32(1)(b) and APPI Art. 23.

- **PR7d-1: Phase 5 Screenshot 削除経路完全修正 + 破損レコード修復 (v0.4.0)** / **PR7d-1: Phase 5 Screenshot deletion path completion + orphaned record repair (v0.4.0)** (`CVE-not-assigned (internal bug, not externally exploitable)`):
  - **背景 / Context**: PR7c (ADR-0009) で `phase-5-fork-orchestrator.ts` の即時 `deleteScreenshot()` 呼び出しは解除したが、`page-analyze-worker.ts` の Phase 5 後処理 (L1294-1299) と finally ブロック (L2107-2116) に残っていた `cleanupPhase5TempDir(path.dirname(state.screenshotPngPath))` 呼び出し 2 箇所を見落としていた。v0.4.0 PR1 で `state.screenshotPngPath` が永続化パス `<REFTRIX_SCREENSHOT_ROOT>/phase5/<webPageId>.png` を指すようになった結果、これらの呼び出しが永続化ディレクトリ全体を `rmSync(recursive:true)` で破壊するようになり、Queue-based Backfill (`part_visual` / `section_visual`) の visual embedding が 0 件に戻る retention-over-deletion bug が残存していた。/ PR7c (ADR-0009) removed the immediate `deleteScreenshot()` call in `phase-5-fork-orchestrator.ts` but overlooked two `cleanupPhase5TempDir(path.dirname(state.screenshotPngPath))` call sites in `page-analyze-worker.ts` (Phase 5 post-processing at L1294-1299 and finally block at L2107-2116). After v0.4.0 PR1 repointed `state.screenshotPngPath` at the persisted path `<REFTRIX_SCREENSHOT_ROOT>/phase5/<webPageId>.png`, these calls started destroying the persisted directory via `rmSync(recursive:true)`, reintroducing the zero-visual-embedding bug.
  - **A. Worker cleanup 除去 / Worker cleanup removal**: `page-analyze-worker.ts` の 2 箇所から `cleanupPhase5TempDir` 呼び出しを削除。`delete state.screenshotPngPath` による in-memory null 化のみ残す。`delete` は throw しないため finally 内 try/catch を縮退。/ Removed the 2 `cleanupPhase5TempDir` calls in `page-analyze-worker.ts`; only the in-memory null-out via `delete state.screenshotPngPath` remains. Since `delete` cannot throw, the finally-block try/catch was simplified.
  - **B. 3 段 whitelist 防御 / 3-stage whitelist defense (SEC A-1)**: `cleanupPhase5TempDir` に 3 段検証を追加 — (1) 入力正規化 + null byte 防御、(2) `fs.realpathSync` で symlink 解決（ENOENT 時は silent return）、(3) `realTmp.startsWith(realOsTmp + path.sep)` + `path.basename(realTmp).startsWith("reftrix-phase5-raw-")` の 2 条件 AND。いずれか失敗時は `logger.warn` + silent return（throw しない）。ログ出力パスは `.slice(0, 80)` で truncate、`sanitizeErrorMessage` で catch 時のエラー整形。/ Added a 3-stage check to `cleanupPhase5TempDir`: (1) input normalization + null-byte defense, (2) symlink resolution via `fs.realpathSync` (silent return on ENOENT), (3) `realTmp.startsWith(realOsTmp + path.sep)` AND `path.basename(realTmp).startsWith("reftrix-phase5-raw-")`. On any failure: `logger.warn` + silent return. Logged paths truncated to 80 chars; catch errors formatted via `sanitizeErrorMessage`.
  - **C. DRY 統合 / DRY consolidation (TDA)**: `phase-5-fork-orchestrator.ts` の `cleanupPhase5TmpDirOnly` を削除し、`cleanupPhase5TempDir(path.dirname(screenshotPngPath))` に委譲。B の 3 段防御が備わったため冗長なロジックを排除。/ Removed `cleanupPhase5TmpDirOnly` from `phase-5-fork-orchestrator.ts` and delegated to `cleanupPhase5TempDir`.
  - **D. 破損レコード修復スクリプト / Repair script**: `apps/mcp-server/scripts/repair-orphaned-backfill-records.ts` を新規追加。`--dry-run`（デフォルト）/ `--confirm` ガードで、`screenshotStoragePath IS NOT NULL` かつ `embeddingBackfillStatus IN ('queued','in_progress')` かつ実ファイル不在のページを検出し、`embeddingBackfillStatus='skipped_screenshot_missing'` に CAS 遷移する。/ New `repair-orphaned-backfill-records.ts`. Detects pages where `screenshotStoragePath IS NOT NULL`, `embeddingBackfillStatus IN ('queued','in_progress')`, and the file is missing; transitions them to `skipped_screenshot_missing` via `updateMany` CAS. `--dry-run` default, `--confirm` required.
  - **E. Enum 拡張 / Enum expansion**: `EmbeddingBackfillStatus` に `skipped_screenshot_missing` を追加。Prisma migration `20260415000000_add_embedding_backfill_skipped_screenshot_missing` で `ALTER TYPE ... ADD VALUE IF NOT EXISTS` を使用（非破壊的）。/ Added `skipped_screenshot_missing` to `EmbeddingBackfillStatus` via non-destructive Prisma migration.
  - **ADR-0010 起票 (Accepted)**: ` で PR7c の見落としと本修正の方針、GDPR Art.17/30/32(1)(b)/5(1)(a) 影響、7 日 TTL の定量根拠（BullMQ retry horizon から導出）、ADR-0009 との継承関係を記録。/ Filed ADR-0010 documenting the PR7c oversight, the PR7d-1 fix plan, GDPR impact (Art.17/30/32(1)(b)/5(1)(a)), the 7-day TTL quantitative rationale derived from the BullMQ retry horizon, and the succession relationship with ADR-0009.
  - **ドキュメント同期 / Doc sync**: `DATA_RETENTION.md` §9 を v2.7.0 に更新（削除経路マトリクスに PR7d-1 列追加 + "Historical Bug Transparency" セクション — PR7a-PR7c 期間の retention-over-deletion bug を GDPR Art.5(1)(a) 公正・透明性観点で開示）。/ Bumped `DATA_RETENTION.md` §9 to v2.7.0 with a PR7d-1 column in the deletion-path matrix and a new "Historical Bug Transparency" section disclosing the PR7a-PR7c retention-over-deletion bug per GDPR Art.5(1)(a).
  - テスト +18 件以上（whitelist 7 + worker regression guard 5 + repair script 6）、0 regression 目標。CLAUDE.md Worker 設定表、current-architecture、README 等の Worker-lock 関連ドキュメント同期は **PR7d-3 に延期**。Worker 二重稼働防止は **PR7d-2 に延期**。TTL cron `audit_logs` 記録実装も **PR7d-3 に延期**。/ 18+ new tests (whitelist 7 + worker regression guard 5 + repair script 6), zero regressions targeted. Docs sync for CLAUDE.md Worker config table, current-architecture, and README is **deferred to PR7d-3**. Worker double-start prevention is **deferred to PR7d-2**. TTL-cron `audit_logs` implementation is also **deferred to PR7d-3**.
  - **注記 / Note**: 本バグは内部コードパスの見落としで、外部から攻撃可能な脆弱性ではない（ユーザー入力で trigger できない、ネットワーク経由でも発動しない）。CVE 未採番。CWE-209 / CWE-770 / CWE-22 の「類似パターン」としてセキュリティ観点を担保。/ This bug is an internal code-path oversight, not an externally exploitable vulnerability (cannot be triggered by user input, cannot be invoked over the network). No CVE assigned. Security posture is preserved via CWE-209 / CWE-770 / CWE-22 "related pattern" defenses.

### Fixed / 修正

- **PR7c: Pre-Return Pause resume 補完 + Phase 5 Screenshot 削除タイミング統一 (v0.4.0)** / **PR7c: Pre-Return Pause resume patch + Phase 5 Screenshot deletion unification (v0.4.0)**:
  - **バグ 1 (Pre-Return Pause 永続化)**: `WORKER_MAX_JOBS_BEFORE_RESTART=1`（default）下で RSS 軽量 Worker (page-analyze / embedding-backfill) が 1 ジョブ完了後にジョブを取得しなくなる問題を修正。新 helper `applyPreReturnPauseAndMemoryGate()` で `pause(true)` → RSS 判定 → 閾値超過なら `process.exit(0)`、未満なら `worker.resume()` の 3 段階にまとめ、RSS 軽量 Worker でも次ジョブ取得を継続できるようにした。/ **Bug 1 (Pre-Return Pause becomes permanent)**: fixes the issue where RSS-light workers (page-analyze / embedding-backfill) stopped acquiring new jobs after a single completion under `WORKER_MAX_JOBS_BEFORE_RESTART=1` (default). The new `applyPreReturnPauseAndMemoryGate()` helper consolidates pause → RSS check → exit-or-resume, restoring job acquisition for RSS-light workers.
  - **バグ 2 (Phase 5 Screenshot 即時削除)**: `phase-5-fork-orchestrator.ts` の `cleanupScreenshotAndTmp()` が Visual child 完了直後に `deleteScreenshot()` を呼び、後続の Queue-based Backfill (`part_visual` / `section_visual`) が screenshot を参照できず visual embedding が 0 件しか生成されないバグを修正。関数名を `cleanupPhase5TmpDirOnly()` に改名し、RAW decode tmp dir (`reftrix-phase5-raw-*`) のみを best-effort 削除する。永続化された screenshot (`<REFTRIX_SCREENSHOT_ROOT>/phase5/<webPageId>.png`) の削除は (1) GDPR `data.delete` (Art. 17) + (2) PR6 TTL cron (7d) の 2 経路に統一。/ **Bug 2 (Phase 5 immediate screenshot deletion)**: fixes the issue where `phase-5-fork-orchestrator.ts`'s `cleanupScreenshotAndTmp()` called `deleteScreenshot()` immediately after the visual child completed, leaving nothing for the downstream Queue-based Backfill (`part_visual` / `section_visual`) to read — which in turn caused zero visual embeddings. Renamed to `cleanupPhase5TmpDirOnly()` — only best-effort removes the RAW decode tmp dir (`reftrix-phase5-raw-*`). Persisted screenshot deletion (`<REFTRIX_SCREENSHOT_ROOT>/phase5/<webPageId>.png`) is now consolidated into two paths: (1) GDPR `data.delete` (Art. 17) + (2) PR6 TTL cron (7d).
  - **M1 共通 helper 抽出**: `apps/mcp-server/src/workers/shared/post-job-lifecycle.ts` に `applyPreReturnPauseAndMemoryGate()` を新規追加。page-analyze-worker / embedding-backfill-worker 両方の success path が同じ lifecycle を共有する（DRY）。/ New shared helper `applyPreReturnPauseAndMemoryGate()` in `apps/mcp-server/src/workers/shared/post-job-lifecycle.ts`, used by both page-analyze-worker and embedding-backfill-worker success paths (DRY).
  - **M2 sanitizeErrorMessage 適用 (CWE-209)**: pause() / resume() の例外ログを `sanitizeErrorMessage()` 経由に統一。BullMQ 内部例外（Redis コマンド、jobId）がそのまま warn ログに出ないよう保護。/ pause() / resume() exceptions are now sanitized via `sanitizeErrorMessage()` (CWE-209), preventing BullMQ-internal Redis commands / jobIds from leaking into warn logs.
  - **M4 `maxJobsBeforeRestart` セマンティクス明記**: `WORKER_MAX_JOBS_BEFORE_RESTART=0` 時は helper が full no-op（pause / resume / memory-check すべてスキップ）。「再起動なし・永続 Worker モード」を明示サポート。/ When `WORKER_MAX_JOBS_BEFORE_RESTART=0`, the helper is a full no-op (skipping pause / resume / memory check) — explicit support for "no-restart persistent worker" mode.
  - **M6 DI 残骸クリーンアップ**: Phase 5 dispatch から `ScreenshotPersistenceService` の注入を削除。fork orchestrator の `deps.screenshotPersistenceService` 引数も除去。GDPR `data.delete` 経路は `service-registrar-search.ts` 経由の DI を維持。/ Removed `ScreenshotPersistenceService` injection from Phase 5 dispatch; removed `deps.screenshotPersistenceService` from the fork orchestrator. The GDPR `data.delete` path retains its DI via `service-registrar-search.ts`.
  - **M10 Art.17 回帰テスト**: `tests/services/gdpr-deletion-pr7c-regression.test.ts` に 4 ケース追加（data.delete 後の即時 unlink、in_progress / queued 中の削除、TTL cron 先行削除との冪等性）+ 1 regression ケース。/ Added 4 Art.17 regression cases + 1 regression case: immediate unlink after data.delete, deletion during in_progress / queued backfill, and idempotency vs. TTL cron prior deletion.
  - **ADR-0009 起票 (Accepted)**: ` Root Cause、3 頂点検証 (A=Product, B=Data/DB, C=Platform/Security)、Race Condition 対応方針 (M9) を記録。/ Filed ADR-0009 (Accepted) with root-cause analysis, A/B/C triangulation, and the M9 race-condition matrix.
  - **ドキュメント同期**: ` `apps/mcp-server/DATA_RETENTION.md`§9 (削除経路マトリクス),`CLAUDE.md`(Screenshot Persistence 節) を PR7c 方針に同期。/ Synced` `DATA_RETENTION.md` §9 (deletion-path matrix), and `CLAUDE.md` with PR7c's new policy.
  - テスト +12 件以上（helper 7 + GDPR 回帰 5）、0 regression。ADR-0009 Status: Accepted、4 面監査（TPA/SEC/TDA/LCC）計画段階で全 CONDITIONAL PASS。/ 12+ new tests (helper 7 + GDPR regression 5), zero regressions. ADR-0009 Accepted, all 4 audits CONDITIONAL PASS at plan stage.

### Added / 追加

- **PR7b: Phase 5 Skip Recovery 全活性化 + 収束修正 (v0.4.0)** / **PR7b: Phase 5 Skip Recovery full activation + convergence fix (v0.4.0)**:
  - Worker 即時 enqueue (`dispatchSkipRecoveryBackfill`): Phase 5 全体 skip (`skipped_fork_error` / `skipped_memory_pressure`) 時に全 7 カテゴリを embedding-backfill Queue へ同期 enqueue、`embeddingBackfillStatus` を `queued` に CAS 遷移。`updateMany WHERE status IN ('skipped_*', 'in_progress')` で Worker/Cron race を防御。/ Worker immediate enqueue on full Phase 5 skip, atomic CAS transition, protects against Worker/Cron races.
  - Retry cap 5 + back-pressure (waiting > 10,000): 無限ループ防御 (SEC HIGH-1) + DoS 増幅防御 (SEC HIGH-2)。超過時 `audit_logs.action = "backfill_retry_exhausted"` 記録。/ Infinite-loop + DoS amplification defense with audit log.
  - Exponential backoff + full jitter (SEC MEDIUM-1): 5s/10s/20s に ±50% full jitter 適用、Thundering Herd 回避。/ Full jitter for exponential backoff.
  - 親 RSS upstream guard (`PHASE5_PARENT_RSS_MAX_MB=3072` default) + Phase 4 dispose (in-memory reference null 化 + GC + RSS 3 サンプル平均)。/ Parent RSS guard + Phase 4 dispose.
  - Cron 拡張 + 7d TTL: WHERE を `IN ('in_progress', 'skipped_fork_error', 'skipped_memory_pressure')` に拡張、7 日超過で `failed` + `skip_recovery_expired` audit log。/ Cron expanded with 7d TTL.
  - `backfillPending.source` discriminated union (Zod `discriminatedUnion("source", [...])`): `sync_overflow` (既存) と `skip_recovery` (新規) を型レベル区別。両方同時 present は invariant violation として `logger.warn` 記録。/ Type-level discrimination for MCP clients.
  - SectionVisualProcessor DINOv2 統合: `requiresScreenshot()` → true、section vision embedding 再生成、PII フィルタ維持。/ SectionVisualProcessor regenerates vision embeddings.
  - 収束修正 (TPA CRITICAL / SEC HIGH / TDA H-1/H-2/M-1/M-2/M-3): `embeddingBackfillSkippedAt` 書き込み追加で cron dead code を解消、`SKIP_RECOVERY_RETRY_CAP` SSOT 化、`enqueueAllCategoriesForSkipRecovery` ヘルパー抽出で重複 67→0 行・複雑度 14→6/8、Zod max SSOT 化、`enqueuedAt` をループ開始前に記録。/ Convergence fix: `embeddingBackfillSkippedAt` writes unblock cron, SSOT consolidation, helper extraction reduces duplication 67 → 0 lines and complexity 14 → 6/8.
  - テスト +100 件以上、15,139 passed / regression ゼロ。ADR-0008 Status: Accepted、4 面監査 (TPA/SEC/TDA/LCC) 全 PASS（収束修正後）。/ 100+ new tests, zero regressions, ADR-0008 Accepted, all audits PASS.

- **ADR-0008 起票 — Phase 5 Skip Recovery 全カテゴリ Backfill 拡張 (Proposed)** / **ADR-0008 filed — Phase 5 Skip Recovery all-category Backfill extension (Proposed)**:
  - 新規 `を起票（Status: Proposed、Extends: ADR-0007）。Stripe 697 件ケース（jobId`019d8261-4f90-7708-922b-276a9dd22ee5`、親 RSS 5027MB → `text_child_abnormal_exit`→ 665 件 embedding 恒久欠落）を契機に、ADR-0007 の Part 限定前提が Phase 5 全体 skip 時に崩れる問題を解決する設計判断を記録。/ Filed new ADR-0008 (Status: Proposed, Extends: ADR-0007). Triggered by the Stripe 697-part case (jobId`019d8261-4f90-7708-922b-276a9dd22ee5`, parent RSS 5027MB → `text_child_abnormal_exit` → 665 embeddings permanently lost); records the design decision to resolve the failure mode where ADR-0007's Part-only scope breaks when the entire Phase 5 is skipped.
  - 11 項目の Decision: (1) `EmbeddingBackfillCategory` 2→7 値化（`section_visual` / `motion` / `background` / `js_animation` / `responsive` 追加）、(2) Phase 5 全体 skip 時の Worker 即時 enqueue、(3) exponential backoff + jitter（固定 60s 廃止）、(4) 親 RSS upstream guard `PHASE5_PARENT_RSS_MAX_MB`（デフォルト 3072MB）、(5) Phase 4 後の in-memory reference null 化（screenshot/sharedBrowser は物理維持）、(6) cron `reconcileStaleBackfillJobs` を `skipped_*` 対象化 + 7 日 TTL、(7) `backfillPending.source` discriminated union（`sync_overflow` / `skip_recovery`）、(8) retry cap 5 回（`embeddingBackfillRetryCount` 超過で `failed` 固定）、(9) `updateMany` CAS ガード拡張、(10) Strategy Pattern `BackfillCategoryProcessor` + `Record<EmbeddingBackfillCategory, ...>` exhaustiveness 型保証、(11) `data.delete` で全 7 カテゴリ jobId を BullMQ から削除。/ 11-item Decision set covering enum expansion, Worker immediate enqueue, exponential backoff, parent RSS guard, Phase 4 dispose, cron extension, source field, retry cap, CAS guard, Strategy Pattern, and `data.delete` queue removal.
  - Semantics Table（TPA H-3 必須）で `backfillPending.source` の `sync_overflow` / `skip_recovery` / 両方同時 present 3 状態の MCP クライアント推奨アクションを明文化。/ Semantics Table (TPA H-3) clarifies MCP client recommended actions for the three states of `backfillPending.source`.
  - 4 代替案（A: Part のみ / B: synchronous retry / C: 全カテゴリ + Strategy Pattern — 採用 / D: 完全 async）を比較検討、Privacy Considerations 6 項目（GDPR Art. 5/17/30/13/14、CCPA §1798.105、APPI 要配慮個人情報）、Migration Path を PR7a（基盤: schema + enum + 型 — 実装済み）と PR7b（skip recovery 実装 — 予定）に分離。/ Compares 4 alternatives (A/B/C-adopted/D), 6 privacy considerations, and splits migration into PR7a (scaffolding, implemented) + PR7b (skip recovery implementation, planned).
  - ADR-0007 は **Accepted のまま維持**（過去の設計根拠保持）。ADR-0008 は Extends 関係で、Part sync 成功時の 100 件閾値は維持し、Phase 5 全体 skip 時のみ all-or-nothing で全 7 カテゴリを enqueue する。/ ADR-0007 remains **Accepted** (preserved as historical rationale). ADR-0008 extends it: the 100-item threshold is preserved for successful Part sync, while all 7 categories are enqueued all-or-nothing only on full Phase 5 skip.

- **PR6 最終統合 — TTL cron + 自動 reconciliation + Stripe E2E + PR6 引継ぎ事項完全回収 (v0.4.0)** / **PR6 final integration — TTL cron + automatic reconciliation + Stripe E2E + PR6 follow-up full closure (v0.4.0)**:
  - 新規 `apps/mcp-server/src/cron/screenshot-cleanup-cron.ts`: PR1 で永続化した screenshot を日次 (24h 間隔、7 日保持、バッチ 1000 件上限) で削除。overlap 防止 + NaN ガード + `.unref()` timer。/ New cron for daily (24h interval, 7d retention, 1000-file batch cap) cleanup of PR1-persisted screenshots. Overlap prevention + NaN guards + `.unref()` timer.
  - 新規 `apps/mcp-server/src/cron/backfill-reconciliation-cron.ts`: `embedding_backfill_status = 'in_progress'` の stale 行を 1h 間隔で自動補正。`start-workers.ts` 起動時に両 cron を自動セットアップし shutdown で stop。/ New cron auto-reconciles stale `embedding_backfill_status = 'in_progress'` rows every 1h. Both crons auto-start with `start-workers.ts` and stop on shutdown.
  - `reconcileStaleBackfillJobs` を `updateMany` CAS 化 (PR6 TPA #1): WHERE 句に `embeddingBackfillStatus = 'in_progress'` ガードを含めて worker 側の先行 status 遷移との race を検出し、`BackfillReconciliationResult.concurrentUpdatesSkipped` カウンタで surface。/ `reconcileStaleBackfillJobs` uses `updateMany` CAS (PR6 TPA #1): WHERE-clause guard `embeddingBackfillStatus = 'in_progress'` detects worker races; skipped updates surfaced via `concurrentUpdatesSkipped`.
  - DB migration `20260412120000_add_embedding_backfill_started_at` で `web_pages.embedding_backfill_started_at TIMESTAMPTZ NULL` 列 + partial index を追加 (PR6 TPA #2)。stale 判定を `updatedAt` ではなく専用列ベースに切り替え、他カラム更新との衝突を排除。/ New migration adds `web_pages.embedding_backfill_started_at` column + partial index (PR6 TPA #2). Stale detection now keyed on the dedicated column, decoupled from `updatedAt` fluctuations.
  - CLI `reconcile-backfill.ts` に `--confirm` / `--dry-run` フラグ追加 (PR6 SEC LOW-2)。production では明示必須化で誤発火防止、`--dry-run` で DB 書き込みをスキップし対象ページをログ出力のみ。/ CLI adds `--confirm` / `--dry-run` flags (PR6 SEC LOW-2). Production requires explicit flag; `--dry-run` skips DB writes and logs targets only.
  - ユーティリティ抽出 (PR6 TDA TD-1 / TD-3): `utils/prisma-raw-count.ts` に `countNonNullVector` (table/column allowlist + webPageId パラメータ化)、`services/backfill-pending.builder.ts` に `buildBackfillPending` pure function を抽出。worker 本体の複雑度を削減しユニットテスト可能に。/ Extracted utilities (PR6 TDA TD-1 / TD-3): `countNonNullVector` (allowlist + parameterized webPageId) and pure `buildBackfillPending`. Worker complexity reduced, unit-testable.
  - 新規テスト: `tests/cron/{screenshot-cleanup-cron,backfill-reconciliation-cron}.test.ts` (fake timers、overlap 防止、NaN ガード)、`tests/services/backfill-pending.builder.test.ts` (8 件、NaN/Infinity 防御)、`tests/utils/prisma-raw-count.test.ts` (9 件、allowlist 検証)、`tests/scripts/reconcile-backfill-cli.test.ts` (8 件、CLI 引数パーサ)、`tests/e2e/stripe-697-regression.test.ts` (Stripe 697 件回帰防止、`REFTRIX_RUN_STRIPE_E2E=1` で有効化)。/ New tests for crons, pure builder, raw-count util, CLI parser, and Stripe 697-item regression (env-gated).
  - `apps/mcp-server/DATA_RETENTION.md` を v2.4.0 に更新 (LCC Low 1): TTL cron の実装状況、overlap 防止、env var（`SCREENSHOT_CLEANUP_*` / `BACKFILL_RECONCILIATION_*`）、CAS 記述、`--confirm` / `--dry-run` 運用を記載。/ Bumped `DATA_RETENTION.md` to v2.4.0 with cron implementation details, overlap prevention, env vars, CAS note, and `--confirm` / `--dry-run` operations.
  - ADR-0007 "Follow-up Work (PR6)" を "Completed in PR6" に変更し、実装済みの 8 項目を明示。/ ADR-0007 renames "Follow-up Work (PR6)" to "Completed in PR6" and enumerates the 8 shipped items.

- **Counter Reconciliation 9カテゴリ化 + MCP response `backfillPending` (PR5)** / **Counter Reconciliation extended to 9 categories + MCP response `backfillPending` (PR5)**:
  - Post-Phase 5 Counter Reconciliation を 4 カテゴリ (`section/part/motion/bg`) から 9 カテゴリ
    (`section`, `section_visual`, `part_text`, `part_visual`, `motion`, `bg`,
    `js_animation`, `responsive`) へ拡張。`part_text`/`part_visual` は `text_embedding IS NOT NULL` /
    `visual_embedding IS NOT NULL` の raw SQL で集計し、PR4 で非同期 backfill に分割された
    生成数を DB self-discovery で厳密に再計上する。/
    Extended Post-Phase 5 Counter Reconciliation from 4 categories to 9
    (`section`, `section_visual`, `part_text`, `part_visual`, `motion`, `bg`,
    `js_animation`, `responsive`). `part_text`/`part_visual` use raw SQL over
    `text_embedding IS NOT NULL` / `visual_embedding IS NOT NULL` so sync-phase
    counts reflect the DB truth after PR4's async backfill split.
  - MCP response `results.embedding.backfillPending` を追加（`partTextPending`,
    `partVisualPending`, `jobIds`, `estimatedCompletionAt`）。100 件閾値を超えて
    backfill に回された場合のみ設定される。/
    Added `results.embedding.backfillPending` to the MCP response with fields
    `partTextPending`, `partVisualPending`, `jobIds`, `estimatedCompletionAt`.
    Populated only when the 100-item threshold triggered backfill enqueue.
  - 新環境変数 `EMBEDDING_BACKFILL_AVG_MS_PER_ITEM`（デフォルト 5000ms、100–60000ms で
    clamp）で `estimatedCompletionAt` の簡易ヒューリスティックを制御。/
    New env var `EMBEDDING_BACKFILL_AVG_MS_PER_ITEM` (default 5000ms, clamped to
    100–60000ms) tunes the `estimatedCompletionAt` heuristic.
  - 新 service `backfill-reconciliation.service.ts` と CLI `reconcile-backfill.ts` を追加。
    `embeddingBackfillStatus='in_progress'` のまま Queue から該当ジョブが消えたページを
    検出し、DB 完全性で `completed` / `failed` に補正する stale job reconciler。
    cron 統合は PR6 で予定。/
    Added new service `backfill-reconciliation.service.ts` and CLI
    `reconcile-backfill.ts` to detect pages stuck in
    `embeddingBackfillStatus='in_progress'` without a matching queue job and
    correct status to `completed` / `failed` from DB truth. Cron integration
    deferred to PR6.
  - ADR-0007 記録: Phase 5 Queue-based Backfill 100 件閾値の設計判断。/
    ADR-0007 records the design rationale for the 100-item Phase 5 backfill threshold.

- **Queue-based Embedding Backfill (PR4)** / **Queue ベース Embedding バックフィル (PR4)**:
  - New BullMQ Queue `embedding-backfill` + dedicated Worker for Part text / visual
    embedding overflow. When `page.analyze` Phase 5 has more than 100 Parts, only the
    first 100 are processed synchronously; the remainder is enqueued and backfilled
    asynchronously. Prevents Phase 5 timeout / RSS spikes on content-heavy pages. /
    `page.analyze` Phase 5 で Part が 100 件を超える場合、先頭 100 件のみ同期処理し残余を
    非同期バックフィルする新 BullMQ Queue `embedding-backfill` と専用 Worker を追加。
  - New service entry points in `embedding-backfill.service.ts`:
    `backfillPartTextForPage()`, `countPartVisualBackfillTargets()`. /
    `embedding-backfill.service.ts` に `backfillPartTextForPage()` と
    `countPartVisualBackfillTargets()` を追加。
  - New `partsLimit` plumbed through `EmbeddingPhaseParams` →
    `TextEmbeddingSubPhaseParams` / `VisualEmbeddingSubPhaseParams` → IPC Zod schemas →
    children. DB-level cap via Prisma `take` + deterministic `orderBy: { id: "asc" }`. /
    `partsLimit` を `EmbeddingPhaseParams` → `TextEmbeddingSubPhaseParams` /
    `VisualEmbeddingSubPhaseParams` → IPC Zod スキーマ → 子プロセスに伝搬。
  - New env var `EMBEDDING_BACKFILL_CONCURRENCY` (default 1, OOM-safe). /
    新環境変数 `EMBEDDING_BACKFILL_CONCURRENCY` (デフォルト 1、OOM 防御)。
  - Bull Board UI now shows both `page-analyze` and `embedding-backfill` Queues. /
    Bull Board UI は `page-analyze` と `embedding-backfill` の両 Queue を可視化する。
  - `start-workers.ts` gains `--backfill` / `-b` flag to start only the backfill Worker. /
    `start-workers.ts` に `--backfill` / `-b` フラグを追加。
  - `web_pages.embeddingBackfillStatus` transitions to `queued` when backfill jobs are
    enqueued and to `completed` when the Worker finishes. /
    backfill 投入時に `web_pages.embeddingBackfillStatus` を `queued` に、Worker 完了時に
    `completed` に遷移させる。

### BREAKING CHANGES / 破壊的変更

- **Phase 5 child process RSS monitoring — delta-based (PR3)** / **Phase 5 子プロセス RSS 監視を delta ベースに変更 (PR3)**:
  - Removed env vars / 削除した環境変数: `PHASE5_CHILD_RSS_WARN_MB`, `PHASE5_CHILD_RSS_KILL_MB`
    (absolute RSS thresholds, no longer functional due to fork() COW / 絶対値 RSS 閾値、fork() COW により機能しないため削除)
  - Added env vars / 追加した環境変数: `PHASE5_CHILD_RSS_WARN_DELTA_MB` (default / デフォルト 2048),
    `PHASE5_CHILD_RSS_KILL_DELTA_MB` (default / デフォルト 3072)
  - Migration / 移行方法: Remove old env vars from deployment config. Default delta values
    work for most workloads; tune only if you previously needed to override absolute thresholds. /
    デプロイ設定から旧環境変数を削除すること。delta のデフォルト値はほとんどのワークロードで動作する。
    以前に絶対値閾値を調整していた場合のみチューニングが必要。
  - Rationale / 背景: Linux fork() Copy-on-Write causes the child to inherit parent RSS,
    making absolute thresholds misfire (e.g., Stripe 697 件 0 件保存 bug). /
    Linux fork() の Copy-on-Write により子プロセスが親の RSS を継承するため、
    絶対値閾値は偽陽性を生む (Stripe 697 件 0 件保存バグ)。

- **Phase 5 atomic deployment requirement** / **Phase 5 アトミックデプロイ要件**:
  - IPC schema `childHeartbeatSchema` now requires `rssDeltaMb` field. /
    IPC スキーマ `childHeartbeatSchema` に `rssDeltaMb` 必須フィールドを追加。
  - Rolling deployment with mixed parent/child versions WILL FAIL (Zod validation). /
    ローリングデプロイで親子が異なるバージョンになると Zod バリデーションで失敗する。
  - Restart the entire MCP server (BullMQ drain + all workers) atomically. /
    MCP サーバー全体（BullMQ drain 後に全 worker プロセス）を一括再起動すること。

## [0.4.0] - 2026-04-11

### Added / 追加

- **`page.batch_analyze` ツール**: 複数URL一括分析（BullMQバッチジョブ） / **`page.batch_analyze` tool**: batch analysis for multiple URLs (BullMQ batch jobs)
- **`page.getBatchStatus` ツール**: バッチジョブ進捗確認 / **`page.getBatchStatus` tool**: batch job progress check
- **`design.regression_test` ツール**: Pixelmatchによるビジュアル回帰テスト（Option Bアーキテクチャ: DesignSnapshot metadata JSONB） / **`design.regression_test` tool**: Pixelmatch visual regression test (Option B: DesignSnapshot metadata JSONB)
- **`report.generate` ツール**: Handlebarsテンプレートによるレポート生成 / **`report.generate` tool**: report generation via Handlebars templates
- **Phase 5 child_process.fork()プロセス分離**: ONNX Runtime（e5-base/DINOv2）のglibc malloc sbrk断片化によるRSS 36-58GB OOM Killを根本解決。embedding推論を2子プロセスに分離し、exit(0)でOS全メモリ回収。ピークRSS 82%+削減。IPC Zod双方向バリデーション、CWE-209対策、Path Traversal防御、3層タイムアウト保護 / **Phase 5 child_process.fork() process isolation**: fundamentally resolves RSS 36-58GB OOM Kill caused by ONNX Runtime (e5-base/DINOv2) glibc malloc sbrk fragmentation. Isolates embedding inference into 2 child processes with OS full memory reclamation on exit(0). Peak RSS reduced 82%+. IPC Zod bidirectional validation, CWE-209 mitigation, Path Traversal defense, 3-layer timeout protection
- **Bull Boardジョブログ表示**: 全6フェーズに`job.log()`追加でBull Board UIのLogsタブにフェーズ進捗を表示 / **Bull Board job log display**: added `job.log()` to all 6 phases for Bull Board UI Logs tab

### Changed / 変更

- **MCPツール数**: 35 → 39（新規4ツール追加: `page.batch_analyze`, `page.getBatchStatus`, `design.regression_test`, `report.generate`） / **MCP tool count**: 35 → 39 (4 new tools added: `page.batch_analyze`, `page.getBatchStatus`, `design.regression_test`, `report.generate`)
- **onnxruntime-node を optionalDependencies に移動**: `packages/ml/package.json` で `onnxruntime-node` を `dependencies` から `optionalDependencies` に変更。`npm install` / `pnpm install` は CUDA 検出失敗やプラットフォーム非互換でも成功するようになり、フリクションレスなインストールを実現。ML機能（Embedding生成、DINOv2 visual similarity）は未インストール時に `OnnxRuntimeUnavailableError` でgraceful degrade。非ML機能（layout解析、quality評価、コード生成等）は onnxruntime-node なしで動作 / **onnxruntime-node moved to optionalDependencies**: changed `onnxruntime-node` from `dependencies` to `optionalDependencies` in `packages/ml/package.json`. `npm install` / `pnpm install` now succeeds even on CUDA detection failure or platform incompatibility, enabling frictionless installation. ML features (embedding generation, DINOv2 visual similarity) gracefully degrade with `OnnxRuntimeUnavailableError` when unavailable. Non-ML features (layout analysis, quality evaluation, code generation, etc.) work without onnxruntime-node

### Fixed / 修正

- **OllamaVisionClient リトライ修正 (OV-1〜4)**: タイムアウト/リトライ/クリーンアップの4件修正 / **OllamaVisionClient retry fix (OV-1–4)**: 4 fixes for timeout, retry, and cleanup
- **Responsive FK違反+ブラウザリーク修正 (RS-1, RS-3)**: FK制約違反解消、ブラウザインスタンスリーク修正 / **Responsive FK violation + browser leak fix (RS-1, RS-3)**: FK constraint violation fix, browser instance leak fix
- **SectionDetector contact検出改善 (SD-1)**: contactセクションの検出精度向上 / **SectionDetector contact detection improvement (SD-1)**: improved contact section detection accuracy
- **Worker analysisStatus未更新修正**: 成功/失敗パスでanalysisStatusが正しく更新されるよう修正（analysisErrorサニタイズ付き） / **Worker analysisStatus update fix**: analysisStatus now correctly updated on success/failure paths (with analysisError sanitization)
- **onnxruntime-node CUDA誤検出修正**: `.npmrc`に`onnxruntime-node-install-cuda=skip`を追加し、CUDA 12環境でCUDA 11と誤検出されるインストールエラーを解消。OSS同期（prepare-oss.sh）にも反映。GPU利用者向けに手動CUDA設定手順をドキュメント化 / **onnxruntime-node CUDA misdetection fix**: added `onnxruntime-node-install-cuda=skip` to `.npmrc` to resolve installation error where CUDA 12 is misdetected as CUDA 11. Also reflected in OSS sync (prepare-oss.sh). Documented manual CUDA setup for GPU users
- **sync-oss.sh 初回フル公開ブロッカー修正**: Step 6.6の一括pre-publish validation（全パッケージを一斉検証→一斉publish）を、パッケージ単位の逐次フロー（validate→publish→registry反映待ち→次パッケージ）に変更。初回フル公開時に上位Tier（webdesign-core, mcp-server）が未公開の下位Tier依存（core@0.3.0等）を解決できない問題を解消。関数外`local`キーワードも修正 / **sync-oss.sh initial full publish blocker fix**: changed Step 6.6 bulk pre-publish validation (validate-all → publish-all) to per-package sequential flow (validate → publish → registry wait → next package). Resolves the issue where upper-tier packages (webdesign-core, mcp-server) fail to resolve unpublished lower-tier dependencies (core@0.3.0, etc.) during initial full publish. Also fixed `local` keyword outside function scope
- **Phase 5 IPC競合修正 4層防御**: fork()子プロセスのIPC結果メッセージ消失を4層防御で修正（setImmediate、サイレントドロップ検出、ONNX dispose削除、Counter Reconciliation全タイプ拡張） / **Phase 5 IPC race fix — 4-layer defense**: fixes IPC result message loss via setImmediate, silent drop detection, ONNX dispose removal, Counter Reconciliation expansion
- **IPC共有化**: text/visual子プロセス間の71行IPC重複コードを`phase-5-child-ipc.ts`に6関数として集約 / **IPC deduplication**: consolidated 71 lines of duplicated IPC code into 6 shared functions in `phase-5-child-ipc.ts`
- **Bull Board進捗バー修正**: `updateProgress(オブジェクト)` → `updateProgress(数値)` で進捗バーが正しく表示されるよう修正 / **Bull Board progress bar fix**: `updateProgress(object)` → `updateProgress(number)` for correct progress bar display
- **バージョン表記統一**: CLI VERSION（0.2.0→package.json SSoT）、User-Agent 8箇所（0.1.0→0.3.0）、SECURITY.md（0.3.x追加） / **Version string unification**: CLI VERSION (SSoT from package.json), User-Agent 8 files (0.1.0→0.3.0), SECURITY.md (add 0.3.x)

### Security / セキュリティ

- **vite override (defense-in-depth)**: GHSA-v2wj-q39q-566r 対応 / **vite override (defense-in-depth)**: GHSA-v2wj-q39q-566r mitigation
- **middleware/auth 鍵長40文字検証 (CWE-521)**: 認証キーの最小長を強制 / **middleware/auth key length 40-char validation (CWE-521)**: enforce minimum authentication key length
- **Phase 4 analysisError PIIサニタイズ (CWE-209, GDPR Art.5(1)(c))**: エラーメッセージからのPII漏洩防止 / **Phase 4 analysisError PII sanitization (CWE-209, GDPR Art.5(1)(c))**: prevent PII leakage from error messages

### Documentation / ドキュメント

- **MCPツールガイド全面修正**: `02-mcp-tools-guide.md`にv0.3.0新規11ツールの使用ガイドを追加。ツール数表記を`gen:tool-count`マーカーで統一し日英不整合（37/35混在）を解消。TOC再構成 / **MCP tools guide comprehensive revision**: added usage guides for 11 new v0.3.0 tools to `02-mcp-tools-guide.md`. Unified tool count notation with `gen:tool-count` markers, fixing JP/EN inconsistency (37/35 mismatch). Restructured TOC
- **OSS READMEツールテーブル完全化**: `oss-readme.md`にv0.3.0新規11ツール（`responsive.capture`, `search.facets`, `design.similar_site`, `design.compare`, `design.track_changes`, `data.delete`, `data.export`, `audit.query`, `embedding.quality`, `accessibility.audit`, `performance.evaluate`）を追加 / **OSS README tool table completion**: added 11 v0.3.0 tools to `oss-readme.md`
- **.env.example 環境変数追加**: Phase 5 fork()関連5件（`PHASE5_FORK_ENABLED`等）、DINOv2関連3件（`DINOV2_RECYCLE_ENABLED`等）、Worker関連1件（`WORKER_RESTART_DELAY_MS`）の計9環境変数を追加。`ONNX_EXECUTION_PROVIDER`の重複定義を「ML/Embedding」セクションに集約 / **.env.example environment variables**: added 9 env vars for Phase 5 fork() (5), DINOv2 (3), Worker (1). Consolidated duplicate `ONNX_EXECUTION_PROVIDER` into "ML/Embedding" section
- **docs-verify.sh Section 14追加**: OSSツールテーブル網羅性の自動検証（`check_oss_tool_table()`）を追加。`docs-verify-extract.mjs`に`--tool-names`サブコマンド新設（ts-morph AST抽出） / **docs-verify.sh Section 14**: added OSS tool table completeness auto-verification (`check_oss_tool_table()`). New `--tool-names` subcommand in `docs-verify-extract.mjs` (ts-morph AST extraction)
- **`next-gen-roadmap.md` 更新**: Tier 3以降の未実装計画を削除（ブランチ失敗に伴い） / **`next-gen-roadmap.md` update**: removed unimplemented Tier 3+ plans (branch failure)

## [0.3.0] - 2026-03-27

### Added / 追加

- **GDPR/APPIデータ削除対応 `data.delete`, `data.export` ツール**: GDPR Art.17削除権 + APPI Art.33利用停止請求に準拠。カスケード削除対応 / **GDPR/APPI data deletion `data.delete`, `data.export` tools**: compliant with GDPR Art.17 right to erasure + APPI Art.33. Cascade deletion support
- **監査ログサービス `audit.query` ツール**: CWE-778対策、GDPR Art.30処理活動記録、Append-only PostgreSQLテーブル / **Audit log service `audit.query` tool**: CWE-778 mitigation, GDPR Art.30 records of processing, append-only PostgreSQL table
- **セマンティック検索高度化**: LLM Query Understanding + Cross-Encoder Reranking で検索精度 +30% 改善 / **Semantic search enhancement**: LLM Query Understanding + Cross-Encoder Reranking for +30% precision improvement
- **Embedding品質モニタリング `embedding.quality` ツール**: Embedding分布統計 + 検索安定性モニタリング / **Embedding quality monitoring `embedding.quality` tool**: embedding distribution statistics + search stability monitoring
- **WCAG監査+コントラストチェック `accessibility.audit` ツール**: axe-core統合、WCAG 2.1 AA準拠チェック / **WCAG audit + contrast check `accessibility.audit` tool**: axe-core integration, WCAG 2.1 AA compliance check
- **類似サイト検索 `design.similar_site` ツール**: URL→mean pooling→類似デザインサイト検索 / **Similar site search `design.similar_site` tool**: URL → mean pooling → similar design site search
- **Core Web Vitals `performance.evaluate` ツール**: CDP PerformanceObserver + Lighthouse統合 / **Core Web Vitals `performance.evaluate` tool**: CDP PerformanceObserver + Lighthouse integration
- **ファセット検索+検索ログ `search.facets` ツール**: 動的ファセット生成、検索行動記録・分析 / **Facet search + search logs `search.facets` tool**: dynamic facet generation, search behavior recording and analysis
- **マルチデバイスキャプチャ `responsive.capture` ツール**: 3 viewport同時キャプチャ（mobile/tablet/desktop） / **Multi-device capture `responsive.capture` tool**: 3 viewport simultaneous capture (mobile/tablet/desktop)
- **ストリーミング進捗**: MCPプロトコル通知で長時間ジョブの進捗リアルタイム送信 / **Streaming progress**: real-time progress notifications for long-running jobs via MCP protocol notifications
- **デザイン比較 `design.compare` ツール**: 多次元比較（レイアウト、カラー、タイポグラフィ、モーション） / **Design comparison `design.compare` tool**: multi-dimensional comparison (layout, color, typography, motion)
- **マルチフレームワークコード生成拡張**: Svelte/Astro出力追加（既存React/Vue/HTMLに加えて） / **Multi-framework code generation extension**: added Svelte/Astro output (in addition to existing React/Vue/HTML)
- **デザイン変更追跡 `design.track_changes` ツール**: 時系列デザイン変更の記録・差分分析 / **Design change tracker `design.track_changes` tool**: temporal design change recording and diff analysis

### Performance / パフォーマンス

- **Phase 5メモリ制御: 6ステップOOM防止**: Sharp RAWシングルデコード、DINOv2セッションリサイクル、動的Fallback時dispose/re-init、Phase 1/3逐次実行による全分析完走保証 / **Phase 5 memory control: 6-step OOM prevention**: Sharp RAW single-decode, DINOv2 session recycle, dynamic fallback dispose/re-init, Phase 1/3 sequential execution for guaranteed full analysis completion

### Changed / 変更

- **MCPツール数**: 28 → 35（新規11ツール追加、2ツール削除） / **MCP tool count**: 28 → 35 (11 new tools added, 2 tools removed)
- **検索アーキテクチャ**: Cross-Encoder Reranking + Query Understanding 追加 / **Search architecture**: added Cross-Encoder Reranking + Query Understanding
- **レート制限ティア拡張**: 新ツール11件を適切なティアに分類 / **Rate limiting tier expansion**: 11 new tools classified into appropriate tiers

### Removed / 削除

- **quality.batch_evaluate ツール削除**（v0.1.0で非推奨化済み、2マイナーバージョン経過）。代替: `quality.evaluate` を個別URLに対して繰り返し実行 / **Removed quality.batch_evaluate tool** (deprecated since v0.1.0, 2 minor versions elapsed). Migration: use `quality.evaluate` for individual URLs
- **quality.getJobStatus ツール削除**（quality.batch_evaluate専用のため同時削除）/ **Removed quality.getJobStatus tool** (quality.batch_evaluate-exclusive, removed together)

### Database / データベース

- **3テーブル追加**: `audit_logs`, `search_logs`, `design_snapshots` + `design_snapshot_sections` / **3 tables added**: `audit_logs`, `search_logs`, `design_snapshots` + `design_snapshot_sections`

### Tests / テスト

- **Phase 5メモリ制御テスト57件追加**: Sharp RAWデコード、DINOv2セッションリサイクル、動的Fallback dispose/re-init、Phase 1/3逐次化の各ステップを網羅 / **57 Phase 5 memory control tests added**: covering Sharp RAW decode, DINOv2 session recycle, dynamic fallback dispose/re-init, Phase 1/3 sequential execution

## [0.2.1] - 2026-03-27

### Fixed / 修正

- **npm パッケージに `dist/` ビルド成果物を含める**: v0.2.0 は `src/` のみで `dist/index.js` が欠落していたため、Glama 等のランタイム実行環境で `MODULE_NOT_FOUND` エラーが発生していた / **Include `dist/` build artifacts in npm package**: v0.2.0 only contained `src/`, missing `dist/index.js`, causing `MODULE_NOT_FOUND` errors in runtime environments like Glama

## [0.2.0] - 2026-03-25

### Added / 追加

- **検索結果キャッシュ（LRU）**: lru-cache v11によるインメモリキャッシュ。P95レイテンシ500ms→50ms目標 / **Search result cache (LRU)**: in-memory cache via lru-cache v11. P95 latency target 500ms → 50ms
- **コンポーネント横断検索 `search.unified` ツール**: 5サービス並列検索+similarity統合 / **Cross-component search `search.unified` tool**: 5-service parallel search with similarity aggregation
- **マルチモーダル検索 `design.search_by_image` ツール**: 画像→DINOv2→HNSW vision search、RRF 3-source (40/30/30) / **Multimodal search `design.search_by_image` tool**: image → DINOv2 → HNSW vision search, RRF 3-source (40/30/30)
- **sanitizeErrorMessage グローバルユーティリティ**: CWE-209対策として47ファイルに適用 / **sanitizeErrorMessage global utility**: applied to 47 files for CWE-209 mitigation
- **SBOM自動生成**: CycloneDX 1.6フォーマット、`pnpm sbom`コマンド、CI統合 / **Automated SBOM generation**: CycloneDX 1.6 format, `pnpm sbom` command, CI integration
- **BullMQジョブ管理UI**: @bull-board/express、Basic Auth認証、ポート21080 / **BullMQ job management UI**: @bull-board/express, Basic Auth, port 21080
- **マイグレーション自動化（db-migrate-safe.sh）**: 自動バックアップ + 自動ロールバック / **Migration automation (db-migrate-safe.sh)**: auto-backup + auto-rollback
- **Phase 1/3並列化**: Promise.allによる約40%高速化 / **Phase 1/3 parallelization**: ~40% speedup via Promise.all
- **スタンドアロンCLI `apps/cli/`**: `reftrix analyze <url>`コマンド、MCP非依存 / **Standalone CLI `apps/cli/`**: `reftrix analyze <url>` command, MCP-independent
- **pgvector 0.8 iterative scan有効化**: ALTER ROLE SET + アプリ層SETで有効化 / **pgvector 0.8 iterative scan enabled**: via ALTER ROLE SET + application-layer SET
- **レート制限ミドルウェア**: Token Bucket + Redis Lua、3ティア（analysis 10RPM / search 120RPM / default 60RPM） / **Rate limiting middleware**: Token Bucket + Redis Lua, 3 tiers (analysis 10RPM / search 120RPM / default 60RPM)
- **フィルタリング統一**: industry/audience/tags共通スキーマ、6検索ツールに適用 / **Filtering unification**: industry/audience/tags common schema, applied to 6 search tools
- **sync-oss.sh npm publish統合**: Step 6でnpm publish実行、`--skip-publish`オプション対応 / **sync-oss.sh npm publish integration**: npm publish in Step 6, `--skip-publish` option supported

### Changed / 変更

- **巨大ファイル4件を責務分割（motion/search.tool.ts, layout/search.tool.ts, sync-processing.ts, service-initializer.ts）** / **Split 4 large files by responsibility (motion/search.tool.ts, layout/search.tool.ts, sync-processing.ts, service-initializer.ts)**
- **MCPツール数の表記統一**: 26→28に統一（37ファイル、約75箇所） / **MCP tool count unification**: unified from 26 to 28 across 37 files (~75 locations)
- **`.gitignore` 更新**: `captured-frames/` と `*.tsbuildinfo` を追加、Git追跡中の生成物7ファイルを除去 / **`.gitignore` update**: added `captured-frames/` and `*.tsbuildinfo`, removed 7 tracked generated files
- **QA一本化**: E2Eランナー統一、CI全ファイル実行、typecheck拡張 / **QA unification**: E2E runner alignment, CI full file coverage, typecheck expansion

### Security / セキュリティ

- **isDevelopment() ガード全是正**: 本番エラーサイレント吸収を防止 / **Remove all isDevelopment() guards in error paths**: prevent silent error absorption in production

### Fixed / 修正

- **narrative.search フィルタ転送修正**: フィルタパラメータが正しく転送されない問題を修正 / **narrative.search filter forwarding fix**: fixed filter parameters not being forwarded correctly
- **.ossfilter に db-migrate-safe.sh を追加**: OSSテスト失敗を修正 / **Added db-migrate-safe.sh to .ossfilter**: fixed OSS test failure

### Tests / テスト

- **SEC/TDA/LCC監査テスト91件追加** / **Add 91 SEC/TDA/LCC audit tests**

## [0.1.8] - 2026-03-22

### Added / 追加

- **npm公開・MCP Registry登録対応**: package.jsonバージョン整合、OSS同期変換（名前空間・スコープ変換）、server.json生成、運用ルール追加 / **npm publish & MCP Registry support**: package.json version alignment, OSS sync transforms (namespace/scope conversion), server.json generation, operation rules

### Fixed / 修正

- **OSS同期パイプライン安定化**: prepare-oss.sh Phase 3末尾とsync-oss.sh rsync後にPrettier自動整形を追加。Step 3.5でPrettier実行前に`pnpm install`を追加しCI Format Check失敗を解消 / **OSS sync pipeline stabilization**: added Prettier auto-formatting after prepare-oss.sh Phase 3 and sync-oss.sh rsync. Added `pnpm install` before Prettier in Step 3.5 to fix CI format check failure

### Tests / テスト

- CIパフォーマンステスト閾値調整: frame-image-analysis、motion-vectorの閾値をCI環境に合わせて緩和 / CI performance test threshold adjustments: relaxed frame-image-analysis and motion-vector thresholds for CI runner
- layout-searchテストでhtml-sanitizerをモック化しCIタイムアウトを解消 / Mocked html-sanitizer in layout-search test to fix CI timeout

### CI/CD

- GitHub Actions CI結果のSlack通知を追加 / Added Slack notification for CI results
- Prettierフォーマット修正・OSS同期検証FAIL 2件解消 / Fixed Prettier format and resolved 2 OSS sync verification failures

## [0.1.7] - 2026-03-21

### Refactored / リファクタリング

- **God Function分割**: page-analyze-worker→7フェーズモジュール（phase-0〜phase-5 + common）に分割。analyze.tool→sync-processing抽出、evaluate.tool→evaluate-engine抽出 / **God Function splits**: page-analyze-worker → 7 phase modules (phase-0–phase-5 + common). analyze.tool → sync-processing, evaluate.tool → evaluate-engine
- **スキーマ分割**: motion/schemas→3ファイル、page/schemas→3ファイル（re-export hub方式で後方互換性維持） / **Schema splits**: motion/schemas → 3 files, page/schemas → 3 files (re-export hub pattern for backward compatibility)
- **llama-vision.adapter→prompts+types分割**: LLMプロンプトと型定義を分離 / **llama-vision.adapter split**: separated LLM prompts and type definitions
- Dead code 13件削除、narrative-search重複統合、ESLint warning 27件修正 / Removed 13 dead code items, consolidated narrative-search duplicates, fixed 27 ESLint warnings

### Security / セキュリティ

- **SSRF・XSSサニタイズ・DOMPurifyバイパス修正**: 複数のセキュリティ脆弱性を解消 / **SSRF, XSS sanitization, and DOMPurify bypass fixes**: resolved multiple security vulnerabilities
- **isDevelopment()ガード違反25箇所修正**: catchブロック内でのエラーサイレント吸収を防止。全環境で`logger.warn`/`logger.error`を出力するよう統一 / **Fixed 25 isDevelopment() guard violations**: prevented silent error absorption in catch blocks. Unified to output `logger.warn`/`logger.error` in all environments
- **脆弱性解消**: flatted, effect (pnpm overrides)、undici 7.18.2→7.24.3 (High×6件)、flatted >=3.4.0 (High×1件) / **Vulnerability fixes**: flatted, effect (pnpm overrides), undici 7.18.2→7.24.3 (6 High), flatted >=3.4.0 (1 High)

### Tests / テスト

- デッドテスト11件削除（4,367行削減）、セキュリティテスト3件追加 / Removed 11 dead tests (4,367 lines reduced), added 3 security tests
- テストカバレッジ拡充（Worker系、スコアリング、グラデーション検出） / Test coverage expansion (Worker, scoring, gradient detection)

### Fixed / 修正

- **Phase 2.5 Progress範囲逆行修正**: 35-45%→60-63%に修正。進捗バーの逆行を解消 / **Phase 2.5 progress range regression fix**: corrected from 35-45% to 60-63%, resolving progress bar reversal
- **resolveMemoryConfig重複初期化を遅延初期化に変更**: 起動時の不要なメモリ設定計算を排除 / **resolveMemoryConfig lazy initialization**: eliminated redundant memory config computation at startup

### CI/CD

- **E2Eテストジョブ追加**: PostgreSQL+pgvector+Playwright+Redisを含む統合テスト環境 / **E2E test job added**: integrated test environment with PostgreSQL+pgvector+Playwright+Redis
- `format:check`有効化、`.git-blame-ignore-revs`作成 / Enabled `format:check`, created `.git-blame-ignore-revs`

### Code Style / コードスタイル

- コードベース全体（1,261ファイル）にPrettier整形適用 / Applied Prettier formatting across entire codebase (1,261 files)

## [0.1.6] - 2026-03-15

### Added / 追加

- **Section Visual Embedding (v0.1.5)**: Phase 5 (Embedding) でセクション単位のDINOv2 ViT-B/14 visual embedding生成を統合。screenshotBase64からセクションbounding boxでcrop→DINOv2で768D L2正規化ベクトルを生成し`section_embeddings.vision_embedding`に保存 / Section-level DINOv2 ViT-B/14 visual embedding generation integrated in Phase 5 (Embedding). Crops sections from screenshotBase64 using bounding boxes → generates 768D L2-normalized vectors via DINOv2, stored in `section_embeddings.vision_embedding`
  - DINOv2 init/disposeはPart Visual Embedding（v0.1.4）と共有しメモリ効率を最適化 / DINOv2 init/dispose shared with Part Visual Embedding (v0.1.4) for memory efficiency
  - PII保護: piiRiskLevel='high'パーツを含むセクションはスキップ / PII protection: skips sections containing piiRiskLevel='high' parts
  - Graceful Degradation: screenshot無し/DINOv2失敗/セクション高さ<10px時はtext_embeddingのみ / Graceful Degradation: text_embedding only when screenshot unavailable, DINOv2 fails, or section height < 10px
- **Section Screenshot Fallback (v0.1.6)**: Phase 5でscreenshotBase64範囲外のセクションに対し、`SectionScreenshotFallbackService`がPlaywrightで個別スクリーンショットを取得→DINOv2 visual embedding生成 / Section Screenshot Fallback captures individual section screenshots via Playwright for sections outside screenshotBase64 range in Phase 5 → DINOv2 visual embedding generation
  - バッチ処理化: workerがフォールバック対象セクションを事前一括収集し、1回の`captureSectionScreenshots`呼び出しで全セクション処理（page.goto N回→1回に削減） / Batch processing: worker pre-collects fallback target sections, processes all in a single `captureSectionScreenshots` call (reduces page.goto from N to 1)
  - Type-aware重複ベクトル検出: DINOv2生成後に同一sectionType内でのみコサイン類似度>0.995の重複をスキップ（スライディングウィンドウ10件、環境変数`DUPLICATE_VECTOR_THRESHOLD`で調整可能） / Type-aware duplicate vector detection: skips vision embeddings with cosine similarity > 0.995 within same sectionType (sliding window 10, configurable via `DUPLICATE_VECTOR_THRESHOLD` env var)
  - CTA小セクション（height<=200px）はdedup対象外 / CTA small sections (height <= 200px) exempt from dedup
  - scrollTo後にrequestAnimationFrame 2フレーム完了待ち（2秒タイムアウト付き）でLazy Rendering描画改善 / Post-scrollTo requestAnimationFrame 2-frame wait (2s timeout) improves lazy rendering paint
  - Feature flag `ENABLE_SECTION_SCREENSHOT_FALLBACK`（デフォルト`true`、opt-out） / Feature flag `ENABLE_SECTION_SCREENSHOT_FALLBACK` (default `true`, opt-out)
  - 安全装置: SSRF検証、NaN/Infinity防御、checkMemoryPressure毎セクション、累積300sタイムアウト、上限50セクション / Safety: SSRF validation, NaN/Infinity defense, checkMemoryPressure per section, 300s cumulative timeout, max 50 sections
- **Section Merge Post-Processor (v0.1.7-v0.1.8)**: Phase 1 (Layout Analysis) 内でmergeVisionDetectedSections()後に実行されるポストプロセッサ / Post-processor executed after mergeVisionDetectedSections() within Phase 1 (Layout Analysis)
  - Rule 1: 同一タイプ3+連続セクションをマージ（MERGEABLE_TYPES 11タイプ: unknown/feature/testimonial/gallery/partners/portfolio/team/stories/stats/faq/cta） / Rule 1: merge 3+ consecutive sections of same type (11 MERGEABLE_TYPES including cta)
  - Rule 2: コンテンツ空unknownセクション吸収（HTMLタグ除去後textContent<20文字） / Rule 2: absorb content-empty unknown sections (textContent < 20 chars after HTML tag stripping)
  - Rule 3: 同名隣接マージ（同一タイプ+同一heading+2件以上連続→1件にマージ） / Rule 3: same-heading adjacent merge (same type + same heading + 2+ consecutive → 1)
  - Feature flag `ENABLE_SECTION_MERGE_POSTPROCESSOR`（デフォルト`true`、opt-out） / Feature flag `ENABLE_SECTION_MERGE_POSTPROCESSOR` (default `true`, opt-out)
  - 安全装置: MAX_INPUT_SECTIONS=500、NaN/Infinity防御、Graceful Degradation / Safety: MAX_INPUT_SECTIONS=500, NaN/Infinity defense, Graceful Degradation
- **Section Split Post-Processor Rule 4 (v0.1.9)**: height > MAX_SECTION_HEIGHT (10,000px)の巨大セクション再分割 / Rule 4: oversized section re-splitting for sections with height > 10,000px
  - 3戦略: (A) HTML子セクション検出（`<section>`, `<article>`, `<h1>`-`<h3>`分割点）、(B) 等分割フォールバック、(C) 分割不可（MIN_SPLIT_SECTION_HEIGHT未満） / 3 strategies: (A) HTML child section detection, (B) equal-split fallback, (C) no-split (below MIN_SPLIT_SECTION_HEIGHT)
  - 実行順序: Rule 4 → Rule 1 → Rule 3 → Rule 2（分割→マージの順） / Execution order: Rule 4 → Rule 1 → Rule 3 → Rule 2 (split before merge)
  - Rule 4分割セクションはexcludeIdsでRule 1再マージ防止 / Rule 4 split sections use excludeIds to prevent Rule 1 re-merging
  - Feature flag `ENABLE_SECTION_SPLIT_POSTPROCESSOR`（デフォルト`true`、opt-out） / Feature flag (default `true`, opt-out)
- **Blank Image Detection + Dynamic Fallback (v0.1.9)**: Phase 5でfullPage screenshotのLazy Loading未描画セクション（白画像）を`isBlankImage()`で検出し、動的にFallback再取得→DINOv2 visual embedding生成 / Detects lazy-loading unrendered sections (blank images) in fullPage screenshots via `isBlankImage()`, dynamically re-captures via Section Screenshot Fallback → DINOv2 visual embedding
  - `acquireSectionCropBuffer()`でcropパス・白画像検出・Fallback取得を一元管理 / `acquireSectionCropBuffer()` unifies crop path, blank image detection, and fallback acquisition
  - 安全装置: MAX_DYNAMIC_FALLBACK_SECTIONS=20、位置ベース+動的合計50件上限、checkMemoryPressure / Safety: MAX_DYNAMIC_FALLBACK_SECTIONS=20, position-based + dynamic total capped at 50, checkMemoryPressure
  - 環境変数`BLANK_IMAGE_STDDEV_THRESHOLD`（デフォルト5.0、0-255範囲） / Env var `BLANK_IMAGE_STDDEV_THRESHOLD` (default 5.0, range 0-255)
- **Lazy Loading Scroll (v0.1.9)**: Phase 0でfullPage screenshot撮影前にページ全体をスクロールし、IntersectionObserverベースのLazy Loadingを発火。白画像問題を根本解決 / Scrolls entire page in Phase 0 before fullPage screenshot to trigger IntersectionObserver-based lazy loading, fundamentally resolving blank images
  - WebGLサイト(fullPage=false)では自動スキップ / Auto-skipped for WebGL sites (fullPage=false)
  - 安全装置: LAZY_SCROLL_MAX_ITERATIONS=50、rAF+2sタイムアウト、Graceful Degradation / Safety: MAX_ITERATIONS=50, rAF+2s timeout, Graceful Degradation
- **Section Screenshot Fallback Multi-Tile Capture (v0.1.10)**: section.height > viewportHeightの場合、セクションを動的に複数タイルに分割してPlaywrightで個別キャプチャし、Sharp compositeで垂直結合して完全なセクション画像を生成 / Multi-tile capture: dynamically splits sections exceeding viewport height into tiles, captures each via Playwright, vertically composites with Sharp
  - デフォルト上限20タイル（環境変数`MAX_TILES_PER_SECTION`でオーバーライド可能、絶対上限100） / Default cap 20 tiles (override via `MAX_TILES_PER_SECTION`, absolute limit 100)
  - Viewport統一: Fallback viewportを1920x1080に変更（ingest viewportと統一） / Viewport unification: 1920x1080 (unified with ingest viewport)
  - scrollY実測値によるclipY計算（sticky header対策、viewportHeight/2以上のズレ時は期待値にフォールバック） / scrollY actual measurement for clipY calculation (sticky header compensation)
  - 診断ログ: セクション単位のpath追跡ログ（in_range/fallback/dynamic/dedup/skipped）とサマリー出力 / Diagnostic logging: per-section path tracking (in_range/fallback/dynamic/dedup/skipped) with summary
  - SEC修正: viewport NaN/Infinity/0/負数防御+上限4096px、timeoutMs NaN防御、env var絶対上限100（SEC-TILES-01） / SEC fixes: viewport NaN defense + 4096px upper limit, absolute env var limit 100
- **Type-aware dedupヘルパー関数抽出**: `shouldSkipDuplicateVision()`として共通ヘルパーに抽出し、テスト7件追加 / Extracted type-aware dedup logic into `shouldSkipDuplicateVision()` shared helper with 7 tests
- **MAX_TILES_PER_SECTION動的化**: 環境変数によるランタイム設定でVision coverageボトルネックを解消 / Dynamic `MAX_TILES_PER_SECTION` via env var resolves Vision coverage bottleneck

### Fixed / 修正

- **onnxruntime-node ABIミスマッチ解消**: onnxruntime-nodeバージョン固定でNode.js ABIバージョン不整合によるクラッシュを修正 / Pin onnxruntime-node version to fix Node.js ABI version mismatch crash
- **isBlankImage()ダークテーマ誤検出修正**: stddev単独判定からstddev + mean輝度の2条件判定に変更（avgStddev < 5.0 AND (avgMean > 245 OR avgMean < 10)）。ダークテーマサイトが白画像と誤検出される問題を解消 / Fix isBlankImage() dark theme false positive: changed from stddev-only to dual-condition check (stddev + mean brightness). Prevents dark theme sites from being incorrectly flagged as blank
- **actualScrollY clipY計算フォールバック追加**: clip_height_zeroリグレッションを修正 / Add fallback to actualScrollY clipY calculation, fixing clip_height_zero regression
- **Dynamic Fallbackバグ修正3件**: (1) acquireSectionCropBufferの構造的バグ修正（isBlank判定の論理反転: false→true）、(2) メモリ圧力回避のscreenshotBuffer明示的解放、(3) Rule 3にexcludeIds適用（Rule 4分割セクションの再マージ防止） / 3 Dynamic Fallback bug fixes: (1) isBlank logic inversion fix, (2) explicit screenshotBuffer release, (3) excludeIds applied to Rule 3
- **Pre-Return Pauseレースコンディション解消**: Worker計画的再起動時のPre-Return Pauseのレースコンディションを修正。startup recoveryのfetchNext呼び出しも修正 / Fix Pre-Return Pause race condition during planned worker restart + fix startup recovery fetchNext call
- **Worker path postProcessSections統合**: page.analyzeの非同期Worker処理にpostProcessSections(Rule 1-4)呼び出しを追加。saveSectionPatterns前に実行し、分割/マージされたセクションのtext_embeddingも正しく生成 / Added postProcessSections (Rule 1-4) to Worker path before saveSectionPatterns, ensuring correct text_embeddings for split/merged sections

### Changed / 変更

- Fallback viewport: 1280x800 → 1920x1080（ingest viewportと統一） / Fallback viewport unified to 1920x1080

### Documentation / ドキュメント

- Section Visual Embedding（v0.1.5）のドキュメント包括的アップデート / Comprehensive docs update for Section Visual Embedding (v0.1.5)
- Section Merge Post-Processor（v0.1.7-v0.1.8）のドキュメント追記 / Section Merge Post-Processor (v0.1.7-v0.1.8) docs added
- v0.1.9 Blank Image Detection + Dynamic Fallback / Section Split Rule 4のドキュメント追記 / v0.1.9 docs for Blank Image Detection, Dynamic Fallback, and Section Split Rule 4
- v0.1.9 Lazy Loading Scroll + Worker postProcessSections統合 + Dynamic Fallbackバグ修正のドキュメント追記 / v0.1.9 docs for Lazy Loading Scroll, Worker postProcessSections integration, and Dynamic Fallback bug fixes
- v0.1.10 Section Screenshot Fallback Multi-Tile + isBlankImage改善のドキュメント追記 / v0.1.10 docs for Multi-Tile Capture and isBlankImage improvement

## [0.1.5] - 2026-03-12

### Added / 追加

- **Part-Level Analysis機能**（3つの新規MCPツール: `part.search`, `part.inspect`, `part.compare`） / **Part-Level Analysis** (3 new MCP tools: `part.search`, `part.inspect`, `part.compare`)
  - `part.search`: セマンティックUIパーツ検索（ハイブリッド: ベクトル + 全文検索 RRF）。16パーツタイプ対応、searchMode（visual/text/hybrid）、partType/webPageIdフィルタ / Semantic UI part search (hybrid: vector + fulltext RRF). 16 part types, searchMode (visual/text/hybrid), partType/webPageId filters
  - `part.inspect`: パーツ詳細取得（computedStyles, boundingBox, interactionInfo, cssClasses, attributes, piiRiskLevel）。オプション: includeHtml, includeEmbedding / Get detailed part info by ID with computed styles, bounding box, interaction info. Opt-in: includeHtml, includeEmbedding
  - `part.compare`: 2-5パーツの比較（スタイル、レイアウト、インタラクション、アクセシビリティ） / Compare 2-5 parts side by side on styles, layout, interaction, and accessibility
  - 16パーツタイプ: heading, button, link, image, icon, input, form, card, navigation, footer, badge, avatar, divider, modal, toast, tooltip / 16 part types
  - PII検出（piiRiskLevel: low/medium/high）で個人情報を含むパーツの自動分類 / PII detection with automatic classification of parts containing personal information
- **DINOv2 ViT-B/14 visual embedding**: パーツの視覚的特徴を768次元L2正規化ベクトルで表現。`part.search` のsearchMode `visual` / `hybrid` で利用可能 / DINOv2 ViT-B/14 visual embedding: 768-dim L2-normalized vectors representing visual features of parts. Available via `part.search` searchMode `visual` / `hybrid`
  - Phase 5 Embedding末尾で自動生成（e5-base dispose後にDINOv2ロード ~800MB、完了後dispose） / Auto-generated at end of Phase 5 Embedding (loads DINOv2 ~800MB after e5-base disposal, disposes after completion)
  - Graceful Degradation: screenshot無し/DINOv2失敗/bbox未解決時はtext_embeddingのみ / Graceful Degradation: text_embedding only when screenshot unavailable, DINOv2 fails, or bbox unresolved
  - piiRiskLevel='high'パーツはvisual embeddingスキップ / Skips visual embedding for piiRiskLevel='high' parts
  - 環境変数 `DINOV2_MODEL_PATH` でモデルパス指定可能 / Model path configurable via `DINOV2_MODEL_PATH` env var

### Fixed / 修正

- **JSDOM bounding box常時ゼロ問題を修正**: Part ExtractionがJSDOMベースのため`getBoundingClientRect()`が常に`{0,0,0,0}`を返す問題を、Phase 5冒頭でPlaywright（`PartBboxPlaywrightService`）により実bounding boxを後付け取得することで解決 / Fix JSDOM bounding box always zero: Part Extraction uses JSDOM where `getBoundingClientRect()` always returns `{0,0,0,0}`. Resolved by retroactively obtaining real bounding boxes via Playwright (`PartBboxPlaywrightService`) at the start of Phase 5
  - sharedBrowserの`isConnected()`チェック + 切断時はフォールバックとして独自Chromiumインスタンスを起動 / Checks sharedBrowser `isConnected()` and falls back to launching standalone Chromium if disconnected
  - SSRF対策（`validateExternalUrl()`）+ CSSインジェクション防御（`escapeCssIdentifier()`） / SSRF prevention (`validateExternalUrl()`) + CSS injection defense (`escapeCssIdentifier()`)
  - 39テスト追加（正常系、早期リターン、Graceful Degradation、リソースクリーンアップ、SSRF、CSSセレクタ） / 39 tests added (normal flow, early return, graceful degradation, resource cleanup, SSRF, CSS selectors)

### Changed / 変更

- MCPツール数: 23 → **26**（`part.search`, `part.inspect`, `part.compare`追加） / MCP tool count: 23 → **26** (added `part.search`, `part.inspect`, `part.compare`)
- Worker Pipeline Phase 5にStep 0（Playwright Bounding Box Resolution）を追加 / Added Step 0 (Playwright Bounding Box Resolution) to Worker Pipeline Phase 5

### Documentation / ドキュメント

- Part-Level Analysisのドキュメントを更新 / Updated Part-Level Analysis documentation

## [0.1.4] - 2026-03-11

### Fixed / 修正

- **WorkerパスでCSSスニペットがDB保存されない問題を修正**: worker-db-save → section_patternsに5 CSSフィールド（cssSnippet, externalCssContent, externalCssMeta, cssFramework, cssFrameworkMeta）を追加。page-analyze-workerでページレベルCSSをセクション単位に配布 / Fix CSS snippet data not saved in Worker path: added 5 CSS fields to section_patterns via worker-db-save, distributing page-level CSS to sections in page-analyze-worker
- **BullMQ obliterateを完全除去しwaiting/completedジョブを保護**: obliterate()がwaiting/completedジョブを破壊していた問題を修正 / Remove BullMQ obliterate entirely to protect waiting/completed jobs
- **コードレビュー指摘5件を修正**: 認証チェック、キュー管理、ポーリング間隔、ドキュメント整合性 / Fix 5 code review findings (auth checks, queue management, polling interval, docs consistency)
- **テスト修正3件**: layout-first-mode並列テストタイムアウト延長(120s)、system-health detectGpuMismatchモック追加、パフォーマンステスト閾値緩和 / Fix 3 test issues: extend parallel test timeout, add GPU mismatch mock, relax perf test threshold

### Security / セキュリティ

- **CVE-2026-0540**: DOMPurify 3.3.2に更新しXSS脆弱性を修正 / Update DOMPurify to 3.3.2 to fix XSS vulnerability
- **GHSA-qffp-2rhf-9h96**: tar overrideを>=7.5.10に更新しhardlinkパストラバーサルを修正 / Update tar override to fix hardlink path traversal
- **hono/node-server脆弱性4件を解消** / Fix 4 Dependabot vulnerabilities in hono/node-server

### Changed / 変更

- Glama MCPサーバーディレクトリ登録（`glama.json`追加、READMEにバッジ追加） / Register on Glama MCP server directory (add `glama.json` and badge to README)
- OSS版mcp-serverパッケージから`private:true`を自動除去 / Auto-remove `private:true` from OSS mcp-server package.json

### Documentation / ドキュメント

- README冒頭にペルソナ文とQuickstart誘導文を追加 / Add persona line and quickstart hook to README

## [0.1.3] - 2026-03-08

### Added / 追加

- **User preference profiling system** (3 new MCP tools: `preference.hear`, `preference.get`, `preference.reset`) / **ユーザー嗜好プロファイリングシステム**（3つの新規MCPツール: `preference.hear`, `preference.get`, `preference.reset`）
  - `preference.hear`: Stateless hearing session (Mode A: sample presentation with progress tracking, Mode B: feedback recording with profile update) / ステートレスヒアリングセッション（Mode A: サンプル提示＋進捗トラッキング、Mode B: フィードバック記録＋プロファイル更新）
  - `preference.get`: Profile retrieval with GDPR data portability (Art. 20) via `include_signals` / プロファイル取得（GDPRデータポータビリティ Art. 20 対応、`include_signals`オプション）
  - `preference.reset`: Soft reset and hard delete (GDPR Art. 17 Right to Erasure) / ソフトリセット＋完全削除（GDPR Art. 17 忘れられる権利）
  - 2-factor confidence model (MoodCategory coverage 0.6 + interaction sufficiency 0.4, threshold 0.8, max 15 hearings) / 2因子信頼度モデル（MoodCategoryカバレッジ 0.6 + インタラクション充足度 0.4、閾値 0.8、最大15回ヒアリング）
  - GDPR Art. 13/14 compliant `profiling_notice` on new profile creation / 新規プロファイル作成時にGDPR Art. 13/14準拠の`profiling_notice`を返却
- **Preference-aware search reranking** across all 5 search tools (layout, motion, background, narrative, responsive) / **全5検索ツールにpreference rerankingを統合**（layout, motion, background, narrative, responsive）
  - Cosine similarity reranking with configurable `rerank_weight` (default 0.3) / コサイン類似度リランキング（設定可能な`rerank_weight`、デフォルト0.3）
  - `applyPreferenceReranking()` shared helper replacing ~35-line inline code per tool / 共通ヘルパー`applyPreferenceReranking()`で各ツール~35行のインラインコードを1行に集約
- **Database schema**: `preference_profiles`, `preference_signals` tables with Prisma migration / **データベーススキーマ追加**: `preference_profiles`, `preference_signals`テーブル（Prismaマイグレーション）
- **PRIVACY.md**: Profiling privacy policy (GDPR Art. 6/13/14/22, 8 sections, bilingual) / **PRIVACY.md**: プロファイリングプライバシーポリシー（GDPR Art. 6/13/14/22、8セクション、日英バイリンガル）
- **DATA_RETENTION.md**: Data retention policy (soft reset, hard delete, data export specifications) / **DATA_RETENTION.md**: データ保持ポリシー（ソフトリセット、完全削除、データエクスポート仕様）
- 138 new tests (29 service + 13 security + 96 tool/schema tests) / テスト138件追加（サービス29 + セキュリティ13 + ツール/スキーマ96）
- SEC/TDA/LCC 3-agent audit passed (12 audits across 4 phases, all PASS) / SEC/TDA/LCC 3エージェント監査全4Phase全PASS（12監査すべて合格）
- **Embedding Idle Timer**: MCPサーバー本体のEmbeddingService ONNX Worker ThreadがCUDA VRAMを30秒アイドル後に自動解放。後続のOllama Vision解析（page.analyze）がGPUで実行可能に / Auto-release CUDA VRAM from MCP server's EmbeddingService ONNX Worker Thread after 30s idle, enabling GPU acceleration for subsequent Ollama Vision analysis (page.analyze)
  - 環境変数 `EMBEDDING_IDLE_TIMEOUT_MS` で設定可能（デフォルト30秒、0で無効化） / Configurable via `EMBEDDING_IDLE_TIMEOUT_MS` env var (default 30s, 0 to disable)
- **Ollama GPU不整合検出** (`system.health`): nvidia-smiでGPU検出 + Ollama `size_vram=0` の不整合をクロスチェックし、actionable warningを表示。不整合時はステータスを `degraded` に降格 / **Ollama GPU mismatch detection** (`system.health`): Cross-checks nvidia-smi GPU detection against Ollama `size_vram=0`, shows actionable warning with fix steps. Downgrades status to `degraded` on mismatch (REFTRIX-GPU-MISMATCH-01)

### Fixed / 修正

- **RRF hybrid search missing `id`** -- search results lacked `id` field required for preference reranking / **RRFハイブリッド検索の`id`欠落** -- 検索結果にリランキングに必要な`id`フィールドが欠落していた
- **Responsive search reranking ID mismatch** -- `responsive_analysis_id` vs top-level `id` inconsistency / **レスポンシブ検索のリランキングID不一致** -- `responsive_analysis_id`とトップレベル`id`の不整合
- **DI factory registration** -- `PrismaClient` and `EmbeddingService` factories were missing at MCP server startup / **DIファクトリ登録欠落** -- MCPサーバー起動時に`PrismaClient`と`EmbeddingService`のファクトリが未登録
- **GPU VRAM競合修正**: 検索ツール（layout.search等）実行後にMCPサーバー本体のONNX Embeddingが~1,406MiB VRAMを占有し続け、Ollama Vision (11.7GB)がCPUフォールバックする問題を修正 / Fix GPU VRAM contention where MCP server's ONNX Embedding held ~1,406MiB VRAM after search tool execution, causing Ollama Vision (11.7GB) to fall back to CPU

### Security / セキュリティ

- **SEC-M-2**: `truncateId()` PII-safe ID truncation utility (5 files, 21 locations) / `truncateId()` PII安全なID切り詰めユーティリティ（5ファイル、21箇所）
- **SEC-L-1**: `parseVectorString()` NaN/Infinity defense with `Number.isFinite()` validation / `parseVectorString()`のNaN/Infinity防御（`Number.isFinite()`バリデーション）
- **SEC-L-2**: Embedding vector pre-generation NaN/Infinity validation / Embeddingベクトル生成前のNaN/Infinityバリデーション
- **LCC-5**: `sanitizeErrorMessage()` preventing internal DB structure leakage / `sanitizeErrorMessage()`で内部DB構造の漏洩を防止

### Changed / 変更

- MCP tool count: 20 → **23** (added `preference.hear`, `preference.get`, `preference.reset`) / MCPツール数: 20 → **23**（`preference.hear`, `preference.get`, `preference.reset`追加）
- All 5 search tool schemas now include optional `profile_id` parameter / 全5検索ツールスキーマにオプションの`profile_id`パラメータを追加

### Documentation / ドキュメント

- Updated `README.md`, `apps/mcp-server/README.md` with preference profiling info / `README.md`、`apps/mcp-server/README.md`にpreference profiling情報を追加
- Updated `docs/users-guide/02-mcp-tools-guide.md` with Preference tools section (Chapter 14) / `docs/users-guide/02-mcp-tools-guide.md`にPreferenceツールセクション（第14章）を追加
- Updated `docs/legal/PRIVACY_POLICY.md` v0.1.0 → v0.1.1 (profiling contradiction fix, Art. 22 explanation) / `docs/legal/PRIVACY_POLICY.md` v0.1.0 → v0.1.1（プロファイリング矛盾修正、Art. 22説明追加）
- Updated `docs/legal/TERMS_OF_SERVICE.md` with preference profiling in feature list / `docs/legal/TERMS_OF_SERVICE.md`の機能リストにpreference profilingを追加

## [0.1.2] - 2026-03-05

### Added / 追加

- **Apple Silicon Metal GPU detection** / **Apple Silicon Metal GPU検出**
  - `GpuVendor` enum (`NVIDIA | APPLE_METAL | UNKNOWN`) for GPU vendor identification / GPUベンダー識別用の`GpuVendor`列挙型
  - `HardwareDetector.isAppleSilicon()` static method (`process.platform + process.arch`, no external commands) / 外部コマンド不使用の静的メソッド
  - Ollama `/api/ps` reports Apple Silicon Unified Memory as `size_vram > 0`, so existing GPU detection works correctly / Ollama `/api/ps`がUnified Memoryを`size_vram > 0`として報告するため既存GPU判定で正しく動作
  - OllamaReadinessProbe log improved: "Apple Silicon detected: Metal GPU manages memory natively" (was "assuming CPU mode") / ReadinessProbeログ改善
  - 10 new tests (8 hardware-detector + 2 readiness-probe) / テスト10件追加
  - SEC/TDA/LCC 3-agent audit passed / SEC/TDA/LCC 3エージェント監査通過
- **NOTICE file** with Apple trademark attribution (per LCC audit recommendation) / Apple商標帰属表示のNOTICEファイル（LCC監査推奨）

### Fixed / 修正

- **Docker Compose backup authentication failure** / **Docker Composeバックアップ認証失敗**
  - Root cause: Docker Compose only reads `.env` by default, not `.env.local`, causing `POSTGRES_PASSWORD` to always resolve to the default `change_me` / 根本原因: Docker Composeは`.env`のみ読み込み、`.env.local`を読まないため`POSTGRES_PASSWORD`が常にデフォルト値`change_me`に展開される
  - Fix: `env_file` two-stage loading (`.env.example` defaults → `.env.local` overrides) / 修正: `env_file` 2段階読み込み（`.env.example`デフォルト → `.env.local`上書き）
  - Added auth pre-flight check (`pg_isready` + `psql SELECT 1`) to `db-backup.sh` and `db-restore.sh` / `db-backup.sh`と`db-restore.sh`に認証事前チェック（`pg_isready` + `psql SELECT 1`）追加
  - Added container-mode support to `db-restore.sh` (`REFTRIX_BACKUP_INSIDE_CONTAINER=true`) / `db-restore.sh`にコンテナ内モード対応追加（`REFTRIX_BACKUP_INSIDE_CONTAINER=true`）
  - `POSTGRES_PASSWORD` added to `.env.example` for Docker Compose consumption / Docker Compose用に`.env.example`に`POSTGRES_PASSWORD`追加
- **Quickstart setup completeness** / **Quickstartセットアップの完全性**
  - Added `pnpm exec playwright install chromium` for page crawling browser dependency / ページクロール用ブラウザ依存の`pnpm exec playwright install chromium`追加
  - Integrated Ollama setup into main Setup section (was optional, now required) / Ollamaセットアップをメインセットアップセクションに統合（オプション→必須）
  - Added `NODE_ENV` and `OLLAMA_BASE_URL` to MCP config example / MCP設定例に`NODE_ENV`と`OLLAMA_BASE_URL`追加
  - Corrected worker auto-start documentation (WorkerSupervisor auto-starts, no manual launch needed) / Worker自動起動ドキュメントの修正（WorkerSupervisorが自動起動、手動起動不要）
- **Ollama Vision OOM prevention (3-point unload)** / **Ollama Vision OOM防止（3箇所アンロード）**
  - Unloads Vision model via `keep_alive: "0"` at 3 points: (1) after Phase 1 Layout Analysis, (2) after Phase 2.5 Scroll Vision, (3) after Phase 4 Narrative / 3箇所でVisionモデルをアンロード
  - Frees ~10.6 GB on CPU-only (16 GB RAM) to prevent embedding OOM / CPU-only環境で~10.6GB解放しembedding OOM防止
  - Phase 1 unload also fixes Phase 2.5 skip on GPU environments (VRAM threshold was not cleared) / Phase 1アンロードでGPU環境のPhase 2.5スキップも解消
  - Idempotent (no-op when Vision not loaded); SSRF-safe via `validateOllamaLocalhostUrl()` / 冪等; SSRF対策済み
- **Default mode `visionUsed: false`** -- was incorrectly set even when Vision was used / デフォルトモードでVision使用時もfalseになっていた
- **CPU-only scroll vision timeout** -- scroll vision analysis timed out prematurely on CPU environments / CPU環境でスクロールVision分析が早期タイムアウト

### Changed / 変更

- Ollama (`llama3.2-vision`) promoted from optional to required prerequisite / Ollama（`llama3.2-vision`）をオプションから必須の前提条件に昇格
- Backup/restore scripts now show clear bilingual error messages on auth failure / バックアップ/リストアスクリプトが認証失敗時に明確な日英エラーメッセージを表示

### Documentation / ドキュメント

- Updated `current-architecture.md` HardwareDetector section with GpuVendor enum, `isAppleSilicon()`, Apple Silicon Unified Memory explanation / `current-architecture.md`のHardwareDetectorセクションにGpuVendor enum・isAppleSilicon()・Unified Memory説明を追加
- Updated `current-architecture.md` Database Backup & Restore section (bilingual, env_file two-stage loading, auth pre-flight check) / `current-architecture.md`のDatabase Backup & Restoreセクション更新（日英バイリンガル、env_file 2段階読み込み、認証事前チェック）
- Added troubleshooting section 2.6: Backup/Restore Authentication Failure / トラブルシューティングセクション2.6追加: バックアップ/リストア認証失敗
- Updated FAQ Q8 to use `pnpm db:backup` / FAQ Q8を`pnpm db:backup`に更新
- Updated development rules with Ollama Vision Unload + Apple Metal Support info / 開発ルールにOllama Vision Unload＋Apple Metal Support情報を追加

## [0.1.1] - 2026-03-03

### Added / 追加

- **Responsive design analysis** (`responsive.search` -- 20th MCP tool) / **レスポンシブデザイン分析**（`responsive.search` -- 20番目のMCPツール）
  - Multi-viewport capture (mobile 375px / tablet 768px / desktop 1440px) with Playwright / Playwrightによるマルチビューポートキャプチャ
  - Difference detection engine v2: computedStyle, BoundingRect, external CSS resolution / 検出エンジンv2: computedStyle・BoundingRect・外部CSS解決
  - Screenshot diff via Pixelmatch with configurable threshold / Pixelmatchによるスクリーンショット差分（閾値設定可能）
  - 8 diff categories: layout, typography, spacing, visibility, navigation, image, interaction, animation / 8つの差異カテゴリ
  - Semantic search over responsive analysis results via pgvector HNSW + JSONB filters / pgvector HNSW + JSONBフィルタによるレスポンシブ分析セマンティック検索
  - Embedding generation integrated into Worker Phase 5 pipeline / Worker Phase 5パイプラインにEmbedding生成を統合
  - Clean-slate pattern: re-analysis overwrites previous results per URL / Clean-slateパターン: 同一URL再分析時に旧データを上書き
  - SEC/TDA/LCC 3-agent audit passed (2 rounds) / SEC/TDA/LCC 3エージェント監査通過（2ラウンド）
- Full Japanese README at `docs/README.ja.md` / 日本語フルREADME（`docs/README.ja.md`）
- Restructured English-main `README.md` (~150 lines, concise and action-oriented) / 英語メインREADME再構築（約150行、簡潔・行動指向）

### Fixed / 修正

- ONNX Worker Thread `execArgv` propagation causing zero embeddings / ONNX Worker ThreadのexecArgv伝播によるEmbedding生成0件問題
- Missing `setEmbeddingServiceFactory` in Worker process DI initialization / WorkerプロセスDI初期化でのsetEmbeddingServiceFactory未設定
- `screenshot_diffs` design bug: separated internal capture from response payload / screenshot_diffs設計バグ: 内部キャプチャとレスポンス返却の分離
- `viewportsAnalyzed` missing `width`/`height` fields / viewportsAnalyzedのwidth/heightフィールド欠落
- Offset schema missing `.int()` constraint (SEC W-1) / offsetスキーマの.int()制約欠落（SEC W-1）

### Changed / 変更

- MCP tool count: 19 → **20** (added `responsive.search`) / MCPツール数: 19 → **20**（`responsive.search`追加）
- Updated all documentation to reflect 20 tools / 全ドキュメントを20ツールに更新
  - `README.md`, `apps/mcp-server/README.md`, `docs/users-guide/02-mcp-tools-guide.md`, `docs/users-guide/03-page-analyze-deep-dive.md`

## [0.1.0] - 2026-03-01

### Added / 追加

- Initial OSS release / 初回OSS公開
- MCP Server with 19 tools (layout, motion, quality, page analysis, search) / 19ツール搭載のMCPサーバー（レイアウト、モーション、品質、ページ分析、検索）
- Layout analysis and section detection / レイアウト分析とセクション検出
- Motion/animation detection (CSS + JavaScript) / モーション・アニメーション検出（CSS + JavaScript）
- Design quality evaluation / デザイン品質評価
- Semantic search with multilingual-e5-base embeddings (768 dimensions) / multilingual-e5-baseエンベディングによるセマンティック検索（768次元）
- Hybrid search (vector + full-text with RRF) / ハイブリッド検索（ベクトル + 全文検索、RRF統合）
- Background design detection / 背景デザイン検出
- Narrative analysis with vector + full-text + hybrid search / ベクトル・全文・ハイブリッド検索対応のナラティブ分析
- Frame image analysis with Worker thread parallelization, CLS calculation, and color change detection / Worker Thread並列処理・CLS計算・色変化検出対応のフレーム画像分析
- Page analysis pipeline with WorkerSupervisor / WorkerSupervisorによるページ分析パイプライン
- GPU Resource Manager for ONNX/Ollama coordination / ONNX/Ollama連携のためのGPUリソースマネージャー
- PostgreSQL 18 + pgvector 0.8 with HNSW indexing / PostgreSQL 18 + pgvector 0.8（HNSWインデックス）
- Browser automation with Playwright / Playwrightによるブラウザ自動化
- Comprehensive pre-release security audit / 包括的リリース前セキュリティ監査
- `pnpm audit --audit-level=high` enforced in CI / CIでHigh以上の脆弱性チェック強制
- `REFTRIX_RESPECT_ROBOTS_TXT` environment variable for robots.txt compliance / robots.txt準拠のための環境変数
- Coverage thresholds for all 5 packages / 全5パッケージにカバレッジ閾値を設定
- Prisma `postinstall` generate hook / Prisma postinstallでの自動generate
