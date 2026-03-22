// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    maxWorkers: 3, // メモリ枯渇防止: 各ワーカー約3.5GB消費
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.d.ts",
        "src/**/index.ts",
        "src/**/*.test.ts",
        "src/**/types.ts",
        "src/**/*-types.ts",
        "src/**/*.types.ts",
        // Worker thread scripts are executed inside node:worker_threads
        // and cannot be instrumented by v8 coverage in the test process.
        // They are tested via mocked parentPort and integration tests
        // through their respective service.ts files.
        "src/**/worker-thread.ts",
        "node_modules/",
        "dist/",
      ],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 80,
      },
    },
    testTimeout: 30000, // 30s for ML model loading tests
  },
});
