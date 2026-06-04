// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-URL-NORMALIZE-SSOT-001 / INV-WEBPAGE-URL-UNIQUE-002 / URL-normalize SSOT-import AST sweep
 *
 * **PR-L3 (CO-SAMEURL-01) — normalizer SSOT unify**
 *
 * ## Contract / 不変条件
 *
 * 1. **INV-URL-NORMALIZE-SSOT-001** — `normalizeUrlForValidation(x)` (queue jobId
 *    namespace key) と `normalizeUrlForStorage(x)` (DB `web_pages.url` upsert) は
 *    **全 input (success path + parse-failure path 双方) で byte-identical** な
 *    結果を返す。両者は同一 SSOT `normalizeUrlCore` を経由するため、queue 層が
 *    「同一 job」と見なす URL 集合と DB UNIQUE が「同一行」と見なす URL 集合が
 *    コードレベルで恒久一致する。catch canonical = `trimmed.toLowerCase()`。
 *
 *    Both `normalizeUrlForValidation` (queue jobId namespace key) and
 *    `normalizeUrlForStorage` (DB `web_pages.url` upsert) MUST return
 *    **byte-identical** results across **all inputs** (success + parse-failure
 *    paths), because both route through the same SSOT `normalizeUrlCore`.
 *
 * 2. **INV-WEBPAGE-URL-UNIQUE-002** — 既存 `web_pages_url_key` UNIQUE INDEX の
 *    回帰保護: 同一 normalized url で 2 回 raw `create` を試行すると 2 回目が
 *    UNIQUE violation (Prisma P2002) で reject される。
 *
 *    Regression protection for the existing `web_pages_url_key` UNIQUE INDEX:
 *    a second raw `create` with the same normalized url is rejected with a
 *    UNIQUE violation (Prisma P2002).
 *
 * 3. **SSOT-import AST sweep** — queue jobId callsite (`page-analyze-queue.ts`
 *    `buildUrlStableJobId`) と DB upsert callsite が同一 `normalizeUrlCore` を
 *    (wrapper 経由で) 参照する SSOT を AST-assert する。`INV-AUDIT-EMIT-SSOT-IMPORT-001`
 *    Test 8 と同 rigor。7 ステップ正規化ロジックは core 1 箇所にのみ存在する。
 *
 *    AST-assert that the queue jobId callsite and DB upsert callsites reference
 *    the same `normalizeUrlCore` (via wrappers); same rigor as
 *    `INV-AUDIT-EMIT-SSOT-IMPORT-001` Test 8. The 7-step logic lives in exactly
 *    one place (the core).
 *
 * ## Why a standing-rigor INV here / なぜ standing 同等の rigor か
 *
 * normalizer の二重定義は coupling drift を silent に許す: 将来一方だけが改修
 * されると queue dedup と DB dedup の「同一 URL」定義が乖離し、CWE-697 (Incorrect
 * Comparison) 系の latent surface を生む。**ただし 4-domain standing regression
 * 非対象** (単一テーブル UNIQUE の回帰保護であり cross-domain critical invariant
 * ではない) — 独立 unit scope (`tests/utils/`) に配置する。
 *
 * @module tests/utils/inv-url-normalize-ssot-001
 * @see  §5
 * @see apps/mcp-server/src/utils/url-normalizer.ts (SSOT: normalizeUrlCore)
 * @see apps/mcp-server/tests/regression/standing/gdpr-delete/inv-audit-emit-ssot-import-001.test.ts (AST-sweep exemplar)
 */

import path from "node:path";
import fs from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Project, SyntaxKind } from "ts-morph";
import type { CallExpression, SourceFile } from "ts-morph";
// C-M01-SHARED (CO-DID-02): shared recursive `*.ts` walk (no new inline copy).
import { collectTypeScriptSources } from "../regression/standing/schema-enum-sync/_extractors";
// queue 側 public export (validator module から)。
import { normalizeUrlForValidation } from "../../src/utils/url-validator";
// DB 側 public export (normalizer module から) + SSOT core。両 module の public
// export を取得し module 境界をまたいだ同一性を assert する。
import { normalizeUrlForStorage, normalizeUrlCore } from "../../src/utils/url-normalizer";
// storageFromNormalizerModule は normalizeUrlForStorage と同一 (single export)。
// cross-module identity assert 用の別名参照として保持。
const storageFromNormalizerModule = normalizeUrlForStorage;

// ============================================================================
// Corpus / コーパス
// ============================================================================

/**
 * success path edge cases (≥ 12 件)。各ケースは「normalize で実際に変形される」
 * 非 vacuous なものを含む (input !== output)。
 *
 * Success-path edge cases (≥ 12). Includes non-vacuous transforms (input !== output).
 */
const SUCCESS_CORPUS: ReadonlyArray<{ input: string; expected: string }> = [
  // root trailing-slash strip
  { input: "https://example.com/", expected: "https://example.com" },
  // path trailing-slash strip
  { input: "https://example.com/path/", expected: "https://example.com/path" },
  // deep path trailing-slash strip
  {
    input: "https://kokuyo.com/special/curiosity-is-life/",
    expected: "https://kokuyo.com/special/curiosity-is-life",
  },
  // mixed-case host lowercase
  { input: "https://Example.COM/Path", expected: "https://example.com/Path" },
  // default https port strip
  { input: "https://example.com:443/path", expected: "https://example.com/path" },
  // default http port strip
  { input: "http://example.com:80/path", expected: "http://example.com/path" },
  // non-default port preserved
  { input: "https://example.com:8443/path", expected: "https://example.com:8443/path" },
  // query-order sort
  { input: "https://example.com/p?b=2&a=1", expected: "https://example.com/p?a=1&b=2" },
  // fragment strip
  { input: "https://example.com/p#section", expected: "https://example.com/p" },
  // consecutive-slash collapse
  { input: "https://example.com/a//b///c", expected: "https://example.com/a/b/c" },
  // root path "/" → empty
  { input: "https://example.com", expected: "https://example.com" },
  // combined: mixed-case host + query sort + fragment + trailing slash
  {
    input: "https://Example.COM/p/?b=2&a=1#h",
    expected: "https://example.com/p?a=1&b=2",
  },
  // whitespace trim + normalize
  { input: "  https://Example.com/x/  ", expected: "https://example.com/x" },
];

/**
 * parse-failure inputs (≥ 3 件、`new URL(...)` が throw)。catch canonical =
 * `trimmed.toLowerCase()` ゆえ expected は trim + lowercase。
 *
 * Parse-failure inputs (≥ 3, `new URL(...)` throws). Catch canonical =
 * `trimmed.toLowerCase()`, so expected is trim + lowercase.
 */
const PARSE_FAILURE_CORPUS: ReadonlyArray<{ input: string; expected: string }> = [
  // not a URL at all
  { input: "not a url", expected: "not a url" },
  // protocol with no host (throws in WHATWG URL)
  { input: "HTTP://", expected: "http://" },
  // control char / space in authority making it unparseable, mixed-case
  { input: "HTTP://EXA MPLE.com", expected: "http://exa mple.com" },
];

// ============================================================================
// AST helpers (mirrors inv-audit-emit-ssot-import-001 exemplar)
// ============================================================================

const MCP_SERVER_ROOT = path.resolve(__dirname, "../..");
const SRC_ROOT = path.resolve(MCP_SERVER_ROOT, "src");
const URL_NORMALIZER_FILE = path.resolve(SRC_ROOT, "utils/url-normalizer.ts");
const URL_VALIDATOR_FILE = path.resolve(SRC_ROOT, "utils/url-validator.ts");
const PAGE_ANALYZE_QUEUE_FILE = path.resolve(SRC_ROOT, "queues/page-analyze-queue.ts");

/**
 * Documented exceptions to the src-wide `web_pages.url` create/upsert sweep
 * (CO-DID-03 / C-OBS2-SCOPE). A discovered callsite that does NOT reference
 * `normalizeUrlForStorage` in its file MUST be registered here, or the sweep
 * fails (forward-compat drift gate). Each entry pins WHY a callsite legitimately
 * bypasses the storage-normalization SSOT, so the bypass never becomes silent.
 *
 * **CO-DID-03 = Option B (documented exception, production code unchanged)**:
 * `web-page.service.ts` `findOrCreateByUrl` does a `find-by-raw-url` then a
 * `create({ data: { url } })` on the raw url. Routing it through
 * `normalizeUrlForStorage` (Option A) would normalize only the create side
 * while `findByUrl` stays raw → find-miss against existing rows → MORE duplicate
 * rows (it WORSENS the CWE-697 dedup degradation it would try to fix). Full
 * symmetrisation requires `findByUrl` normalization + an existing-row backfill
 * migration (a future ADR, breaking). Real-harm is currently 0 because of the
 * **data-layer dual defense**: the `web_pages_url_key` UNIQUE constraint
 * (Evidence-First anchor `019e8fcd`, production-operating) + `findOrCreateByUrl`
 * find-first idempotency. The SSRF entrypoint `validateExternalUrl` is not on
 * this path (no security surface).
 *
 * @see  §4 (Option B rationale)
 * @see  §2 / C-OBS2-SCOPE
 */
const DOCUMENTED_RAWCREATE_EXCEPTIONS: ReadonlyArray<{
  file: string;
  callsite: string;
  reason: string;
  trackedIssue: string;
}> = [
  {
    file: "src/services/web-page.service.ts",
    callsite: "findOrCreateByUrl prisma.webPage.create",
    reason:
      "data-layer 2-defense (web_pages_url_key UNIQUE + find-first idempotency); " +
      "Option A (normalizeUrlForStorage) deferred to a future ADR due to existing-row " +
      "normalization-set integrity risk (would require findByUrl symmetrisation + row backfill)",
    trackedIssue: "CO-DID-03",
  },
] as const;

function createAstProject(): Project {
  return new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { allowJs: false, strict: true },
  });
}

/**
 * The 7-step inline markers that MUST exist only inside the core. Used to
 * detect orphaned dead-code (a wrapper / validator that re-inlines the logic).
 */
const SEVEN_STEP_MARKERS: readonly RegExp[] = [
  /let\s+sortedQuery\s*=/, // step 5 query sort
  /replace\(\/\\\/\+\$\/,/, // step 7 trailing-slash strip (escaped: replace(/\/+$/,)
  /urlObj\.port\s*=\s*""/, // step 2 default-port strip
  /urlObj\.hash\s*=\s*""/, // step 3 fragment strip
] as const;

// ============================================================================
// src-wide AST discovery of web_pages.url create/upsert callsites
// (CO-DID-02 / C-M02-AST + C-M03-HELPER)
// ============================================================================

/**
 * A discovered `prisma.webPage.create` / `prisma.webPage.upsert` callsite that
 * writes (or can write) `web_pages.url`.
 */
interface WebPageUrlUpsertCallsite {
  /** repo-relative source path (e.g. `src/services/web-page.service.ts`). */
  readonly file: string;
  /** the create/upsert method name, for diagnostics. */
  readonly method: "create" | "upsert";
  /** the call expression head text (e.g. `prisma.webPage.create`). */
  readonly headText: string;
}

/**
 * Return the create/upsert method name if `callExpr`'s head is a
 * `<anything>.webPage.create` / `.upsert` member chain, else `null`.
 *
 * Narrows to **create/upsert only**: `update` / `updateMany` / `findUnique` etc.
 * never (re)write the immutable `url` key, so they are intentionally excluded.
 * Accepts any receiver chain (`prisma.`, `tx.`, `deps.prisma.`, …) by matching
 * the `.webPage.<method>` suffix.
 *
 * @returns `"create" | "upsert"` when matched, otherwise `null`
 */
function matchWebPageUrlMethod(callExpr: CallExpression): "create" | "upsert" | null {
  const head = callExpr.getExpression().getText();
  if (/\.webPage\.create$/.test(head)) return "create";
  if (/\.webPage\.upsert$/.test(head)) return "upsert";
  return null;
}

/**
 * Discover every `*.webPage.create` / `*.webPage.upsert` callsite in a single
 * SourceFile via AST CallExpression traversal (C-M02-AST). Pure function —
 * returns the discovered callsites; the test body owns all assertions
 * (C-M03-HELPER). Kept structurally simple (cyclomatic complexity ≤ 10) by
 * delegating the head-chain match to {@link matchWebPageUrlMethod}.
 *
 * @param sourceFile - ts-morph SourceFile to scan
 * @param relFile - repo-relative path used in the returned callsite records
 * @returns discovered create/upsert callsites for this file (may be empty)
 */
function discoverWebPageUrlUpsertCallsites(
  sourceFile: SourceFile,
  relFile: string
): WebPageUrlUpsertCallsite[] {
  const found: WebPageUrlUpsertCallsite[] = [];
  const calls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
  for (const call of calls) {
    const callExpr = call as CallExpression;
    const method = matchWebPageUrlMethod(callExpr);
    if (method === null) continue;
    found.push({ file: relFile, method, headText: callExpr.getExpression().getText() });
  }
  return found;
}

// ============================================================================
// Test Suite
// ============================================================================

describe("INV-URL-NORMALIZE-SSOT-001: normalizeUrlForValidation === normalizeUrlForStorage via shared normalizeUrlCore SSOT (PR-L3 CO-SAMEURL-01)", () => {
  // ==========================================================================
  // INV-URL-NORMALIZE-SSOT-001 — success path behavioural equivalence
  // ==========================================================================

  it("INV-URL-NORMALIZE-SSOT-001: success-path corpus — validation === storage for every URL (non-vacuous transforms)", () => {
    for (const { input, expected } of SUCCESS_CORPUS) {
      const viaValidation = normalizeUrlForValidation(input);
      const viaStorage = normalizeUrlForStorage(input);
      expect(viaValidation, `validation(${input})`).toBe(expected);
      expect(viaStorage, `storage(${input})`).toBe(expected);
      // SSOT equivalence: both callsites must agree byte-for-byte.
      expect(viaValidation, `validation === storage for ${input}`).toBe(viaStorage);
    }
  });

  it("INV-URL-NORMALIZE-SSOT-001: non-vacuity — corpus contains URLs actually transformed by normalization (input !== output)", () => {
    const transformed = SUCCESS_CORPUS.filter(({ input, expected }) => input.trim() !== expected);
    // Guard against a vacuous corpus where every case is input === output.
    expect(
      transformed.length,
      "success corpus MUST contain ≥3 URLs that are actually transformed by normalization"
    ).toBeGreaterThanOrEqual(3);
  });

  // ==========================================================================
  // INV-URL-NORMALIZE-SSOT-001 — parse-failure path equivalence (TDD Red→Green)
  //
  // Pre-integration: normalizeUrlForStorage("HTTP://") === "HTTP://" (trimmed,
  // no lowercase) but normalizeUrlForValidation("HTTP://") === "http://"
  // (trimmed + lowercase) → this assert was RED. After core unify (catch
  // canonical = trimmed.toLowerCase()), both === "http://" → GREEN.
  // ==========================================================================

  it("INV-URL-NORMALIZE-SSOT-001: parse-failure corpus — validation === storage (catch canonical = trimmed.toLowerCase(), TDD Red→Green guard)", () => {
    for (const { input, expected } of PARSE_FAILURE_CORPUS) {
      const viaValidation = normalizeUrlForValidation(input);
      const viaStorage = normalizeUrlForStorage(input);
      expect(viaValidation, `validation(${input})`).toBe(expected);
      // The Red→Green pin: before core unify, storage returned `trimmed`
      // (no lowercase) and diverged from validation on parse-failure input.
      expect(viaStorage, `storage(${input})`).toBe(expected);
      expect(viaValidation, `validation === storage on parse-failure for ${input}`).toBe(
        viaStorage
      );
    }
  });

  it("INV-URL-NORMALIZE-SSOT-001: cross-module identity — url-validator and url-normalizer export the same normalizeUrlForStorage semantic, both routing through normalizeUrlCore", () => {
    // normalizeUrlForStorage is re-exported by url-normalizer; the validation
    // wrapper and both storage wrappers must agree across the whole corpus.
    for (const { input } of [...SUCCESS_CORPUS, ...PARSE_FAILURE_CORPUS]) {
      const core = normalizeUrlCore(input);
      expect(normalizeUrlForValidation(input), `validation === core for ${input}`).toBe(core);
      expect(normalizeUrlForStorage(input), `storage === core for ${input}`).toBe(core);
      expect(
        storageFromNormalizerModule(input),
        `url-normalizer.normalizeUrlForStorage === core for ${input}`
      ).toBe(core);
    }
  });
});

describe("INV-WEBPAGE-URL-UNIQUE-002: web_pages.url UNIQUE (web_pages_url_key) regression protection (PR-L3 CO-SAMEURL-01)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("INV-WEBPAGE-URL-UNIQUE-002: two raw creates with the same normalized url — second is rejected with a UNIQUE violation (Prisma P2002 on constraint web_pages_url_key)", async () => {
    // The live DB enforces `web_pages_url_key` UNIQUE INDEX on the (normalized)
    // url column. Unit scope mocks Prisma, so we model the constraint with an
    // in-memory uniqueness ledger that throws a P2002-shaped error on a
    // duplicate normalized url — pinning the constraint semantic that the DB
    // is required to enforce. The normalized key is derived from the SSOT so a
    // future regression that desyncs storage normalization is caught here too.
    const seenUrls = new Set<string>();

    function rawCreate(rawUrl: string): { id: string; url: string } {
      const url = normalizeUrlForStorage(rawUrl);
      if (seenUrls.has(url)) {
        // Mirror Prisma's PrismaClientKnownRequestError P2002 shape.
        const err = new Error(`Unique constraint failed on the fields: (\`url\`)`) as Error & {
          code: string;
          meta: { target: string[] };
        };
        err.code = "P2002";
        err.meta = { target: ["web_pages_url_key"] };
        throw err;
      }
      seenUrls.add(url);
      return { id: `id-${seenUrls.size}`, url };
    }

    // Two raw URLs that normalize to the SAME canonical form (trailing slash
    // + mixed-case host) → DB UNIQUE must collapse them to one surviving row.
    const first = rawCreate("https://Example.com/dup/");
    expect(first.url).toBe("https://example.com/dup");

    expect(() => rawCreate("https://EXAMPLE.com/dup")).toThrowError(/Unique constraint failed/);

    // Exactly one surviving normalized url.
    expect(seenUrls.size).toBe(1);
  });

  it("INV-WEBPAGE-URL-UNIQUE-002: distinct normalized urls do NOT collide (uniqueness is normalized-url scoped, not raw-url scoped)", () => {
    const seenUrls = new Set<string>();
    const insert = (raw: string): void => {
      const url = normalizeUrlForStorage(raw);
      expect(seenUrls.has(url), `unexpected collision for ${raw}`).toBe(false);
      seenUrls.add(url);
    };

    insert("https://a.example.com/");
    insert("https://b.example.com/");
    insert("https://example.com/path-a");
    insert("https://example.com/path-b");
    expect(seenUrls.size).toBe(4);
  });
});

describe("INV-URL-NORMALIZE-SSOT-001: SSOT-import AST sweep — queue jobId + DB upsert callsites share normalizeUrlCore, 7-step logic in exactly one place (same rigor as INV-AUDIT-EMIT-SSOT-IMPORT-001 Test 8)", () => {
  let astProject: Project;

  beforeEach(() => {
    astProject = createAstProject();
  });

  // ==========================================================================
  // (a) The 7-step normalization body exists in EXACTLY ONE file: the core
  //     (url-normalizer.ts). No wrapper / validator re-inlines it (dead-code 0).
  // ==========================================================================

  it("INV-URL-NORMALIZE-SSOT-001: 7-step normalization markers appear ONLY in url-normalizer.ts core (orphaned dead-code 0)", () => {
    const coreText = fs.readFileSync(URL_NORMALIZER_FILE, "utf8");
    const validatorText = fs.readFileSync(URL_VALIDATOR_FILE, "utf8");

    for (const marker of SEVEN_STEP_MARKERS) {
      // marker must be present in the core
      expect(marker.test(coreText), `core MUST contain marker ${marker}`).toBe(true);
      // marker must be ABSENT from the validator (no re-inlined dead-code)
      expect(
        marker.test(validatorText),
        `url-validator.ts MUST NOT re-inline 7-step marker ${marker} (orphaned dead-code)`
      ).toBe(false);
    }
  });

  it("INV-URL-NORMALIZE-SSOT-001: normalizeUrlForStorage / normalizeUrlForValidation are thin wrappers delegating to normalizeUrlCore (no inline new URL parse in the wrappers)", () => {
    astProject.addSourceFileAtPath(URL_NORMALIZER_FILE);
    astProject.addSourceFileAtPath(URL_VALIDATOR_FILE);

    const normalizerSf = astProject.getSourceFileOrThrow(URL_NORMALIZER_FILE);
    const validatorSf = astProject.getSourceFileOrThrow(URL_VALIDATOR_FILE);

    // normalizeUrlForStorage body must call normalizeUrlCore.
    const storageFn = normalizerSf.getFunctionOrThrow("normalizeUrlForStorage");
    expect(storageFn.getBodyText() ?? "", "storage wrapper delegates to core").toMatch(
      /normalizeUrlCore\s*\(/
    );

    // normalizeUrlForValidation body must call normalizeUrlCore.
    const validationFn = validatorSf.getFunctionOrThrow("normalizeUrlForValidation");
    expect(validationFn.getBodyText() ?? "", "validation wrapper delegates to core").toMatch(
      /normalizeUrlCore\s*\(/
    );

    // The validation wrapper must NOT contain its own `new URL(` parse — only
    // validateExternalUrl owns an independent parse in this module.
    expect(
      validationFn.getBodyText() ?? "",
      "validation wrapper MUST NOT re-inline a `new URL(` parse"
    ).not.toMatch(/new\s+URL\s*\(/);
  });

  // ==========================================================================
  // (b) queue jobId callsite (buildUrlStableJobId) routes through
  //     normalizeUrlForValidation → normalizeUrlCore.
  // ==========================================================================

  it("INV-URL-NORMALIZE-SSOT-001: queue jobId callsite (buildUrlStableJobId) derives its uuidv5 namespace key from normalizeUrlForValidation (→ normalizeUrlCore SSOT)", () => {
    astProject.addSourceFileAtPath(PAGE_ANALYZE_QUEUE_FILE);
    const queueSf = astProject.getSourceFileOrThrow(PAGE_ANALYZE_QUEUE_FILE);
    const buildFn = queueSf.getFunctionOrThrow("buildUrlStableJobId");
    const body = buildFn.getBodyText() ?? "";
    expect(body, "buildUrlStableJobId MUST normalize via normalizeUrlForValidation").toMatch(
      /normalizeUrlForValidation\s*\(/
    );
    // It MUST NOT inline its own normalization (no bare `new URL(`).
    expect(body, "buildUrlStableJobId MUST NOT inline its own URL normalization").not.toMatch(
      /new\s+URL\s*\(/
    );
  });

  // ==========================================================================
  // (c) src-wide AST sweep (CO-DID-02): every `*.webPage.create` /
  //     `*.webPage.upsert` callsite in src/ either references
  //     normalizeUrlForStorage (→ core) and does NOT re-inline the 7-step
  //     logic, OR is registered in DOCUMENTED_RAWCREATE_EXCEPTIONS (CO-DID-03).
  //
  //     **Scope (C-OBS2-SCOPE)**: Prisma fluent API `create` / `upsert` only.
  //     `update` / `updateMany` never (re)write the immutable `url` key, so
  //     they are excluded. Raw-SQL paths (`$executeRaw*` / `createMany`) that
  //     write `web_pages.url` are NOT covered by this sweep — none currently
  //     exist (only `DELETE FROM web_pages` raw-SQL exists), so real-harm 0.
  //
  //     This replaces the prior 4-entry `KNOWN_DB_UPSERT_FILES` sanity-list,
  //     which silently omitted 2 url-writing upsert callsites
  //     (`tools/page/handlers/db-handler.ts`, `services/worker-supervisor-
  //     failure-path.service.ts`) — exactly the silent-drift surface CO-DID-02
  //     closes.
  // ==========================================================================

  it("INV-URL-NORMALIZE-SSOT-001: src-wide AST sweep — every webPage.create/upsert callsite references normalizeUrlForStorage OR is a documented exception (forward-compat drift gate)", () => {
    const srcFiles = collectTypeScriptSources(SRC_ROOT, { includeTests: false });

    type Discovered = { file: string; method: "create" | "upsert"; headText: string };
    const discovered: Discovered[] = [];

    for (const abs of srcFiles) {
      const rel = path.relative(MCP_SERVER_ROOT, abs);
      const sf = astProject.addSourceFileAtPath(abs);
      for (const c of discoverWebPageUrlUpsertCallsites(sf, rel)) {
        discovered.push({ file: c.file, method: c.method, headText: c.headText });
      }
    }

    // Non-vacuity: the sweep must not collapse to an empty set (a broken
    // discovery that returns nothing would otherwise be a false-green).
    expect(
      discovered.length,
      "src-wide AST sweep must discover ≥4 webPage.create/upsert callsites (non-empty coverage)"
    ).toBeGreaterThanOrEqual(4);

    const exceptionFiles = new Set(DOCUMENTED_RAWCREATE_EXCEPTIONS.map((e) => e.file));
    const violations: Array<{ file: string; reason: string }> = [];

    for (const callsite of discovered) {
      const abs = path.resolve(MCP_SERVER_ROOT, callsite.file);
      const text = fs.readFileSync(abs, "utf8");
      const referencesStorage = /normalizeUrlForStorage\s*\(/.test(text);
      const isException = exceptionFiles.has(callsite.file);

      if (!referencesStorage && !isException) {
        // A url-writing create/upsert that neither delegates to the storage
        // SSOT wrapper nor is registered as a documented exception → drift.
        violations.push({
          file: callsite.file,
          reason:
            `webPage.${callsite.method} callsite does not reference normalizeUrlForStorage ` +
            "and is NOT in DOCUMENTED_RAWCREATE_EXCEPTIONS (register it or route through the SSOT wrapper)",
        });
      }

      // Must NOT re-inline the distinctive 7-step markers (drift guard),
      // even for the documented-exception file.
      for (const marker of SEVEN_STEP_MARKERS) {
        if (marker.test(text)) {
          violations.push({
            file: callsite.file,
            reason: `re-inlines 7-step normalization marker ${marker} instead of delegating to the core`,
          });
        }
      }
    }

    if (violations.length > 0) {
      const formatted = violations.map((v) => `  - ${v.file}: ${v.reason}`).join("\n");
      expect.fail(
        `INV-URL-NORMALIZE-SSOT-001 src-wide sweep: ${violations.length} webPage url create/upsert drift(s):\n${formatted}`
      );
    }
    expect(violations).toEqual([]);

    // Every registered exception must actually be discovered by the sweep
    // (no stale exception entries that point at a non-existent callsite).
    const discoveredFiles = new Set(discovered.map((d) => d.file));
    for (const exc of DOCUMENTED_RAWCREATE_EXCEPTIONS) {
      expect(
        discoveredFiles.has(exc.file),
        `DOCUMENTED_RAWCREATE_EXCEPTIONS entry ${exc.file} must correspond to a discovered callsite (no stale exceptions)`
      ).toBe(true);
    }
  });

  // ==========================================================================
  // (c2) Over/under-match guard (C-M02-AST verification): the sweep discovers
  //      EXACTLY the expected set of url-writing create/upsert callsites — no
  //      false positives (e.g. webPage.update url-less) and no false negatives.
  //      The expected set is derived from ground-truth and pins the count so a
  //      future regression (new un-normalized callsite, or a discovery that
  //      silently drops one) is caught.
  // ==========================================================================

  it("INV-URL-NORMALIZE-SSOT-001: AST discovery matches EXACTLY the ground-truth webPage.create/upsert callsite set (over/under-match 0)", () => {
    const srcFiles = collectTypeScriptSources(SRC_ROOT, { includeTests: false });
    const discoveredFiles = new Set<string>();
    for (const abs of srcFiles) {
      const rel = path.relative(MCP_SERVER_ROOT, abs);
      const sf = astProject.addSourceFileAtPath(abs);
      for (const c of discoverWebPageUrlUpsertCallsites(sf, rel)) {
        discoveredFiles.add(c.file);
      }
    }

    // Ground-truth (IO-verified 2026-06-05): 7 files contain a
    // `webPage.create` / `webPage.upsert` writing `web_pages.url`. 6 route
    // through normalizeUrlForStorage; 1 (web-page.service.ts) is the
    // documented CO-DID-03 exception. NOTE: this is 7, not the Registry's
    // forecast of 5 — the plan's KNOWN_DB_UPSERT_FILES (4-file) under-counted
    // db-handler.ts + worker-supervisor-failure-path.service.ts, the very
    // omission CO-DID-02 closes (flagged to IO for V1 reconciliation).
    const EXPECTED_CALLSITE_FILES: readonly string[] = [
      "src/services/web-page.service.ts", // CO-DID-03 exception (create)
      "src/workers/phases/phase-0-ingest.ts",
      "src/workers/page-analyze-worker.ts",
      "src/tools/layout/ingest.tool.ts",
      "src/tools/layout/batch-ingest.tool.ts",
      "src/tools/page/handlers/db-handler.ts",
      "src/services/worker-supervisor-failure-path.service.ts",
    ];

    const expectedSet = new Set(EXPECTED_CALLSITE_FILES.map((f) => f.replace(/\//g, path.sep)));
    const normalizedDiscovered = new Set(
      Array.from(discoveredFiles).map((f) => f.replace(/\//g, path.sep))
    );

    const overMatch = Array.from(normalizedDiscovered).filter((f) => !expectedSet.has(f));
    const underMatch = Array.from(expectedSet).filter((f) => !normalizedDiscovered.has(f));

    expect(
      overMatch,
      `AST sweep over-matched (discovered callsites NOT in ground-truth): ${overMatch.join(", ")}`
    ).toEqual([]);
    expect(
      underMatch,
      `AST sweep under-matched (ground-truth callsites NOT discovered): ${underMatch.join(", ")}`
    ).toEqual([]);
    expect(normalizedDiscovered.size, "exactly 7 url-writing create/upsert callsite files").toBe(7);
  });

  // ==========================================================================
  // (d) Forward-compat: any src file that constructs a uuidv5 page-analyze
  //     jobId namespace key MUST route through normalizeUrlForValidation /
  //     normalizeUrlCore (not its own normalization).
  // ==========================================================================

  it("INV-URL-NORMALIZE-SSOT-001: url-validator.ts imports normalizeUrlCore from url-normalizer.ts (dependency direction url-validator → url-normalizer, no cycle)", () => {
    const validatorText = fs.readFileSync(URL_VALIDATOR_FILE, "utf8");
    expect(
      validatorText,
      "url-validator MUST import normalizeUrlCore from ./url-normalizer"
    ).toMatch(/import\s*\{[^}]*normalizeUrlCore[^}]*\}\s*from\s*["']\.\/url-normalizer["']/);
    // No reverse import (url-normalizer must NOT import from url-validator) →
    // structurally prevents the dependency cycle.
    const coreText = fs.readFileSync(URL_NORMALIZER_FILE, "utf8");
    expect(
      coreText,
      "url-normalizer MUST NOT import from url-validator (would create a dependency cycle)"
    ).not.toMatch(/from\s*["']\.\/url-validator["']/);
  });

  it("INV-URL-NORMALIZE-SSOT-001: AST sanity — discovered emit shape is non-empty (buildUrlStableJobId call to uuidv5 found)", () => {
    astProject.addSourceFileAtPath(PAGE_ANALYZE_QUEUE_FILE);
    const queueSf: SourceFile = astProject.getSourceFileOrThrow(PAGE_ANALYZE_QUEUE_FILE);
    const calls = queueSf.getDescendantsOfKind(SyntaxKind.CallExpression);
    const uuidv5Calls = calls.filter((c) =>
      /^uuidv5\b/.test((c as CallExpression).getExpression().getText())
    );
    expect(
      uuidv5Calls.length,
      "page-analyze-queue MUST contain ≥1 uuidv5(...) call"
    ).toBeGreaterThan(0);
  });
});
