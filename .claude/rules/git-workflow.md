# Git運用ルール / Git Workflow Rules

## 評価方法 / Evaluation Criteria

| 検証項目 / Check Item                          | 評価方法 / Method | 目標 / Target                                    |
| ---------------------------------------------- | ----------------- | ------------------------------------------------ |
| ブランチ命名規則 / Branch naming convention    | 自動（Code）      | 100%準拠 / 100% compliance                       |
| コミットメッセージ形式 / Commit message format | 自動（Code）      | Conventional Commits 100%                        |
| lint/typecheck通過 / lint/typecheck pass       | 自動（Code）      | エラー 0件 / 0 errors                            |
| テスト通過（推奨） / Test pass (recommended)   | 自動（Code）      | 0 failed（CI検証前提）                           |
| PRサイズ / PR size                             | 自動（Code）      | 800行以下 / 800 lines or less                    |
| 自動コミット適用 / Auto-commit applied         | 自動（Code）      | 機能実装・修正完了時 / On feature/fix completion |

---

## ブランチ命名規則（必須） / Branch Naming Convention (Required)

### フォーマット / Format

```
<type>/<topic>
```

### Type一覧 / Type List

| Type        | 用途 / Purpose                                 | 例 / Example               |
| ----------- | ---------------------------------------------- | -------------------------- |
| `feature/`  | 新機能開発 / New feature                       | `feature/semantic-search`  |
| `fix/`      | バグ修正 / Bug fix                             | `fix/login-error`          |
| `chore/`    | 設定・依存関係更新 / Config/dependency updates | `chore/update-deps`        |
| `hotfix/`   | 緊急本番修正 / Emergency production fix        | `hotfix/critical-auth-bug` |
| `docs/`     | ドキュメント更新 / Documentation updates       | `docs/api-reference`       |
| `test/`     | テスト追加・修正 / Test additions/fixes        | `test/search-unit-tests`   |
| `refactor/` | リファクタリング / Refactoring                 | `refactor/auth-module`     |

### 命名ルール / Naming Rules

- ✅ **小文字のみ使用 / Lowercase only**: `feature/search`
- ✅ **ハイフン区切り / Hyphen-separated**: `feature/semantic-search`
- ✅ **短く具体的に / Short and specific**: `feature/semantic-search`
- ❌ 大文字 / Uppercase: `feature/Search`
- ❌ アンダースコア / Underscores: `feature/semantic_search`
- ❌ 長すぎる / Too long: `feature/add-new-search-functionality-to-the-app`

---

## コミットルール / Commit Rules

### ブランチ内でのコミット（自由） / Commits Within Branch (Flexible)

ブランチ作業中は自由にコミットできます:

Commits during branch work are flexible:

- ✅ `WIP: 検索機能の実装中`
- ✅ `fix typo`
- ✅ `wip`
- ✅ 細かい単位での頻繁なコミット / Frequent small commits

### Conventional Commits形式 / Conventional Commits Format

| Prefix      | 用途 / Purpose                 |
| ----------- | ------------------------------ |
| `feat:`     | 新機能 / New feature           |
| `fix:`      | バグ修正 / Bug fix             |
| `test:`     | テスト / Tests                 |
| `docs:`     | ドキュメント / Documentation   |
| `refactor:` | リファクタリング / Refactoring |
| `style:`    | コードスタイル / Code style    |
| `chore:`    | ビルド・設定 / Build/config    |
| `perf:`     | パフォーマンス / Performance   |
| `hotfix:`   | 緊急修正 / Emergency fix       |

---

## MCP Clientでのコミット / Commits via MCP Client

### ✅ PASS基準（自動コミット許可条件） / PASS Criteria (Auto-commit Conditions)

**以下の場合は自動コミット可能 / Auto-commit allowed when**:

- ✅ 機能実装完了時（feat） / Feature implementation complete
- ✅ バグ修正完了時（fix） / Bug fix complete
- ✅ Enhancement完了時（refactor, perf） / Enhancement complete
- ✅ ユーザーが明示的に依頼した場合（「コミットして」「変更をコミット」等） / User explicitly requests commit

**コミット判断の基準 / Commit criteria**:

- 実装が完了し、論理的な区切りがついている / Implementation complete with logical breakpoint
- Pre-commit検証（lint, typecheck）が通過している / Pre-commit checks (lint, typecheck) pass

### ❌ FAIL基準（コミット禁止） / FAIL Criteria (Commit Prohibited)

以下の場合は**コミットしない** / Do **NOT** commit when:

- ❌ 実装が未完了（WIP状態） / Implementation incomplete (WIP)
- ❌ lint/typecheckエラーが存在 / lint/typecheck errors exist
- ❌ ユーザーが明示的に「コミットしないで」と指示した場合 / User explicitly says "don't commit"

### コミット時の必須事項（3ステップ） / Required Commit Steps (3 Steps)

1. **Pre-commit検証 / Pre-commit Verification**:

   ```bash
   pnpm lint && pnpm typecheck && pnpm format:check
   ```

   - ✅ lint/typecheck/format:checkが成功（exit code 0） / lint/typecheck/format:check succeed (exit code 0)
   - ❌ いずれかが失敗した場合、ユーザーに報告してコミット中止 / If either fails, report to user and abort commit
   - **注**: テストは推奨だが必須ではない（CI環境で検証される前提） / Note: Tests recommended but not required (verified in CI)

2. **コミット実行 / Execute Commit**:
   - Conventional Commits形式のメッセージ生成 / Generate Conventional Commits message
   - 変更内容を簡潔に説明（What + Why） / Concisely describe changes (What + Why)
   - Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com> 追加

3. **Post-commit確認 / Post-commit Verification**:

   ```bash
   git status
   git log -1 --stat
   ```

   - コミット成功を確認してユーザーに報告 / Verify commit success and report to user

---

## プルリクエストルール / Pull Request Rules

### PRタイトル形式（必須） / PR Title Format (Required)

PRタイトルは **Squash時の最終コミットメッセージのsubject部分** として使用:

PR title is used as the **final squash commit message subject**:

- ✅ `feat(search): セマンティック検索機能を実装`
- ✅ `fix(auth): ログイン時のトークン検証エラーを修正`
- ❌ `検索機能の実装`（type/scopeがない / missing type/scope）
- ❌ `WIP: 検索機能`（WIPはPRタイトルに使用不可 / WIP not allowed in PR title）

### PRサイズ制限 / PR Size Limits

| 状態 / Status            | 差分行数 / Diff Lines   | アクション / Action             |
| ------------------------ | ----------------------- | ------------------------------- |
| ✅ 適切 / Appropriate    | 400行以下 / 400 or less | そのままレビュー / Review as-is |
| ⚠️ 要検討 / Needs review | 400-800行 / 400-800     | 分割を検討 / Consider splitting |
| ❌ 分割必須 / Must split | 800行超 / Over 800      | 必ず分割する / Must split       |

**例外 / Exceptions**: 自動生成ファイル、ロックファイル、大規模リファクタリング（事前承認済み） / Auto-generated files, lock files, large refactoring (pre-approved)

**Plan v2 PR-Bα series LoC variance band gate / Plan v2 PR-Bα シリーズ LoC 偏差バンドゲート**: PR-Bα-2 (N≥2) では [ADR-0026](../specs/adr/ADR-0026-loc-tolerance-principle.md) の 4-band ladder (Green ±10% / Yellow / Red ±20% / Hard fail) で actual feat-only LoC vs predicted LoC を gate する。governance-only PR は本 ADR §Decision 2 Red-band sign-off 経路で 800-line hard cap exception と直交契約。 / For PR-Bα-2 onward, the 4-band ladder gate from ADR-0026 governs actual feat-only LoC vs predicted LoC; governance-only PRs are orthogonal to the 800-line hard cap via Decision 2 Red-band sign-off.

### PR作成前チェックリスト / Pre-PR Checklist

```bash
# 必須コマンド（すべてパスすること）
pnpm lint && pnpm typecheck && pnpm format:check && pnpm test
```

- [ ] すべてのテストがパス / All tests pass
- [ ] ESLintエラー: 0件 / ESLint errors: 0
- [ ] TypeScriptエラー: 0件 / TypeScript errors: 0
- [ ] テストカバレッジ: 80%以上 / Test coverage: above 80%
- [ ] 差分が800行以下（または分割済み） / Diff 800 lines or less (or already split)

#### Quality Gate コマンド列の記述規約 / Quality Gate Command Sequence Convention

**規約 / Convention**: Quality Gate コマンド列 (`pnpm lint && pnpm typecheck && pnpm format:check && pnpm test` 等) は、`docs-verify` の `qualityGateEnum()` 抽出器が検出・検証できるよう、**fenced bash コードブロック** (` ```bash ` で開始) で記述しなければならない。インラインコード (`` ` `` 単一バックティック) や箇条書き内の plain text 列挙は検出対象外となり、Registry §15 EXEMPT scope safety net による整合性検証を bypass する。

Quality Gate command sequences (e.g. `pnpm lint && pnpm typecheck && pnpm format:check && pnpm test`) MUST be expressed as **fenced bash code blocks** (opening with ` ```bash `) so that the `docs-verify` `qualityGateEnum()` extractor can detect and validate them. Inline code (single backticks) or plain-text enumerations in bullet lists are NOT detected and bypass the Registry §15 EXEMPT scope safety net consistency check.

**適用範囲 / Scope**: `配下の Plan /` 配下の ADR で Quality Gate を列挙するすべての `##` / `###` / `####` セクション。

Applies to all `##` / `###` / `####` sections enumerating Quality Gate commands under `(Plans) or` (ADRs).

**Cross-ref**: Registry §13.14 TPA-PHASE3-BATCH-C-01 (L) / `scripts/docs-verify-extract.mjs` `qualityGateEnum()` JSDoc / `CONTRIBUTING.md` Pre-PR Checklist.

---

## マージルール（最重要） / Merge Rules (Most Important)

### マージ方法（Squash and Merge のみ） / Merge Method (Squash and Merge Only)

| 方法 / Method        | 許可 / Allowed       | 理由 / Reason                              |
| -------------------- | -------------------- | ------------------------------------------ |
| **Squash and Merge** | ✅                   | 履歴がクリーン / Clean history             |
| Merge Commit         | ❌ 禁止 / Prohibited | 履歴が複雑になる / History becomes complex |
| Rebase and Merge     | ❌ 禁止 / Prohibited | 一貫性のため / For consistency             |

### Squashコミットメッセージ / Squash Commit Message

**テンプレート**: 背景/変更内容/影響範囲を明記

**詳細**: [references/git-templates.md](./references/git-templates.md)

### Linear History（一直線の履歴） / Linear History

mainブランチは常に**一直線の履歴**を維持:

The main branch always maintains a **linear history**:

```
main: A ─ B ─ C ─ D ─ E
         ↑       ↑
      Squash  Squash
```

---

## プッシュ条件 / Push Conditions

プッシュはユーザー承認後のみ実行する。

Push only after user approval.

1. 機能開発が完了している / Feature development is complete
2. ユーザー（レビュワー）が承認 / User (reviewer) approves
3. コミットがSquash用に準備済み / Commits prepared for squash

---

## 禁止事項 / Prohibited Actions

- ❌ WIP状態でのmainへのマージ / Merging WIP to main
- ❌ テスト未通過でのプッシュ / Pushing with failing tests
- ❌ ユーザー承認なしでのプッシュ / Pushing without user approval
- ❌ セキュリティ脆弱性残存でのプッシュ / Pushing with remaining security vulnerabilities
- ❌ `git push --force` の無断使用 / Unauthorized use of `git push --force`
- ❌ Merge Commit / Rebase and Merge の使用 / Using Merge Commit or Rebase and Merge
- ❌ 800行超のPR（分割なし） / PR over 800 lines (without splitting)

---

## CHANGELOG管理ルール / CHANGELOG Management Rules

### 3つのCHANGELOG / Three CHANGELOGs

v0.4.0 PR-D-9 で `apps/mcp-server/CHANGELOG.md`（パッケージレベル）を追加し、3 CHANGELOG 構成に拡張（PR-D-9 Phase 3 docs-sync OBS-2 / OBS-PRDD9-01 per Finding Registry §11.6）。

As of v0.4.0 PR-D-9, `apps/mcp-server/CHANGELOG.md` (package-level) was added, expanding to a 3-CHANGELOG structure (PR-D-9 Phase 3 docs-sync OBS-2 / OBS-PRDD9-01 per Finding Registry §11.6).

| ファイル / File                | 用途 / Purpose                                                                                                                                                                                                                                                                                                                                         | OSS同期 / OSS Sync      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `CHANGELOG.md`（ルート）       | **OSS公開用** — OSSリポジトリに同期される変更のみ記載 / **OSS-facing** — only changes synced to OSS repo                                                                                                                                                                                                                                               | ✅ 同期対象             |
| `                              | **内部完全版** — プロジェクト全変更を記載（エージェント・スキル・内部ドキュメント含む） / **Internal full version** — all project changes including agents, skills, internal docs                                                                                                                                                                      | ❌ 除外（`.ossfilter`） |
| `apps/mcp-server/CHANGELOG.md` | **MCPサーバーパッケージレベル** — MCP server package 固有の変更を記載（コード変更、リファクタ、依存関係更新等）。OSS sync 対象（OSSリポジトリの `apps/mcp-server/` 配下に同期）/ **MCP server package-level** — MCP server package-specific changes (code changes, refactoring, dependency updates). Synced to OSS repo's `apps/mcp-server/` directory | ✅ 同期対象             |

### 3 CHANGELOG sync rules / 3 CHANGELOG 同期ルール

PR-D-9 以降、MCPサーバーのコード変更（リファクタリング、バグ修正、機能追加）は **3 CHANGELOG 全てに bilingual JP/EN で記載** する（FIND-IMPL-LCC-03 / OBS-4 mandatory landing per Registry §11.6）。

From PR-D-9 onward, MCP server code changes (refactoring, bug fixes, feature additions) MUST be recorded in **all 3 CHANGELOGs in bilingual JP/EN** (FIND-IMPL-LCC-03 / OBS-4 mandatory landing per Registry §11.6).

- ルート `CHANGELOG.md`: OSS公開向け要約（コード/テスト変更の本質、AGPL §5(a)/(b) modification notice）/ Root: OSS-facing summary
- ` 内部完全版（IO Decision anchors、Plan/Registry/ADR cross-refs）/ Internal full
- `apps/mcp-server/CHANGELOG.md`: パッケージレベル詳細（per-file LoC deltas、test counts、env var additions）/ Package-level details

Cross-check: `grep -l "PR-D-N" CHANGELOG.md  apps/mcp-server/CHANGELOG.md` が全 3 path を返すこと。

Cross-check: `grep -l "PR-D-N" CHANGELOG.md  apps/mcp-server/CHANGELOG.md` MUST return all 3 paths.

### ルート CHANGELOG.md に記載しない内容 / Do NOT include in root CHANGELOG.md

以下は `.ossfilter` でOSS同期から除外されるため、ルートCHANGELOGに記載不要:

The following are excluded from OSS sync via `.ossfilter` and should NOT appear in root CHANGELOG:

- ❌ `.claude/agents/` — エージェント定義の変更 / Agent definition changes
- ❌ ` — 内部仕様ドキュメント変更 / Internal spec document changes
- ❌ `.claude/skills/` — スキル定義の変更 / Skill definition changes
- ❌ `.claude/commands/` — コマンド定義の変更 / Command definition changes
- ❌ `example/` — LP・実験アプリの変更 / LP and experimental app changes
- ❌ 内部ドキュメント整合性修正 / Internal documentation consistency fixes

### ルート CHANGELOG.md に記載する内容 / Include in root CHANGELOG.md

- ✅ MCPサーバーのコード変更（リファクタリング、バグ修正、機能追加） / MCP server code changes
- ✅ セキュリティ修正・脆弱性解消 / Security fixes and vulnerability resolution
- ✅ テスト改善 / Test improvements
- ✅ CI/CD変更 / CI/CD changes
- ✅ 依存関係更新 / Dependency updates
- ✅ パフォーマンス改善 / Performance improvements
- ✅ コードスタイル変更（Prettier等） / Code style changes

---

## OSSリポジトリ運用ルール（最重要） / OSS Repository Operation Rules (Critical)

### 直接編集禁止 / Direct Edit Prohibited

OSSリポジトリ（`TKMD/ReftrixMCP`）への直接コミットは**禁止**。すべての変更はプライベートリポ（`TKMD/Reftrix`）で行い、`sync-oss.sh` 経由で同期する。

Direct commits to the OSS repository (`TKMD/ReftrixMCP`) are **prohibited**. All changes must be made in the private repository (`TKMD/Reftrix`) and synced via `sync-oss.sh`.

| 操作 / Operation              | 許可 / Allowed       | 理由 / Reason                                                 |
| ----------------------------- | -------------------- | ------------------------------------------------------------- |
| プライベートリポで変更 → sync | ✅                   | 同期元が常に正 / Source of truth is always correct            |
| OSSリポに直接コミット         | ❌ 禁止 / Prohibited | 次回sync時に上書きされる / Overwritten on next sync           |
| `.oss-sync/ReftrixMCP` で編集 | ❌ 禁止 / Prohibited | ローカルクローンも同期で上書き / Local clone also overwritten |

### OSS同期フロー / OSS Sync Flow

npm 公開は **2 経路**に分かれる: **primary = CI（Trusted Publishing / OIDC）**、**fallback = ローカル publish（opt-in）**。`sync-oss.sh` は git 同期までを担い、**npm publish を既定で skip** する（publish は CI 側の責務）。

npm publishing has **two paths**: **primary = CI (Trusted Publishing / OIDC)**, **fallback = local publish (opt-in)**. `sync-oss.sh` handles the git sync and **skips npm publish by default** (publishing is CI's responsibility).

```
プライベートリポで修正 → pnpm lint/typecheck → コミット → sync-oss.sh
                                                           ↓
                                              prepare-oss.sh (Phase 0-3)
                                                  ↓ sed変換・SPDX追加 + publish.yml rsync
                                              Prettier format (Step 3.5)
                                                  ↓
                                              rsync → .oss-sync/ReftrixMCP
                                                  ↓ Prettier再整形
                                              Verification (Phase 4, incl. V34/V35)
                                                  ↓ 全チェックPASS
                                              commit & push → TKMD/ReftrixMCP
                                                  ↓
                        ┌─────────── primary（既定 / default）───────────┐
                        │  gh release create vX.Y.Z --repo TKMD/ReftrixMCP │
                        │            ↓ release: published                  │
                        │  .github/workflows/publish.yml (verify → publish)│
                        │            ↓ npm-publish Environment 承認         │
                        │  npm Trusted Publishing (OIDC) + --provenance     │
                        └──────────────────────────────────────────────────┘
                        ┌──────── fallback（opt-in、CI/OIDC 障害時のみ）────┐
                        │  sync-oss.sh --local-publish                      │
                        │            ↓ Environment 承認 gate を bypass       │
                        │  ローカル npm publish --access public              │
                        └──────────────────────────────────────────────────┘
```

**Primary（CI / OIDC）**: OSS リポで `v*` タグの GitHub Release を作成すると `.github/workflows/publish.yml` が起動し、5 パッケージを Tier 順に npm Trusted Publishing (OIDC) + `--provenance` で公開する（`NPM_TOKEN` 不使用、`npm-publish` Environment の required-reviewer 承認が最後の可逆ゲート）。**recovery の `workflow_dispatch` は `v*` タグ ref から dispatch すること**（Environment のタグ制限は `github.ref` を評価する）。

When you create a GitHub Release for a `v*` tag in the OSS repo, `.github/workflows/publish.yml` publishes the 5 packages in Tier order via npm Trusted Publishing (OIDC) + `--provenance` (no `NPM_TOKEN`; the `npm-publish` Environment's required-reviewer approval is the last reversible gate). A recovery `workflow_dispatch` MUST be dispatched from a `v*` tag ref (the Environment's tag restriction evaluates `github.ref`).

**Fallback（`--local-publish`、opt-in）/ Fallback (`--local-publish`, opt-in)**: CI/OIDC が使えない場合に限り `sync-oss.sh --local-publish` で従来のローカル npm publish を明示 opt-in できる（Environment 承認 gate を bypass するため通常経路では使わない）。/ Only when CI/OIDC is unavailable, `sync-oss.sh --local-publish` explicitly opts into the legacy local npm publish (bypasses the Environment-approval gate — not for the normal flow).

**`--skip-publish` は no-op（後方互換）/ `--skip-publish` is a no-op (backward-compatible)**: publish はもはや既定で skip されるため、`sync-oss.sh --skip-publish` は **no-op + `[DEPRECATION]` warn** になった（後方互換のため残置、review checkpoint 2026-07-13 refresh-on-elapse）。/ Because publish is now skipped by default, `sync-oss.sh --skip-publish` is a **no-op + a `[DEPRECATION]` warn** (kept for backward compatibility; review checkpoint 2026-07-13, refresh-on-elapse).

### CI修正が必要な場合 / When CI Fix is Needed

OSSリポのCIが失敗した場合も、**プライベートリポ側で修正** → `sync-oss.sh` で再同期する。

When OSS repo CI fails, fix in the **private repo** → re-sync via `sync-oss.sh`.

1. `gh run view <id> --repo TKMD/ReftrixMCP --log-failed` でエラー特定
2. プライベートリポのソースまたは `prepare-oss.sh` を修正
3. `bash scripts/sync-oss.sh` で再同期（Prettierフォーマット自動適用）

---

## 関連ドキュメント / Related Documents

- **詳細なルール / Detailed rules**: `CONTRIBUTING.md`
- **PRテンプレート / PR template**: `.github/pull_request_template.md`
- **コードオーナー / Code owners**: `CODEOWNERS`
- **内部CHANGELOG / Internal CHANGELOG**: `
