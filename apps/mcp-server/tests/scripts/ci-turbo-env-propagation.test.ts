// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CO-R2-61 (1) — CI が注入する test 用 env が turbo の `test:unit` task に届くことの guard
 * Guard: test env vars injected by CI must reach the turbo `test:unit` task (CO-R2-61 (1)).
 *
 * 欠陥 / Defect: ci.yml は workflow-level env で `REDOS_TEST_THROUGHPUT_CHARS_PER_MS=80`
 * を注入していた (ADR-0020 Decision 5) が、`pnpm test:unit` は `turbo run test:unit`
 * (turbo 2.x、既定 env mode = strict) で実行され、turbo.json で宣言されていない env は
 * task に渡らない。結果 ReDoS test は既定値 100 で評価され、閾値は 50025 文字に対し
 * 825.3ms ではなく 700.25ms になっていた (main run 37331847837 の失敗)。
 * ci.yml injects `REDOS_TEST_THROUGHPUT_CHARS_PER_MS=80` at workflow level, but
 * `pnpm test:unit` runs `turbo run test:unit` (turbo 2.x, strict env mode by default),
 * which drops env vars not declared in turbo.json. The ReDoS test therefore used
 * the default 100, i.e. a 700.25 ms budget instead of 825.3 ms for 50025 chars.
 *
 * 3 legs:
 * 1. 静的 / static: `turbo.json` の `test:unit.env` が必須 env を宣言している。
 * 2. sweep: ci.yml の workflow-level env は全て「test:unit へ伝播」か「伝播不要 (理由付き)」
 *    に分類済。新しい env の追加で未分類が生じたら RED。
 * 3. runtime: CI (`CI=true`) で実行中は、必須 env が ci.yml と同じ値で test process に
 *    届いている。欠落時は RED (strict mode で落ちた状態の検出)。
 *
 * Regression domain: none (CI tooling)。`.skip` / retry / 閾値緩和なし。
 *
 * @module tests/scripts/ci-turbo-env-propagation.test
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** test:unit に届く必要がある CI 注入 env / CI-injected env the test:unit task must receive */
const REQUIRED_TEST_UNIT_ENV = ["REDOS_TEST_THROUGHPUT_CHARS_PER_MS"] as const;

/**
 * test:unit へ伝播させない workflow-level env と、その理由。
 * Workflow-level env vars intentionally not propagated to test:unit, with reasons.
 */
const NOT_PROPAGATED_TO_TEST_UNIT: Readonly<Record<string, string>> = {
  NODE_VERSION: "consumed only by `${{ env.NODE_VERSION }}` in actions/setup-node",
  CI: "passed through by turbo itself (verified by the runtime leg below)",
  ONNXRUNTIME_NODE_INSTALL_CUDA: "consumed by `pnpm install` postinstall, not by turbo tasks",
  REFTRIX_RESPECT_ROBOTS_TXT:
    "not propagated today (strict mode drops it and unit tests pass without it); " +
    "propagating it changes unit-test behaviour and is out of scope for CO-R2-61 (1)",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 必須 env のうち、未定義または空文字のものを返す。
 * Returns the required env names that are undefined or empty.
 */
function findMissingEnv(
  env: Readonly<Record<string, string | undefined>>,
  required: readonly string[]
): string[] {
  return required.filter((name) => (env[name] ?? "") === "");
}

function readWorkflowEnv(): Record<string, string> {
  const raw: unknown = load(
    fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf-8")
  );
  if (!isRecord(raw) || !isRecord(raw.env)) throw new Error("ci.yml: workflow env missing");
  return Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)]));
}

/**
 * ReDoS test file を実行する turbo task (CI は test:unit、local は test / test:coverage)。
 * Turbo tasks that run the ReDoS test file (CI uses test:unit; local uses test / test:coverage).
 */
const TURBO_TEST_TASKS = ["test", "test:unit", "test:coverage"] as const;

function readTaskEnv(taskName: string): string[] {
  const raw: unknown = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "turbo.json"), "utf-8"));
  if (!isRecord(raw) || !isRecord(raw.tasks)) throw new Error("turbo.json: tasks missing");
  const task = raw.tasks[taskName];
  if (!isRecord(task)) throw new Error(`turbo.json: ${taskName} task missing`);
  return Array.isArray(task.env) ? task.env.filter((v): v is string => typeof v === "string") : [];
}

describe("CI test env propagation through turbo (CO-R2-61 (1))", () => {
  describe("findMissingEnv", () => {
    it("reports a required env var that is absent", () => {
      expect(findMissingEnv({ CI: "true" }, REQUIRED_TEST_UNIT_ENV)).toEqual([
        "REDOS_TEST_THROUGHPUT_CHARS_PER_MS",
      ]);
    });

    it("reports a required env var that is empty", () => {
      expect(
        findMissingEnv({ REDOS_TEST_THROUGHPUT_CHARS_PER_MS: "" }, REQUIRED_TEST_UNIT_ENV)
      ).toEqual(["REDOS_TEST_THROUGHPUT_CHARS_PER_MS"]);
    });

    it("reports nothing when every required env var is set", () => {
      expect(
        findMissingEnv({ REDOS_TEST_THROUGHPUT_CHARS_PER_MS: "80" }, REQUIRED_TEST_UNIT_ENV)
      ).toEqual([]);
    });
  });

  it("ci.yml injects every required env var at workflow level", () => {
    expect(findMissingEnv(readWorkflowEnv(), REQUIRED_TEST_UNIT_ENV)).toEqual([]);
  });

  it.each(TURBO_TEST_TASKS)("turbo.json declares every required env var on the %s task", (task) => {
    const declared = readTaskEnv(task);
    expect(REQUIRED_TEST_UNIT_ENV.filter((name) => !declared.includes(name))).toEqual([]);
  });

  // IO-PR0C-02: the mcp-server DB suites (page-analyze.e2e, visual-features-search.e2e,
  // report-template.integration) run under `test`; strict env mode dropped DATABASE_URL and
  // they failed authentication when the full run went through turbo
  it.each(["test", "test:coverage"])("turbo.json passes DATABASE_URL to the %s task", (task) => {
    expect(readTaskEnv(task)).toContain("DATABASE_URL");
  });

  it("every ci.yml workflow-level env var is classified (propagated or reasoned exclusion)", () => {
    const required: readonly string[] = REQUIRED_TEST_UNIT_ENV;
    const unclassified = Object.keys(readWorkflowEnv()).filter(
      (name) => !required.includes(name) && !(name in NOT_PROPAGATED_TO_TEST_UNIT)
    );
    expect(unclassified).toEqual([]);
  });

  it("under CI, the required env vars reach this test process with the ci.yml values", () => {
    // Local runs get no CI injection, so only CI runs (CI=true) are checked here.
    // Under CI a missing value means turbo dropped it (strict env mode) -> RED.
    const underCi = process.env.CI === "true";
    const missing = underCi ? findMissingEnv(process.env, REQUIRED_TEST_UNIT_ENV) : [];
    expect(missing).toEqual([]);
    if (underCi) {
      const workflowEnv = readWorkflowEnv();
      for (const name of REQUIRED_TEST_UNIT_ENV) {
        expect(process.env[name]).toBe(workflowEnv[name]);
      }
    }
  });
});
