# セキュリティ要件 / Security Requirements

## 評価方法 / Evaluation Criteria

| 検証項目 / Item | 評価方法 / Method | ツール / Tool | 目標 / Target |
|---------|---------|-------|------|
| HTMLサニタイズ / HTML sanitization | 自動（Code） + 手動（Human） / Auto + Manual | DOMPurify + コードレビュー / DOMPurify + code review | XSS脆弱性 0件 / 0 XSS vulnerabilities |
| 脆弱性スキャン / Vulnerability scan | 自動（Code） / Auto | pnpm audit | High/Critical 0件 / 0 High/Critical |
| SSRF対策 / SSRF prevention | 自動（Code） / Auto | Unit Test | プライベートIP/メタデータブロック100% / 100% private IP/metadata blocking |
| SQLインジェクション / SQL injection | 自動（Code） / Auto | Prisma + Unit Test | 脆弱性 0件 / 0 vulnerabilities |
| UUIDv7検証 / UUIDv7 validation | 自動（Code） / Auto | Zod Schema | 無効UUID検出100% / 100% invalid UUID detection |

## HTMLサニタイズ（Webページクロール時） / HTML Sanitization (During Web Page Crawling)

### ✅ PASS基準 / PASS Criteria

- ✅ DOMPurify 3.3.x でHTMLをサニタイズ / Sanitize HTML with DOMPurify 3.3.x
- ✅ 危険なスクリプト参照（`<script>`タグ、`javascript:` URL、イベントハンドラ）が除去されている / Dangerous script references (`<script>` tags, `javascript:` URLs, event handlers) are removed
- ✅ XSS攻撃テストケースが通過（`<script>alert('xss')</script>` 等が無害化） / XSS attack test cases pass (e.g., `<script>alert('xss')</script>` is neutralized)
- ✅ layout.ingest/page.analyzeで取得したHTMLがサニタイズ済み / HTML from layout.ingest/page.analyze is sanitized

### ❌ FAIL基準 / FAIL Criteria

- ❌ DOMPurifyを使用していない / DOMPurify is not used
- ❌ `<script>` タグが残っている / `<script>` tags remain
- ❌ `javascript:` URLが残っている / `javascript:` URLs remain
- ❌ `<script>`、`<iframe>`、`<object>` 等の危険タグが残っている / Dangerous tags like `<script>`, `<iframe>`, `<object>` remain
- **注 / Note**: `<img src>` 等のコンテンツ要素の外部URLはデザイン分析用途で保持される / External URLs in content elements like `<img src>` are preserved for design analysis

### 検証方法 / Verification Method

**自動テスト（Unit Test） / Automated tests (Unit Test)**:
```typescript
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

describe('HTMLサニタイズ', () => {
  test('script タグが除去される', () => {
    const window = new JSDOM('').window;
    const purify = DOMPurify(window as any);
    const dirty = '<p>Hello</p><script>alert("XSS")</script>';
    const clean = purify.sanitize(dirty);
    expect(clean).toBe('<p>Hello</p>');
    expect(clean).not.toContain('<script>');
  });

  test('javascript: URLが除去される', () => {
    const window = new JSDOM('').window;
    const purify = DOMPurify(window as any);
    const dirty = '<a href="javascript:alert(\'XSS\')">Click</a>';
    const clean = purify.sanitize(dirty);
    expect(clean).not.toContain('javascript:');
  });
});
```

**手動検証（コードレビュー） / Manual verification (code review)**:
- layout.ingest/page.analyze のコードでDOMPurify使用を確認 / Verify DOMPurify usage in layout.ingest/page.analyze code
- サニタイズ前のHTMLが外部に漏れていないことを確認 / Verify unsanitized HTML is not exposed externally

## CSP/ヘッダー / CSP/Headers

> **注 / Note**: helmet.jsは現在の依存関係に含まれていない（MCPサーバー専用構成のため）。
> WebサーバーにHTTPエンドポイントを追加する場合は導入を検討すること。
>
> helmet.js is not currently in dependencies (MCP server-only architecture).
> Consider adding it if HTTP endpoints are introduced.
- Content Security Policy の適用（将来的な実装目標） / Content Security Policy enforcement (future implementation goal)

## 依存関係管理 / Dependency Management

```bash
# 脆弱性スキャン / Vulnerability scan
pnpm audit --audit-level=high

# ライセンスチェック / License check
npx license-checker --production \
  --excludePackages "reftrix@<version>;sharp" \
  --onlyAllow "MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;CC0-1.0;CC-BY-4.0;Unlicense;0BSD;AGPL-3.0-only;PostgreSQL;MPL-2.0;Python-2.0;BlueOak-1.0.0"
# Note: sharp is excluded because its native binding (libvips) is LGPL-3.0-or-later; reviewed individually
```

## 品質ゲート（CI必須） / Quality Gate (CI Required)

### ✅ PASS基準（pass^3: 3回連続成功必須） / PASS Criteria (pass^3: must pass 3 consecutive times)

- ✅ `pnpm audit` で High/Critical 脆弱性 0件 / Zero High/Critical vulnerabilities via `pnpm audit`
- ✅ 新規依存のライセンスが以下のポリシーに適合: / New dependency licenses comply with the following policy:
  - **許可（Permissive） / Allowed (Permissive)**: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, CC0-1.0, CC-BY-4.0, Unlicense, 0BSD
  - **許可（その他） / Allowed (Other)**: AGPL-3.0-only（自プロジェクト）, PostgreSQL, Python-2.0, BlueOak-1.0.0
  - **Copyleft互換（CI allowlistに含む） / Copyleft-compatible (included in CI allowlist)**: MPL-2.0（弱コピーレフト。DOMPurify, axe-core等で使用） / MPL-2.0 (weak copyleft; used by DOMPurify, axe-core, etc.)
  - **動的リンク例外 / Dynamic linking exception**: LGPL-3.0-or-later（ネイティブバインディング依存。Sharp/libvips等で使用） / LGPL-3.0-or-later (native binding deps; used by Sharp/libvips, etc.)
- ✅ DOMPurify のセキュリティテストが通過 / DOMPurify security tests pass

### ❌ FAIL基準 / FAIL Criteria

- ❌ High/Critical 脆弱性が1件でも存在 / Any High/Critical vulnerability exists
- ❌ 禁止ライセンスの依存を追加（GPL-2.0-only, GPL-3.0-only, SSPL, CC-BY-NC-*, proprietary） / Adding dependencies with prohibited licenses
- ❌ セキュリティテストが失敗 / Security tests fail

### 自動検証（CI） / Automated Verification (CI)

以下はCI（`.github/workflows/ci.yml`）と同期した検証コマンドです。

The following verification commands are synced with CI (`.github/workflows/ci.yml`).

```bash
# 脆弱性スキャン / Vulnerability scan
pnpm audit --audit-level=high
if [ $? -ne 0 ]; then
  echo "❌ High/Critical 脆弱性検出"
  exit 1
fi

# ライセンスチェック / License check
# ルートパッケージ(reftrix@<version>)はAGPL-3.0-onlyだがlicense-checkerが認識しないため除外
# Root package excluded because license-checker cannot parse its AGPL-3.0-only SPDX ID
npx license-checker --production \
  --excludePackages "reftrix@<version>;sharp" \
  --onlyAllow 'MIT;Apache-2.0;BSD-2-Clause;BSD-3-Clause;ISC;CC0-1.0;CC-BY-4.0;Unlicense;0BSD;AGPL-3.0-only;PostgreSQL;MPL-2.0;Python-2.0;BlueOak-1.0.0'
if [ $? -ne 0 ]; then
  echo "❌ 許可されていないライセンス検出"
  exit 1
fi
```

セキュリティ脆弱性（High/Critical）0件でないとマージ不可。
新規依存追加時はライセンス確認必須。
LGPL-3.0-or-later依存は `license-checker` の `--excludePackages` で除外し、個別にレビュー記録を残すこと。

No merge allowed with any High/Critical vulnerabilities.
License verification is mandatory when adding new dependencies.
LGPL-3.0-or-later dependencies must be excluded via `--excludePackages` and reviewed individually.

## データセキュリティ / Data Security

- 環境変数で機密情報管理（.envファイル） / Manage secrets via environment variables (.env files)
- 本番ログに機密情報出力禁止 / No secrets in production logs
- RLS（Row Level Security）でデータ分離 / Data isolation via RLS (Row Level Security)
- **PostgreSQL 18.x + pgvector 0.8.x**使用 / Uses **PostgreSQL 18.x + pgvector 0.8.x**
- ポート設定: 26432（標準5432 + オフセット21000） / Port: 26432 (standard 5432 + offset 21000)

## 認証・認可 / Authentication & Authorization

- MCPサーバー専用構成（APIアクセスはMCPプロトコル経由のみ） / MCP server-only architecture (API access via MCP protocol only)

## URL/リソースフェッチ / URL/Resource Fetching

- SSRF対策: プライベートIP、メタデータサービスをブロック / SSRF prevention: block private IPs and metadata services
- HTMLサニタイズ必須 / HTML sanitization required
- タイムアウト設定必須（デフォルト30秒） / Timeout required (default 30s)

## SQLインジェクション対策 / SQL Injection Prevention

- Prisma ORM使用（パラメータ化クエリ） / Use Prisma ORM (parameterized queries)
- Raw SQL使用時は必ずパラメータバインド / Always use parameter binding with raw SQL
- UUIDv7バリデーション必須 / UUIDv7 validation required
