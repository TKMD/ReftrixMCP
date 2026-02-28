# Git Workflow - Templates and Examples

**Parent**: `.claude/rules/git-workflow.md`

## Squashコミットメッセージテンプレート / Squash Commit Message Template

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

## Squashコミットメッセージ例 / Squash Commit Message Example

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

## 説明的なコミットメッセージ例 / Descriptive Commit Message Examples

**✅ 良い例 / Good example**:
```bash
git commit -m "feat(auth): add JWT refresh token support (feat-002)

- ユーザーが7日後に再ログインせずに済むようリフレッシュトークンを実装
- アクセストークンは15分で期限切れ、リフレッシュトークンは7日間有効
- セキュリティ強化のため、リフレッシュトークンはHTTP-Only Cookie に保存

Tests: test/auth/refresh-token.test.ts (pass@3: 3/3)
Refs: feat-002, decision-20260118-002

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

**❌ 悪い例 / Bad example**:
```bash
# ❌ 悪い例: 曖昧、理由なし
git commit -m "update auth"
```

## PR作成前チェックリスト / Pre-PR Checklist

```bash
# 必須コマンド（すべてパスすること）
pnpm lint && pnpm typecheck && pnpm test
```

- [ ] すべてのテストがパス / All tests pass
- [ ] ESLintエラー: 0件 / ESLint errors: 0
- [ ] TypeScriptエラー: 0件 / TypeScript errors: 0
- [ ] テストカバレッジ: 80%以上 / Test coverage: 80% or higher
- [ ] 差分が800行以下（または分割済み） / Diff under 800 lines (or already split)

