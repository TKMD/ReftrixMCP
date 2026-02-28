# コーディング規約 / Coding Standards

## 評価方法 / Evaluation Criteria

| 検証項目 / Item | 評価方法 / Method | ツール / Tool | 目標 / Target |
|---------|---------|-------|------|
| TypeScript strict mode | 自動（Code） / Auto | tsc --noEmit | エラー 0件 / 0 errors |
| any型の使用 / `any` type usage | 自動（Code） / Auto | ESLint @typescript-eslint/no-explicit-any | 違反 0件 / 0 violations |
| 戻り値型の明示 / Explicit return types | 自動（Code） / Auto | ESLint @typescript-eslint/explicit-function-return-type | 警告 0件（warn） / 0 warnings |
| 命名規則 / Naming conventions | 手動（Human） / Manual | コードレビュー（naming-conventionルール未設定） / Code review (naming-convention rule not configured) | 規約準拠 / Compliant |
| コンソールログ分離 / Console log separation | 自動（Code） / Auto | ESLint no-console（全環境でwarn、console.warn/errorは許可。テストファイルではoff） / ESLint no-console (warn in all envs, console.warn/error allowed, off in test files) | 本番ビルドでログ0件 / 0 logs in production |

## TypeScript

### ✅ PASS基準 / PASS Criteria

- ✅ `strict: true` が tsconfig.json に設定されている / `strict: true` is configured in tsconfig.json
- ✅ `any` 型が0件（`unknown` + 型ガードで代替） / Zero `any` types (use `unknown` + type guards instead)
- ✅ すべての関数・メソッドに戻り値型が明示されている（ESLintで `warn` レベル検出） / All functions/methods have explicit return types (detected at `warn` level by ESLint)
- ✅ インターフェースに `I` プレフィックスが使用されていない / No `I` prefix on interfaces

### ❌ FAIL基準 / FAIL Criteria

- ❌ tsconfig.json で `strict: false` / `strict: false` in tsconfig.json
- ❌ `any` 型が1件でも存在（緊急の型定義困難な場合は `// eslint-disable-next-line` + 理由コメント必須。テストファイルではモック用途として `warn` レベルに緩和） / Any `any` type present (if unavoidable, require `// eslint-disable-next-line` + reason comment. Relaxed to `warn` level in test files for mocking purposes)
- ❌ 戻り値型が省略されている関数が存在（ESLint `warn` で警告、コードレビューで修正必須） / Functions with omitted return types (ESLint `warn`, must fix during code review)
- ❌ `IUser` のような `I` プレフィックス付きインターフェース / Interfaces with `I` prefix like `IUser`

### 具体例 / Examples

**✅ 良い例 / Good example**:
```typescript
// 戻り値型明示、unknown使用
function parseJSON(input: string): unknown {
  return JSON.parse(input);
}

// 型ガードで安全に使用
interface User {
  id: string;
  name: string;
}

function isUser(value: unknown): value is User {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'name' in value
  );
}

const data = parseJSON(jsonString);
if (isUser(data)) {
  console.log(data.name); // 型安全
}
```

**❌ 悪い例 / Bad example**:
```typescript
// any型使用、戻り値型省略
function parseJSON(input: string) {
  return JSON.parse(input) as any; // ❌ any禁止
}

// Iプレフィックス
interface IUser { // ❌ I不要
  id: string;
}
```

## 命名規則 / Naming Conventions

### ✅ PASS基準（コードレビューによる手動検証） / PASS Criteria (Manual verification via code review)

> **注 / Note**: `@typescript-eslint/naming-convention` ルールは現在ESLint設定（`packages/config/eslint/index.js`）に未設定のため、コードレビューによる手動検証を行う。
>
> The `@typescript-eslint/naming-convention` rule is not yet configured in the ESLint config, so manual verification is performed during code review.

| 種別 / Type | 規則 / Rule | ✅ 良い例 / Good | ❌ 悪い例 / Bad |
|------|------|----------|----------|
| ファイル名 / File name | kebab-case | `search-service.ts` | `SearchService.ts`, `search_service.ts` |
| クラス / Class | PascalCase | `SearchService` | `searchService`, `search_service` |
| 関数 / Function | camelCase | `handleSearch` | `HandleSearch`, `handle_search` |
| 定数 / Constant | SCREAMING_SNAKE_CASE | `MAX_RESULTS` | `maxResults`, `max-results` |
| 型・インターフェース / Type/Interface | PascalCase | `SearchResult` | `searchResult`, `ISearchResult` |
| Zodスキーマ / Zod schema | camelCase + Schema | `searchQuerySchema` | `SearchQuerySchema`, `search_query_schema` |

### 検証方法 / Verification Method

**手動検証（コードレビュー時） / Manual verification (during code review)**:
- ファイル名が kebab-case であることを確認 / Verify file names use kebab-case
- コンポーネントファイル名とコンポーネント名が一致（`SearchService.ts` → `export function SearchForm()`） / Class/module file name matches export name
- インターフェース名に `I` プレフィックスがないことを確認（`@typescript-eslint/no-explicit-any` は自動検証済み） / Verify no `I` prefix on interface names

## 技術スタック（2026-03時点） / Tech Stack (as of 2026-03)

| カテゴリ / Category | 技術 / Technology | バージョン / Version |
|---------|------|-----------|
| Backend | Node.js | 20.x LTS (>=20.19.0) |
| Database | PostgreSQL + pgvector | 18.x + 0.8.x |
| Testing | Vitest | 4.x（mcp-server, ml, core, webdesign-core）/ 3.2.x（database） |
| Testing | Playwright | 1.57.0 |

## コンソールログ / Console Logging

**開発環境 / Development**: `[Module] Action:` 形式でログ出力（エラー特定用） / Log output in `[Module] Action:` format (for error identification)

```tsx
// 推奨パターン
if (process.env.NODE_ENV === 'development') {
  console.log('[Hero] isVisible:', isVisible);
}
```

**本番環境 / Production**: 不要なログ出力禁止、エラーログのみloggerへ / No unnecessary logs; error logs only via logger

- `process.env.NODE_ENV`で環境判定 / Use `process.env.NODE_ENV` for environment detection
- 開発時のみconsole.log使用 / Use console.log only in development
- 本番ではloggerライブラリ使用（構造化ログ） / Use logger library in production (structured logging)

## 原則 / Principles

- 単一責任の原則に従う / Follow the Single Responsibility Principle
- 各モジュール/コンポーネントは1つの責任のみ持つ / Each module/component has only one responsibility
- Linter/Formatterで検出できるルールはツールに任せる / Delegate linter/formatter-detectable rules to tooling
