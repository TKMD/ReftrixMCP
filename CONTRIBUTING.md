# Contributing to ReftrixMCP

[日本語版](#日本語版) | [English](#english-version)

---

## 日本語版

ReftrixMCPへの貢献に興味を持っていただき、ありがとうございます。このドキュメントでは、プロジェクトへの貢献方法について説明します。

## 目次

- [行動規範](#行動規範)
- [はじめに](#はじめに)
- [CLA（貢献者ライセンス契約）](#cla貢献者ライセンス契約)
- [開発環境のセットアップ](#開発環境のセットアップ)
- [開発ワークフロー](#開発ワークフロー)
- [コーディング規約](#コーディング規約)
- [テスト](#テスト)
- [コミットメッセージ規約](#コミットメッセージ規約)
- [プルリクエストガイドライン](#プルリクエストガイドライン)
- [Issue報告](#issue報告)

---

## 行動規範

このプロジェクトでは、すべての貢献者が敬意を持って協力し合うことを期待しています。建設的で歓迎的な環境を維持するため、以下を遵守してください:

- 他の貢献者を尊重する
- 建設的なフィードバックを提供する
- プロフェッショナルな態度を保つ
- 多様な視点を尊重する

---

## はじめに

### 貢献方法

以下の方法でプロジェクトに貢献できます:

- **バグ報告**: バグを発見した場合は、Issueを作成してください
- **機能提案**: 新機能のアイデアがあれば、Issueで提案してください
- **コード貢献**: バグ修正や新機能の実装を行うPull Requestを送信してください
- **ドキュメント改善**: ドキュメントの誤字修正や改善提案を歓迎します

### 初めての貢献

初めての方は、以下のラベルが付いたIssueから始めることをお勧めします:

- `good first issue`: 初心者向けの簡単なタスク
- `help wanted`: コミュニティからの助けを求めているタスク
- `documentation`: ドキュメント関連のタスク

---

## CLA（貢献者ライセンス契約）

> **重要**: このプロジェクトへの貢献は、AGPL-3.0-onlyライセンスの下で提供されます。
> Pull Requestの送信前に、[CLA](CLA.md)への同意が必要です。

### なぜCLAが必要か

ReftrixMCPはデュアルライセンスモデルであるAGPL-3.0-only + 商用ライセンスを採用しています。外部からの貢献を商用版にも含められるようにするため、初回のPull Request前にCLAへの同意が必要です。商用ライセンスについては [licence@reftrix.io](mailto:licence@reftrix.io) までお問い合わせください。

### 署名方法

1. [CLA.md](CLA.md) の内容を確認してください
2. Pull Requestの説明欄に以下のテキストを含めてください:

   ```
   I have read the CLA Document and I hereby agree to its terms.
   ```

3. コミットメッセージに `Signed-off-by` を含めてください:

   ```bash
   git commit -s -m "feat: your feature description"
   ```

### 注意事項

- CLAに同意いただけない場合、Pull Requestはマージできません
- CLAは貢献者の著作権を保護しつつ、プロジェクトに再ライセンス権を付与するものです
- 詳細は [CLA.md](CLA.md) をご確認ください

---

## 開発環境のセットアップ

### 前提条件

以下のツールがインストールされている必要があります:

- **Node.js**: v20.19.0以上
- **pnpm**: `package.json` の `packageManager` フィールドで指定されたバージョンを使用してください（Corepackで自動管理されます）
- **Docker**: v24.0以上（データベース用）
- **Git**: v2.40以上

### セットアップ手順

1. **リポジトリをフォーク**

   GitHubでリポジトリをフォークし、ローカルにクローンします:

   ```bash
   git clone https://github.com/YOUR_USERNAME/ReftrixMCP.git
   cd ReftrixMCP
   ```

2. **依存関係のインストール**

   ```bash
   pnpm install
   ```

3. **環境変数の設定**

   `.env.example`をコピーして`.env.local`を作成し、必要な環境変数を設定します:

   ```bash
   cp .env.example .env.local
   ```

4. **データベースの起動**

   Dockerを使用してPostgreSQLとpgvectorを起動します:

   ```bash
   pnpm docker:up
   ```

5. **データベースマイグレーション**

   ```bash
   pnpm db:migrate
   pnpm db:seed
   ```

6. **開発ビルドの起動**

   ```bash
   pnpm dev
   ```


### ポート設定

ReftrixMCPは他のプロジェクトとの干渉を避けるため、**21000オフセット**を使用しています:

| サービス | ポート |
|---------|--------|
| PostgreSQL | 26432 |
| Prisma Studio | 26555 |
| Redis | 27379 |

---

## 開発ワークフロー

### ブランチ戦略

- **main**: 本番環境用の安定版ブランチ
- **feature/\***: 新機能開発用ブランチ
- **fix/\***: バグ修正用ブランチ
- **chore/\***: 設定・依存関係更新用ブランチ
- **hotfix/\***: 緊急本番修正用ブランチ
- **docs/\***: ドキュメント更新用ブランチ
- **test/\***: テスト追加・修正用ブランチ
- **refactor/\***: リファクタリング用ブランチ

### 開発の流れ

1. **Issueの作成**（バグ報告や機能提案）
2. **ブランチの作成**

   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **テスト駆動開発（TDD）**

   - まず失敗するテストを書く（Red）
   - テストをパスする最小限のコードを書く（Green）
   - コードをリファクタリングする（Refactor）

4. **コミット**

   Conventional Commits形式でコミットメッセージを書く

5. **プルリクエストの作成**

   mainブランチに対してPRを作成

6. **レビュー対応**

   レビュアーからのフィードバックに対応

7. **マージ**

   承認後、mainブランチにマージ

---

## コーディング規約

### TypeScript

- **strict mode**: `strict: true`を維持
- **any型禁止**: `unknown`と型ガードを使用
- **型注釈**: 関数の戻り値の型を明示
- **命名規則**:
  - ファイル名: `kebab-case`（例: `search-service.ts`）
  - コンポーネント: `PascalCase`（例: `SearchForm`）
  - 関数: `camelCase`（例: `handleSearch`）
  - 定数: `SCREAMING_SNAKE_CASE`（例: `MAX_RESULTS`）
  - 型: `PascalCase`（例: `SearchResult`）

### コンソールログ

- **開発環境**: 詳細なログを出力（`[Module] Action: details`形式）
- **本番環境**: エラーログのみ

```typescript
if (process.env.NODE_ENV === 'development') {
  console.log('[Search] Query:', { q, filters });
}
```

---

## テスト

### テスト駆動開発（TDD）必須

このプロジェクトでは**TDD**を必須としています。

#### テストの種類

1. **ユニットテスト**: 個別の関数・モジュールのテスト
2. **統合テスト**: 複数のモジュールの連携テスト
3. **E2Eテスト**: ユーザーフローの動作テスト（Playwright）

#### テストコマンド

```bash
# 全テスト実行
pnpm test

# ウォッチモード
pnpm test:watch

# カバレッジレポート
pnpm test:coverage

# ユニットテストのみ（現在はmcp-serverパッケージのみ対応）
pnpm test:unit

# 統合テストのみ（現在はmcp-serverパッケージのみ対応）
pnpm test:integration

# スモークテスト（現在はmcp-serverパッケージのみ対応）
pnpm test:smoke

# E2Eテスト（Playwright、mcp-serverパッケージのみ）
pnpm --filter @reftrix/mcp-server test:e2e:playwright
```

> **Note**: `test:unit`, `test:integration`, `test:smoke` は現在 `@reftrix/mcp-server` パッケージのみが対応しています。他パッケージでは `pnpm test` を使用してください。

#### テストカバレッジ目標

- ステートメントカバレッジ: **80%以上**
- ブランチカバレッジ: **70%以上**
- 関数カバレッジ: **85%以上**

#### E2Eテスト

- **Playwright + Chromium**を使用
- **スクリーンショット検証**を実施
- 主要なユーザーフローは100%カバー

---

## コミットメッセージ規約

### Conventional Commits

以下の形式でコミットメッセージを書いてください:

```
<type>(<scope>): <subject>

<body>

<footer>
```

#### Type

| Prefix | 用途 |
|--------|------|
| `feat:` | 新機能 |
| `fix:` | バグ修正 |
| `test:` | テスト追加・修正 |
| `docs:` | ドキュメント |
| `refactor:` | リファクタリング |
| `style:` | コードスタイル変更 |
| `chore:` | ビルド・設定変更 |
| `perf:` | パフォーマンス改善 |
| `hotfix:` | 緊急修正（本番障害対応） |

#### 例

```
feat(search): セマンティック検索機能を実装

- pgvectorを使用したベクトル検索
- HNSW m=16でP95 10.66ms達成
- 多言語対応Embedding (multilingual-e5-base)

Closes #123
```

---

## ブランチ命名規則

### 必須フォーマット

```
<type>/<topic>
```

#### Type一覧

| Type | 用途 | 例 |
|------|------|-----|
| `feature/` | 新機能開発 | `feature/semantic-search` |
| `fix/` | バグ修正 | `fix/login-error` |
| `chore/` | 設定・依存関係更新 | `chore/update-deps` |
| `hotfix/` | 緊急本番修正 | `hotfix/critical-auth-bug` |
| `docs/` | ドキュメント更新 | `docs/api-reference` |
| `test/` | テスト追加・修正 | `test/search-unit-tests` |
| `refactor/` | リファクタリング | `refactor/auth-module` |

#### 命名ルール

- **小文字のみ使用**: `feature/Search` → ❌ / `feature/search` → ✅
- **ハイフン区切り**: `feature/semantic_search` → ❌ / `feature/semantic-search` → ✅
- **短く具体的に**: `feature/add-new-search-functionality-to-the-app` → ❌ / `feature/semantic-search` → ✅

---

## コミットルール

### ブランチ内でのコミット

ブランチ作業中は自由にコミットできます:

- ✅ `WIP: 検索機能の実装中`
- ✅ `fix typo`
- ✅ `wip`
- ✅ 細かい単位での頻繁なコミット

### mainブランチへのマージ時

**Squash and Merge** を使用し、以下のルールを適用:

#### Squashコミットメッセージテンプレート

```
<type>(<scope>): <簡潔な説明>

## 背景
<なぜこの変更が必要か>

## 変更内容
- <変更点1>
- <変更点2>
- <変更点3>

## 影響範囲
- 破壊的変更: あり/なし
- 設定変更: あり/なし
- DB Migration: あり/なし

Refs: #<issue番号>
```

#### Squashコミットメッセージ例

```
feat(search): セマンティック検索機能を実装

## 背景
キーワード検索では意図を正確に捉えられないため、
ベクトル検索による意味的な検索が必要。

## 変更内容
- pgvectorを使用したベクトル検索APIを追加
- HNSW m=16, ef_construction=64でインデックス作成
- multilingual-e5-baseによるEmbedding生成
- Hybrid Search（60% vector + 40% full-text）

## 影響範囲
- 破壊的変更: なし
- 設定変更: あり（EMBEDDING_MODEL環境変数追加）
- DB Migration: あり（embeddingsテーブル追加）

Refs: #123
```

---

## プルリクエストルール

### PRタイトル

PRタイトルは **Squash時の最終コミットメッセージのsubject部分** として使用されます:

- ✅ `feat(search): セマンティック検索機能を実装`
- ✅ `fix(auth): ログイン時のトークン検証エラーを修正`
- ❌ `検索機能の実装`（type/scopeがない）
- ❌ `WIP: 検索機能`（WIPはPRタイトルに使用不可）

### PRサイズ制限

| 状態 | 差分行数 | 推奨アクション |
|------|---------|---------------|
| ✅ 適切 | 400行以下 | そのままレビュー |
| ⚠️ 要検討 | 400-800行 | 分割を検討 |
| ❌ 分割必須 | 800行超 | 必ず分割する |

**例外**: 自動生成ファイル、ロックファイル、大規模リファクタリング（事前承認済み）

### PR作成前チェックリスト

```bash
# 必須コマンド（すべてパスすること）
pnpm lint && pnpm typecheck && pnpm test
```

- [ ] すべてのテストがパス
- [ ] ESLintエラー: 0件
- [ ] TypeScriptエラー: 0件
- [ ] テストカバレッジ: 80%以上
- [ ] 差分が800行以下（または分割済み）
- [ ] CLA に同意済み（初回のみ）
- [ ] コミットに `Signed-off-by` を含めている

---

## マージルール

### マージ方法

**Squash and Merge のみ使用** - 他のマージ方法は禁止

| 方法 | 許可 | 理由 |
|------|------|------|
| Squash and Merge | ✅ | 履歴がクリーン |
| Merge Commit | ❌ | 履歴が複雑になる |
| Rebase and Merge | ❌ | 一貫性のため禁止 |

### ブランチ保護ルール（main）

以下の条件を満たさないとマージ不可:

- ✅ 1人以上のApprove
- ✅ CIステータスチェック通過
- ✅ 最新のmainとの同期（Require up-to-date）
- ✅ 会話（コメント）の解決

### Linear History

mainブランチは常に**一直線の履歴**を維持します:

```
main: A ─ B ─ C ─ D ─ E
         ↑       ↑
      Squash  Squash
```

---

## GitHub設定チェックリスト（管理者向け）

### Settings → General → Pull Requests

- [ ] **Allow squash merging**: ✅ ON
- [ ] **Allow merge commits**: ❌ OFF
- [ ] **Allow rebase merging**: ❌ OFF
- [ ] **Default commit message**: Pull request title

### Settings → Branches → Branch protection rules（main）

- [ ] **Require a pull request before merging**: ✅ ON
- [ ] **Require approvals**: 1
- [ ] **Require status checks to pass**: ✅ ON
- [ ] **Require branches to be up to date**: ✅ ON
- [ ] **Require conversation resolution**: ✅ ON
- [ ] **Require linear history**: ✅ ON

---

## プルリクエストガイドライン

### PRを作成する前に

- [ ] すべてのテストがパスすることを確認
- [ ] ESLintエラーが0件であることを確認
- [ ] TypeScriptエラーが0件であることを確認
- [ ] テストカバレッジが80%以上であることを確認
- [ ] コミットをスカッシュしてクリーンな履歴にする

### PRテンプレート

PRを作成すると、[`.github/pull_request_template.md`](.github/pull_request_template.md) のテンプレートが自動的に適用されます。テンプレートには以下のセクションが含まれます:

- **背景 / 目的**: なぜこの変更が必要か
- **変更点（3〜7点）**: 主な変更内容
- **影響範囲 / 移行**: 破壊的変更・設定変更・DB Migration の有無
- **テスト**: Unit / Integration・E2E / 手動確認のチェックリスト
- **関連Issue**: Fixes / Refs
- **CLA**: 初回コントリビューター向けCLA同意チェック
- **レビュアー向けチェックリスト**: コードスタイル・テスト・ドキュメント確認
- **スクリーンショット**: UI変更の場合のBefore/After

### レビュープロセス

1. **自動チェック**: CI/CDで自動テストが実行されます
2. **コードレビュー**: 少なくとも1人のレビュアーの承認が必要です
3. **品質ゲート**: 以下を満たす必要があります
   - テストカバレッジ 80%以上
   - ESLintエラー 0件
   - TypeScriptエラー 0件
   - セキュリティ脆弱性（High/Critical）0件

---

## Issue報告

### バグ報告

バグを報告する場合は、以下の情報を含めてください:

- **再現手順**: バグを再現する詳細な手順
- **期待される動作**: 本来どう動作すべきか
- **実際の動作**: 実際にどう動作したか
- **環境情報**: OS、ブラウザ、Node.jsバージョンなど
- **スクリーンショット**: 該当する場合

#### バグ報告テンプレート

```markdown
## バグの説明

バグの簡潔な説明

## 再現手順

1. '...'に移動
2. '...'をクリック
3. '...'までスクロール
4. エラーを確認

## 期待される動作

本来の動作の説明

## 実際の動作

実際の動作の説明

## 環境

- OS: [例: macOS 14.0]
- ブラウザ: [例: Chrome 120]
- Node.js: [例: v20.19.0]

## スクリーンショット

該当する場合はスクリーンショットを添付
```

### 機能提案

新機能を提案する場合は、以下の情報を含めてください:

- **解決したい課題**: なぜこの機能が必要か
- **提案する解決策**: どのような機能を追加するか
- **代替案**: 他に検討した解決策
- **追加のコンテキスト**: 参考資料や関連情報

---

## 質問・サポート

- **GitHub Discussions**: 一般的な質問や議論
- **GitHub Issues**: バグ報告や機能提案
- **Pull Requests**: コード貢献

---

ご不明な点がありましたら、お気軽にIssueやDiscussionで質問してください。貢献をお待ちしております！

---

## English Version

Thank you for your interest in contributing to ReftrixMCP! This document provides guidelines for contributing to the project.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started-en)
- [CLA (Contributor License Agreement)](#cla-contributor-license-agreement)
- [Development Setup](#development-setup-en)
- [Development Workflow](#development-workflow-en)
- [Coding Standards](#coding-standards-en)
- [Testing](#testing-en)
- [Commit Message Guidelines](#commit-message-guidelines-en)
- [Pull Request Guidelines](#pull-request-guidelines-en)
- [Issue Reporting](#issue-reporting-en)

---

## Code of Conduct

We expect all contributors to collaborate respectfully. To maintain a constructive and welcoming environment, please:

- Respect other contributors
- Provide constructive feedback
- Maintain a professional attitude
- Respect diverse perspectives

---

## Getting Started (EN)

### Ways to Contribute

You can contribute to the project in the following ways:

- **Bug Reports**: Create an issue if you find a bug
- **Feature Requests**: Suggest new features via issues
- **Code Contributions**: Submit pull requests for bug fixes or new features
- **Documentation**: Help improve documentation

### First-Time Contributors

If you're new, we recommend starting with issues labeled:

- `good first issue`: Simple tasks for beginners
- `help wanted`: Tasks where we need community help
- `documentation`: Documentation-related tasks

---

## CLA (Contributor License Agreement)

> **Important**: Contributions to this project are provided under the AGPL-3.0-only license.
> You must agree to the [CLA](CLA.md) before submitting a Pull Request.

### Why is a CLA Required?

ReftrixMCP uses a dual-license model (AGPL-3.0-only + Commercial License). To allow external contributions to be included in the commercial version, all contributors must sign the CLA before their first Pull Request. For commercial licensing inquiries, contact [licence@reftrix.io](mailto:licence@reftrix.io).

### How to Sign

1. Review the contents of [CLA.md](CLA.md)
2. Include the following text in your Pull Request description:

   ```
   I have read the CLA Document and I hereby agree to its terms.
   ```

3. Include `Signed-off-by` in your commit message:

   ```bash
   git commit -s -m "feat: your feature description"
   ```

### Notes

- Pull Requests cannot be merged without CLA agreement
- The CLA protects contributor copyright while granting the project re-licensing rights
- See [CLA.md](CLA.md) for full details

---

## Development Setup (EN)

### Prerequisites

Ensure you have the following tools installed:

- **Node.js**: v20.19.0 or higher
- **pnpm**: Use the version specified in the `packageManager` field of `package.json` (automatically managed by Corepack)
- **Docker**: v24.0 or higher (for database)
- **Git**: v2.40 or higher

### Setup Steps

1. **Fork the Repository**

   Fork the repository on GitHub and clone it locally:

   ```bash
   git clone https://github.com/YOUR_USERNAME/ReftrixMCP.git
   cd ReftrixMCP
   ```

2. **Install Dependencies**

   ```bash
   pnpm install
   ```

3. **Configure Environment Variables**

   Copy `.env.example` to `.env.local` and configure required variables:

   ```bash
   cp .env.example .env.local
   ```

4. **Start Database**

   Use Docker to start PostgreSQL with pgvector:

   ```bash
   pnpm docker:up
   ```

5. **Run Database Migrations**

   ```bash
   pnpm db:migrate
   pnpm db:seed
   ```

6. **Start Development Build**

   ```bash
   pnpm dev
   ```


### Port Configuration

ReftrixMCP uses a **21000 offset** to avoid conflicts:

| Service | Port |
|---------|------|
| PostgreSQL | 26432 |
| Prisma Studio | 26555 |
| Redis | 27379 |

---

## Development Workflow (EN)

### Branching Strategy

- **main**: Stable production branch
- **feature/\***: Feature development branches
- **fix/\***: Bug fix branches
- **chore/\***: Config/dependency update branches
- **hotfix/\***: Critical production fix branches
- **docs/\***: Documentation update branches
- **test/\***: Test addition/modification branches
- **refactor/\***: Refactoring branches

### Development Flow

1. **Create an Issue** (bug report or feature request)
2. **Create a Branch**

   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Test-Driven Development (TDD)**

   - Write failing tests (Red)
   - Write minimal code to pass (Green)
   - Refactor code (Refactor)

4. **Commit**

   Use Conventional Commits format

5. **Create Pull Request**

   Create a PR against the main branch

6. **Address Review Feedback**

   Respond to reviewer comments

7. **Merge**

   Merge to main after approval

---

## Coding Standards (EN)

### TypeScript

- **Strict mode**: Maintain `strict: true`
- **No any**: Use `unknown` with type guards
- **Type annotations**: Explicitly type function return values
- **Naming conventions**:
  - Files: `kebab-case` (e.g., `search-service.ts`)
  - Components: `PascalCase` (e.g., `SearchForm`)
  - Functions: `camelCase` (e.g., `handleSearch`)
  - Constants: `SCREAMING_SNAKE_CASE` (e.g., `MAX_RESULTS`)
  - Types: `PascalCase` (e.g., `SearchResult`)

### Console Logging

- **Development**: Output detailed logs (`[Module] Action: details` format)
- **Production**: Error logs only

```typescript
if (process.env.NODE_ENV === 'development') {
  console.log('[Search] Query:', { q, filters });
}
```

### Testing (EN)

#### Test Types

1. **Unit Tests**: Test individual functions/modules
2. **Integration Tests**: Test module interactions
3. **E2E Tests**: Test user flows (Playwright)

#### Test Commands

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# Coverage report
pnpm test:coverage

# Unit tests only (currently mcp-server package only)
pnpm test:unit

# Integration tests only (currently mcp-server package only)
pnpm test:integration

# Smoke tests (currently mcp-server package only)
pnpm test:smoke

# E2E tests (Playwright, mcp-server package only)
pnpm --filter @reftrix/mcp-server test:e2e:playwright
```

> **Note**: `test:unit`, `test:integration`, `test:smoke` are currently only supported by the `@reftrix/mcp-server` package. Use `pnpm test` for other packages.

#### Coverage Targets

- Statement coverage: **80%+**
- Branch coverage: **70%+**
- Function coverage: **85%+**

---

## Commit Message Guidelines (EN)

### Conventional Commits

Use the following format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

#### Types

| Prefix | Purpose |
|--------|---------|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `test:` | Test addition/modification |
| `docs:` | Documentation |
| `refactor:` | Refactoring |
| `style:` | Code style changes |
| `chore:` | Build/config changes |
| `perf:` | Performance improvements |
| `hotfix:` | Emergency production fix |

#### Example

```
feat(search): implement semantic search

- Vector search using pgvector
- HNSW m=16 achieving P95 10.66ms
- Multilingual embedding support

Closes #123
```

---

## Branch Naming Conventions (EN)

### Required Format

```
<type>/<topic>
```

#### Types

| Type | Purpose | Example |
|------|---------|---------|
| `feature/` | Feature development | `feature/semantic-search` |
| `fix/` | Bug fix | `fix/login-error` |
| `chore/` | Config/dependency updates | `chore/update-deps` |
| `hotfix/` | Critical production fix | `hotfix/critical-auth-bug` |
| `docs/` | Documentation updates | `docs/api-reference` |
| `test/` | Test additions/modifications | `test/search-unit-tests` |
| `refactor/` | Refactoring | `refactor/auth-module` |

#### Naming Rules

- **Lowercase only**: `feature/Search` -> invalid / `feature/search` -> valid
- **Hyphen-separated**: `feature/semantic_search` -> invalid / `feature/semantic-search` -> valid
- **Short and specific**: `feature/add-new-search-functionality-to-the-app` -> invalid / `feature/semantic-search` -> valid

---

## Commit Rules (EN)

### Commits Within Branches

You are free to commit at will within your branch:

- `WIP: implementing search feature`
- `fix typo`
- `wip`
- Frequent small commits are encouraged

### Merging to main

Use **Squash and Merge** with the following rules:

#### Squash Commit Message Template

```
<type>(<scope>): <brief description>

## Background
<why this change is needed>

## Changes
- <change 1>
- <change 2>
- <change 3>

## Impact
- Breaking changes: yes/no
- Config changes: yes/no
- DB Migration: yes/no

Refs: #<issue number>
```

---

## Pull Request Rules (EN)

### PR Title

PR titles are used as the **subject line of the final squash commit message**:

- `feat(search): implement semantic search`
- `fix(auth): fix token validation error on login`
- `Search implementation` (invalid - missing type/scope)
- `WIP: search feature` (invalid - WIP not allowed in PR titles)

### PR Size Limits

| Status | Diff Lines | Recommended Action |
|--------|-----------|-------------------|
| Appropriate | 400 lines or less | Proceed with review |
| Needs consideration | 400-800 lines | Consider splitting |
| Must split | Over 800 lines | Must be split |

**Exceptions**: Auto-generated files, lock files, large-scale refactoring (pre-approved)

### Pre-PR Checklist

```bash
# Required commands (all must pass)
pnpm lint && pnpm typecheck && pnpm test
```

- [ ] All tests pass
- [ ] ESLint errors: 0
- [ ] TypeScript errors: 0
- [ ] Test coverage: 80%+
- [ ] Diff under 800 lines (or already split)
- [ ] CLA agreed (first time only)
- [ ] Commits include `Signed-off-by`

---

## Merge Rules (EN)

### Merge Method

**Squash and Merge only** - other merge methods are prohibited

| Method | Allowed | Reason |
|--------|---------|--------|
| Squash and Merge | Yes | Clean history |
| Merge Commit | No | History becomes complex |
| Rebase and Merge | No | Prohibited for consistency |

### Branch Protection Rules (main)

The following conditions must be met before merging:

- 1 or more Approvals
- CI status checks passed
- Up to date with latest main (Require up-to-date)
- All conversations resolved

### Linear History

The main branch always maintains a **linear history**:

```
main: A - B - C - D - E
         ^       ^
      Squash  Squash
```

---

## GitHub Settings Checklist (For Administrators) (EN)

### Settings -> General -> Pull Requests

- [ ] **Allow squash merging**: ON
- [ ] **Allow merge commits**: OFF
- [ ] **Allow rebase merging**: OFF
- [ ] **Default commit message**: Pull request title

### Settings -> Branches -> Branch protection rules (main)

- [ ] **Require a pull request before merging**: ON
- [ ] **Require approvals**: 1
- [ ] **Require status checks to pass**: ON
- [ ] **Require branches to be up to date**: ON
- [ ] **Require conversation resolution**: ON
- [ ] **Require linear history**: ON

---

## Pull Request Guidelines (EN)

### Before Creating a PR

- [ ] Ensure all tests pass
- [ ] ESLint errors: 0
- [ ] TypeScript errors: 0
- [ ] Test coverage: 80%+
- [ ] Squash commits for clean history
- [ ] CLA agreed (first-time contributors only)
- [ ] Commits include `Signed-off-by`

### PR Template

When you create a PR, the template from [`.github/pull_request_template.md`](.github/pull_request_template.md) is automatically applied. The template includes the following sections:

- **Background / Purpose**: Why this change is needed
- **Changes (3-7 items)**: Main changes as bullet points
- **Impact / Migration**: Breaking changes, config changes, DB Migration status
- **Tests**: Checklist for Unit / Integration & E2E / Manual verification
- **Related Issues**: Fixes / Refs
- **CLA**: CLA agreement checkbox for first-time contributors
- **Reviewer Checklist**: Code style, tests, and documentation verification
- **Screenshots**: Before/After for UI changes

---

## Issue Reporting (EN)

### Bug Reports

Include the following information:

- **Reproduction steps**: Detailed steps to reproduce
- **Expected behavior**: What should happen
- **Actual behavior**: What actually happens
- **Environment**: OS, browser, Node.js version
- **Screenshots**: If applicable

### Feature Requests

When proposing a new feature, please include:

- **Problem to solve**: Why this feature is needed
- **Proposed solution**: What feature to add
- **Alternatives considered**: Other solutions you explored
- **Additional context**: References or related information

---

## Questions & Support

- **GitHub Discussions**: General questions and discussions
- **GitHub Issues**: Bug reports and feature requests
- **Pull Requests**: Code contributions

---

Feel free to ask questions via issues or discussions. We look forward to your contributions!
