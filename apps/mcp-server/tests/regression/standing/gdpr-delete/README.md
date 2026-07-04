# gdpr-delete Standing Regression Suite

## Purpose / 目的

GDPR Art.17 削除権の常設不変条件を検証する standing regression suite。`data.delete(webPageId)` 実行後、3 秒以内に **5 項目** (web_pages 行、cascading parts/sections、pgvector 4 テーブル、screenshot filesystem、audit_logs Art.30 記録) が完全に削除/書込されていることを保証する。Screenshot 保持は `data.delete` まで (TTL cron は PR-SS-B / ADR-0041 で構造ごと撤去済、`INV-SCREENSHOT-RETENTION-001`)、撤去後は `screenshot_ttl_cleanup` を emit しないこと (`INV-DATA-DELETE-002-B` negative test)、Path Traversal 10 matrix 防御 (null byte / ../ / symlink / CR-LF / 絶対 path / Unicode 正規化 / 空文字列 / 超長文字列 / UUID v7 reject の 10 種) を契約レベルで保証。

Standing regression suite for the GDPR Art.17 right-to-erasure domain. Guarantees that within 3 seconds after `data.delete(webPageId)` execution, **5 items** (web_pages row, cascading parts/sections, pgvector 4 tables, screenshot filesystem, audit_logs Art.30 record) are completely deleted/written. Screenshot retention is until `data.delete` (the TTL cron was removed together with its structure in PR-SS-B / ADR-0041, `INV-SCREENSHOT-RETENTION-001`); after removal no `screenshot_ttl_cleanup` is emitted (`INV-DATA-DELETE-002-B` negative test). Also guarantees Path Traversal defense across 10 matrix variants (null byte / `../` / symlink / CR-LF / absolute path / Unicode normalization / empty string / oversized string / UUID v7 reject).

## Invariants Covered / 対応不変条件

| INV-\*                       | 内容 / Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 関連 ADR / Related ADR                                     | 関連実装ファイル / Related Implementation                                                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| INV-DATA-DELETE-002          | `data.delete(webPageId)` 3s 以内に web_pages + parts/sections + pgvector 4 tables + screenshot + audit_logs の **5 項目完全削除** / 5-item complete deletion within 3s                                                                                                                                                                                                                                                                                                                                                     | (PR7c GDPR / ADR-0009)                                     | `apps/mcp-server/src/services/gdpr-deletion.service.ts`<br>`apps/mcp-server/src/services/screenshot-persistence.service.ts`<br>`apps/mcp-server/src/tools/data/delete.tool.ts`                                        |
| INV-DATA-DELETE-002-B        | (改訂、ADR-0041 §Invariants (1)) Screenshot TTL cron は PR-SS-B で構造ごと撤去済 → `screenshot_ttl_cleanup` action は **production src のいずれからも emit されない** negative assert (TTL 削除経路の暗黙再導入を防ぐ forward-compat guard、`.skip` 不使用) / (revised, ADR-0041 §Invariants (1)) the Screenshot TTL cron was structurally removed in PR-SS-B → negative assert that `screenshot_ttl_cleanup` is **emitted from no production src** (a forward-compat guard against silent re-introduction, never `.skip`) | (ADR-0041 §Invariants (1)、旧 PR7d-3 LCC M-2 を supersede) | `apps/mcp-server/tests/regression/standing/gdpr-delete/inv-data-delete-002-b-ttl-cron.test.ts`                                                                                                                        |
| INV-SCREENSHOT-RETENTION-001 | (ADR-0041 §Invariants (2)) Screenshot 保持の trigger-event は `data.delete` のみ、TTL 構造 (cleanupExpired / cron module) は不在。assertion #5 (`screenshot_ttl_cleanup` 非 emit) は 002-B に単一所掌、本 INV は cross-ref のみ / (ADR-0041 §Invariants (2)) the screenshot retention trigger event is `data.delete` only, the TTL structure (cleanupExpired / cron module) is absent; assertion #5 is owned by 002-B, this INV only cross-refs                                                                            | (ADR-0041 §Invariants (2)、PR-SS-B 新設)                   | `apps/mcp-server/src/services/gdpr-deletion.service.ts` (`buildScreenshotPrismaAdapter` / `getScreenshotService` H-1)<br>`apps/mcp-server/tests/regression/standing/gdpr-delete/inv-screenshot-retention-001.test.ts` |
| INV-DATA-DELETE-002-C        | data.delete Path Traversal **10 matrix** 防御 (ADR-0016 § INV-DATA-DELETE-002-C 参照) / 10-matrix Path Traversal defense                                                                                                                                                                                                                                                                                                                                                                                                   | (PR7d-1 LCC)                                               | `apps/mcp-server/src/services/gdpr-deletion.service.ts`<br>`apps/mcp-server/src/tools/data/delete.tool.ts` (Zod schema)                                                                                               |

**M1 stub の現状 / M1 stub status**: 本ドメインでは現在 1 stub test (`inv-data-delete-002.stub.test.ts`) が `INV-DATA-DELETE-002` で意図的に fail する。M2 で test-qa-engineer + pipeline-engineer + legal-compliance-counsel が `INV-DATA-DELETE-002` / `-002-B` / `-002-C` を独立 file (1 INV → N file 分割上限 4) に分割実装する。Path Traversal 10 matrix の各 invalid input は Zod throw + DB 書込ゼロ + filesystem 書込ゼロ + audit_logs 書込ゼロ を全て assert する。

**M1 stub status**: 1 stub test (`inv-data-delete-002.stub.test.ts`) currently fails intentionally on `INV-DATA-DELETE-002`. M2 will split into independent files (max 4 per INV). Each Path Traversal matrix entry must assert Zod throw + zero DB write + zero filesystem write + zero audit_logs write.

## Owner Agents / 担当エージェント

- **Primary**: `pipeline-engineer` (`gdpr-deletion.service.ts`、`screenshot-persistence.service.ts`。Screenshot TTL cron は PR-SS-B / ADR-0041 で撤去済)
- **Co-reviewer**: `legal-compliance-counsel` (Art.17 within reasonable time = 3s SLA、Art.30 processing activity records、SLA 緩和 Amendment 承認)

## How to Run / 実行方法

```bash
# 全 standing regression suite 実行 / Run full standing suite
pnpm test:regression:standing

# gdpr-delete domain のみ実行 / Run gdpr-delete domain only
pnpm test:regression:standing --filter gdpr-delete
```

CI workflow: `.github/workflows/regression-standing.yml` — 単一 job `Standing Regression (4 domains)` で 4 ドメインを連続実行 (matrix 並列ではなく単一 runner 15 分以内) + nightly 1 連 + weekly 10 連 flaky monitor / single job `Standing Regression (4 domains)` executes all 4 domains sequentially on one runner within 15 minutes (not matrix-parallel) + nightly 1-run + weekly 10-run flaky monitor.

## Failure Response / 失敗時の対応

standing regression の失敗は **P0 incident** 扱い:

Standing regression failure is treated as a **P0 incident**:

1. **即時 merge block** — IO は該当 PR を自動 BLOCK (`.claude/agents/integration-owner.md` 参照) / Immediate merge block
2. **即時エスカレーション** — `pipeline-engineer` (primary) と `legal-compliance-counsel` (co-reviewer) に**同時通知** (GDPR / EDPB 関連は法務同時参画必須) / Notify both `pipeline-engineer` and `legal-compliance-counsel` simultaneously (GDPR/EDPB requires legal co-attendance)
3. **一時的 disable 禁止** — `.skip` / `.todo` / `describe.skip` での回避は禁止 / No `.skip` / `.todo` / `describe.skip` workaround allowed
4. **SLA 緩和は LCC sign-off 必須** — 例: 3 秒 → 10 秒以上への緩和を提案する Amendment は LCC が EDPB "without undue delay" 解釈を再検証した sign-off 必須 (ADR-0016 § Amendment Process) / SLA relaxation requires LCC sign-off (e.g., proposals to relax 3s → 10s+ require LCC re-verification of EDPB "without undue delay" interpretation)
5. **対応経路** — fail 原因を修正するか、INV-\* を改訂する場合は ADR-0016 Amendment を発行 / Fix the root cause, or issue ADR-0016 Amendment to revise INV-\*

## Existing Test Migration / 既存テスト移行履歴

ADR-0016 § Existing Test Migration Mapping より該当 row を抜粋。**方針**: 既存 regression test は **保持し、standing/ は新規作成**。既存は実装詳細検証、standing は契約レベル不変条件検証という責務分離。

Excerpts from ADR-0016 § Existing Test Migration Mapping. **Policy**: existing tests are **retained**; standing/ is **newly created**.

| 既存 test / Existing Test                                          | 関連 INV-\* / Related INV-\* | 扱い / Treatment                                                                                                                                    |
| ------------------------------------------------------------------ | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/services/gdpr-deletion-pr7c-regression.test.ts`             | INV-DATA-DELETE-002          | 保持 (M10 4 cases)、standing/ は 5 項目完全削除 + 3s SLA / Retained (M10 4 cases); standing/ covers 5-item complete deletion + 3s SLA               |
| `tests/services/gdpr-deletion-screenshot.test.ts`                  | INV-DATA-DELETE-002-C        | 保持 (PR7d-1 3 段 whitelist)、standing/ は 10 matrix Path Traversal / Retained (PR7d-1 3-tier whitelist); standing/ covers 10-matrix Path Traversal |
| `tests/tools/data-delete.tool.test.ts`                             | INV-DATA-DELETE-002          | 保持 (MCP tool layer)、standing/ は service layer + filesystem + audit_logs 統合 / Retained (MCP tool layer); standing/ covers integrated layers    |
| `tests/workers/page-analyze-worker-screenshot-persistence.test.ts` | INV-DATA-DELETE-002          | 保持、standing/ で screenshot 削除契約を補完 / Retained; standing/ supplements screenshot deletion contract                                         |

**重複監視 / Duplicate monitoring**: CI で standing と既存の両方が green を要求。両方 fail したら P0 incident、一方のみ fail なら P1 として triage。

## Related Documents / 関連ドキュメント

- [ADR-0016: Standing Regression Suite](../../../../../ — 本 suite の上位契約 / parent contract for this suite
- [ADR-0041: Screenshot Persistent Storage and TTL Removal](../../../../../ — Screenshot TTL 構造撤去 + 保持 = `data.delete` まで + `INV-SCREENSHOT-RETENTION-001` / `INV-DATA-DELETE-002-B` 改訂の背景 / background for the TTL structure removal, retention until `data.delete`, and the revised invariants
- [ADR-0009: Pre-Return Pause + Screenshot TTL](../../../../../ — 旧 Screenshot 7d TTL cron / GDPR `data.delete` 同期削除の歴史的背景 (TTL 側は ADR-0041 で supersede) / historical background for the former Screenshot 7d TTL cron and synchronous deletion (the TTL portion is superseded by ADR-0041)
- `CLAUDE.md` § 常設 Regression Suite / Standing Regression Suite — 4 ドメインの不変条件カテゴリ表 / 4-domain invariant category table
- `CLAUDE.md` § Screenshot Persistence (v0.4.0) — Screenshot 削除経路 = GDPR `data.delete` 同期削除のみ (TTL cron は ADR-0041 で撤去) / Screenshot deletion path = GDPR `data.delete` synchronous deletion only (the TTL cron was removed in ADR-0041)
- ` § Standing Regression Suite — 運用ルール、CI-failing 要件、P0 incident 対応 / operational rules
- ADR-0016 § INV-DATA-DELETE-002 Assertion Contract (5 項目独立 assertion) / 5-item independent assertion contract
- ADR-0016 § INV-DATA-DELETE-002-C Path Traversal 10 Matrix / 10-matrix Path Traversal defense
- `tests/regression/standing/_setup/` — testcontainers / global-setup / per-file-setup / fixture-lifecycle / inv-assert helper
