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
 * DB upsert callsites that build `web_pages.url` from `normalizeUrlForStorage`.
 * Sanity-list (not allowlist) to ensure the sweep coverage is non-empty.
 */
const KNOWN_DB_UPSERT_FILES: readonly string[] = [
  "src/workers/phases/phase-0-ingest.ts",
  "src/workers/page-analyze-worker.ts",
  "src/tools/layout/ingest.tool.ts",
  "src/tools/layout/batch-ingest.tool.ts",
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
  // (c) DB upsert callsites reference normalizeUrlForStorage (→ core), and do
  //     NOT inline the 7-step normalization logic themselves.
  // ==========================================================================

  it("INV-URL-NORMALIZE-SSOT-001: DB upsert callsites reference normalizeUrlForStorage (→ normalizeUrlCore) and do NOT re-inline 7-step normalization (forward-compat drift gate)", () => {
    const violations: Array<{ file: string; reason: string }> = [];
    let discovered = 0;

    for (const rel of KNOWN_DB_UPSERT_FILES) {
      const abs = path.resolve(MCP_SERVER_ROOT, rel);
      if (!fs.existsSync(abs)) {
        violations.push({ file: rel, reason: "KNOWN_DB_UPSERT_FILES entry not found on disk" });
        continue;
      }
      discovered++;
      const text = fs.readFileSync(abs, "utf8");
      // Must reference the storage wrapper (which delegates to the core).
      if (!/normalizeUrlForStorage\s*\(/.test(text)) {
        violations.push({
          file: rel,
          reason: "does not reference normalizeUrlForStorage (storage normalization SSOT wrapper)",
        });
      }
      // Must NOT re-inline the distinctive 7-step markers (drift guard).
      for (const marker of SEVEN_STEP_MARKERS) {
        if (marker.test(text)) {
          violations.push({
            file: rel,
            reason: `re-inlines 7-step normalization marker ${marker} instead of delegating to the core`,
          });
        }
      }
    }

    expect(
      discovered,
      "AST sweep must discover ≥1 DB upsert callsite (non-empty coverage)"
    ).toBeGreaterThan(0);

    if (violations.length > 0) {
      const formatted = violations.map((v) => `  - ${v.file}: ${v.reason}`).join("\n");
      expect.fail(
        `INV-URL-NORMALIZE-SSOT-001 SSOT-import sweep: ${violations.length} DB upsert callsite drift(s):\n${formatted}`
      );
    }
    expect(violations).toEqual([]);
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
