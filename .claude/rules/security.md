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
- ✅ 全<!-- gen:tool-count -->39<!-- /gen:tool-count --> MCPツールに自動適用 / Auto-applied to all <!-- gen:tool-count -->39<!-- /gen:tool-count --> MCP tools

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
LGPL-3.0-or-later依存は `license-checker` の `--excludePackages` で除外し、個別にレビュー記録を残すこと。

No merge allowed with any High/Critical vulnerabilities.
License verification is mandatory when adding new dependencies.
LGPL-3.0-or-later dependencies must be excluded via `--excludePackages` and reviewed individually.

## エラーメッセージサニタイズ / Error Message Sanitization

### sanitizeErrorMessage パターン / sanitizeErrorMessage Pattern

v0.2.0で `utils/sanitize-error.ts` に統一ユーティリティとして抽出。<!-- gen:sanitize-usage-count -->116<!-- /gen:sanitize-usage-count -->ファイル・<!-- gen:tool-count -->39<!-- /gen:tool-count -->ツールに適用（<!-- gen:sanitize-import-count -->108<!-- /gen:sanitize-import-count -->ファイルでインポート）。

Extracted as a unified utility in `utils/sanitize-error.ts` in v0.2.0. Applied to <!-- gen:sanitize-usage-count -->116<!-- /gen:sanitize-usage-count --> files and <!-- gen:tool-count -->39<!-- /gen:tool-count --> tools (<!-- gen:sanitize-import-count -->108<!-- /gen:sanitize-import-count --> files importing it).

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

### Embedding backfill IPC unconstrained-string surfaces (defense-in-depth tracked) / Embedding backfill IPC 無制約文字列 surface（defense-in-depth tracked）

**JP**: `apps/mcp-server/src/workers/phases/embedding-backfill-ipc.ts` の child→parent IPC message schema のうち 2 個の `z.string()` field が現状 length / format 無制約である:

- `BackfillErrorMessage.message: z.string()` (line ~255) — NEW-SEC-V2-01 に隣接する surface（Phase 3 docs-sync FIND-IMPL-V2-L3 = SEC-IMPL-V2-L-01）
- `BackfillDoneMessage.skipReason: z.string().optional()` (line ~236) — enum 想定だが現状 free-form string（Phase 3 docs-sync FIND-IMPL-V2-L4 = SEC-IMPL-V2-L-02）

**現状の実害なし根拠 / Why no current real harm**: いずれの field も (1) **producer-contract sanitize** 済（child 側 emit 前に `sanitizeErrorMessage` / SSOT 由来の skipReason enum 値を使用）、(2) IPC schema 全体が `.strict()` で unknown-key 混入を reject（SEC H-2）、(3) IPC は OS-level child_process fork 境界（外部 untrusted input を直接 bind しない）。よって現リリースサイクルで実害は無く、L severity として docs 記録 + tracked-issue 継続が landing。

**Defense-in-depth 検討余地 / Defense-in-depth candidates** (将来 PR、deadline 2026-05-24 = T+1d):

- `BackfillErrorMessage.message` に length cap (`z.string().max(N)`) を追加し、IPC 境界での CWE-770 (Allocation of Resources Without Limits / unbounded string) latent surface を縮退。`BackfillErrorMessage.code` の `z.string().regex(/^P\d{4}$/).optional()` narrow (ADR-0018 Amendment 7 §7.7 / SEC-V1-01) と同 rigor。
- `BackfillDoneMessage.skipReason` を `z.enum(EMBEDDING_SKIP_REASONS)` 化し、free-form string ではなく SSOT enum 由来に制約（enum drift を schema-level で防止、`EMBEDDING_SKIP_REASONS` SSOT 由来）。

**EN**: Two `z.string()` fields in the child→parent IPC message schemas of `apps/mcp-server/src/workers/phases/embedding-backfill-ipc.ts` are currently length-/format-unconstrained: `BackfillErrorMessage.message: z.string()` (line ~255, adjacent to the NEW-SEC-V2-01 surface; FIND-IMPL-V2-L3 = SEC-IMPL-V2-L-01) and `BackfillDoneMessage.skipReason: z.string().optional()` (line ~236, intended as an enum but currently free-form; FIND-IMPL-V2-L4 = SEC-IMPL-V2-L-02). No current real harm because each field is (1) producer-contract sanitized (the child uses `sanitizeErrorMessage` / an SSOT-derived skipReason enum value before emit), (2) the whole IPC schema uses `.strict()` to reject unknown keys (SEC H-2), and (3) the IPC is an OS-level `child_process` fork boundary (it does not directly bind external untrusted input). Hence these land as L severity (docs record + tracked-issue continuation). Defense-in-depth candidates for a future PR (deadline 2026-05-24 = T+1d): add a length cap (`z.string().max(N)`) to `BackfillErrorMessage.message` to shrink the CWE-770 (unbounded string) latent surface at the IPC boundary — same rigor as the `BackfillErrorMessage.code` `z.string().regex(/^P\d{4}$/).optional()` narrow (ADR-0018 Amendment 7 §7.7 / SEC-V1-01); and convert `BackfillDoneMessage.skipReason` to `z.enum(EMBEDDING_SKIP_REASONS)` so it is constrained to the SSOT enum rather than a free-form string (preventing enum drift at the schema level, derived from the `EMBEDDING_SKIP_REASONS` SSOT).

**Cross-ref**: ADR-0018 Amendment 7 §7.7 (IPC `code` schema narrow, SEC-V1-01) / NEW-SEC-V2-01 (adjacent IPC surface tracked-issue) / `apps/mcp-server/src/workers/phases/embedding-backfill-ipc.ts` (`.strict()` SEC H-2) / IO Impl Decision anchor `019e5259-28fb` (Phase 3 docs-sync FIND-IMPL-V2-L3 / L4 landing).

### phase-5-child-ipc.ts nested-schema `.strict()` defense-in-depth (SEC-IMPL-PR1-L-01, tracked) / phase-5-child-ipc.ts nested-schema `.strict()` defense-in-depth

**JP**: PR-1 GPU-COORD (FIND-PLAN-M-02 / SEC-M-1) で `apps/mcp-server/src/workers/phases/phase-5-child-ipc.ts` の **10 top-level schema 全てに `.strict()` を新規追加** し、`embedding-backfill-ipc.ts` との SEC H-2 unknown-key reject parity を達成した (PR-1 着地前は `.strict()` 適用 0 個 = `phase-5-child-ipc.ts` 側に SEC H-2 契約は存在しなかった、FIND-PLAN-DOC-01)。一方、`childTextResultSchema` (line ~213) 内の **nested** `z.object` 2 個 — `chunkedEncoderTelemetry` (line ~223) とその nested `partialCompletion` (line ~225) — は `.strict()` が **未適用**であり、nested object 階層では unknown-key が pass-through する。

**現状の実害なし根拠 / Why no current real harm**: (1) **親 schema は `.strict()` 済** — `childTextResultSchema` の top-level は unknown-key を reject する。(2) **OS-level fork 境界の内部 IPC** — child→parent message は `child_process.fork()` 境界で、外部 untrusted input を直接 bind しない (`embedding-backfill-ipc.ts` の同根拠と整合)。(3) **producer-contract** — child は同一 codebase で、nested object には SSOT enum (`partialCompletion` は `chunksDone`/`totalChunks` の int のみ) / numeric telemetry のみを emit する。よって nested unknown-key は CWE-20 (improper input validation) の latent surface に留まり、現リリースサイクルで実害はない → **L severity** (docs 記録 + tracked-issue 継続)。

**Defense-in-depth 検討余地 / Defense-in-depth candidate** (将来 PR、deadline 2026-05-28 = T+1d、CO-PRBT5-01; PR-BT-5 で nested `.strict()` 悪化なしを確認、deadline 2026-05-25 経過につき refresh): `chunkedEncoderTelemetry` と `partialCompletion` の nested `z.object` に `.strict()` を追加し、IPC 境界の unknown-key reject 契約を nested 階層まで一貫させる (`embedding-backfill-ipc.ts` の defense-in-depth rigor と同水準)。既存 `INV-WORKER-LOCK-003` (worker-lifecycle domain) の IPC reject 検証で nested-key reject を assert 可能。

**EN**: PR-1 GPU-COORD (FIND-PLAN-M-02 / SEC-M-1) **newly added `.strict()` to all 10 top-level schemas** of `apps/mcp-server/src/workers/phases/phase-5-child-ipc.ts`, achieving SEC H-2 unknown-key-reject parity with `embedding-backfill-ipc.ts` (before PR-1 the file had **0** `.strict()` applications — no SEC H-2 contract existed on the `phase-5-child-ipc.ts` side, FIND-PLAN-DOC-01). However, the two **nested** `z.object` schemas inside `childTextResultSchema` (line ~213) — `chunkedEncoderTelemetry` (line ~223) and its nested `partialCompletion` (line ~225) — are **not** `.strict()`, so unknown keys pass through at the nested-object level. No current real harm because (1) the parent `childTextResultSchema` is `.strict()` (top-level unknown-key reject), (2) it is internal child→parent IPC across an OS-level `child_process.fork()` boundary (does not directly bind external untrusted input — same rationale as `embedding-backfill-ipc.ts`), and (3) the producer is in the same codebase and emits only SSOT enums / numeric telemetry into the nested objects. Hence this lands as **L severity** (docs record + tracked-issue continuation). Defense-in-depth candidate for a future PR (deadline 2026-05-28 = T+1d, CO-PRBT5-01; PR-BT-5 confirmed no worsening of the nested `.strict()` surface, refreshed because the 2026-05-25 deadline elapsed): add `.strict()` to the `chunkedEncoderTelemetry` and `partialCompletion` nested `z.object`s so the IPC-boundary unknown-key-reject contract is consistent down to the nested level (same rigor as `embedding-backfill-ipc.ts`); the existing `INV-WORKER-LOCK-003` (worker-lifecycle domain) IPC reject verification can assert nested-key reject.

**Cross-ref**: FIND-PLAN-DOC-01 (`phase-5-child-ipc.ts` had 0 `.strict()` before PR-1; SEC H-2 origin = `embedding-backfill-ipc.ts`) / FIND-PLAN-M-02 / SEC-M-1 (10 top-level `.strict()` addition) / ADR-0038 §Security (zero new IPC types) / `apps/mcp-server/src/workers/phases/phase-5-child-ipc.ts` (`childTextResultSchema` nested `chunkedEncoderTelemetry`/`partialCompletion`) / Finding Registry §"Impl-phase tracked-issues" SEC-IMPL-PR1-L-01 / IO Impl Decision V0 anchor `019e567d` (Phase 3 docs-sync landing).

### `@reftrixmcp/ml` onnx-provider-detect dedicated subpath export (defense-in-depth tracked) / `@reftrixmcp/ml` onnx-provider-detect 専用 subpath export（defense-in-depth tracked）

**JP**: PR-1 GPU-COORD H regression remediation (commit 85e8fb3b、FIND-IMPL-PR1-H-NEW-01) で、Phase 5 fork-child leaf path (`apps/mcp-server/src/workers/phases/phase-5-gpu-probe.ts`) が `verifyCudaAvailability` / `detectExecutionProvider` / `isLdLibraryPathSetAtOsLevel` を **root barrel `@reftrixmcp/ml`** index 経由で import するようになった (`packages/ml/src/index.ts` から re-export)。一方 `@reftrixmcp/ml` の `package.json` `exports` map は `./embeddings` / `./search` / `./dinov2` の subpath export を持つが、**`./onnx-provider-detect` 専用 subpath は未定義**である。そのため fork-child は CUDA-EP 可用性 check 関数 3 個のためだけに barrel index の transitive surface 全体を import 経路上で引き込む。

**現状の実害なし根拠 / Why no current real harm**: (1) **ADR-0037 fork-only 境界は非違反** — leaf-import invariant `INV-GPU-PROBE-LEAF-IMPORT-001` は依然成立 (閾値定数は leaf module `services/vision/vram-thresholds.ts` から、VRAM query は leaf util `vram-utils.ts` から import し、in-process full `gpu-resource-manager.ts` を import しない)。barrel index 経由でも `onnx-provider-detect` 自体は GPU/native init を持たない pure filesystem check であり、fork-child の起動コストやメモリ profile に観測可能な影響はない。(2) `verifyCudaAvailability` 等は同一 codebase の producer 由来で外部 untrusted input を bind しない。よって本項目は **L severity** (docs 記録 + tracked-issue 継続)、実害なし。

**Defense-in-depth 検討余地 / Defense-in-depth candidate** (将来 PR、deadline 2026-05-28 = T+1d; deadline 2026-05-25 経過につき refresh、PR-BT-5 で本 surface 悪化なし): `@reftrixmcp/ml` の `package.json` `exports` に **`./onnx-provider-detect` 専用 subpath** を追加し、fork-child が barrel index ではなく `@reftrixmcp/ml/onnx-provider-detect` から narrow に import できるようにする。これにより import surface が CUDA-EP detect 関数群に縮退し、`./embeddings` / `./search` / `./dinov2` 既存 subpath と同 rigor の module boundary 明示性が得られる。`INV-GPU-PROBE-LEAF-IMPORT-001` の AST sweep を subpath import 形に合わせて narrow 化可能。

**EN**: In the PR-1 GPU-COORD H regression remediation (commit 85e8fb3b, FIND-IMPL-PR1-H-NEW-01), the Phase 5 fork-child leaf path (`apps/mcp-server/src/workers/phases/phase-5-gpu-probe.ts`) now imports `verifyCudaAvailability` / `detectExecutionProvider` / `isLdLibraryPathSetAtOsLevel` via the **root barrel `@reftrixmcp/ml`** index (re-exported from `packages/ml/src/index.ts`). However, the `@reftrixmcp/ml` `package.json` `exports` map defines `./embeddings` / `./search` / `./dinov2` subpath exports but **no dedicated `./onnx-provider-detect` subpath**. The fork-child therefore pulls the barrel index's transitive surface on the import path just for the 3 CUDA-EP availability-check functions. No current real harm because (1) the ADR-0037 fork-only boundary is **not violated** — the leaf-import invariant `INV-GPU-PROBE-LEAF-IMPORT-001` still holds (threshold constants imported from the leaf module `services/vision/vram-thresholds.ts`, VRAM query from the leaf util `vram-utils.ts`, with no import of the in-process full `gpu-resource-manager.ts`); even via the barrel index, `onnx-provider-detect` itself is a pure filesystem check with no GPU/native init and no observable effect on fork-child startup cost or memory profile, and (2) `verifyCudaAvailability` et al. originate from a same-codebase producer and bind no external untrusted input. Hence this lands as **L severity** (docs record + tracked-issue continuation), no real harm. Defense-in-depth candidate for a future PR (deadline 2026-05-28 = T+1d; refreshed because the 2026-05-25 deadline elapsed, PR-BT-5 did not worsen this surface): add a **dedicated `./onnx-provider-detect` subpath** to the `@reftrixmcp/ml` `package.json` `exports` so the fork-child can import narrowly from `@reftrixmcp/ml/onnx-provider-detect` instead of the barrel index, shrinking the import surface to the CUDA-EP detect functions and gaining the same module-boundary explicitness as the existing `./embeddings` / `./search` / `./dinov2` subpaths; the `INV-GPU-PROBE-LEAF-IMPORT-001` AST sweep can be narrowed to the subpath-import form.

**Cross-ref**: TPA-RE2-L-01 (re-audit 2 L finding, dedicated subpath export import-surface reduction candidate) / FIND-IMPL-PR1-H-NEW-01 (H regression remediation that added the barrel re-export) / ADR-0037 (per-job fork-only model, NOT violated — `INV-GPU-PROBE-LEAF-IMPORT-001` preserved) / `packages/ml/src/index.ts` (barrel re-export of `detectExecutionProvider` / `verifyCudaAvailability` / `isLdLibraryPathSetAtOsLevel`) / `packages/ml/package.json` `exports` (`./embeddings` / `./search` / `./dinov2` present, `./onnx-provider-detect` absent) / `apps/mcp-server/src/workers/phases/phase-5-gpu-probe.ts` (fork-child leaf import) / IO Impl Decision V1 anchor `019e573c` (Phase 3 docs-sync landing).

### phase-5-fork-orchestrator.ts buildChildEnv `filterTestOnlyEnvForChild` parity (SEC-IMPL-PRBT5-L-01, tracked) / phase-5-fork-orchestrator.ts buildChildEnv の `filterTestOnlyEnvForChild` parity

**JP**: PR-BT-5 (M-1-RSS) re-audit で、Phase 5 orchestrator の local `buildChildEnv()` (`apps/mcp-server/src/workers/phases/phase-5-fork-orchestrator.ts:201`) が child env を `{ ...process.env }` で直接構築し、共通 helper `shared/fork-common.ts:299` が経由する `filterTestOnlyEnvForChild(process.env)` を**未経由**である点が SEC L finding (SEC L-SEC-1 / F-IMPL-L-01) として確認された。これは PR-BT-5 で導入された差異ではなく **pre-existing** (baseline `05f91d18` 既存) である。

**現状の実害なし根拠 / Why no current real harm**: (1) **補償制御 `assertNoTestOnlyEnvLeak` が production throw する** — `apps/mcp-server/src/config/test-env-guard.ts` の `assertNoTestOnlyEnvLeak()` が **3 つの boot entrypoint** (`server.ts` / `index.ts` / `scripts/start-workers.ts`) で起動時に test-only env (`MCP_SKIP_RATE_LIMIT` 等) の leak を検出し production で throw する。よって test-only env が production fork child に伝播する経路は boot-time guard で塞がれている。(2) Phase 5 fork child は OS-level `child_process.fork()` 境界の内部 IPC で、外部 untrusted input を直接 bind しない。(3) `buildChildEnv` が設定する値 (`EMBEDDING_WORKER_THREAD=false` / `DINOV2_WORKER_THREAD=false` / `PIPELINE_RECYCLE_THRESHOLD=0` / `ONNX_EXECUTION_PROVIDER` 等) は固定リテラルまたは parent probe 由来で、test-only env を fork child に転送する意図はない。よって本項目は **L severity** (docs 記録 + tracked-issue 継続)、現リリースサイクルで実害なし。

**Defense-in-depth 検討余地 / Defense-in-depth candidate** (将来 PR、deadline 2026-05-28 = T+1d、CO-PRBT5-NN): Phase 5 orchestrator の local `buildChildEnv()` を共通 helper `shared/fork-common.ts` の `filterTestOnlyEnvForChild(process.env)` 経由に統一し、test-only env filter を boot-time guard だけでなく fork-spawn-time でも defense-in-depth として適用する。`shared/fork-common.ts:299` (backfill fork) と同 rigor の parity を Phase 5 fork にも与える。`INV-WORKER-LOCK-003` (worker-lifecycle domain) の IPC/env 検証で test-only env 非伝播を assert 可能。

**EN**: In the PR-BT-5 (M-1-RSS) re-audit, a SEC L finding (SEC L-SEC-1 / F-IMPL-L-01) confirmed that the Phase 5 orchestrator's local `buildChildEnv()` (`apps/mcp-server/src/workers/phases/phase-5-fork-orchestrator.ts:201`) builds the child env directly via `{ ...process.env }` and does **NOT** route through `filterTestOnlyEnvForChild(process.env)` the way the shared helper `shared/fork-common.ts:299` does. This is **pre-existing** (present at baseline `05f91d18`), NOT introduced by PR-BT-5. No current real harm because (1) the compensating control `assertNoTestOnlyEnvLeak()` (`apps/mcp-server/src/config/test-env-guard.ts`) throws in production at all **3 boot entrypoints** (`server.ts` / `index.ts` / `scripts/start-workers.ts`), detecting test-only env leak (e.g. `MCP_SKIP_RATE_LIMIT`) at startup — so the propagation path of test-only env into a production fork child is closed by the boot-time guard; (2) the Phase 5 fork child is internal IPC across an OS-level `child_process.fork()` boundary and binds no external untrusted input; (3) the values `buildChildEnv` sets (`EMBEDDING_WORKER_THREAD=false` / `DINOV2_WORKER_THREAD=false` / `PIPELINE_RECYCLE_THRESHOLD=0` / `ONNX_EXECUTION_PROVIDER`, etc.) are fixed literals or parent-probe-derived, with no intent to forward test-only env to the fork child. Hence this lands as **L severity** (docs record + tracked-issue continuation), no real harm in the current release cycle. Defense-in-depth candidate for a future PR (deadline 2026-05-28 = T+1d, CO-PRBT5-NN): unify the Phase 5 orchestrator's local `buildChildEnv()` to route through the shared helper's `filterTestOnlyEnvForChild(process.env)` so the test-only env filter applies as defense-in-depth at fork-spawn time (not just at the boot-time guard), giving the Phase 5 fork the same `shared/fork-common.ts:299` (backfill fork) parity; the `INV-WORKER-LOCK-003` (worker-lifecycle domain) IPC/env verification can assert non-propagation of test-only env.

**Cross-ref**: SEC L-SEC-1 / F-IMPL-L-01 (`pr-bt-5-impl-finding-registry-v0.md` §3) / `apps/mcp-server/src/workers/phases/phase-5-fork-orchestrator.ts:201` (`buildChildEnv` `{ ...process.env }` direct) / `apps/mcp-server/src/workers/phases/shared/fork-common.ts:299` (`filterTestOnlyEnvForChild` parity reference) / `apps/mcp-server/src/config/test-env-guard.ts` (`assertNoTestOnlyEnvLeak` boot-time compensating control, 3 entrypoints) / IO Impl Decision V0 anchor `019e65a3-aaf7` (Phase 3 docs-sync landing).

### Backfill secondary-spawn deferred audit emit + scan terminal failedAt + label-lock SSOT (defense-in-depth tracked) / Backfill secondary-spawn の繰延 audit emit + scan terminal failedAt + label-lock SSOT（defense-in-depth tracked）

**JP**: backfill-worker-autostart (ADR-0011 Amendment 7、Impl Decision V1 APPROVE `019e7967-963f-75ef-af6e-0916bf7342dc`) の re-audit で、deferred-spawn retry + scan-based terminal の周辺に **L severity の defense-in-depth tracked-issue 3 件** が確認された。いずれも本 PR の net 改善を阻害せず、現リリースサイクルで実害なし (L severity、docs 記録 + tracked-issue 継続、deadline 2026-06-01 = T+1d)。

- **TPA-IMPL-01** (L): defer 時点の paired audit emit (`vision_residual_detected` / `backfill_secondary_deferred`) が未配線。**pre-existing** (baseline も defer を silent drop) であり、本 PR は fail-loud retry (`vision_probe_unavailable` / `backfill_secondary_spawn_timeout`) を追加して net 改善。defer 時点の observability は将来 PR の defense-in-depth 候補。
- **TDA-IMPL-01** (L): scan-based terminal transition (`updateMany` で `failed` 化) 時に `embeddingBackfillFailedAt` を **未設定** (他の terminal transition path は設定する)。GDPR Art.30 record-keeping は `backfill_secondary_spawn_timeout` audit emit で代替担保されているため minor observability gap のみ。将来 PR で他 terminal transition と対称化する候補。
- **LCC-REMED-01** (L): `INV-WORKER-LOCK-003` #11 label-lock test (`inv-worker-lock-003-embedding-backfill-supervisor.test.ts:836/837/1044`) が `worker_lock_ttl_fallback` を **pre-existing hardcoded literal** で照合 (co-migration 由来でない、diff hunk 外 = pre-existing)。production code は SSOT 定数 `AUDIT_ACTION_WORKER_LOCK_TTL_FALLBACK` 済で `INV-AUDIT-EMIT-SSOT-IMPORT-001` AST sweep は production-only scope のため実害なし。将来 PR で label-lock test を SSOT 定数 import 経由 assert に migrate する候補 (§"Canonical CWE-209 PII Protection Pattern" / §"Worker actor naming SSOT" の SSOT-derive rigor を test path にも適用)。

**EN**: In the backfill-worker-autostart (ADR-0011 Amendment 7, Impl Decision V1 APPROVE `019e7967-963f-75ef-af6e-0916bf7342dc`) re-audit, **3 L-severity defense-in-depth tracked-issues** were confirmed around the deferred-spawn retry + scan-based terminal. None block this PR's net improvement and none cause real harm in the current release cycle (L severity, docs record + tracked-issue continuation, deadline 2026-06-01 = T+1d). **TPA-IMPL-01** (L): the defer-time paired audit emit (`vision_residual_detected` / `backfill_secondary_deferred`) is not wired — **pre-existing** (the baseline also silently drops the defer); this PR is a net improvement by adding the fail-loud retry emits (`vision_probe_unavailable` / `backfill_secondary_spawn_timeout`), and defer-time observability is a future-PR defense-in-depth candidate. **TDA-IMPL-01** (L): the scan-based terminal transition (`updateMany` to `failed`) does **not** set `embeddingBackfillFailedAt` (other terminal-transition paths do); GDPR Art.30 record-keeping is alternatively satisfied by the `backfill_secondary_spawn_timeout` audit emit, so this is a minor observability gap and a future-PR symmetrisation candidate. **LCC-REMED-01** (L): the `INV-WORKER-LOCK-003` #11 label-lock test (`inv-worker-lock-003-embedding-backfill-supervisor.test.ts:836/837/1044`) asserts `worker_lock_ttl_fallback` via a **pre-existing hardcoded literal** (not co-migration-derived; the literal lines are outside the diff hunk = pre-existing); production code already uses the SSOT constant `AUDIT_ACTION_WORKER_LOCK_TTL_FALLBACK` and the `INV-AUDIT-EMIT-SSOT-IMPORT-001` AST sweep is production-only scope, so there is no real harm — migrating the label-lock test to an SSOT-constant-import assert is a future-PR candidate (applying the SSOT-derive rigor of §"Canonical CWE-209 PII Protection Pattern" / §"Worker actor naming SSOT" to the test path).

**Cross-ref**: Impl Finding Registry V1 (`backfill-worker-autostart-impl-finding-registry-v1.md` §Finding Registry: TPA-IMPL-01 / TDA-IMPL-01 / LCC-REMED-01) / ADR-0011 Amendment 7 §A7.4 (scan terminal) / `apps/mcp-server/src/services/worker-supervisor-lifecycle.service.ts` (`handleSecondarySpawnTimeout` scan terminal, defer site) / `apps/mcp-server/tests/regression/standing/worker-lifecycle/inv-worker-lock-003-embedding-backfill-supervisor.test.ts:836/1044` (label-lock literal) / §"Worker actor naming SSOT" (SSOT-derive rigor) / IO Impl Decision V1 anchor `019e7967-963f-75ef-af6e-0916bf7342dc` (Phase 3 docs-sync landing).

### `BULLMQ_KEY_MISSING_TRANSIENT_RE` lazy `[\s\S]*?` cross-newline keyword-tail match (TDA-IMPL-L-01, tracked, L) / `BULLMQ_KEY_MISSING_TRANSIENT_RE` の lazy `[\s\S]*?` 跨改行 keyword-tail マッチ（tracked, L）

**JP**: PR-L1a sub-item 4 (CO-SAMEURL-02 D1) で `apps/mcp-server/src/queues/enqueue-with-collision-guard.ts` に追加した SSOT regex `BULLMQ_KEY_MISSING_TRANSIENT_RE = /^Missing key for job [\s\S]*?(?:updateProgress|moveToActive|lock)/i` の lazy `[\s\S]*?` 部分が、`Missing key for job ` の後に **改行を跨いで** keyword tail (`updateProgress` / `moveToActive` / `lock`) にマッチしうる nuance を TDA-IMPL-L-01 (L) として確認した。`[\s\S]` は `.` と異なり改行も含むため、多行 error message で `Missing key for job` 行と keyword 行が離れていても 1 つの transient と分類しうる。

**現状の実害なし根拠 / Why no current real harm**: (1) **両分岐 outcome 不変** — `handleFailOpen` の D1 2 分岐 (transient warn / generic warn) はいずれも `outcome: "enqueued_fail_open"` を返す。すなわち key-missing transient を transient と分類するか generic と分類するかは **同一 outcome** であり、same-URL dedup correctness (BullMQ jobId uniqueness による ≤1 surviving job) の delta は **0**。(2) **両分岐 CWE-209 不変** — transient 分岐も generic 分岐も jobId を `truncateId(8)` で truncate し error を `sanitizeErrorMessage` 経由で出力するため、誤分類しても PII / 内部構造 leakage の delta は **0**。(3) **`^` anchor で over-match 確認済** — regex は `^Missing key for job ` で行頭 anchor 済のため、無関係 error が先頭から `Missing key for job ` で始まらない限り match しない (over-match false 確認済)。よって本項目は CWE の latent surface に留まり現リリースサイクルで実害はない → **L severity** (docs 記録 + tracked、deadline 2026-06-05 = T+1d)。

**Defense-in-depth 検討余地 / Defense-in-depth candidate** (将来 PR、owner pipeline-engineer): lazy `[\s\S]*?` を `[^\n]*?` に narrow し、`Missing key for job ` と keyword tail を **同一行内**に限定する (跨改行マッチを構造的に排除)。BullMQ の実 transient message は単一行 (`Missing key for job <id>. updateProgress`) であるため、`[^\n]*?` 化は real transient classification を維持しつつ multi-line over-match surface を縮退させる。new unit test (`tests/queues/enqueue-collision-guard-failopen-transient.test.ts` の anchor over-match guard) を `[^\n]*?` 形に合わせて narrow 可能。

**EN**: A TDA-IMPL-L-01 (L) finding confirmed that the lazy `[\s\S]*?` segment of the SSOT regex `BULLMQ_KEY_MISSING_TRANSIENT_RE = /^Missing key for job [\s\S]*?(?:updateProgress|moveToActive|lock)/i` added to `apps/mcp-server/src/queues/enqueue-with-collision-guard.ts` in PR-L1a sub-item 4 (CO-SAMEURL-02 D1) can match the keyword tail (`updateProgress` / `moveToActive` / `lock`) **across a newline** after `Missing key for job `. Because `[\s\S]` (unlike `.`) includes newlines, a multi-line error message with the `Missing key for job` line and the keyword line separated could still be classified as a single transient. No current real harm because (1) **both branches are outcome-invariant** — the D1 2-branch `handleFailOpen` (transient warn / generic warn) both return `outcome: "enqueued_fail_open"`, so classifying a key-missing transient as transient vs generic yields the **same outcome** and same-URL dedup correctness (≤1 surviving job via BullMQ jobId uniqueness) has delta **0**; (2) **both branches are CWE-209-invariant** — both the transient and generic branches `truncateId(8)`-truncate the jobId and route the error through `sanitizeErrorMessage`, so a misclassification has delta **0** for PII / internal-structure leakage; and (3) **the `^` anchor confirms over-match is false** — the regex is line-anchored at `^Missing key for job `, so an unrelated error cannot match unless it begins with `Missing key for job ` from the start. Hence this lands as **L severity** (docs record + tracked, deadline 2026-06-05 = T+1d). Defense-in-depth candidate for a future PR (owner pipeline-engineer): narrow the lazy `[\s\S]*?` to `[^\n]*?` so `Missing key for job ` and the keyword tail must be on the **same line** (structurally eliminating cross-newline matches); BullMQ's real transient message is single-line (`Missing key for job <id>. updateProgress`), so `[^\n]*?` preserves real transient classification while shrinking the multi-line over-match surface; the new unit test (the anchor over-match guard in `tests/queues/enqueue-collision-guard-failopen-transient.test.ts`) can be narrowed to the `[^\n]*?` form.

**Cross-ref**: PR-L1a sub-item 4 / CO-SAMEURL-02 D1 / `apps/mcp-server/src/queues/enqueue-with-collision-guard.ts` (`BULLMQ_KEY_MISSING_TRANSIENT_RE` SSOT named-export + `handleFailOpen` 2-branch) / Plan V1 §UB-6 (F-PLAN-L-01 regex `^` anchor + over-match contract) / `apps/mcp-server/tests/queues/enqueue-collision-guard-failopen-transient.test.ts` (anchor over-match guard) / `l-tracked-remediation-pr-l1-finding-registry-v0.md` §Impl-phase tracked-issues (TDA-IMPL-L-01) / IO Impl Decision = APPROVE (PR-L1a, Phase 3 docs-sync landing).

### PR-L4 L-PR sequence closure — CO-ASYNC-04 descope + CO-SAMEURL-02 D2/D3 accepted-risk (docs-only, no code change, 3×L accepted-risk) / PR-L4 L-PR sequence closure — CO-ASYNC-04 descope + CO-SAMEURL-02 D2/D3 accepted-risk（docs-only、code 変更なし、3×L accepted-risk）

**JP**: PR-L4 は orthogonal L tracked-issue remediation の L-PR sequence (PR-L1a / L1b / L2 / L3 / L4) の **最終 PR** であり、**production code を一切変更しない docs-only closure** である。User が **Option A (3 item を documented accepted-risk として closure)** を採択 (IO Evidence-First/sequencing decision anchor `019e9008`)。以下 **3 件の L** を accepted-risk として記録する (現リリースサイクルで実害なし、L severity、docs 記録 + tracked、deadline 2026-06-05 = T+1d)。

- **CO-ASYNC-04** (L、descope): `page.analyze` の 5 grandfathered camelCase param (`narrativeOptions` / `visionOptions` / `layoutTimeout` / `motionTimeout` / `qualityTimeout`) の snake_case 個別移行を **descope** (実施しない)。**accepted-risk 根拠**: (a) string→scalar coercion correctness は PR #55 (CO-ASYNC-01/02) + PR-L2 (CO-ASYNC-03 nested parity) で既に解決済 (本移行は correctness を変えない)、(b) 対象 5 個は `page.analyze` 内の 9 個の sibling camelCase + project 全体 44 個の grandfathered camelCase の一部に過ぎず、5 個 (~11%) だけ snake_case 化すると naming consistency を **むしろ悪化** (snake_case の島ができる)、(c) `mcp-parameter-naming.test.ts` の naming test は camelCase 残存を fail させず、移行は将来 major version へ明示 deferred、(d) Option A (rename) は既存 client argument 契約を破壊、Option B/C (dual-accept) は 5 個だけでは 9 sibling と非対称悪化。**将来 candidate** (将来 major version): project 全体 44 field を別 ADR (project-wide naming convention 移行) で一括 snake_case 統一 + dual-accept deprecation window。本件 owner backend-api-developer。
- **CO-SAMEURL-02 D2** (L、accepted-risk): key-missing transient の **専用 audit emit** (`audit_logs` への transient-specific entry) を追加しない。**accepted-risk 根拠**: observability は **D1 (log discrimination, PR-L1a 着地) で既に確保済** — `enqueue-with-collision-guard.ts` の `handleFailOpen` 2-branch structured `logger.warn` (jobId は `truncateId(8)`、error は `sanitizeErrorMessage` 経由 = CWE-209 clean) で transient を discriminate 可能。`auditEmitter` opt-in hook は既に配線済 (`enqueue-with-collision-guard.ts` line 172/452)。dedup correctness (BullMQ jobId uniqueness による ≤1 survivor) は D2 の有無に依存しない (delta 0)。**将来 candidate** (将来 PR、owner backend-api-developer): transient 専用 audit-action を SSOT audit-action 定数化 (§"Worker actor naming SSOT" / §"Canonical CWE-209 PII Protection Pattern" の SSOT-derive rigor に従い `audit-actions.ts` の SSOT 定数経由で emit、bare literal hardcode を避ける) する際に追加。
- **CO-SAMEURL-02 D3** (L、accepted-risk): fail-open path の **retry budget** (loser race 時の bounded re-add 試行) を追加しない。**accepted-risk 根拠**: **原 L1 plan 自身が reject 済** — `l-tracked-remediation-pr-l1-plan-v0.md` の PR Sequencing 議論で D3 retry-budget は「dedup correctness に不要 (jobId uniqueness が ≤1 survivor を保証)、queue boundary の timing/blast-radius を変える medium risk」として reject されている。D3 は dedup の正しさに寄与しない optional behavioural tuning。**将来 candidate** (将来 PR、owner pipeline-engineer): queue boundary の behavioural tuning が実際に必要になった場合 (例: fail-open re-add storm 観測時) に独立評価。

**CO-SAMEURL-02 family closure 宣言**: CO-SAMEURL-02 family は **closure 完了** — D1 (log discrimination) は PR-L1a で landed、D2 / D3 は本 entry で documented accepted-risk として確定。real problem (same-URL near-concurrent resubmit race による embedding 0 終端) は **PR #54 (jobId = uuidv5、main `8cfd5e78`) で既に解決済**であり、D2 / D3 はいずれも dedup 正しさに不要な observability 増分 (D2) / optional behavioural (D3) に留まる。

**EN**: PR-L4 is the **final PR** of the orthogonal L tracked-issue remediation L-PR sequence (PR-L1a / L1b / L2 / L3 / L4) and is a **docs-only closure that changes no production code**. The User adopted **Option A (close 3 items as documented accepted-risk)** (IO Evidence-First/sequencing decision anchor `019e9008`). The following **3 L items** are recorded as accepted-risk (no real harm in the current release cycle, L severity, docs record + tracked, deadline 2026-06-05 = T+1d). **CO-ASYNC-04** (L, descope): the per-field snake_case migration of `page.analyze`'s 5 grandfathered camelCase params (`narrativeOptions` / `visionOptions` / `layoutTimeout` / `motionTimeout` / `qualityTimeout`) is **descoped** (not performed); accepted-risk because (a) string→scalar coercion correctness was already fixed by PR #55 + PR-L2 (the migration changes no correctness), (b) the 5 targets are a slice of 9 sibling camelCase in `page.analyze` + 44 project-wide grandfathered camelCase, so migrating only 5 (~11%) would **worsen** naming consistency (a snake_case island), (c) the `mcp-parameter-naming.test.ts` naming test does not fail on camelCase residue and the migration is explicitly deferred to a future major version, and (d) Option A (rename) breaks the existing client argument contract while Option B/C (dual-accept) for only 5 fields is asymmetric with the 9 siblings — future candidate (future major version): bulk snake_case unification of all 44 fields via a separate project-wide naming-convention ADR + dual-accept deprecation window (owner backend-api-developer). **CO-SAMEURL-02 D2** (L, accepted-risk): no dedicated audit emit for the key-missing transient; accepted-risk because observability is **already provided by D1 (log discrimination, landed in PR-L1a)** — the `handleFailOpen` 2-branch structured `logger.warn` in `enqueue-with-collision-guard.ts` (jobId `truncateId(8)`-truncated, error routed through `sanitizeErrorMessage` = CWE-209 clean) discriminates the transient, the `auditEmitter` opt-in hook is already wired (`enqueue-with-collision-guard.ts` lines 172/452), and dedup correctness (≤1 survivor via BullMQ jobId uniqueness) has delta 0 with respect to D2 — future candidate (future PR, owner backend-api-developer): add it when the transient-specific audit action is SSOT-constant-ized (emitting via an `audit-actions.ts` SSOT constant per the §"Worker actor naming SSOT" / §"Canonical CWE-209 PII Protection Pattern" SSOT-derive rigor, avoiding bare-literal hardcoding). **CO-SAMEURL-02 D3** (L, accepted-risk): no retry budget on the fail-open path; accepted-risk because the **original L1 plan itself rejected it** — in the PR-sequencing discussion of `l-tracked-remediation-pr-l1-plan-v0.md`, the D3 retry budget was rejected as "not needed for dedup correctness (jobId uniqueness already guarantees ≤1 survivor), a medium risk that changes timing/blast-radius at the queue boundary"; D3 is an optional behavioural tuning that does not contribute to dedup correctness — future candidate (future PR, owner pipeline-engineer): independently evaluate if queue-boundary behavioural tuning is actually needed (e.g. on an observed fail-open re-add storm). **CO-SAMEURL-02 family closure declaration**: the family is **closure-complete** — D1 (log discrimination) landed in PR-L1a, and D2 / D3 are finalized as documented accepted-risk in this entry; the real problem (embedding-0 termination from the same-URL near-concurrent resubmit race) was **already fixed by PR #54 (jobId = uuidv5, main `8cfd5e78`)**, leaving D2 / D3 as an observability increment (D2) / an optional behavioural tuning (D3) only.

**Cross-ref**: PR-L4 (L-PR sequence closure) / `(§5 CO-ASYNC-04 descope + §14 CO-SAMEURL-02 D2/D3 accepted-risk) /` (PR Sequencing — D3 retry-budget reject) / CO-SAMEURL-02 D1 entry above (`BULLMQ_KEY_MISSING_TRANSIENT_RE`) / `apps/mcp-server/src/queues/enqueue-with-collision-guard.ts` (`handleFailOpen` 2-branch + `auditEmitter` opt-in hook) / `apps/mcp-server/tests/tools/mcp-parameter-naming.test.ts` (`DEPRECATED_CAMEL_CASE_PARAMS` grandfathered allowlist) / PR #54 (jobId = uuidv5 same-URL race fix, main `8cfd5e78`) / IO Evidence-First/sequencing decision anchor `019e9008` (Option A adoption, Phase 3 docs-sync landing).

### page.analyze advertised inputSchema pre-existing default drift (FIND-IMPL-L2-DRIFT-01, tracked, L) / page.analyze advertised inputSchema の pre-existing default drift（tracked, L）

**JP**: PR-L2 (CO-ASYNC-03) で `apps/mcp-server/src/tools/page/analyze.tool.ts` の advertised inputSchema に 21 個のネストスカラーを additive 追加した際、**PR-L2 が導入したものではない pre-existing な advertised↔Zod default drift 3 件**を FIND-IMPL-L2-DRIFT-01 (L) として確認した。いずれも対象 field は本 PR より前から既に advertised 済 (PR-L2 の 21 ネスト追加 field とは別):

- `motionOptions.maxPatterns`: advertised default **100** vs Zod canonical (`pageAnalyzeInputSchema`) default **500**
- `motionOptions.timeout`: advertised default **180000** vs Zod default **300000**
- `js_animation_options.waitTime`: advertised default **1000** vs Zod default **2000**

**現状の実害なし根拠 / Why no current real harm**: coercion engine (`coerceArgs`) は advertised の `default` を **入力として使わない** — advertised `default` は AI クライアントへの schema 表示ヒント (description 用途) であり、実際の default 解決は Zod canonical が行う。よって drift は client に提示される schema description のみに影響し、runtime 挙動 (実際に適用される default 値) には影響しない。PR-L2 が新規に追加する 21 ネスト field の constraint (default/min/max) は test design (d) の nested constraint SSOT-diff test が Zod と一致を CI で検証する (gap=21 のみが対象)。これら 3 件の pre-existing drift は PR-L2 を additive-only かつ scope-minimal に保つため、CI RED で gate せず tracked-issue として記録する。

**Defense-in-depth 検討余地 / Defense-in-depth candidate** (将来 PR、owner backend-api-developer、deadline 2026-06-05 = T+1d): 当該 3 件の advertised default を Zod canonical の値 (`maxPatterns` 500 / `timeout` 300000 / `waitTime` 2000) に揃え、SSOT-diff の対象を 21 ネスト field から既存 top-level field にも拡張して advertised↔Zod default parity を完全化する。

**EN**: While additively adding 21 nested scalars to the advertised inputSchema of `apps/mcp-server/src/tools/page/analyze.tool.ts` in PR-L2 (CO-ASYNC-03), a FIND-IMPL-L2-DRIFT-01 (L) finding confirmed **3 pre-existing advertised↔Zod default drifts that are NOT introduced by PR-L2** (the fields were already advertised before this PR, separate from PR-L2's 21 newly-added nested fields): `motionOptions.maxPatterns` (advertised default **100** vs Zod canonical default **500**), `motionOptions.timeout` (advertised **180000** vs Zod **300000**), and `js_animation_options.waitTime` (advertised **1000** vs Zod **2000**). No current real harm because the coercion engine (`coerceArgs`) does **not** use the advertised `default` as an input — the advertised `default` is a schema-display hint for AI clients (description purpose), and the actual default resolution is performed by the Zod canonical; so the drift affects only the schema description shown to clients, not runtime behavior (the default value actually applied). The constraints (default/min/max) of the 21 nested fields PR-L2 newly adds are CI-verified against Zod by the nested constraint SSOT-diff test (test design (d), scoped to the gap=21 fields only). These 3 pre-existing drifts are recorded as a tracked-issue rather than gated RED, to keep PR-L2 additive-only and scope-minimal. Defense-in-depth candidate for a future PR (owner backend-api-developer, deadline 2026-06-05 = T+1d): align the 3 advertised defaults to the Zod canonical values (`maxPatterns` 500 / `timeout` 300000 / `waitTime` 2000) and extend the SSOT-diff scope from the 21 nested fields to the existing top-level fields to fully close advertised↔Zod default parity.

**Cross-ref**: PR-L2 (CO-ASYNC-03) / `apps/mcp-server/src/tools/page/analyze.tool.ts` (advertised inputSchema) / `apps/mcp-server/src/tools/page/input.schemas.ts` (`pageAnalyzeInputSchema` Zod canonical = T1 SSOT) / `apps/mcp-server/tests/tools/page/analyze-advertised-schema-coercion.test.ts` (nested constraint SSOT-diff test, gap=21 scope) / Plan V0→V1 §4.4 (UB4 constraint parity) / ` / IO Impl Decision = APPROVE (PR-L2, Phase 3 docs-sync landing).

### URL normalize SSOT unification — defense-in-depth + CO-SAMEURL-01 closure (PR-L3, tracked, 4×L + 1 closure) / URL 正規化 SSOT 統一 — defense-in-depth + CO-SAMEURL-01 closure（PR-L3、tracked、4×L + closure 1 件）

**JP**: PR-L3 (CO-SAMEURL-01) で URL 正規化を単一 SSOT `normalizeUrlCore` (`apps/mcp-server/src/utils/url-normalizer.ts`) に統一し、queue jobId (`buildUrlStableJobId` → `uuidv5(normalizeUrlForValidation(url), uuid.v5.URL)`、ADR-0018 Amendment 11/12) と DB 保存 (`web_pages.url` upsert) が「同一 URL」と見なす集合をコードレベルで一致させた (`normalizeUrlForStorage` / `normalizeUrlForValidation` は core への ≤3 行 wrapper、catch canonical = `trimmed.toLowerCase()` の no-throw degraded-return)。本 PR は **non-breaking code-only L** であり、SSRF entrypoint `validateExternalUrl` は無改変。Impl 監査で確認された **L severity の tracked-issue 4 件 + CO-SAMEURL-01 closure 1 件** を記録する。いずれも現リリースサイクルで実害なし (L severity、docs 記録 + tracked、deadline 2026-06-05 = T+1d)。

- **TPA-IMPL-L-01** (L): `INV-WEBPAGE-URL-UNIQUE-002` の対象 unit test が **DB-mock scope** で `web_pages.url` UNIQUE 制約を検証する。実 production の UNIQUE 制約は稼働中 (Evidence-First anchor `019e8fcd` で確認) だが、unit test は DB-mock であり real-DB integration test は未配線。defense-in-depth 候補 (将来 PR、owner platform-engineer): real-DB integration test で UNIQUE 制約違反の挙動を end-to-end に pin。
- **TPA-IMPL-L-02** (L): `KNOWN_DB_UPSERT_FILES` が 6 個の DB-upsert 経路のうち **4 個のみを列挙する sanity-list** であり、src-wide の網羅的 sweep ではない。新規 upsert 経路追加時に sanity-list 漏れが silent に発生しうる。defense-in-depth 候補 (将来 PR): AST sweep で `web_pages.url` を upsert する全 callsite を src-wide に列挙し、normalizer SSOT 経由を強制。
- **SEC-IMPL-L-01** (L): `web-page.service.ts:207` の raw `create` 経路は **caller-依存 gate** であり、caller が `normalizeUrlForStorage` を経由せず raw URL を渡すと normalizer SSOT を bypass しうる。**現状の実害なし根拠**: production の全 caller は normalizer 経由で、かつ `web_pages.url` UNIQUE 制約が data-layer で重複を弾く。defense-in-depth 候補 (将来 PR): service-layer validation で raw create 入力を normalizer SSOT 経由に強制 (caller-契約から service-契約への昇格)。
- **TDA-IMPL-L-01** (L): `normalizeUrlCore` の cyclomatic complexity が **CC~10-11** であり、かつ `url-normalizer.ts` が complexity-override scope 外のため lint complexity gate の閾値 (10) を境界的に超えうる。**現状の実害なし根拠**: 7 ステップ正規化は線形シーケンスで本質的複雑度は低く、SSOT 集約により全体の重複は減少 (-60 行)。defense-in-depth 候補 (将来 PR): query-sort / path-normalize を helper 関数に extract して CC を閾値下に下げる。
- **CO-SAMEURL-01 closure record** (closed-as-already-satisfied): ADR-0018 Amendment 11 §Consequences で tracked された CO-SAMEURL-01 [L] (「`web_pages.url` UNIQUE 制約の不在、別 PR で upsert-by-url 設計」) は、**Evidence-First DB 確認 (anchor `019e8fcd`) で UNIQUE 制約が既に production 稼働中**であることが判明したため、breaking migration は redundant。PR-L3 の normalizer SSOT unify (queue↔DB 正規化集合の整合) と既存 UNIQUE 制約の組合せで defense-in-depth を達成し、**closed-as-already-satisfied** とする。

**EN**: PR-L3 (CO-SAMEURL-01) unified URL normalization into a single SSOT `normalizeUrlCore` (`apps/mcp-server/src/utils/url-normalizer.ts`), so the queue jobId (`buildUrlStableJobId`, ADR-0018 Amendment 11/12) and DB storage (`web_pages.url` upsert) treat the same set of URLs as "the same URL" at the code level (`normalizeUrlForStorage` / `normalizeUrlForValidation` are ≤3-line wrappers over the core, catch canonical = `trimmed.toLowerCase()` no-throw degraded-return). This is a **non-breaking code-only L**; the SSRF entrypoint `validateExternalUrl` is unchanged. Recording the **4 L-severity tracked-issues + 1 CO-SAMEURL-01 closure** confirmed during the Impl audit; none cause real harm in the current release cycle (L severity, docs record + tracked, deadline 2026-06-05 = T+1d). **TPA-IMPL-L-01** (L): the `INV-WEBPAGE-URL-UNIQUE-002` unit test verifies the `web_pages.url` UNIQUE constraint at **DB-mock scope**; the production UNIQUE constraint is operating (confirmed via Evidence-First anchor `019e8fcd`) but a real-DB integration test is not yet wired (future-PR candidate, owner platform-engineer). **TPA-IMPL-L-02** (L): `KNOWN_DB_UPSERT_FILES` is a **sanity-list enumerating 4 of 6** DB-upsert paths, not a src-wide exhaustive sweep, so a new upsert path could silently miss the list (future-PR candidate: AST sweep enumerating all `web_pages.url` upsert callsites src-wide). **SEC-IMPL-L-01** (L): the raw `create` path at `web-page.service.ts:207` is a **caller-dependent gate** — a caller that passes a raw URL without `normalizeUrlForStorage` could bypass the normalizer SSOT; no current real harm because all production callers route through the normalizer and the `web_pages.url` UNIQUE constraint rejects duplicates at the data layer (future-PR candidate: service-layer validation enforcing the normalizer SSOT on raw-create input). **TDA-IMPL-L-01** (L): `normalizeUrlCore` has **CC~10-11** and `url-normalizer.ts` is outside the complexity-override scope, so it could marginally exceed the lint complexity gate threshold (10); no current real harm because the 7-step normalization is a linear sequence with low essential complexity and the SSOT consolidation reduces overall duplication (-60 lines) (future-PR candidate: extract query-sort / path-normalize helpers to drop CC below threshold). **CO-SAMEURL-01 closure record** (closed-as-already-satisfied): the CO-SAMEURL-01 [L] tracked in ADR-0018 Amendment 11 §Consequences (absence of a `web_pages.url` UNIQUE constraint, a separate upsert-by-url PR) was found via an Evidence-First DB check (anchor `019e8fcd`) to **already exist and operate in production**, making a breaking migration redundant; the PR-L3 normalizer SSOT unify (queue↔DB normalization-set alignment) combined with the existing UNIQUE constraint achieves defense-in-depth, so it is **closed-as-already-satisfied**.

**Cross-ref**: PR-L3 (CO-SAMEURL-01) / Evidence-First anchor `019e8fcd` (`web_pages.url` UNIQUE already operating) / IO Plan Decision V0 = CONDITIONAL `019e8fd2` → V1 = APPROVE `019e8fdb` / IO Impl Decision = APPROVE `019e8ff8` / ADR-0018 Amendment 11 (CO-SAMEURL-01 origin) + Amendment 12 (URL normalize SSOT) / `apps/mcp-server/src/utils/url-normalizer.ts` (`normalizeUrlCore` SSOT + `normalizeUrlForStorage` wrapper) / `apps/mcp-server/src/utils/url-validator.ts` (`normalizeUrlForValidation` wrapper, `validateExternalUrl` unchanged) / `apps/mcp-server/tests/utils/inv-url-normalize-ssot-001.test.ts` (`INV-URL-NORMALIZE-SSOT-001`, 12 tests) / `apps/mcp-server/src/services/web-page.service.ts` (raw create caller gate, SEC-IMPL-L-01).

### L-tracked defense-in-depth bundle PR — tracked-issue status update (3×FIXED / 1×KEEP-ACCEPTED-RISK / 1×ALREADY-CLOSED / 2×DEFER) / L-tracked defense-in-depth bundle PR — tracked-issue 状態更新（3×FIXED / 1×KEEP-ACCEPTED-RISK / 1×ALREADY-CLOSED / 2×DEFER）

**JP**: L-tracked defense-in-depth cleanup bundle PR (branch `chore/l-tracked-defense-in-depth`、IO Impl Decision V0 = APPROVE anchor `019e926d`) が上記 3 tracked-issue section の defense-in-depth candidate を着地させた。本節は上記各 section の status を**確定的に supersede**する (上記 section の本文は origin record として保持、status のみ本節が canonical)。すべて behavior-不変 L hardening、現リリースサイクルで実害なし。

- **§"`BULLMQ_KEY_MISSING_TRANSIENT_RE`" (TDA-IMPL-L-01) → FIXED**: defense-in-depth candidate (lazy `[\s\S]*?` → `[^\n]*?` narrow) を着地。`apps/mcp-server/src/queues/enqueue-with-collision-guard.ts` の SSOT regex は現在 `/^Missing key for job [^\n]*?(?:updateProgress|moveToActive|lock)/i` であり、`Missing key for job ` と lifecycle keyword tail を **同一行内**に構造的に限定する (cross-newline over-match を排除)。BullMQ の実 transient message は単一行 (`Missing key for job <id>. updateProgress`) のため real transient classification は不変、両分岐 outcome (`enqueued_fail_open`) も CWE-209 truncation も不変。`tests/queues/enqueue-collision-guard-failopen-transient.test.ts` に cross-newline false-match guard を追加。
- **§"page.analyze advertised inputSchema pre-existing default drift" (FIND-IMPL-L2-DRIFT-01) → FIXED**: defense-in-depth candidate (advertised default 3 件を Zod canonical = `input.schemas.ts` に align) を着地。`apps/mcp-server/src/tools/page/analyze.tool.ts` の advertised inputSchema は現在 `motionOptions.maxPatterns` default **500** / `motionOptions.timeout` default **300000** / `js_animation_options.waitTime` default **2000** であり、Zod canonical (`pageAnalyzeInputSchema`) と完全一致する。canonical = `input.schemas.ts` (Zod) であり handler の `?? 500` fallback ではない (用語精度)。advertised `default` は AI クライアントへの **schema 表示ヒント** であり coercion engine の入力ではないため runtime 挙動は align 前後で不変 (表示 hint のみの訂正)。`tests/tools/page/analyze-advertised-schema-coercion.test.ts` の SSOT-diff allowlist を 3-field 拡張。
- **§"URL normalize SSOT unification" TDA-IMPL-L-01 (`normalizeUrlCore` CC) → FIXED**: defense-in-depth candidate (query-sort / path-normalize の helper extract で CC を閾値下に) を着地。`apps/mcp-server/src/utils/url-normalizer.ts` から helper 2 個 (`sortQueryParams` L77 / `normalizePathname` L113) を抽出して `normalizeUrlCore` 本体の CC を ≤10 に下げ、`packages/config/eslint/index.js` に `url-normalizer.ts` 限定 scope の `complexity: ["error", 10]` override を追加 (base rule は monorepo-wide で `off`)。純粋 refactor であり、`INV-URL-NORMALIZE-SSOT-001` の AST sweep (SEVEN_STEP_MARKERS literal を `url-normalizer.ts` 内に保持) は GREEN 維持、normalization 挙動不変。
- **§"URL normalize SSOT unification" SEC-IMPL-L-01 (`web-page.service.ts` raw create) → KEEP-ACCEPTED-RISK**: service-layer validation への昇格は **実施しない** (accepted-risk)。**事実ベース rationale (SEC ground-truth)**: real 防御は「DB `web_pages_url_key` UNIQUE 制約 + `findOrCreateByUrl` の find-first idempotency」の **data-layer 2重防御**であり、URL 正規化の非対称は同一論理 URL の重複 `web_pages` 行を生む **CWE-697 latent dedup degradation (L)** に留まる (PII / SSRF / injection 非該当、SSRF entrypoint `validateExternalUrl` は bypass されない)。`web-page.service.ts` は `KNOWN_DB_UPSERT_FILES` AST sweep 対象外であり (sanity-list 4-file に不在)、唯一 caller `motion/detect.tool.ts:491` (`findOrCreateWebPageForUrl`) が raw `url` を `normalizeUrlForStorage` 経由せず渡す。「全 caller が SSOT 正規化経由 (AST-pin) / 3重防御」という記述は **採らない** (事実は 2重防御)。defense-in-depth candidate (CO-DID-03): `findOrCreateByUrl` 内での再正規化 OR `web-page.service.ts` を `KNOWN_DB_UPSERT_FILES` scope に追加 — deadline **2026-06-05 (T+1d)**、owner backend-api-developer (F-DEFER-02 と統合可)。
- **§"`BULLMQ_KEY_MISSING_TRANSIENT_RE`" claim-key line-ref (Item 2) → ALREADY-CLOSED**: claim-key JSDoc line-ref 精度は PR-L1a finding registry (`l-tracked-remediation-pr-l1-finding-registry-v0.md:313/:324`) で既訂正済 (report-only、code/test delta なし)。
- **DEFER CO-DID-01 (Item 4, `INV-WEBPAGE-URL-UNIQUE-002` real-DB integration)**: 現状の unit test は DB-mock scope。real-DB integration test (`tests/integration/` での UNIQUE 制約違反 end-to-end pin) は別 PR — owner platform-engineer、deadline **2026-06-05 (T+1d)**。production UNIQUE 制約自体は稼働中 (Evidence-First anchor `019e8fcd`)。
- **DEFER CO-DID-02 (Item 5, `KNOWN_DB_UPSERT_FILES` src-wide AST sweep)**: 現状の `KNOWN_DB_UPSERT_FILES` は 6 DB-upsert 経路のうち 4-of-6 を列挙する sanity-list。src-wide AST sweep (全 `web_pages.url` upsert callsite を列挙、`INV-AUDIT-EMIT-SSOT-IMPORT-001` Test 8 pattern 流用) は別 PR — owner backend-api-developer、deadline **2026-06-05 (T+1d)**。CO-DID-03 (Item 6 defense-in-depth) と連関 (sweep が src-wide 化されれば `web-page.service.ts` も自動 cover)。

**EN**: The L-tracked defense-in-depth cleanup bundle PR (branch `chore/l-tracked-defense-in-depth`, IO Impl Decision V0 = APPROVE anchor `019e926d`) landed the defense-in-depth candidates of the three tracked-issue sections above. This section **authoritatively supersedes** the status of each section above (the prose above is retained as the origin record; only the status is canonicalised here). All are behavior-invariant L hardening with no real harm in the current release cycle. **§"`BULLMQ_KEY_MISSING_TRANSIENT_RE`" (TDA-IMPL-L-01) → FIXED**: landed the candidate (lazy `[\s\S]*?` → `[^\n]*?` narrow); the SSOT regex in `apps/mcp-server/src/queues/enqueue-with-collision-guard.ts` is now `/^Missing key for job [^\n]*?(?:updateProgress|moveToActive|lock)/i`, structurally confining `Missing key for job ` and the lifecycle keyword tail to the **same line** (eliminating cross-newline over-match); BullMQ's real transient message is single-line (`Missing key for job <id>. updateProgress`), so real transient classification, both branch outcomes (`enqueued_fail_open`), and the CWE-209 truncation are unchanged; a cross-newline false-match guard was added to `tests/queues/enqueue-collision-guard-failopen-transient.test.ts`. **§"page.analyze advertised inputSchema pre-existing default drift" (FIND-IMPL-L2-DRIFT-01) → FIXED**: landed the candidate (align the 3 advertised defaults to the Zod canonical = `input.schemas.ts`); the advertised inputSchema in `apps/mcp-server/src/tools/page/analyze.tool.ts` is now `motionOptions.maxPatterns` default **500** / `motionOptions.timeout` default **300000** / `js_animation_options.waitTime` default **2000**, exactly matching the Zod canonical (`pageAnalyzeInputSchema`); the canonical is `input.schemas.ts` (Zod), not the handler's `?? 500` fallback (terminology precision); since the advertised `default` is a **schema-display hint** for AI clients and not a coercion-engine input, runtime behavior is unchanged across the align (display-hint-only correction); the SSOT-diff allowlist in `tests/tools/page/analyze-advertised-schema-coercion.test.ts` was extended by the 3 fields. **§"URL normalize SSOT unification" TDA-IMPL-L-01 (`normalizeUrlCore` CC) → FIXED**: landed the candidate (extract query-sort / path-normalize helpers to drop CC below threshold); 2 helpers (`sortQueryParams` L77 / `normalizePathname` L113) were extracted from `apps/mcp-server/src/utils/url-normalizer.ts` to bring `normalizeUrlCore`'s CC to ≤10, and a `url-normalizer.ts`-scoped `complexity: ["error", 10]` override was added to `packages/config/eslint/index.js` (the base rule is `off` monorepo-wide); this is a pure refactor — the `INV-URL-NORMALIZE-SSOT-001` AST sweep (SEVEN_STEP_MARKERS literals retained inside `url-normalizer.ts`) stays GREEN and normalization behavior is unchanged. **§"URL normalize SSOT unification" SEC-IMPL-L-01 (`web-page.service.ts` raw create) → KEEP-ACCEPTED-RISK**: the promotion to service-layer validation is **not performed** (accepted-risk). **Fact-based rationale (SEC ground-truth)**: the real defense is the **data-layer dual defense** of "the DB `web_pages_url_key` UNIQUE constraint + the find-first idempotency of `findOrCreateByUrl`", and the URL-normalization asymmetry is only a **CWE-697 latent dedup degradation (L)** producing duplicate `web_pages` rows for the same logical URL (not PII / SSRF / injection; the SSRF entrypoint `validateExternalUrl` is not bypassed); `web-page.service.ts` is outside the `KNOWN_DB_UPSERT_FILES` AST sweep (absent from the 4-file sanity-list), and the sole caller `motion/detect.tool.ts:491` (`findOrCreateWebPageForUrl`) passes a raw `url` without `normalizeUrlForStorage`. The claim "all callers route through the SSOT normalizer (AST-pinned) / triple defense" is **NOT adopted** (the fact is dual defense). Defense-in-depth candidate (CO-DID-03): re-normalize inside `findOrCreateByUrl` OR add `web-page.service.ts` to the `KNOWN_DB_UPSERT_FILES` scope — deadline **2026-06-05 (T+1d)**, owner backend-api-developer (can be unified with F-DEFER-02). **§"`BULLMQ_KEY_MISSING_TRANSIENT_RE`" claim-key line-ref (Item 2) → ALREADY-CLOSED**: the claim-key JSDoc line-ref precision was already corrected in the PR-L1a finding registry (`l-tracked-remediation-pr-l1-finding-registry-v0.md:313/:324`) (report-only, no code/test delta). **DEFER CO-DID-01 (Item 4, `INV-WEBPAGE-URL-UNIQUE-002` real-DB integration)**: the current unit test is DB-mock scope; a real-DB integration test (end-to-end UNIQUE-violation pin under `tests/integration/`) is a separate PR — owner platform-engineer, deadline **2026-06-05 (T+1d)**; the production UNIQUE constraint itself is operating (Evidence-First anchor `019e8fcd`). **DEFER CO-DID-02 (Item 5, `KNOWN_DB_UPSERT_FILES` src-wide AST sweep)**: the current `KNOWN_DB_UPSERT_FILES` is a 4-of-6 sanity-list of the DB-upsert paths; a src-wide AST sweep (enumerate all `web_pages.url` upsert callsites, reusing the `INV-AUDIT-EMIT-SSOT-IMPORT-001` Test 8 pattern) is a separate PR — owner backend-api-developer, deadline **2026-06-05 (T+1d)**; coupled with CO-DID-03 (Item 6 defense-in-depth) — a src-wide sweep would automatically cover `web-page.service.ts`.

**Cross-ref**: L-tracked defense-in-depth bundle PR (branch `chore/l-tracked-defense-in-depth`) / IO Plan Decision V0 = CONDITIONAL `019e9253` → V1 = APPROVE `019e925a` / IO Impl Decision V0 = APPROVE `019e926d` / Finding Registry `(F-FIX-01/02/03 + F-KEEP-01 + F-CLOSED-01 + F-DEFER-01/02 + C-01 SEC ground-truth + U-1) / Plan` / `apps/mcp-server/src/queues/enqueue-with-collision-guard.ts` (`BULLMQ_KEY_MISSING_TRANSIENT_RE` `[^\n]*?`) / `apps/mcp-server/src/tools/page/analyze.tool.ts` (advertised default align) / `apps/mcp-server/src/utils/url-normalizer.ts` (`sortQueryParams` / `normalizePathname` helper extract) / `packages/config/eslint/index.js` (`url-normalizer.ts`-scoped `complexity` override) / `apps/mcp-server/src/services/web-page.service.ts` (raw create caller gate, SEC-IMPL-L-01 KEEP) / `apps/mcp-server/src/tools/motion/detect.tool.ts:491` (`findOrCreateWebPageForUrl` raw-url caller).

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

### Tracked: `section-screenshot-fallback.service.ts` logger.warn slice (SEC-RV2-L-01, pre-existing, L) / Tracked note

**JP**: PR-C4 re-audit で SEC L finding (SEC-RV2-L-01) として、`apps/mcp-server/src/services/part/section-screenshot-fallback.service.ts` の `logger.warn` 内で id を inline `.slice(...)` で truncate している箇所が確認された。これは **非 audit-emit file** (`audit_logs` を emit しない、log line のみ) かつ **pre-existing** (PR-C4 で導入された差異ではない) であり、PR-C4 の audit emit path (`embedding_section_visual_pii_excluded`) は §"Canonical CWE-209 PII Protection Pattern" の `truncateAuditTargetId` SSOT を既に経由しているため CWE-209 CLEAN (SEC APPROVE)。本 log line slice は CWE-209 の latent surface に留まり現リリースサイクルで実害はない → **L severity** (docs 記録 + tracked、deadline 2026-05-31 = T+1d)。

**Defense-in-depth 候補 / Defense-in-depth candidate** (将来 PR): 当該 `logger.warn` の inline `.slice(...)` を `truncateAuditTargetId` SSOT (`AUDIT_LOG_CONSTANTS.TARGET_ID_TRUNCATE_LENGTH` 由来) に統一し、log path の PII truncation length を audit path と同一契約に揃える (coupling drift 検出、§"Canonical CWE-209 PII Protection Pattern" の SSOT-derive rigor を log path にも適用)。`truncateId()` ユーティリティ統一 (`src/tools/preference/schemas.ts` / `src/services/part/schemas.ts`) と co-migration 候補。

**EN**: The PR-C4 re-audit confirmed a SEC L finding (SEC-RV2-L-01): a `logger.warn` in `apps/mcp-server/src/services/part/section-screenshot-fallback.service.ts` truncates an id via an inline `.slice(...)`. It is a **non-audit-emit file** (log line only, no `audit_logs`) and **pre-existing** (not introduced by PR-C4); the PR-C4 audit emit path (`embedding_section_visual_pii_excluded`) already routes through the `truncateAuditTargetId` SSOT per §"Canonical CWE-209 PII Protection Pattern" (CWE-209 CLEAN, SEC APPROVE). The log-line slice is a latent CWE-209 surface with no current real harm → **L severity** (docs record + tracked, deadline 2026-05-31 = T+1d). Defense-in-depth candidate (future PR): unify the inline `.slice(...)` to the `truncateAuditTargetId` SSOT so the log path uses the same PII-truncation-length contract as the audit path (coupling-drift detection); co-migration candidate with the `truncateId()` utility unification.

**Cross-ref**: SEC-RV2-L-01 (PR-C4 Finding Registry V4 Open L) / `apps/mcp-server/src/services/part/section-screenshot-fallback.service.ts` (`logger.warn` inline slice) / §"Canonical CWE-209 PII Protection Pattern" (audit path SSOT) / §"truncateId() ユーティリティ" (future unification) / IO Impl Decision V3 (Phase 3 docs-sync landing).

### Embedding cache temp-leak fix — L tracked-issues (ADR-0040, deadline 2026-06-09 = T+1d) / Embedding キャッシュ temp-leak fix — L tracked-issue（ADR-0040、deadline 2026-06-09 = T+1d）

- **TPA-RE3-01** (L、CWE-697 latent): `parseTempPid` (`cache-orphan-sweep.ts`) の SSOT-derive form が元 regex と **非producible入力** (例 `cache.json.tmp.12a.9`) で非等価 (new=12 / legacy=null)。**現状実害なし**: producer は `process.pid` 純整数のみで、`12a` 形 pid は構造的に生成不能 (CWE-697 latent のみ)、かつ全 deletion が `CACHE_TEMP_REGEX` filter 先行。defense-in-depth 候補 (将来 PR): `parsePidStrict` を `/^\d+$/` gate で完全等価化 + INV に「非producible 入力は非削除」assert 追加。owner pipeline-engineer。
- **SEC-IMPL-01** (L、CWE-367): sweep の `realpathSync`→`rmSync`/`unlinkSync` 間の残余 TOCTOU window。**現状実害なし**: 削除には basename predicate + underRoot + 死 pid + grace の AND 同時成立が必要で window は極小、Phase 5 `cleanupPhase5TempDir` 前例と同水準。defense-in-depth 候補 (将来 PR): delete 前の `lstatSync` re-check。owner pipeline-engineer。
- **SEC-IMPL-02 / TDA-IMPL-02** (L、CWE-710): `layout-embedding.service.ts` の `resolveEmbeddingCacheRoot` / `resolvePerWorkerCacheConfig` が eslint scoped complexity override の対象外 (現 CC≤10 だが machine-enforce なし)。**現状実害なし**: 現 CC は閾値以下。defense-in-depth 候補 (将来 PR): leaf module 抽出 or `layout-embedding.service.ts` を scoped override scope に追加。owner backend-api-developer。
- **TPA-IMPL-02** (L、accepted-risk): `persistent-cache.ts` の新 scoped complexity override 対象化により、pre-existing CC=15 の `loadFromDisk` に inline `eslint-disable` を付与 (実装者が透明文書化済、FIND-TDA-07 tracked)。**accepted-risk**: 本 PR scope 外の pre-existing 複雑度であり、override scope 追加の副作用として明示 disable で透明化。defense-in-depth 候補 (将来 PR): `loadFromDisk` の複雑度低減 refactor。owner pipeline-engineer。

**Cross-ref**: ADR-0040 (embedding cache temp-leak 根治) / `(IO Impl Decision V0 CONDITIONAL → V1 APPROVE、Impl-phase tracked-issues 表) /`apps/mcp-server/src/services/cache-orphan-sweep.ts` (`parseTempPid`/`realpathSync`→delete) / `apps/mcp-server/src/services/layout-embedding.service.ts` (`resolveEmbeddingCacheRoot`/`resolvePerWorkerCacheConfig`) / `apps/mcp-server/src/services/persistent-cache.ts` (`loadFromDisk`inline eslint-disable) /`packages/config/eslint/index.js`(scoped`complexity:["error",10]`override) /`apps/mcp-server/DATA_RETENTION.md` §9.5.

### Visual-backfill truncated-screenshot data-loss fix — L tracked-issues (ADR-0018 Amendment 13, deadline 2026-06-09 = T+1d) / visual-backfill 切り詰めスクリーンショット data-loss fix — L tracked-issue（ADR-0018 Amendment 13、deadline 2026-06-09 = T+1d）

- **SEC-IMPL-PRA-L-01** (L、CWE-20 latent) — **status: FIXED (本 PR `fix/visual-backfill-l-followup` で着地、下記 §"Visual-backfill Amendment 13 follow-up" 節が canonical)**: one-shot repair script (`apps/mcp-server/scripts/repair-truncated-screenshot-terminals.ts`) の `--web-page-id` arg に UUID regex 検証がなく、canonical precedent (`screenshot-persistence.service.ts` 等の strict UUID v4/v7 regex) から divergence していた。**現状の実害なし根拠 (origin record 保持)**: 当該 arg は `$1::uuid` parameterized query + 固定リテラル fragment でのみ使用され、PostgreSQL 側が `uuid` cast で不正値を reject するため SQL injection は構造的に不可能 (CWE-20 improper input validation の latent surface のみ)。repair script は operator 手動実行 (外部 untrusted input を bind しない)。**着地 (FIXED)**: defense-in-depth 候補 (`--web-page-id` arg に strict UUID v4/v7 regex 検証を追加、canonical precedent と parity) を本 PR で着地。`screenshot-persistence.service.ts` の `UUID_REGEX` を SSOT export 化し、repair `parseArgs` が import → `--web-page-id` 不正時に DB 接続前 `exit(1)`。owner security-engineer + pipeline-engineer。
- **TPA-IMPL-B-L-01** (L、honesty、Phase 3 docs で着地済): part の `screenshot_truncated` は section 経由で visual 回復**しない** (part loop は永続 truncated screenshot から crop、section 再capture バッファは part loop に非書戻し)。part は bounded budget (cap=5) で `screenshot_truncated_expired` terminal に収束し、coverage 0 を GDPR Art.5(1)(d) accuracy で正確記録。**着地**: ADR-0018 Amendment 13 §8.10 + plan §5.7 honesty note + DATA_RETENTION.md §9 "Truncated-Screenshot Skip Reasons" に「section のみ genuine 回復、part は terminal expired 収束 (coverage 0 正確記録)」を明記済 (本 Phase 3 docs-sync)。owner pipeline-engineer + documentation-engineer。
- **TPA-IMPL-B-L-02** (L、test 拡張 tracked): robots-disallow→terminal の production 収束 (`INV-BACKFILL-SECTION-FALLBACK-ROBOTS`) + part/section symmetry (`INV-TRUNCATED-PART-SECTION-SYMMETRY`) が現状 AST-pin / 型レベル検証のみで、runtime write-path は 3層検証 (AST source-pin + fixture propagation + real-DB state) で代替されているが直接 exercise されていない。**現状の実害なし根拠**: 3層検証で contract semantic equivalence を担保、runtime write は PR-B section fallback 着地で genuine 化。defense-in-depth 候補 (将来 PR): real-DB runtime write-path assert 拡張。owner capture-embedding-engineer + pipeline-engineer。
- **TDA-IMPL-PRB-L-01** (L、accepted-risk): URL fetch helper 2 個並存 — module-level `fetchWebPageUrlForFallback` (`embedding-backfill-processors.ts:688`) vs private `fetchPageUrlForBboxResolve` (`:998`) の論理重複。**accepted-risk 根拠**: 機能重複だが両者 behavior-correct (同一 URL fetch + `validateExternalUrl` SSRF gate 通過)、実害なし。defense-in-depth 候補 (将来 PR): helper 統一。owner backend-api-developer。

**Cross-ref**: ADR-0018 Amendment 13 §8.2 / §8.10 (part vs section honesty) / `(IO Impl Decision V2 = APPROVE) /` (PR-A L findings) / `apps/mcp-server/scripts/repair-truncated-screenshot-terminals.ts` (`--web-page-id` arg, SEC-IMPL-PRA-L-01) / `apps/mcp-server/src/queues/embedding-backfill-processors.ts` (`fetchWebPageUrlForFallback` / `fetchPageUrlForBboxResolve`, TDA-IMPL-PRB-L-01) / `apps/mcp-server/DATA_RETENTION.md` §9 "Truncated-Screenshot Skip Reasons" + ADR-0018 Amendment 13 §8.10 (part honesty landing) / `INV-BACKFILL-SECTION-FALLBACK-ROBOTS` / `INV-TRUNCATED-PART-SECTION-SYMMETRY` (large-page standing).

### Visual-backfill Amendment 13 follow-up — stale skip_reason cosmetic closure + repair UUID hardening — L tracked-issues (deadline 2026-06-10 = T+1d) / visual-backfill Amendment 13 follow-up — stale skip_reason cosmetic closure + repair UUID hardening — L tracked-issue（deadline 2026-06-10 = T+1d）

- **TPA-IMPL-L-01** (L、accepted-risk): 初期 analysis 経路の別 3 vision write site (`vision-embedding.service.ts:482/511/555`) も `vision_skip_reason` を非クリア。**実害なし根拠**: 初期 analysis は fresh row への書き込みであり stale skip_reason は存在しないため実害なし (本 PR の backfill 経路と異なり pre-existing marker がない)。defense-in-depth 候補 (将来 PR、owner capture-embedding-engineer): backfill 経路と同 symmetry で `vision_skip_reason = NULL` を追加。
- **TPA-IMPL-L-02** (L、test): repair `parseArgs` の UUID 検証に対する直接 unit test が欠如 (手動 node 検証済)。**実害なし根拠**: 検証ロジックは strict regex 単一 gate であり手動 node 検証で挙動確認済。defense-in-depth 候補 (将来 PR、owner test-qa-engineer): `parseArgs` の UUID-reject unit test を追加。
- **F-TDA-02** (L): codebase 全体に UUID regex が 15 件散在しており project-wide SSOT 統一が未完。**実害なし根拠**: 本 PR は `UUID_REGEX` SSOT export 化により net -1 (悪化なし、改善方向)。defense-in-depth 候補 (将来 PR、owner backend-api-developer): 残 14 件を SSOT 定数 import に集約。
- **LCC-2** (L): 新 INV test ファイルに SPDX header 欠落。**実害なし根拠**: `prepare-oss.sh` が OSS sync 時に SPDX header を auto-inject するため license-validity 非該当 (私リポジトリ慣例の不整合のみ、accepted)。
- **F-2** (L、accepted): repair arg-error が operator 自入力の UUID を verbatim echo する。**実害なし根拠**: repair script は operator 手動実行 CLI であり、echo される値は operator 自身の入力 (外部 untrusted input ではない) ゆえ CWE-209 information exposure 非該当 (accepted)。
- **F-TDA-03** (L、accepted): repair script の cyclomatic complexity が +1×2 だが lint 閾値内であり complexity override 不要 (accepted)。
- **fork-path 関連 (別 tracked、owner pipeline-engineer)**: RCA 確定 — Phase 5 fork-path の throw は by-design throw であり systemic bug ではない。defense-in-depth 候補: ① by-design throw を typed/sentinel error 化 + WARN→INFO に格下げ (observability noise 低減)、② visual 2 カテゴリの早期 in-process dispatch。**UNVERIFIED (実機検証未完)**: Redis per-job lock fail-open の真因特定、genuine-fork 5 カテゴリの実機検証 (いずれも未検証として明示、捏造しない)。
- **既存 1002 行の one-time UPDATE (User 判断待ち、提案として記録)**: 既存データの stale skip_reason 残存 (`UPDATE section_embeddings SET vision_skip_reason = NULL WHERE vision_embedding IS NOT NULL AND vision_skip_reason IS NOT NULL`、PII-safe gate = vision_embedding IS NOT NULL のみ filter) は **未実行**。本 PR の code-fix は future write のみクリアするため、過去 backfill で書かれた既存矛盾行 (実機検証で 33 行確認) は one-time UPDATE で別途クリアが必要。実行は User 判断 (本 docs に提案として記録、機能無害ゆえ非緊急)。

**Cross-ref**: ADR-0018 Amendment 13 (origin) / §"Visual-backfill truncated-screenshot data-loss fix — L tracked-issues" above (SEC-IMPL-PRA-L-01 origin node, status FIXED) / `apps/mcp-server/src/services/screenshot-persistence.service.ts` (`UUID_REGEX` SSOT export) / `apps/mcp-server/scripts/repair-truncated-screenshot-terminals.ts` (`--web-page-id` strict UUID validation in `parseArgs`) / `apps/mcp-server/src/workers/phases/phase-5-embedding.ts` (`processSingleSectionVisualEmbedding` / `processDynamicFallbackBatch` `vision_skip_reason = NULL`) / `apps/mcp-server/src/services/vision-embedding.service.ts:482/511/555` (initial-analysis sites, TPA-IMPL-L-01) / `apps/mcp-server/tests/regression/standing/large-page/inv-section-visual-skip-reason-clear-001.test.ts` (`INV-SECTION-VISUAL-SKIP-REASON-CLEAR-001`) / §"Canonical CWE-209 PII Protection Pattern" (SSOT-derive rigor) / IO Impl Decision = CONDITIONAL→APPROVE (Phase 3 docs-sync landing).

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
