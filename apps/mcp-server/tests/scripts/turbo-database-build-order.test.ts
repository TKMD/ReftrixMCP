// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * database パッケージの build と、同じパッケージで生成済み Prisma client を読む task の並走を防ぐ guard
 * Guard: tasks in the database package that read the generated Prisma client must not run
 * in parallel with that package's own build.
 *
 * 欠陥 / Defect: OSS 版の `@reftrixmcp/database` の build は
 * `rm -rf src/generated dist && prisma generate && tsc && ...` で生成物を一度消す
 * (scripts/prepare-oss.sh `transform_database_for_publish`)。turbo の `typecheck` / `test`
 * は `^build`（依存先の build）しか待たないため、`pnpm typecheck` の中で
 * `database#build` と `database#typecheck` が同時に走り、typecheck が消えた
 * `src/generated/prisma/index.d.ts` を読んで TS6053 で落ちた（OSS CI run 41856375963 attempt 1）。
 * The OSS build of `@reftrixmcp/database` deletes the generated client first. turbo's
 * `typecheck` / `test` wait only for `^build`, so `database#build` and `database#typecheck`
 * ran in parallel inside `pnpm typecheck`, and typecheck failed with TS6053 on the deleted
 * `src/generated/prisma/index.d.ts` (OSS CI run 41856375963, attempt 1).
 *
 * 契約 / Contract: database の package.json にある script のうち、turbo で build と同じ実行
 * グラフに入り、生成済み client を読むもの（下の EXEMPT_SCRIPTS 以外のすべて）は、
 * turbo.json の `@reftrixmcp/database#<task>` で自パッケージの `build` を dependsOn に含める。
 * root の turbo.json の `<pkg>#<task>` は共通 task の定義をまるごと置き換えるので、
 * dependsOn 以外の設定（inputs / env / outputs）は共通 task と同じに保つ。
 * prepare-oss.sh は turbo.json の `@reftrixmcp/` を `@reftrixmcp/` に置き換えるので、
 * OSS 側でも同じ key が効く。
 * Every database script that runs in the same turbo graph as build and reads the generated
 * client (everything not in EXEMPT_SCRIPTS below) must list the package's own `build` in
 * `dependsOn` under `@reftrixmcp/database#<task>`. A root `<pkg>#<task>` entry replaces the
 * whole generic task definition, so every field other than dependsOn (inputs / env /
 * outputs) must stay equal to the generic task. prepare-oss.sh rewrites `@reftrixmcp/` to
 * `@reftrixmcp/` in turbo.json, so the same keys apply in the OSS repo.
 *
 * Regression domain: none (CI tooling)。`.skip` / retry なし。
 *
 * @module tests/scripts/turbo-database-build-order.test
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** 契約の対象外の script と理由 / Scripts outside the contract, with reasons */
const EXEMPT_SCRIPTS: Readonly<Record<string, string>> = {
  build: "the producer itself",
  clean: "deletes outputs; never run together with build",
  postinstall: "npm lifecycle script, not a turbo task (removed in the OSS transform)",
  "test:watch": "persistent local watch task (cache: false), never part of a CI run",
  lint: "eslint without type information and with **/generated/** ignored",
  "lint:fix": "eslint without type information and with **/generated/** ignored",
};

/**
 * 接頭辞で対象外にする script。db:* は turbo task に dependsOn が無く build と同じ実行
 * グラフに入らない（下のテストで固定）。seed:* は turbo task ではない。
 * Prefix-exempt scripts: turbo's db:* tasks have no dependsOn, so they never share a graph
 * with build (pinned by a test below); seed:* scripts are not turbo tasks.
 */
const EXEMPT_PREFIXES = ["db:", "seed:"] as const;

interface TurboTask {
  dependsOn?: string[];
}

function readJson(rel: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function databaseScripts(): string[] {
  const pkg = readJson("packages/database/package.json");
  if (!isRecord(pkg) || !isRecord(pkg.scripts)) {
    throw new Error("packages/database/package.json has no scripts object");
  }
  return Object.keys(pkg.scripts);
}

function turboTasks(): Record<string, TurboTask> {
  const turbo = readJson("turbo.json");
  if (!isRecord(turbo) || !isRecord(turbo.tasks)) {
    throw new Error("turbo.json has no tasks object");
  }
  return turbo.tasks as Record<string, TurboTask>;
}

describe("turbo: database tasks wait for the database build", () => {
  it("the package name used in the task keys is @reftrixmcp/database", () => {
    const pkg = readJson("packages/database/package.json");
    expect(isRecord(pkg) && pkg.name).toBe("@reftrixmcp/database");
  });

  it("every task that reads the generated client depends on the package's own build", () => {
    const tasks = turboTasks();
    const consumers = databaseScripts().filter(
      (s) => !(s in EXEMPT_SCRIPTS) && !EXEMPT_PREFIXES.some((p) => s.startsWith(p))
    );
    // typecheck と test は必ず含まれる（空集合で通らないように）/ never pass on an empty set
    expect(consumers).toEqual(expect.arrayContaining(["typecheck", "test"]));

    const missing = consumers.filter((task) => {
      const entry = tasks[`@reftrixmcp/database#${task}`];
      return !entry?.dependsOn?.includes("build");
    });
    expect(
      missing,
      "add `build` to dependsOn of @reftrixmcp/database#<task> in turbo.json"
    ).toEqual([]);
  });

  it("the package-specific entries keep every other field of the generic task", () => {
    const tasks = turboTasks();
    const entries = Object.entries(tasks).filter(([key]) =>
      key.startsWith("@reftrixmcp/database#")
    );
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, entry] of entries) {
      const generic = tasks[key.slice("@reftrixmcp/database#".length)];
      expect(generic, `generic task for ${key}`).toBeDefined();
      const { dependsOn: specificDeps, ...specificRest } = entry as Record<string, unknown>;
      const { dependsOn: genericDeps, ...genericRest } = (generic ?? {}) as Record<string, unknown>;
      // inputs / env / outputs などは共通 task と同じ / same inputs, env, outputs, ...
      expect(specificRest, key).toEqual(genericRest);
      // 共通 task の dependsOn をすべて含む / keeps every generic dependency
      expect(specificDeps, key).toEqual(expect.arrayContaining((genericDeps as string[]) ?? []));
    }
  });

  it("turbo's db:* tasks have no dependsOn, so they never share a graph with build", () => {
    const tasks = turboTasks();
    const dbTasks = Object.entries(tasks).filter(([key]) => key.startsWith("db:"));
    expect(dbTasks.length).toBeGreaterThan(0);
    for (const [key, entry] of dbTasks) {
      expect(entry.dependsOn, key).toBeUndefined();
    }
  });
});
