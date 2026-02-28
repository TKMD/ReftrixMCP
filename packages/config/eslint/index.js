// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
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
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-undef": "off",
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
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-undef": "off",
    },
  },
  // Test files (.test.ts, .test.tsx, .spec.ts, .spec.tsx)
  {
    files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "**/tests/**/*.ts", "**/tests/**/*.tsx"],
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
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/.turbo/**",
    ],
  },
];

export default baseConfig;
