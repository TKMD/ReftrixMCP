# セキュリティ要件 / Security Requirements

## 評価方法 / Evaluation Criteria

| 検証項目 / Item                     | 評価方法 / Method                            | ツール / Tool                                        | 目標 / Target                                                             |
| ----------------------------------- | -------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| HTMLサニタイズ / HTML sanitization  | 自動（Code） + 手動（Human） / Auto + Manual | DOMPurify + コードレビュー / DOMPurify + code review | XSS脆弱性 0件 / 0 XSS vulnerabilities                                     |
| 脆弱性スキャン / Vulnerability scan | 自動（Code） / Auto                          | pnpm audit                                           | High/Critical 0件 / 0 High/Critical                                       |
| SSRF対策 / SSRF prevention          | 自動（Code） / Auto                          | Unit Test                                            | プライベートIP/メタデータブロック100% / 100% private IP/metadata blocking |
| SQLインジェクション / SQL injection | 自動（Code） / Auto                          | Prisma + Unit Test                                   | 脆弱性 0件 / 0 vulnerabilities                                            |
| UUIDv7検証 / UUIDv7 validation      | 自動（Code） / Auto                          | Zod Schema                                           | 無効UUID検出100% / 100% invalid UUID detection                            |

## HTMLサニタイズ（Webページクロール時） / HTML Sanitization (During Web Page Crawling)

### ✅ PASS基準 / PASS Criteria

- ✅ DOMPurify <!-- gen:ver-dompurify -->3.4<!-- /gen:ver-dompurify -->.x でHTMLをサニタイズ / Sanitize HTML with DOMPurify <!-- gen:ver-dompurify -->3.4<!-- /gen:ver-dompurify -->.x
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
import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

describe("HTMLサニタイズ", () => {
  test("script タグが除去される", () => {
    const window = new JSDOM("").window;
    const purify = DOMPurify(window as any);
    const dirty = '<p>Hello</p><script>alert("XSS")</script>';
    const clean = purify.sanitize(dirty);
    expect(clean).toBe("<p>Hello</p>");
    expect(clean).not.toContain("<script>");
  });

  test("javascript: URLが除去される", () => {
    const window = new JSDOM("").window;
    const purify = DOMPurify(window as any);
    const dirty = "<a href=\"javascript:alert('XSS')\">Click</a>";
    const clean = purify.sanitize(dirty);
    expect(clean).not.toContain("javascript:");
  });
});
```

**手動検証（コードレビュー） / Manual verification (code review)**:

- layout.ingest/page.analyze のコードでDOMPurify使用を確認 / Verify DOMPurify usage in layout.ingest/page.analyze code
- サニタイズ前のHTMLが外部に漏れていないことを確認 / Verify unsanitized HTML is not exposed externally

## レート制限（CWE-770 DoS対策） / Rate Limiting (CWE-770 DoS Prevention)

### ✅ PASS基準 / PASS Criteria

- ✅ Token Bucket + Redis Luaスクリプトによるアトミック制御 / Atomic control via Token Bucket + Redis Lua script
- ✅ 3ティア構成: analysis(10RPM), search(120RPM), default(60RPM) / 3-tier configuration
- ✅ Graceful Degradation: Redis未接続時はインメモリフォールバック / In-memory fallback when Redis unavailable
- ✅ 全<!-- gen:tool-count -->40<!-- /gen:tool-count --> MCPツールに自動適用 / Auto-applied to all <!-- gen:tool-count -->40<!-- /gen:tool-count --> MCP tools

### ❌ FAIL基準 / FAIL Criteria

- ❌ レート制限なしでMCPツールが公開されている / MCP tools exposed without rate limiting
- ❌ Redis障害時にサービス停止 / Service stops on Redis failure

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

### SBOM (Software Bill of Materials)

- CycloneDX 1.6 JSON形式（`pnpm sbom` / CI自動生成） / CycloneDX 1.6 JSON format (`pnpm sbom` / auto-generated in CI)
- EU CRA 2026/9/11脆弱性報告義務対応 / EU CRA vulnerability reporting compliance
- CI: GitHub Artifacts 90日保持 / CI: GitHub Artifacts 90-day retention

### CI ツールの GPL 互換性 — shellcheck (FIND-NPMPUB-SHELLCHECK-GPL-NOTE-01) / CI-tool GPL compatibility — shellcheck

**JP**: `.github/workflows/ci.yml` の `actionlint` job は内蔵の **shellcheck**（`raven-actions/actionlint` wrapper 経由、`shellcheck: "true"` で ACTIVE）を用いて workflow の `run:` bash を静的検証する。shellcheck は **GPL-3.0-or-later** ライセンスだが、これは **CI-only invoke**（GitHub Actions runner 上で lint 実行するのみ）であり、成果物（公開される npm tarball / OSS ソース）に **非配布・非リンク**であるため、AGPL-3.0-only（自プロジェクト）との copyleft 衝突を **trigger しない**（build-time / CI-time の tool 利用であって conveyed work への組込みではない）。したがって shellcheck は `license-checker` の依存関係 allowlist（`## 品質ゲート` の許可リスト）には**追加されない** — CI tool として利用されるのみで project の dependency graph には入らない。

**EN**: The `actionlint` job in `.github/workflows/ci.yml` statically lints the workflows' `run:` bash via the bundled **shellcheck** (through the `raven-actions/actionlint` wrapper, kept ACTIVE with `shellcheck: "true"`). shellcheck is **GPL-3.0-or-later**, but this is a **CI-only invocation** (it merely runs the lint on the GitHub Actions runner) and is **NOT distributed with, nor linked into, any conveyed artifact** (the published npm tarballs / OSS source), so it does **NOT trigger** a copyleft conflict with AGPL-3.0-only (this project) — it is a build-/CI-time tool use, not incorporation into a conveyed work. shellcheck is therefore **NOT added** to the `license-checker` dependency allowlist (the policy list under `## Quality Gate`) — it is used only as a CI tool and never enters the project's dependency graph.

**Cross-ref**: FIND-NPMPUB-SHELLCHECK-GPL-NOTE-01 (Phase 3 docs-sync landing; required landing = "ci.yml comment or security.md" → the `.claude/rules/security.md` leg, since the `ci.yml` actionlint comment carries no GPL note) / `.github/workflows/ci.yml` `actionlint` job (`SHELLCHECK_OPTS=--exclude=SC1091 --exclude=SC2129`, security checks incl. SC2086 kept active) / Finding Registry `(IO Impl Decision V1 = APPROVE`019f5346-7542-7243-9e7a-bc57376f3d8d`).

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
- ❌ 禁止ライセンスの依存を追加（GPL-2.0-only, GPL-3.0-only, SSPL, CC-BY-NC-\*, proprietary） / Adding dependencies with prohibited licenses
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
LGPL-3.0-or-later 依存は**個別にレビュー記録を残すこと**（この義務は維持する）。なお、上記 gate の `--excludePackages` が列挙するのは `reftrix@<version>` と `sharp` のみであり LGPL パッケージを一切列挙しないため、「LGPL 依存を `--excludePackages` で除外する」という従来の記述は**記述どおりには no-op** である（実測。gate は `@img/*` をそもそも検査していない）。`--onlyAllow` への `LGPL-3.0-or-later` の追加は**引き続き禁止**である。

No merge allowed with any High/Critical vulnerabilities.
License verification is mandatory when adding new dependencies.
LGPL-3.0-or-later dependencies **must be reviewed individually and the review recorded** (this obligation is retained). Note that the gate's `--excludePackages` enumerates only `reftrix@<version>` and `sharp` and no LGPL package, so the former instruction to "exclude LGPL dependencies via `--excludePackages`" is **a no-op as written** (measured: the gate never inspects `@img/*`). Adding `LGPL-3.0-or-later` to `--onlyAllow` **remains prohibited**.

## エラーメッセージサニタイズ / Error Message Sanitization

- **Server-side log 規範 / Server-side log rule**: `sanitizeErrorMessage` は client response 専用。server-side log には raw message / error object を出す（適用すると root cause が隠蔽される）/ `sanitizeErrorMessage` is client-response only; server-side logs carry the raw message / error object (applying it hides the root cause). 経緯 / History: `
- **page.evaluate 規範 / page.evaluate rule**: Playwright `page.evaluate` の callback は argument-position の無名関数にし、named function を書かない（tsx keepNames の `__name` 注入で browser ReferenceError、`INV-PAGE-EVALUATE-NO-NAME-INJECTION-001`）/ Write the Playwright `page.evaluate` callback as an argument-position anonymous function, never a named function (tsx keepNames injects `__name` → browser ReferenceError). 詳細 / Details: ` §12

### sanitizeErrorMessage パターン / sanitizeErrorMessage Pattern

v0.2.0で `utils/sanitize-error.ts` に統一ユーティリティとして抽出。<!-- gen:sanitize-usage-count -->122<!-- /gen:sanitize-usage-count -->ファイル・<!-- gen:tool-count -->40<!-- /gen:tool-count -->ツールに適用（<!-- gen:sanitize-import-count -->109<!-- /gen:sanitize-import-count -->ファイルでインポート）。

Extracted as a unified utility in `utils/sanitize-error.ts` in v0.2.0. Applied to <!-- gen:sanitize-usage-count -->122<!-- /gen:sanitize-usage-count --> files and <!-- gen:tool-count -->40<!-- /gen:tool-count --> tools (<!-- gen:sanitize-import-count -->109<!-- /gen:sanitize-import-count --> files importing it).

エラーコードから汎用メッセージへ変換するヘルパー関数を使用し、内部構造の漏洩を防止する。

Use a helper function that maps error codes to generic messages, preventing internal structure leakage.

**✅ PASS基準 / PASS Criteria**:

- ✅ Prisma/SQLの内部構造（テーブル名、カラム名、SQL構文）をクライアントレスポンスに含めない / Do not include Prisma/SQL internals (table names, column names, SQL syntax) in client responses
- ✅ サーバーサイドログには `errorInstance.message` を記録（デバッグ用） / Log `errorInstance.message` on server side (for debugging)
- ✅ クライアントレスポンスには固定メッセージのみ返却 / Return only fixed messages in client responses

**❌ FAIL基準 / FAIL Criteria**:

- ❌ `error.message` をそのままクライアントに返却 / Returning raw `error.message` to client
- ❌ スタックトレースやDB構造がレスポンスに含まれる / Stack traces or DB structure included in response

```typescript
// ✅ 良い例 / Good example
function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    if (code) {
      switch (code) {
        case "P2002":
          return "A record with this value already exists";
        case "P2025":
          return "Record not found";
        default:
          return "Database operation failed";
      }
    }
  }
  return "An internal error occurred";
}

// サーバーログ / Server log
logger.error("Operation failed", { error: errorInstance.message });
// クライアント / Client
return { error: sanitizeErrorMessage(error) };
```

※ 上記は簡略化した例です。詳細は `utils/sanitize-error.ts` を参照。
Note: The above is a simplified example. See `utils/sanitize-error.ts` for full implementation.

### Prisma catch block 採用パターン / Prisma catch block adoption pattern

Prisma `$transaction` / `$executeRawUnsafe` / `createMany` 等の DB 操作 catch block でも、**生 `error.message` を client response に含めず必ず `sanitizeErrorMessage(error)` 経由で汎用メッセージ化する**こと。Prisma error code (`P2002` unique violation / `P2025` record not found 等) の内部テーブル名・カラム名は CWE-209 (Information Exposure Through an Error Message) の latent risk に該当し、client に露出すると DB schema 推定攻撃の足がかりとなる。

In DB-operation catch blocks (Prisma `$transaction` / `$executeRawUnsafe` / `createMany`, etc.) as well, **never put raw `error.message` into client responses — always route through `sanitizeErrorMessage(error)` to convert to a generic message**. Prisma error codes (`P2002` unique violation / `P2025` record not found, etc.) may carry internal table/column names — a CWE-209 (Information Exposure Through an Error Message) latent risk that exposes DB schema inference vectors to the client.

**✅ PASS パターン / PASS pattern**:

```typescript
// Prisma transaction / raw SQL の catch block
try {
  await prisma.$transaction(async (tx) => {
    await tx.componentPartEmbedding.createMany({ data: nonVectorRows });
    for (const part of parts) {
      await tx.$executeRawUnsafe(
        `UPDATE component_part_embeddings
           SET visual_embedding = $1::vector(768)
         WHERE component_part_id = $2::uuid`,
        `[${part.visualEmbedding.join(",")}]`,
        part.componentPartId
      );
    }
  });
} catch (error) {
  // ✅ Server-side: full error logged for debugging
  logger.error("savePartEmbeddings transaction failed", {
    error: (error as Error).message,
    code: (error as { code?: string }).code,
  });
  // ✅ Client-safe: sanitized message + mapped Prisma code
  result.errors.push({
    message: sanitizeErrorMessage(error),
    code: extractPrismaCode(error), // P2002 → "duplicate", P2025 → "not_found"
  });
}
```

**❌ FAIL パターン / FAIL pattern (CWE-209 latent risk)**:

```typescript
// ❌ 生 error.message を client response に push
} catch (error) {
  result.errors.push({
    message: (error as Error).message, // ❌ DB schema leakage risk
    code: (error as { code?: string }).code,
  });
}
```

**Cross-ref**: ADR-0018 §Decision 3.9 "`result.errors[]` sanitize policy" / PR-D-2 landed state の documented risk (FIND-IMPL-SEC-01, M severity, deadline 2026-05-04) / `utils/sanitize-error.ts`

> 過去 PR の L tracked-issue 経緯記録（Embedding backfill IPC 〜 L-tracked bundle）は → `Tracked-issue history (Embedding backfill IPC … L-tracked bundle) moved to` (same headings).

## isDevelopment() ガード原則 / isDevelopment() Guard Principle

### エラーハンドリングでの使用禁止 / Prohibited in Error Handling

エラーハンドリングパス（catchブロック）で `isDevelopment()` ガードを使用しない。本番環境でエラーがサイレント吸収されるリスクを排除する。

Do not use `isDevelopment()` guards in error handling paths (catch blocks). Eliminate the risk of errors being silently absorbed in production.

**✅ PASS基準 / PASS Criteria**:

- ✅ catchブロック内のログは全環境で `logger.warn` / `logger.error` を出力 / Log `logger.warn` / `logger.error` in all environments within catch blocks
- ✅ 正常系のデバッグログ（verbose情報）は `isDevelopment()` ガード内で可 / Debug logs for normal flow (verbose info) may use `isDevelopment()` guard

**❌ FAIL基準 / FAIL Criteria**:

- ❌ catchブロック内で `if (isDevelopment())` によりログ出力を制限 / Restricting log output with `if (isDevelopment())` inside catch blocks
- ❌ 本番環境でエラーが無視される構造 / Structure where errors are ignored in production

```typescript
// ❌ 悪い例 / Bad example
catch (error) {
  if (isDevelopment()) {
    console.error('Failed:', error); // 本番で吸収される / Absorbed in production
  }
}

// ✅ 良い例 / Good example
catch (error) {
  logger.warn('Failed:', { error: (error as Error).message }); // 全環境で出力 / Output in all environments
}
```

## PII配慮ログ出力 / PII-Aware Logging

個人識別可能情報（PII）をログ出力する際は、truncateして漏洩リスクを最小化する。

When logging personally identifiable information (PII), truncate to minimize leakage risk.

**✅ PASS基準 / PASS Criteria**:

- ✅ profileId等のPIIはログ出力時に `truncateId()` または `id.slice(0, 8) + '...'` でtruncate / Truncate PII such as profileId with `truncateId()` or `id.slice(0, 8) + '...'` when logging
- ✅ 開発環境限定のログ（`isDevelopment()` ガード下）ではフル出力可 / Full output allowed in development-only logs (under `isDevelopment()` guard)

**❌ FAIL基準 / FAIL Criteria**:

- ❌ 本番ログにPII（profileId, userId等）をフル出力 / Full PII (profileId, userId, etc.) in production logs

### truncateId() ユーティリティ / truncateId() Utility

PII truncateユーティリティ関数。現在2箇所に定義: (1) `src/tools/preference/schemas.ts`（undefined対応版）、(2) `src/services/part/schemas.ts`（length引数版）。将来的に統一を検討。

A PII truncation utility function. Currently defined in 2 locations: (1) `src/tools/preference/schemas.ts` (handles undefined), (2) `src/services/part/schemas.ts` (with length parameter). Future unification planned.

> **Tracked: migration CLI local `truncateId(id, 8)` co-migration (FIND-IMPL-SS-L-09, L, deadline 2026-06-14 = T+1d)**: PR-SS-A (ADR-0041) の `apps/mcp-server/scripts/migrate-screenshots-to-persistent-root.ts` は local `truncateId(id, 8)` (`:94-96`) を持ち、SSOT `truncateAuditTargetId` を非経由 + `repair-truncated-screenshot-terminals.ts:105` と論理重複する (`details.targetWebPageIdTruncated` (`:365`) も同 local helper 由来)。**実害なし根拠**: length=8 は SSOT 値と一致 (現状 PII 漏洩 0)、主経路 (audit_logs targetId) は AuditLogService 境界で SSOT truncate 済、repair script precedent 整合。**defense-in-depth 候補 (将来 PR、owner backend-api-developer)**: project-wide `truncateId` SSOT 統一時に上記 migration CLI / repair script の local helper を co-migration し、§"Canonical CWE-209 PII Protection Pattern" の SSOT-derive rigor を log/details path にも適用する。
>
> **Tracked: migration CLI local `truncateId(id, 8)` co-migration (FIND-IMPL-SS-L-09, L, deadline 2026-06-14 = T+1d)**: PR-SS-A's (ADR-0041) `migrate-screenshots-to-persistent-root.ts` has a local `truncateId(id, 8)` (`:94-96`) that bypasses the SSOT `truncateAuditTargetId` and logically duplicates `repair-truncated-screenshot-terminals.ts:105` (`details.targetWebPageIdTruncated` at `:365` is from the same local helper). No current real harm because length=8 matches the SSOT value (0 PII leakage), the main path (audit_logs targetId) is SSOT-truncated at the AuditLogService boundary, and it is consistent with the repair-script precedent. Defense-in-depth candidate (future PR, owner backend-api-developer): co-migrate these local helpers during project-wide `truncateId` SSOT unification, applying the §"Canonical CWE-209 PII Protection Pattern" SSOT-derive rigor to the log/details path.

```typescript
// schemas.ts から提供 / Provided by schemas.ts
export function truncateId(id: string, length: number = 8): string {
  return `${id.slice(0, length)}...`;
}

// ✅ 良い例: truncateId()を使用 / Good example: using truncateId()
import { truncateId } from "./schemas";
logger.info(`Profile updated: ${truncateId(profileId)}`);
logger.warn("Reranking failed", { profileId: truncateId(profileId) });

// ✅ 開発環境のみフル出力 / Full output in development only
if (isDevelopment()) {
  logger.debug(`Profile details: ${profileId}`, { signals });
}
```

### Canonical CWE-209 PII Protection Pattern (LCC-endorsed) / 正典 CWE-209 PII 保護パターン (LCC 承認)

PR-D-9-patch Wave 5 で **canonical CWE-209 PII 保護パターン** として LCC が正式 endorsement (FIND-IMPL-LCC-PATCH-W5-02 / Registry §13.11.2 / §13.14)。テスト assertion およびログ出力で truncation length の hardcoded literal (例: `"embeddin..."` のような 8 文字 + `...` の手書き) を使用してはならず、**SSOT (Single Source of Truth) 定数を import して導出**すること。

PR-D-9-patch Wave 5 LCC formally endorsed this as the **canonical CWE-209 PII protection pattern** (FIND-IMPL-LCC-PATCH-W5-02 / Registry §13.11.2 / §13.14). Test assertions and log output MUST NOT use hardcoded truncation literals (e.g. hand-written 8-char + `...` strings like `"embeddin..."`); instead, **import the SSOT (Single Source of Truth) constant and derive**.

**SSOT 定数 / SSOT constant**: `apps/mcp-server/src/services/audit-log.service.ts` `AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` (現在値: 8 / current value: 8)

**✅ PASS パターン / PASS pattern (Bug fix #2 canonical)**:

```typescript
// ✅ Production code: SSOT 定数を使用 / Use SSOT constant in production
import { AUDIT_LOG_CONSTANTS } from "./audit-log.service";

function truncateTargetId(id: string | undefined | null): string | null {
  if (!id) return null;
  if (id.length <= AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) return id;
  return id.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...";
}

// ✅ Test assertion: SSOT 定数から導出 / Derive expected literal from SSOT constant in tests
import { AUDIT_LOG_CONSTANTS } from "@/services/audit-log.service";

const expectedTruncated = fullId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "...";
expect(auditLog.targetId).toBe(expectedTruncated);
```

**❌ FAIL パターン / FAIL pattern (silent coupling drift risk)**:

```typescript
// ❌ Test assertion: hardcoded literal — TARGET_ID_TRUNCATE_LENGTH を 8→12 に変更すると silently fail / regression
expect(auditLog.targetId).toBe("embeddin..."); // ❌ 8-char literal hardcoded
expect(log.profileId).toBe(profileId.substring(0, 8) + "..."); // ❌ length も hardcoded
```

**理由 / Rationale**:

- **Coupling drift 検出**: SSOT 定数を変更すると、import 漏れ箇所は CI で TypeError / test failure として顕在化し silent regression を防止。Hardcoded literal は静かに stale 化する。
- **GDPR Art.30 audit trail 整合**: `audit_logs.target_id` の truncation length は GDPR Art.30 PII minimisation 契約。SSOT 一元化により不一致を構造的に排除。
- **CWE-209 information exposure 防御**: 全 PII truncation 経路 (production code / test code / log message) が同じ length contract に従うことを保証し、特定経路だけが full PII を漏らす latent risk を排除。

**Coupling drift detection**: Changing the SSOT constant exposes any unimported callsite as a CI-time TypeError / test failure, preventing silent regression. Hardcoded literals go stale silently.
**GDPR Art.30 audit trail consistency**: `audit_logs.target_id` truncation length is a GDPR Art.30 PII minimisation contract. SSOT unification structurally eliminates discrepancies.
**CWE-209 information exposure defense**: Guarantees all PII truncation paths (production / test / log) follow the same length contract, eliminating the latent risk that a specific path leaks full PII.

**適用範囲 / Scope**: `audit_logs.target_id` truncation のすべての callsite (production code、unit test、integration test、standing regression test)。`truncateId()` ユーティリティ (`src/tools/preference/schemas.ts` / `src/services/part/schemas.ts`) も将来の統一時に SSOT 定数導出パターンへ移行検討。

Applies to all callsites truncating `audit_logs.target_id` (production code, unit tests, integration tests, standing regression). The `truncateId()` utilities (`src/tools/preference/schemas.ts` / `src/services/part/schemas.ts`) are also candidates for migration to SSOT-derived patterns during future unification.

**Cross-ref**: Registry §13.14 C-IMPL-PATCH-W5-08 (L) / FIND-IMPL-LCC-PATCH-W5-02 / FIND-IMPL-TDA-PATCH-W5-01 (M, hardcoded `"embeddin..."` literal coupling) / `apps/mcp-server/src/services/audit-log.service.ts` (SSOT) / `tests/regression/standing/worker-lifecycle/inv-worker-lock-003-embedding-backfill-supervisor.test.ts` line 2317 (Wave 5 fix exemplar).

### A path SQL LIKE 用途 / A path SQL LIKE pattern usage

`AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` SSOT は B path log output (`+ "..."` suffix via `truncateAuditTargetId()`) と **A path SQL LIKE** (`+ "%"` suffix for ILIKE/LIKE prefix queries) の双方で **length のみを共有** する。Suffix と use-case は path 別:

- **B path (log output)**: `truncateAuditTargetId(id)` helper → `{prefix}+"..."` for CWE-209 PII protection in log lines
- **A path (SQL LIKE)**: inline `slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + "%"` for SQL LIKE prefix-based query (NOT a log output, NOT a PII protection pattern)
- A path は length-invariant guard が前提 (短 ID rejection で SQL semantic 完全性確保)
- Test SSOT-derive pattern は両 path 共通 (`expect(...).toBe(fullId.slice(0, AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH) + ...)`、hardcoded literal 0)

**Cross-ref**: ADR-0032 (truncateAuditTargetId SSOT)、CO-5 canonical-pattern migration (V0 plan + IO Plan Decision V0 anchor `019dfd8f-033a`)、Wave 5 LCC canonical anchor `019df7ab-2f5a` for B path original endorsement.

### Worker actor naming SSOT (Plan v4.3 PR-M / ADR-0035) / Worker actor 命名 SSOT

PR-D-9-patch Wave 5 で確立された canonical CWE-209 PII Protection Pattern (`truncateAuditTargetId` SSOT) と **同 rigor** の SSOT-derive ruling を `audit_logs.actor` literal にも適用する。Plan v4.3 PR-M LCC M-01 closure (anchor `019e30bc-9bc8`) で FIND-IMPL-LCC-V43-PRM-M-01 (production suffix-stripping template literal `system:embedding-backfill` をproduction code から排除) として正式 ruling 確定。

The canonical CWE-209 PII Protection Pattern (`truncateAuditTargetId` SSOT) established in PR-D-9-patch Wave 5 is extended **with equivalent rigor** to `audit_logs.actor` literals. Formally ruled by Plan v4.3 PR-M LCC M-01 closure (anchor `019e30bc-9bc8`) as FIND-IMPL-LCC-V43-PRM-M-01 (elimination of the production suffix-stripping template literal `system:embedding-backfill` from production code).

**T1 Canonical (Source of Truth Hierarchy ruling per `CLAUDE.md` §"真実の源泉")**:

- **T1 SSOT (code + test)**: `apps/mcp-server/src/audit/audit-actions.ts` の以下 3 個の SSOT 定数 + 1 個の exhaustive helper:
  - `AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER = "system:embedding-backfill-worker" as const`
  - `AUDIT_ACTOR_PAGE_ANALYZE_WORKER = "system:page-analyze-worker" as const`
  - `AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT = "embedding_dispose_timeout" as const`
  - `getWorkerActorName(workerType: WorkerLifecycleType): string` — exhaustive `never`-narrowing switch
- **T2 Derived (ADR)**: ADR-0035 §Decision 4 (SSOT action definition) + Plan v4.3 PR-M §Decision 4 (3 SSOT 定数 + exhaustive helper の決定)
- **T3 Derived (runbook / spec / changelog)**: `apps/mcp-server/DATA_RETENTION.md` §"Plan v4.3 PR-M Callback-Exit Teardown Symmetry L1.5 SLO_MARKER" + 3-CHANGELOG bilingual entries

**T1 Canonical** (per the Source of Truth Hierarchy in `CLAUDE.md` §"真実の源泉"):

- **T1 SSOT (code + test)**: the following 3 SSOT constants + 1 exhaustive helper in `apps/mcp-server/src/audit/audit-actions.ts`:
  - `AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER = "system:embedding-backfill-worker" as const`
  - `AUDIT_ACTOR_PAGE_ANALYZE_WORKER = "system:page-analyze-worker" as const`
  - `AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT = "embedding_dispose_timeout" as const`
  - `getWorkerActorName(workerType: WorkerLifecycleType): string` — exhaustive `never`-narrowing switch
- **T2 Derived (ADRs)**: ADR-0035 §Decision 4 (SSOT action definition) + Plan v4.3 PR-M §Decision 4 (decision for the 3 SSOT constants + exhaustive helper)
- **T3 Derived (runbook / spec / changelog)**: `apps/mcp-server/DATA_RETENTION.md` §"Plan v4.3 PR-M Callback-Exit Teardown Symmetry L1.5 SLO_MARKER" + the 3-CHANGELOG bilingual entries

**T1 wins ruling (Source of Truth ドリフト時の解決規則 / Source of Truth drift resolution rule)**:

T2/T3 と T1 に乖離が発生した場合 (例: ADR や CHANGELOG で `"system:embedding-backfill"` の bare suffix が書かれている、test assertion が hardcoded literal で actor を assert している、production code が template literal で `system:` prefix を文字列構築している)、**T1 (code + test の SSOT 定数 import) が常に勝つ**。T2/T3 doc を T1 に合わせて整合させる。**逆 (T1 を doc に合わせて変更する) は禁止**。

When T2/T3 and T1 diverge (e.g., ADR or CHANGELOG writes the bare suffix `"system:embedding-backfill"`, test assertions hardcode the actor literal, or production code template-constructs the `system:` prefix), **T1 (code + test SSOT constant import) always wins**. Align T2/T3 docs to T1. **The reverse (changing T1 to match docs) is forbidden**.

**✅ PASS パターン / PASS pattern (canonical)**:

```typescript
// ✅ Production code: SSOT 定数を import / Use SSOT constant in production
import { AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER, getWorkerActorName } from "@/audit/audit-actions";

await emitAuditLog({
  action: AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT,
  actor: AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER, // ✅ SSOT constant
  // または / OR
  actor: getWorkerActorName("embedding-backfill"), // ✅ exhaustive helper
  targetId: truncateAuditTargetId(jobId),
  details: { workerType: "embedding-backfill", ceilingMs: 5000 },
});

// ✅ Test assertion: SSOT 定数から導出 / Derive expected literal from SSOT constant in tests
import { AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER } from "@/audit/audit-actions";

expect(auditLog.actor).toBe(AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER);
```

**❌ FAIL パターン / FAIL pattern (silent coupling drift risk)**:

```typescript
// ❌ Production code: hardcoded literal — 将来 actor 名を rename しても callsite は silent stale
await emitAuditLog({
  actor: "system:embedding-backfill-worker", // ❌ hardcoded literal
});

// ❌ Production code: template literal で suffix を変数化 — bare prefix `system:embedding-backfill` が production sweep に hit する
const actorBase = "system:embedding-backfill";
await emitAuditLog({
  actor: `${actorBase}-worker`, // ❌ template literal、bare prefix が AST sweep にひっかかる
});

// ❌ Test assertion: hardcoded literal
expect(auditLog.actor).toBe("system:embedding-backfill-worker"); // ❌ rename で silent fail
```

**Drift detection (forward-compat AST sweep)**:

`INV-AUDIT-EMIT-SSOT-IMPORT-001` Test 8 (Plan v4.3 PR-M で新規追加) は **production code 全域** (`apps/mcp-server/src/**/*.ts`) を AST traversal で sweep し、bare `system:embedding-backfill` literal が **0 occurrences** であることを assert する forward-compat 不変条件。`AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER` SSOT 定数 import のみを許容 (CI で AST gate が hardcoded literal regression を即時 fail に変換)。Wave 5 LCC canonical anchor `019df7ab-2f5a` の B path PII truncation pattern と同 rigor を actor naming にも適用。

`INV-AUDIT-EMIT-SSOT-IMPORT-001` Test 8 (newly added in Plan v4.3 PR-M) AST-sweeps the **entire production code** (`apps/mcp-server/src/**/*.ts`) and asserts bare `system:embedding-backfill` literal has **0 occurrences** — a forward-compat invariant. Only `AUDIT_ACTOR_EMBEDDING_BACKFILL_WORKER` SSOT constant imports are allowed (CI's AST gate converts hardcoded literal regression into immediate fail). Applies the Wave 5 LCC canonical anchor `019df7ab-2f5a` B path PII truncation pattern rigor to actor naming.

**Rationale (T1 wins の理由 / why T1 wins)**:

- **Coupling drift detection**: SSOT 定数を rename / change すると import 漏れ箇所は CI で TypeError / test failure として顕在化、silent regression を排除。Hardcoded literal は静かに stale 化。
- **GDPR Art.30 audit trail consistency**: `audit_logs.actor` の literal は GDPR Art.30 processing-records contract の一部。`truncateAuditTargetId` length と同様、SSOT 一元化により inconsistency を構造的に排除。
- **Compile-time `WorkerLifecycleType` extension gate**: `getWorkerActorName` の `never`-narrowing exhaustive switch により、新 worker type を `WorkerLifecycleType` enum に追加して switch arm を更新しない場合は compile-time error。新 worker type の audit emit を silently miss する failure mode を排除。
- **AGPL §5(a)/(b) modification notice trail**: actor naming が SSOT 由来であることが、3-CHANGELOG bilingual entry の改変通知範囲を確定的にする (各 commit がどの SSOT を変更したかを cross-reference で trace 可能)。

- **Coupling drift detection**: renaming or changing the SSOT constant exposes any unimported callsite as a CI-time TypeError / test failure, preventing silent regression. Hardcoded literals go stale silently.
- **GDPR Art.30 audit trail consistency**: `audit_logs.actor` literals are part of the GDPR Art.30 processing-records contract. As with `truncateAuditTargetId` length, SSOT unification structurally eliminates inconsistency.
- **Compile-time `WorkerLifecycleType` extension gate**: `getWorkerActorName`'s `never`-narrowing exhaustive switch raises a compile-time error if a new worker type is added to the `WorkerLifecycleType` enum without updating the switch arm. Eliminates the failure mode of silently missing the audit emit for the new worker type.
- **AGPL §5(a)/(b) modification notice trail**: SSOT-derived actor naming makes the scope of the 3-CHANGELOG bilingual modification notices deterministic — each commit can be cross-referenced to which SSOT it modified.

**適用範囲 / Scope**: `audit_logs.actor` literal を emit するすべての callsite (production code、unit test、integration test、standing regression test、CHANGELOG cross-reference 等)。新 `audit_logs.action` literal (例: `AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT`) も同 ruling を適用、bare literal の production code 内 hardcode は禁止。

Applies to all callsites emitting `audit_logs.actor` literals (production code, unit tests, integration tests, standing regression, CHANGELOG cross-references, etc.). New `audit_logs.action` literals (e.g., `AUDIT_ACTION_EMBEDDING_DISPOSE_TIMEOUT`) follow the same ruling — hardcoded bare literals in production code are forbidden.

**Cross-ref**: ADR-0035 §Decision 4 (SSOT action definition) / Plan v4.3 PR-M §Decision 4 (3 SSOT constants + exhaustive helper decision) / FIND-IMPL-LCC-V43-PRM-M-01 closure anchor `019e30bc-9bc8` (production suffix-stripping template literal elimination) / `apps/mcp-server/src/audit/audit-actions.ts` (T1 SSOT) / `tests/regression/standing/<area>/inv-audit-emit-ssot-import-001.test.ts` Test 8 (forward-compat AST sweep) / Wave 5 LCC canonical anchor `019df7ab-2f5a` (B path PII truncation original endorsement pattern).

## PII-Symmetric Pending Predicate Pattern (GDPR Art.5(1)(c) data-minimisation) / PII 対称 pending predicate パターン (PR-C4 で確立)

PR-C4 (ADR-0018 Amendment, section_visual PII 非対称 closure) で確立した **PII-symmetric pending predicate** パターン。embedding backfill の pending 判定 predicate は、**work 側で PII data-minimisation (GDPR Art.5(1)(c)) のため意図的に embedding を非生成にした high-PII レコードを、pending 側でも対称に除外しなければならない**。work 側除外と pending 側除外が非対称だと、high-PII レコードが永久 pending に残り page が `completed` に到達しない (systemic bug)。

The **PII-symmetric pending predicate** pattern established by PR-C4 (ADR-0018 Amendment, section_visual PII asymmetry closure). Embedding-backfill pending predicates **MUST symmetrically exclude the high-PII records that the work side intentionally leaves un-embedded for PII data-minimisation (GDPR Art.5(1)(c))**. If work-side exclusion and pending-side exclusion are asymmetric, high-PII records stay perpetually pending and the page never reaches `completed` (a systemic bug).

**契約 / Contract**:

- **work 側除外 = pending 側除外 (対称必須)** / work-side exclusion MUST equal pending-side exclusion. `part_visual` / `part_text` は既に対称 (`backfill-status.helper.ts` の `cp.pii_risk_level != 'high'` / `piiRiskLevel: { not: "high" }`)。`section_visual` だけが pending 側 PII filter を欠いていた = PR-C4 が closure した非対称。
- **PII anchor が別テーブルにある場合は `NOT EXISTS` で対称化** / when the PII anchor lives in a different table, restore symmetry via `NOT EXISTS`. `section_embeddings` には `pii_risk_level` column が無いため、`section_pattern_id` を anchor に `NOT EXISTS (SELECT 1 FROM component_parts cp WHERE cp.section_pattern_id = <se>.section_pattern_id AND cp.pii_risk_level = 'high')` で high-PII section を除外する (SSOT predicate `sectionVisualPendingExclusionPredicate`、inline WHERE 禁止)。
- **enum-bound literal のみ、user-input interpolation 禁止** / enum-bound literal only, no user-input interpolation. PII filter は固定 `pii_risk_level = 'high'` literal のみを参照し、特定の reason / id を文字列構築しない (SQL injection surface 0、SEC-RV1-01 confirmed pattern)。
- **orthogonal な二重防御 (row-level marker)** / orthogonal dual-defense via a row-level marker. query-level `NOT EXISTS` (Path A) に加え、work 側で row-level terminal marker (`vision_skip_reason = 'section_visual_pii_excluded'`、§"Canonical CWE-209 PII Protection Pattern" 準拠の audit emit 付き) を書くことで、将来 query が変更されても `vision_skip_reason IS NULL` 単独で pending 除外が機能する (robustness)。marker emit は `truncateAuditTargetId` SSOT + PII-free numeric/enum `details` (canonical CWE-209 PII Protection Pattern 準拠)。

**✅ PASS パターン / PASS pattern**:

```typescript
// ✅ SSOT predicate (single source, inline WHERE 禁止) — work 側除外と対称
export function sectionVisualPendingExclusionPredicate(alias: string = "se"): string {
  return (
    `${alias}.text_embedding IS NOT NULL ` +
    `AND ${alias}.vision_embedding IS NULL ` +
    `AND ${alias}.vision_skip_reason IS NULL ` +
    // PR-C4: high-PII section を対称除外 (work 側 data-minimisation と一致)
    `AND NOT EXISTS (` +
    `  SELECT 1 FROM component_parts cp ` +
    `  WHERE cp.section_pattern_id = ${alias}.section_pattern_id ` +
    `  AND cp.pii_risk_level = 'high'` + // 固定 enum literal、user-input 補間なし
    `)`
  );
}
```

**❌ FAIL パターン / FAIL pattern (PII asymmetry, systemic bug)**:

```typescript
// ❌ work 側は high-PII を除外するが pending 側に PII filter なし
// → high-PII レコードが永久 pending → page が completed 未到達
`${alias}.vision_embedding IS NULL AND ${alias}.vision_skip_reason IS NULL`; // ❌ PII filter 欠落
```

**Cross-ref**: ADR-0018 Amendment (PR-C4) §Decision 1 (Path A) + §Decision 2 (Path B marker) / `apps/mcp-server/src/workers/phases/types.ts` (`sectionVisualPendingExclusionPredicate`) / `apps/mcp-server/src/services/backfill-status.helper.ts` (`part_visual` / `part_text` 既存対称) / §"Canonical CWE-209 PII Protection Pattern" (marker audit emit の PII minimisation) / `INV-SECTION-VISUAL-PII-EXCLUDED-TERMINAL-011` (large-page、real-leak orthogonality assert) / PR-C4 IO Impl Decision V3 (Finding Registry V4).

> 過去 PR の L tracked-issue 経緯記録（section-screenshot-fallback 〜 WebUI Atelier Detail）は → `Tracked-issue history (section-screenshot-fallback … WebUI Atelier Detail) moved to` (same headings).

## ベクトルデータ検証 / Vector Data Validation

### NaN/Infinity防御 / NaN/Infinity Defense

ベクトルデータ（embedding等）の入出力時に `NaN` や `Infinity` が混入すると、pgvectorクエリ失敗やサイレントな検索精度低下を引き起こす。数値配列を扱う箇所では検証を行うこと。

`NaN` or `Infinity` in vector data (embeddings, etc.) causes pgvector query failures or silent search quality degradation. Validate numeric arrays at input/output boundaries.

**✅ PASS基準 / PASS Criteria**:

- ✅ Embedding生成結果に `NaN`/`Infinity` が含まれないことを検証 / Verify embedding results contain no `NaN`/`Infinity`
- ✅ confidence等のスカラー値計算で `NaN`/`Infinity` を防御（`Math.min`/`Math.max`クランプ、除算前のゼロチェック等） / Defend against `NaN`/`Infinity` in scalar calculations (clamp with `Math.min`/`Math.max`, zero-division checks, etc.)

**❌ FAIL基準 / FAIL Criteria**:

- ❌ `NaN`/`Infinity` を含むベクトルをDBに保存 / Saving vectors containing `NaN`/`Infinity` to DB
- ❌ 除算結果を検証せずにそのまま使用 / Using division results without validation

```typescript
// ✅ 良い例 / Good example
const confidence = totalWeight > 0 ? weightedSum / totalWeight : 0;
const clampedScore = Math.max(0, Math.min(1, score));

// ✅ Embedding検証 / Embedding validation
if (embedding.some((v) => !Number.isFinite(v))) {
  throw new Error("Invalid embedding: contains NaN or Infinity");
}
```

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
