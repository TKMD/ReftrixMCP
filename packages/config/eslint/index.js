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
