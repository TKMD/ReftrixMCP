# Git運用ルール / Git Workflow Rules

## 評価方法 / Evaluation Criteria

| 検証項目 / Check Item | 評価方法 / Method | 目標 / Target |
|---------|---------|------|
| ブランチ命名規則 / Branch naming convention | 自動（Code） | 100%準拠 / 100% compliance |
| コミットメッセージ形式 / Commit message format | 自動（Code） | Conventional Commits 100% |
| lint/typecheck通過 / lint/typecheck pass | 自動（Code） | エラー 0件 / 0 errors |
| テスト通過（推奨） / Test pass (recommended) | 自動（Code） | 0 failed（CI検証前提） |
| PRサイズ / PR size | 自動（Code） | 800行以下 / 800 lines or less |
| 自動コミット適用 / Auto-commit applied | 自動（Code） | 機能実装・修正完了時 / On feature/fix completion |

---

## ブランチ命名規則（必須） / Branch Naming Convention (Required)

### フォーマット / Format

```
<type>/<topic>
```

### Type一覧 / Type List

| Type | 用途 / Purpose | 例 / Example |
|------|------|-----|
| `feature/` | 新機能開発 / New feature | `feature/semantic-search` |
| `fix/` | バグ修正 / Bug fix | `fix/login-error` |
| `chore/` | 設定・依存関係更新 / Config/dependency updates | `chore/update-deps` |
| `hotfix/` | 緊急本番修正 / Emergency production fix | `hotfix/critical-auth-bug` |
| `docs/` | ドキュメント更新 / Documentation updates | `docs/api-reference` |
| `test/` | テスト追加・修正 / Test additions/fixes | `test/search-unit-tests` |
| `refactor/` | リファクタリング / Refactoring | `refactor/auth-module` |

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

| Prefix | 用途 / Purpose |
|--------|------|
| `feat:` | 新機能 / New feature |
| `fix:` | バグ修正 / Bug fix |
| `test:` | テスト / Tests |
| `docs:` | ドキュメント / Documentation |
| `refactor:` | リファクタリング / Refactoring |
| `style:` | コードスタイル / Code style |
| `chore:` | ビルド・設定 / Build/config |
| `perf:` | パフォーマンス / Performance |
| `hotfix:` | 緊急修正 / Emergency fix |

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
   pnpm lint && pnpm typecheck
   ```
   - ✅ lint/typecheckが成功（exit code 0） / lint/typecheck succeed (exit code 0)
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

| 状態 / Status | 差分行数 / Diff Lines | アクション / Action |
|------|---------|-----------|
| ✅ 適切 / Appropriate | 400行以下 / 400 or less | そのままレビュー / Review as-is |
| ⚠️ 要検討 / Needs review | 400-800行 / 400-800 | 分割を検討 / Consider splitting |
| ❌ 分割必須 / Must split | 800行超 / Over 800 | 必ず分割する / Must split |

**例外 / Exceptions**: 自動生成ファイル、ロックファイル、大規模リファクタリング（事前承認済み） / Auto-generated files, lock files, large refactoring (pre-approved)

### PR作成前チェックリスト / Pre-PR Checklist

```bash
# 必須コマンド（すべてパスすること）
pnpm lint && pnpm typecheck && pnpm test
```

- [ ] すべてのテストがパス / All tests pass
- [ ] ESLintエラー: 0件 / ESLint errors: 0
- [ ] TypeScriptエラー: 0件 / TypeScript errors: 0
- [ ] テストカバレッジ: 80%以上 / Test coverage: above 80%
- [ ] 差分が800行以下（または分割済み） / Diff 800 lines or less (or already split)

---

## マージルール（最重要） / Merge Rules (Most Important)

### マージ方法（Squash and Merge のみ） / Merge Method (Squash and Merge Only)

| 方法 / Method | 許可 / Allowed | 理由 / Reason |
|------|------|------|
| **Squash and Merge** | ✅ | 履歴がクリーン / Clean history |
| Merge Commit | ❌ 禁止 / Prohibited | 履歴が複雑になる / History becomes complex |
| Rebase and Merge | ❌ 禁止 / Prohibited | 一貫性のため / For consistency |

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

## 関連ドキュメント / Related Documents

- **詳細なルール / Detailed rules**: `CONTRIBUTING.md`
- **PRテンプレート / PR template**: `.github/pull_request_template.md`
- **コードオーナー / Code owners**: `CODEOWNERS`
