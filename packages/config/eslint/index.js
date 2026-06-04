// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import vitestPlugin from "@vitest/eslint-plugin";
import globals from "globals";

/** @type {import('eslint').Linter.Config[]} */
export const baseConfig = [
  js.configs.recommended,
  // TypeScript (.ts) files - server-side / Node.js
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
        // DOM types used in server-side code (e.g., linkedom, jsdom)
        Element: "readonly",
        Document: "readonly",
        Node: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": "warn",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-undef": "off",
      // FIND-WAVE4-TPA-V4-H-01 canonical fix (TPA V4 BLOCK Phase 4 commit gate unblock):
      // Base ESLint `no-redeclare` flags legitimate TypeScript function overload signatures
      // as duplicates (e.g. `truncateAuditTargetId` in audit-log.service.ts:211-213,
      // Wave 5 LCC canonical CWE-209 non-null guarantee pattern). The TypeScript-aware
      // replacement `@typescript-eslint/no-redeclare` correctly understands overload
      // signatures and only flags actual redeclarations. Monorepo-wide application
      // (Option 1 per TPA V4 recommendation) — see TPA V4 BLOCK anchor 019e1913-23b9.
      //
      // FIND-WAVE4-TPA-V4-H-01 canonical fix (TPA V4 BLOCK Phase 4 commit gate unblock):
      // ベース ESLint の `no-redeclare` は TypeScript の正当な関数オーバーロード署名
      // (例: audit-log.service.ts:211-213 の `truncateAuditTargetId`, Wave 5 LCC canonical
      // CWE-209 非 null 保証パターン) を重複として誤検出する。TypeScript 対応版の
      // `@typescript-eslint/no-redeclare` は overload signature を正しく理解し、実際の
      // 再宣言のみを検出する。Monorepo 全体適用 (TPA V4 推奨 Option 1)。
      "no-redeclare": "off",
      "@typescript-eslint/no-redeclare": "error",
      // PR-D-6 Phase 2 IO spot decision 019db5a5-b84d-71cd-a198-95f9c8c1cbb7 (Option A):
      // Base rule `off` silences pre-existing 541 src + 22 scripts violations deferred to
      // Q3-2026 monorepo-wide rollout backlog (FIND-TDA-07 successor issue). Scope-limited
      // `error` enforcement for PR-D-6 3 files is applied via the dedicated override below.
      //
      // PR-D-6 フェーズ 2 の IO spot decision 019db5a5 (Option A) により、ベースルールは
      // `off` とし既存 541 src + 22 scripts 違反を Q3-2026 monorepo 全面 rollout backlog に
      // 繰越 (FIND-TDA-07 successor issue)。PR-D-6 の 3 ファイルには下記 override で
      // `error` 強制を適用する。
      complexity: "off",
    },
  },
  // React/TSX files - client-side / browser
  {
    files: ["**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.es2022,
        // React globals
        React: "readonly",
        JSX: "readonly",
        // DOM element types for forwardRef
        HTMLElement: "readonly",
        HTMLButtonElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLDivElement: "readonly",
        SVGSVGElement: "readonly",
        // Node.js globals for Next.js (process.env)
        process: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": "warn",
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-undef": "off",
      // FIND-WAVE4-TPA-V4-H-01 canonical fix — see `.ts` block comment for rationale.
      // Defensive: TypeScript overload signatures may also appear in `.tsx` files.
      // FIND-WAVE4-TPA-V4-H-01 canonical fix — `.ts` ブロックのコメント参照。
      // 防御的措置: TS overload signature は `.tsx` ファイルにも出現する可能性あり。
      "no-redeclare": "off",
      "@typescript-eslint/no-redeclare": "error",
    },
  },
  // Test files (.test.ts, .test.tsx, .spec.ts, .spec.tsx)
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/tests/**/*.ts",
      "**/tests/**/*.tsx",
    ],
    languageOptions: {
      globals: {
        // Vitest globals
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        vi: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        // Browser globals for E2E tests
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        CSSFontFaceRule: "readonly",
        PerformanceObserver: "readonly",
        // DOM element types for E2E tests (Playwright)
        HTMLElement: "readonly",
        HTMLButtonElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLDivElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLSelectElement: "readonly",
        Element: "readonly",
        Node: "readonly",
        // MediaQueryList events for hook testing
        MediaQueryListEvent: "readonly",
        // ResizeObserver for virtualization tests
        ResizeObserver: "readonly",
        ResizeObserverEntry: "readonly",
        // Node.js globals for mocking fetch, etc.
        global: "readonly",
        process: "readonly",
        console: "readonly",
      },
    },
    rules: {
      // Relax rules for test files
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "warn", // Allow any in test mocks
      "no-console": "off",
    },
  },
  // React hooks (.ts files in hooks/ directory) - browser context
  {
    files: ["**/hooks/**/*.ts", "**/hooks/use-*.ts"],
    languageOptions: {
      globals: {
        // Browser globals for React hooks
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        // DOM element types
        HTMLElement: "readonly",
        HTMLDivElement: "readonly",
        // Observers
        ResizeObserver: "readonly",
        ResizeObserverEntry: "readonly",
        IntersectionObserver: "readonly",
        MutationObserver: "readonly",
        // Media queries
        MediaQueryList: "readonly",
        MediaQueryListEvent: "readonly",
        // Animation
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
      },
    },
  },
  // Debug scripts (e.g., Playwright debugging) - browser context in page.evaluate()
  {
    files: ["**/debug-*.ts", "**/debug-*.tsx"],
    languageOptions: {
      globals: {
        // Browser globals for page.evaluate() callbacks
        document: "readonly",
        window: "readonly",
        navigator: "readonly",
        Element: "readonly",
        HTMLElement: "readonly",
        NodeList: "readonly",
      },
    },
    rules: {
      // Relax rules for debug scripts
      "no-console": "off",
      "@typescript-eslint/explicit-function-return-type": "off",
    },
  },
  // ADR-0016 § ESLint Rule Strategy (TDA-Plan-11/12):
  // Scope-limited application of @vitest/eslint-plugin to standing regression suite only.
  // 既存 26 ファイル × 74 occurrence の `.skip` / `.only` には影響しない (scope 限定)。
  // backlog 2026-Q4 で triage + global 適用を再検討。
  //
  // Limited to `tests/regression/standing/**/*.test.ts` to avoid regressing
  // existing 26 files × 74 occurrences of `.skip` / `.only`. backlog 2026-Q4
  // will revisit triage + global rollout.
  {
    files: ["**/tests/regression/standing/**/*.test.ts"],
    plugins: {
      vitest: vitestPlugin,
    },
    rules: {
      "vitest/no-disabled-tests": "error",
      "vitest/no-focused-tests": "error",
    },
  },
  // PR-D-6 Phase 2 IO spot decision 019db5a5-b84d-71cd-a198-95f9c8c1cbb7 (Option A):
  // Scope-limited `complexity: ["error", 10]` enforcement for PR-D-6 RC-A BullMQ jobId
  // collision guard files. Protects Plan v1.2 §8.1 CI-failing DoD binding (dispatcher
  // + 5 sub-handler + new helpers CC ≤ 10) while leaving the 563 pre-existing monorepo
  // violations under the base `complexity: "off"` until Q3-2026 successor issue refactor.
  // Pre-existing CC=15/21 functions in `embedding-backfill-queue.ts` /
  // `page-analyze-queue.ts` use inline `// eslint-disable-next-line complexity` with
  // a FIND-TDA-07 Q3-2026 rationale comment (scope: existing helpers only; all new
  // PR-D-6 functions stay under CC ≤ 10 without disables).
  //
  // PR-D-6 フェーズ 2 の IO spot decision 019db5a5 (Option A) により、RC-A BullMQ
  // jobId collision guard の 3 ファイルに限定して `complexity: ["error", 10]` を
  // `error` 強制する。Plan v1.2 §8.1 の CI-failing DoD (dispatcher + 5 sub-handler +
  // new helpers CC ≤ 10) を保護しつつ、既存の 563 monorepo 違反は base rule `off`
  // のまま Q3-2026 successor issue で解消する。`embedding-backfill-queue.ts` /
  // `page-analyze-queue.ts` の CC=15/21 の既存関数は inline `// eslint-disable-next-line
  // complexity` + FIND-TDA-07 Q3-2026 rationale でスコープ外化する (新規 PR-D-6 関数
  // はすべて CC ≤ 10 を満たし disable 不要)。
  {
    files: [
      "apps/mcp-server/src/queues/enqueue-with-collision-guard.ts",
      "apps/mcp-server/src/queues/embedding-backfill-queue.ts",
      "apps/mcp-server/src/queues/page-analyze-queue.ts",
    ],
    rules: {
      complexity: ["error", 10],
    },
  },
  // PR-D-8 Phase 2 (TDA-V11-02 M resolution):
  // Scope-limited `complexity: ["error", 10]` enforcement for WorkerSupervisor
  // + IPC boundary + spawn helper per Plan v1.1 §3.2.5 + Finding Registry v2
  // §10 #9. Each method in WorkerSupervisor (handleChildExit, executeSelfChainedRespawn,
  // verifyIpcSpoofing, etc.) must stay ≤ CC 10 to keep the supervisor
  // maintainable as it gains per-WorkerType branches.
  //
  // PR-D-8 Phase 2 (TDA-V11-02): WorkerSupervisor と IPC 境界の cyclomatic
  // complexity を ≤ 10 に強制。
  {
    files: [
      "apps/mcp-server/src/services/worker-supervisor.service.ts",
      "apps/mcp-server/src/services/worker-active-lock.service.ts",
      "apps/mcp-server/src/schemas/worker-ipc.schema.ts",
      "apps/mcp-server/src/types/worker-type.ts",
      "apps/mcp-server/scripts/_worker-spawn-helper.ts",
    ],
    rules: {
      complexity: ["error", 10],
    },
  },
  // PR-D-8 Phase 2 (TDA-V11-02 M, class LoC ceiling):
  // worker-supervisor.service.ts class size guard. Plan v1.1 §7 R8 NEW
  // forecasts ~1100 LoC after multi-type extension (was 982 LoC pre-PR-D-8).
  // Empirical Phase 2 landing yielded ~1350 LoC (per-type config + Map +
  // dispatch handlers + boot-token sanitization + audit emit). Set `error`
  // at 1500 LoC for hard ceiling. Future refactor (TDA-V11-02 sub-method
  // extraction) brings it down toward the §7 R8 ~1100 forecast.
  //
  // PR-D-8 Phase 2 (TDA-V11-02 class LoC): supervisor 1500 LoC error 上限。
  // 実装後 ~1350 LoC 観測、後続 refactor で §7 R8 forecast (~1100) を目指す。
  {
    files: ["apps/mcp-server/src/services/worker-supervisor.service.ts"],
    rules: {
      "max-lines": ["error", { max: 1500, skipBlankLines: false, skipComments: false }],
    },
  },
  // Plan v4.5 PR3 IO Impl Decision V0 Unblock U-3 (FIND-IMPL-TDA-PR3-CC M):
  // Scope-limited `complexity: ["error", 10]` machine-enforcement for the two
  // PR3 Track 2 fork-mode + per-job-lock files. Closes the gap where neither
  // `runForkOrFallback` (refactored 13 → 5) nor the worker-supervisor lifecycle
  // exit handler were complexity-gated, making `pnpm lint` exit 0 misleading.
  // Follows the existing scope-limited pattern (PR-D-6 / PR-D-8 blocks above):
  // the base rule stays `complexity: "off"` for the 563 pre-existing monorepo
  // violations deferred to the Q3-2026 successor issue. Two pre-existing
  // CC>10 functions in these files (`resolveAndPersistBboxes` CC=17,
  // `handleWorkerExit` CC=11) are NOT in PR3 scope and carry inline
  // `// eslint-disable-next-line complexity` + a Plan v4.6 tracked-issue
  // rationale (FIND-IMPL-TDA-PR3-CC-CARRYOVER, deadline 2026-05-22).
  //
  // Plan v4.5 PR3 IO Impl Decision V0 Unblock U-3 (FIND-IMPL-TDA-PR3-CC M):
  // PR3 Track 2 の fork-mode + per-job-lock 2 ファイルに限定して
  // `complexity: ["error", 10]` を machine-enforce する。`runForkOrFallback`
  // (13 → 5 に refactor) と lifecycle exit handler が complexity gate されず
  // `pnpm lint` exit 0 が誤誘導していた gap を closure。base rule は既存 563
  // 違反のため `off` のまま (Q3-2026 successor issue 繰越)。本ファイル内の
  // pre-existing CC>10 2 件は PR3 scope 外で inline disable + Plan v4.6
  // tracked-issue (FIND-IMPL-TDA-PR3-CC-CARRYOVER, deadline 2026-05-22)。
  {
    files: [
      "apps/mcp-server/src/queues/embedding-backfill-processors.ts",
      "apps/mcp-server/src/services/worker-supervisor-lifecycle.service.ts",
    ],
    rules: {
      complexity: ["error", 10],
    },
  },
  // PR-1 GPU-COORD IO Plan Decision V1 (anchor 019e562d) FIND-PLAN-H-03 (TDA-H-01):
  // Scope-limited `complexity: ["error", 10]` machine-enforcement for the Phase 5
  // fork-child VRAM probe (GPU-COORD). `phase-5-embedding.ts` is NOT added here
  // (it carries pre-existing CC>10 functions under the base `complexity: "off"`,
  // Q3-2026 successor issue); instead the new GPU branches are extracted into the
  // dedicated leaf helper `phase-5-gpu-probe.ts` (all functions CC ≤ 10), and the
  // leaf threshold module `vram-thresholds.ts` is pure constants. This makes
  // `pnpm lint` exit 0 a real complexity guarantee for the new GPU-COORD code path
  // (closes the misleading-exit-0 gap per FIND-PLAN-H-03). Follows the existing
  // scope-limited pattern (PR-D-6 / PR-D-8 / Plan v4.5 PR3 blocks above).
  //
  // PR-1 GPU-COORD FIND-PLAN-H-03: GPU-COORD の新規分岐を leaf helper
  // `phase-5-gpu-probe.ts` に抽出し `complexity: ["error", 10]` を machine-enforce。
  {
    files: [
      "apps/mcp-server/src/workers/phases/phase-5-gpu-probe.ts",
      "apps/mcp-server/src/services/vision/vram-thresholds.ts",
    ],
    rules: {
      complexity: ["error", 10],
    },
  },
  // PR-BT-4 (ADR-0018 Amendment 10 Decision 10.1 + 10.4, U3): scope-limited
  // `complexity: ["error", 10]` machine-enforcement for the H-1 analysis-status
  // guard pure decision leaf helper. `embedding-backfill-worker.ts` is NOT added
  // here (it carries pre-existing CC>10 functions under the base
  // `complexity: "off"`, Q3-2026 successor issue); instead the new guard *decision*
  // branches are extracted into the dedicated leaf helper `backfill-analysis-guard.ts`
  // (all functions CC ≤ 10), so `pnpm lint` exit 0 is a real complexity guarantee
  // for the new H-1 code path. Follows the existing scope-limited pattern
  // (PR-D-6 / PR-D-8 / Plan v4.5 PR3 / GPU-COORD blocks above).
  {
    files: ["apps/mcp-server/src/workers/phases/backfill-analysis-guard.ts"],
    rules: {
      complexity: ["error", 10],
    },
  },
  // PR-BT-5 (M-1-RSS, ADR-0039 Decision 1, unblock #9 / TDA-M-02): scope-limited
  // `complexity: ["error", 10]` machine-enforcement for the per-sub-phase fork
  // dispatch *decision* leaf. `phase-5-fork-orchestrator.ts` is NOT added here
  // (it retains the dispatch loop orchestration under the base `complexity:
  // "off"`); instead the dispatch *decision* branches (descriptor builders +
  // skip predicates) are extracted into the dedicated leaf
  // `phase-5-subphase-dispatch.ts` (all functions CC ≤ 10), so `pnpm lint`
  // exit 0 is a real complexity guarantee for the new dispatch decision path.
  // Follows the existing scope-limited pattern (PR-D-6 / PR-D-8 / Plan v4.5 PR3
  // / GPU-COORD / PR-BT-4 blocks above).
  {
    files: ["apps/mcp-server/src/workers/phases/phase-5-subphase-dispatch.ts"],
    rules: {
      complexity: ["error", 10],
    },
  },
  // PR-BT-5 chunk-fork contingency (ADR-0039 §Consequences #2a): scope-limited
  // `complexity: ["error", 10]` machine-enforcement for the shared chunked
  // text-embedding loop driver. `phase-5-embedding.ts` is NOT added here (it
  // carries pre-existing CC>10 functions under the base `complexity: "off"`,
  // Q3-2026 successor issue); instead the canonical chunk loop (C1 per-chunk RSS
  // budget break + adaptive halving + chunk-boundary dispose) is extracted into
  // the dedicated leaf `phase-5-chunked-text-loop.ts` (all functions CC ≤ 10),
  // so `pnpm lint` exit 0 is a real complexity guarantee for the new chunk-fork
  // contingency code path. Follows the existing scope-limited pattern (PR-D-6 /
  // PR-D-8 / Plan v4.5 PR3 / GPU-COORD / PR-BT-4 / PR-BT-5 dispatch blocks above).
  {
    files: ["apps/mcp-server/src/workers/phases/phase-5-chunked-text-loop.ts"],
    rules: {
      complexity: ["error", 10],
    },
  },
  // PR-C3 (系統B, CPU true-10/10 plan V1.1 §3.3 / §3.4 TDA-RE-M-01): scope-limited
  // `complexity: ["error", 10]` for the parent-RSS trim + ceiling-fallback leaf.
  // `page-analyze-worker.ts` (3470 LoC, base `complexity: "off"`, pre-existing
  // CC>10 group, Q3-2026 successor issue) is NOT added here; the new trim/recompute/
  // fallback decision logic is extracted into the dedicated leaf
  // `phase5-parent-rss-trim.ts` (pure fn, CC ≤ 10), so `pnpm lint` exit 0 is a real
  // complexity guarantee for the new code path. Follows the canonical leaf-extraction
  // pattern (PR-D-6 / PR-D-8 / Plan v4.5 PR3 / GPU-COORD / PR-BT-4 / PR-BT-5 / chunked-text-loop above).
  {
    files: ["apps/mcp-server/src/workers/phases/phase5-parent-rss-trim.ts"],
    rules: {
      complexity: ["error", 10],
    },
  },
  // PR-C2 (Layer 2, CPU true 10/10 plan V1.1 §3.4, TDA-RE-M-01): scope-limited
  // `complexity: ["error", 10]` machine-enforcement for the backfill enqueue ↔
  // markComplete ordering relocation leaf. `page-analyze-worker.ts` is NOT added
  // here (it is 3470 LoC carrying ~563 pre-existing CC>10 functions under the
  // base `complexity: "off"`, Q3-2026 successor issue); instead the ordering
  // orchestration is extracted into the dedicated leaf
  // `backfill-enqueue-relocation.ts` (all functions CC ≤ 10), so `pnpm lint`
  // exit 0 is a real complexity guarantee for the new ordering code path (closes
  // the misleading-exit-0 gap per FIND-IO-V0-M-06). Follows the existing
  // scope-limited pattern (PR-D-6 / PR-D-8 / Plan v4.5 PR3 / GPU-COORD / PR-BT-4
  // / PR-BT-5 / phase-5-chunked-text-loop.ts blocks above).
  {
    files: ["apps/mcp-server/src/workers/phases/backfill-enqueue-relocation.ts"],
    rules: {
      complexity: ["error", 10],
    },
  },
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/generated/**",
    ],
  },
];

export default baseConfig;
