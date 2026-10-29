// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Standing Regression Suite — INV-SEC-AUDIT-IGNORE-BOUND-001
 *
 * `pnpm audit` の ignore 集合を **空** に固定する。以前の唯一の entry (braces
 * `GHSA-vfj7-8cjw-p6xm`) は 2026-10-23 に withdrawn され何も抑止していなかったため、
 * root `package.json` の `pnpm.auditConfig` ごと削除した。以後 ignore を足すと本 INV が RED になる。
 * **ignore を足して GREEN にすることは禁止**。足す必要が生じたら accepted-risk の記録と IO 裁定を
 * 先に取り、本 INV の期待集合を同一 commit で変える。
 *
 * Pins the `pnpm audit` ignore set to EMPTY. The only former entry (braces GHSA-vfj7-8cjw-p6xm) was
 * withdrawn on 2026-10-23 and suppressed nothing, so the whole `pnpm.auditConfig` was removed from the
 * root `package.json`. Adding any ignore turns this test RED; widening the ignore to go GREEN is
 * forbidden (record an accepted risk and get an IO ruling first, then change the expected set here).
 *
 * | leg | 契約 / contract                                                                           |
 * | --- | ----------------------------------------------------------------------------------------- |
 * | (1) | root `package.json` に `pnpm.auditConfig` が無い (ignoreGhsas / ignoreCves / 他キー全て不可) |
 * | (2) | `pnpm-workspace.yaml` に `auditConfig` が無い                                             |
 * | (3) | `.github/workflows/*.yml` の `pnpm audit` 呼出 (>= 1): `--ignore*` 無し、`--audit-level` は   |
 * |     | `high` のみで全 workflow 合計ちょうど 1 回、`\|\| true` / pipe / `continue-on-error` 無し     |
 *
 * 非空虚性 / Non-vacuity: 各 leg は読み出した値を引数に取る純関数で、control fixture が
 * ID 追加・空配列の ignoreGhsas・`ignoreCves`・workspace の `auditConfig`・workflow の
 * `--ignore-unfixable` / `--ignore` (1 行・`\` 継続・`>-` 折り返し)・`--audit-level` の緩和 / 重複 / 欠落・
 * `|| true` / pipe / `continue-on-error`・呼出 0 件で RED になることを assert する。実 file の読取結果が
 * 空でも RED。leg (3) は YAML を parse して step の `run` を対象にする (1 行 regex ではない)。
 *
 * 配置 / Placement: INV-SEC-OVERRIDE-BOUND-001 (harness) と同 directory の別 file (harness を編集しない、
 * helper を copy しない)。YAML は root devDependency の `js-yaml` で parse する。
 * Regression domain: large-page.
 */

// INV-SEC-AUDIT-IGNORE-BOUND-001

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../_shared/semver-lockfile";

// ---------------------------------------------------------------------------
// 読み出し / readers (読取結果が空なら throw = RED)
// ---------------------------------------------------------------------------

function readNonEmpty(path: string): string {
  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) throw new Error(`読取結果が空 / empty read: ${path}`);
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface WorkflowFile {
  path: string;
  text: string;
}

function readWorkflows(repoRoot: string): WorkflowFile[] {
  const dir = join(repoRoot, ".github", "workflows");
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({ path: `.github/workflows/${name}`, text: readNonEmpty(join(dir, name)) }));
}

// ---------------------------------------------------------------------------
// legs (読み出した値を引数に取る純関数 = control fixture から再利用)
// ---------------------------------------------------------------------------

/** leg (1): root manifest に `pnpm.auditConfig` が無い */
function checkAuditConfig(manifest: unknown): string[] {
  if (!isRecord(manifest)) return ["(1) root package.json が object でない"];
  const pnpmField = manifest.pnpm;
  if (isRecord(pnpmField) && "auditConfig" in pnpmField) {
    const keys = isRecord(pnpmField.auditConfig) ? Object.keys(pnpmField.auditConfig) : [];
    return [`(1) pnpm.auditConfig がある (keys: [${keys.join(", ")}]) — ignore 集合は空で固定`];
  }
  return [];
}

/** leg (2): `pnpm-workspace.yaml` に `auditConfig` が無い */
function checkWorkspace(workspace: unknown): string[] {
  if (!isRecord(workspace)) return ["(2) pnpm-workspace.yaml が mapping でない"];
  return "auditConfig" in workspace ? ["(2) pnpm-workspace.yaml に auditConfig がある"] : [];
}

/** `pnpm [options] audit` 呼出。group 1 = `audit` より前の option (`pnpm --prod audit`) / group 1 = options before `audit` */
const AUDIT_CALL_RE = /\bpnpm\s+((?:(?:-\S+|\S+=\S+)\s+)*)audit\b/g;
/**
 * option を問わない出現 (raw text との件数突合用)。`pnpm-workspace.yaml` のような語は数えない
 * any occurrence, for the raw-count cross-check; a word such as `pnpm-workspace.yaml` does not count
 */
const AUDIT_LOOSE_RE = /\bpnpm\s[^\n]*?\baudit\b/g;
/** step / input の説明文の行 (呼出ではない) / description lines of a step or input (not a call) */
const PROSE_LINE_RE = /^\s*(?:-\s+)?(?:name|description):/;
/**
 * 許可する option (allowlist)。`--audit-level` の値は別に high のみを許す。それ以外の option
 * (`--fix` は常に exit 0、`--ignore*`、`--prod` / `--filter` 等の範囲縮小、`--registry` / `--dir`)
 * はすべて RED / allowed options; the `--audit-level` value is checked separately (high only).
 * Any other option is RED (`--fix` always exits 0, `--ignore*`, narrowing, `--registry` / `--dir`).
 */
const ALLOWED_AUDIT_OPTIONS: readonly string[] = ["--json"];

/** allowlist に無い token (`audit` の前後とも) / tokens outside the allowlist, before or after `audit` */
function disallowedOptions(flags: string): string[] {
  const tokens = flags.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    if (token === "--audit-level") i += 1;
    else if (!token.startsWith("--audit-level=") && !ALLOWED_AUDIT_OPTIONS.includes(token))
      out.push(token);
  }
  return out;
}

/** `continue-on-error` が false 以外 (式を含む) / any `continue-on-error` other than a literal false */
function continuesOnError(value: unknown): boolean {
  return value !== undefined && value !== false && value !== "false";
}

/** `\` 継続を 1 行に畳む (`>-` 等の YAML 折り返しは parse 済み) */
const fold = (text: string): string => text.replace(/\\\r?\n/g, " ");

/** step の `run` を読む */
function runScripts(workflow: unknown): Array<{ where: string; script: string; lenient: boolean }> {
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) return [];
  const out: Array<{ where: string; script: string; lenient: boolean }> = [];
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    job.steps.forEach((step: unknown, index: number) => {
      if (!isRecord(step) || typeof step.run !== "string") return;
      out.push({
        where: `${jobName}.steps[${index}]`,
        script: fold(step.run),
        lenient:
          continuesOnError(job["continue-on-error"]) || continuesOnError(step["continue-on-error"]),
      });
    });
  }
  return out;
}

/** 呼出 1 件分の判定 / the verdict for one call */
function checkCall(at: string, flags: string, after: string, lenient: boolean): string[] {
  const out: string[] = [];
  const extra = disallowedOptions(flags);
  if (extra.length > 0)
    out.push(
      `${at} の pnpm audit に許可外の option [${extra.join(" ")}] (--ignore / 範囲縮小 / --fix 等)`
    );
  if (after.startsWith("|")) out.push(`${at} の pnpm audit の終了コードが || / pipe で失われる`);
  if (lenient) out.push(`${at} は continue-on-error (pnpm audit が落ちても通る)`);
  return out;
}

/** raw text (コメント行を除く) の `pnpm ... audit` 件数: `run` 以外に置いた呼出を拾う */
const rawAuditCount = (text: string): number =>
  [
    ...fold(text)
      .split("\n")
      .filter((line) => !/^\s*#/.test(line) && !PROSE_LINE_RE.test(line))
      .join("\n")
      .matchAll(AUDIT_LOOSE_RE),
  ].length;

/**
 * leg (3): workflow の `pnpm audit` 呼出 (>= 1) を YAML の step `run` から読む。
 * - option は allowlist (`--audit-level=high`、`--json`) のみ。`--ignore*`、範囲縮小 (--prod / --filter ...)、
 *   `--fix` (常に exit 0)、`--registry` / `--dir` 等は RED (`audit` より前の option も見る)
 * - `--audit-level` は `high` のみ (緩和 / 他の値は RED)、全 workflow 合計でちょうど 1 回
 * - 呼出の直後が `|| ...` / pipe ではない、step / job が `continue-on-error` ではない
 * - raw text の件数と `run` の解析で数えた件数が一致する (`with:` 入力などに置いた呼出は RED)
 * - 呼出 0 件も RED (locator)
 * 範囲外 (step `if:`、`shell:` 上書き、`set +e`、`! pnpm audit`、`; exit 0`) は tracked: deps-zod4.md TDA-B2C2A-06。
 */
function checkScript(
  at: string,
  run: { where: string; script: string; lenient: boolean }
): { parsed: number; highLevels: number; violations: string[] } {
  const out = { parsed: 0, highLevels: 0, violations: [] as string[] };
  for (const match of run.script.matchAll(AUDIT_CALL_RE)) {
    out.parsed += 1;
    const rest = run.script.slice((match.index ?? 0) + match[0].length);
    const end = rest.search(/&&|;|\||\n/);
    const args = end < 0 ? rest : rest.slice(0, end);
    const where = `${at} ${run.where}`;
    const after = end < 0 ? "" : rest.slice(end).trimStart();
    const flags = `${match[1] ?? ""} ${args}`;
    out.violations.push(...checkCall(where, flags, after, run.lenient));
    for (const level of flags.matchAll(/--audit-level(?:=|\s+)(\S+)/g)) {
      if (level[1] === "high") out.highLevels += 1;
      else out.violations.push(`${where} の --audit-level が ${String(level[1])} (high 以外)`);
    }
  }
  return out;
}

function checkWorkflows(files: readonly WorkflowFile[]): string[] {
  const violations: string[] = [];
  let calls = 0;
  let highLevels = 0;
  for (const file of files) {
    const found = runScripts(load(file.text)).map((run) => checkScript(`(3) ${file.path}`, run));
    const parsed = found.reduce((n, f) => n + f.parsed, 0);
    highLevels += found.reduce((n, f) => n + f.highLevels, 0);
    violations.push(...found.flatMap((f) => f.violations));
    const raw = rawAuditCount(file.text);
    if (raw !== parsed)
      violations.push(`(3) ${file.path} の pnpm audit は raw ${raw} 件、run の解析 ${parsed} 件`);
    calls += parsed;
  }
  if (calls === 0) violations.push("(3) workflow に pnpm audit 呼出が 1 件も無い (locator)");
  else if (highLevels !== 1)
    violations.push(`(3) --audit-level=high が ${highLevels} 回 (全 workflow 合計でちょうど 1 回)`);
  return violations;
}

// ---------------------------------------------------------------------------
// 実 assert / the real asserts
// ---------------------------------------------------------------------------

describe("INV-SEC-AUDIT-IGNORE-BOUND-001 (large-page)", () => {
  const manifest: unknown = JSON.parse(readNonEmpty(join(REPO_ROOT, "package.json")));
  const workspace: unknown = load(readNonEmpty(join(REPO_ROOT, "pnpm-workspace.yaml")));
  const workflows = readWorkflows(REPO_ROOT);

  it("(1) root package.json に pnpm.auditConfig が無い (ignore 集合 = 空)", () => {
    expect(checkAuditConfig(manifest)).toEqual([]);
  });

  it("(2) pnpm-workspace.yaml に auditConfig が無い", () => {
    expect(checkWorkspace(workspace)).toEqual([]);
  });

  it("(3) workflow の pnpm audit 呼出 (>= 1) に --ignore / --ignore-unfixable が無い", () => {
    expect(workflows.length).toBeGreaterThanOrEqual(1);
    expect(checkWorkflows(workflows)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // control fixtures (非空虚性 / non-vacuity): 各 leg が実際に RED を返せることを固定する
  // -------------------------------------------------------------------------
  describe("control fixtures", () => {
    it("(1) auditConfig 無しは GREEN、ID 追加 / 空 ignoreGhsas / ignoreCves / 他キーは RED", () => {
      expect(checkAuditConfig({ pnpm: { overrides: {} } })).toEqual([]);
      expect(checkAuditConfig({})).toEqual([]);
      const cases: unknown[] = [
        { pnpm: { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } } },
        { pnpm: { auditConfig: { ignoreGhsas: [] } } },
        { pnpm: { auditConfig: { ignoreCves: ["CVE-2026-93687"] } } },
        { pnpm: { auditConfig: { ignoreCves: [] } } },
        { pnpm: { auditConfig: { ignoreUnfixable: true } } },
        { pnpm: { auditConfig: {} } },
      ];
      for (const fixture of cases) expect(checkAuditConfig(fixture)).toHaveLength(1);
      expect(checkAuditConfig("not an object")).toHaveLength(1);
    });

    it("(2) workspace に auditConfig を置く → RED", () => {
      expect(checkWorkspace({ packages: ["apps/*"] })).toEqual([]);
      expect(
        checkWorkspace({ packages: ["apps/*"], auditConfig: { ignoreGhsas: ["GHSA-x"] } })
      ).toHaveLength(1);
    });

    const workflow = (run: string, extra = ""): WorkflowFile[] => [
      {
        path: "ci.yml",
        text: `jobs:\n  audit:\n    runs-on: ubuntu-latest\n${extra}    steps:\n      - name: a\n${run}`,
      },
    ];
    const step = (text: string, stepExtra = ""): WorkflowFile[] =>
      workflow(`        run: ${text}\n${stepExtra}`);

    it("(3) 現在の形 (pnpm audit --audit-level=high が 1 回) は GREEN", () => {
      expect(checkWorkflows(step("pnpm audit --audit-level=high"))).toEqual([]);
      expect(checkWorkflows(step("pnpm audit --audit-level high"))).toEqual([]);
    });

    it("(3) --ignore-unfixable / --ignore <CVE> (1 行) → RED", () => {
      for (const line of [
        "pnpm audit --audit-level=high --ignore-unfixable",
        "pnpm audit --ignore CVE-2026-93687 --audit-level=high",
      ]) {
        expect(checkWorkflows(step(line))).toHaveLength(1);
      }
    });

    it("(3) `\\` 継続の --ignore → RED", () => {
      const run =
        "        run: |\n          pnpm audit --audit-level=high \\\n            --ignore CVE-2026-93687\n";
      expect(checkWorkflows(workflow(run))).toHaveLength(1);
    });

    it("(3) `>-` 折り返しの --ignore → RED", () => {
      const run =
        "        run: >-\n          pnpm audit\n          --audit-level=high\n          --ignore-unfixable\n";
      expect(checkWorkflows(workflow(run))).toHaveLength(1);
      const clean = "        run: >-\n          pnpm audit\n          --audit-level=high\n";
      expect(checkWorkflows(workflow(clean))).toEqual([]);
    });

    it("(3) --audit-level の緩和 (critical / moderate) と欠落 → RED", () => {
      expect(checkWorkflows(step("pnpm audit --audit-level=critical"))).toHaveLength(2);
      expect(checkWorkflows(step("pnpm audit --audit-level moderate"))).toHaveLength(2);
      expect(checkWorkflows(step("pnpm audit"))).toHaveLength(1);
    });

    it("(3) --audit-level=high が 2 回 (別 step) → RED", () => {
      const run =
        "        run: pnpm audit --audit-level=high\n      - name: b\n        run: pnpm audit --audit-level=high\n";
      expect(checkWorkflows(workflow(run))).toHaveLength(1);
    });

    it("(3) `|| true` / pipe → RED", () => {
      expect(checkWorkflows(step("pnpm audit --audit-level=high || true"))).toHaveLength(1);
      expect(checkWorkflows(step("pnpm audit --audit-level=high | tee audit.log"))).toHaveLength(1);
    });

    it("(3) continue-on-error (step / job、true / 式) → RED、false は GREEN", () => {
      const line = "pnpm audit --audit-level=high";
      expect(checkWorkflows(step(line, "        continue-on-error: true\n"))).toHaveLength(1);
      expect(
        checkWorkflows(step(line, "        continue-on-error: ${{ always() }}\n"))
      ).toHaveLength(1);
      expect(
        checkWorkflows(workflow(`        run: ${line}\n`, "    continue-on-error: true\n"))
      ).toHaveLength(1);
      expect(checkWorkflows(step(line, "        continue-on-error: false\n"))).toEqual([]);
    });

    it("(3) audit の前置 option と範囲を狭める flag (--prod / --filter) → RED", () => {
      expect(checkWorkflows(step("pnpm --prod audit --audit-level=high"))).toHaveLength(1);
      expect(checkWorkflows(step("pnpm audit --audit-level=high --prod"))).toHaveLength(1);
      expect(checkWorkflows(step("pnpm --filter=app audit --audit-level=high"))).toHaveLength(1);
      expect(checkWorkflows(step("pnpm audit --audit-level=high --filter app"))).toHaveLength(1);
    });

    it("(3) allowlist 外の option (--fix / --registry / --dir / 位置引数) → RED、--json は GREEN", () => {
      for (const line of [
        "pnpm audit --audit-level=high --fix",
        "pnpm audit --audit-level=high --registry=https://example.invalid",
        "pnpm audit --dir=packages/core --audit-level=high",
        "pnpm --dir=packages/core audit --audit-level=high",
        "pnpm audit --audit-level=high extra",
      ]) {
        expect(checkWorkflows(step(line))).toHaveLength(1);
      }
      expect(checkWorkflows(step("pnpm audit --audit-level=high --json"))).toEqual([]);
      expect(checkWorkflows(step("pnpm audit --json --audit-level high"))).toEqual([]);
    });

    it("(3) step 名や pnpm-workspace.yaml の語は raw 件数に数えない", () => {
      const named = workflow(
        "        run: pnpm audit --audit-level=high\n      - name: pnpm audit の結果を確認\n        run: echo done\n"
      );
      expect(checkWorkflows(named)).toEqual([]);
      const word = workflow(
        "        run: pnpm audit --audit-level=high\n      - name: b\n        run: cat pnpm-workspace.yaml && echo audit\n"
      );
      expect(checkWorkflows(word)).toEqual([]);
    });

    it("(3) run 以外 (with: 入力) の pnpm audit は raw 件数との突合で RED、コメントは数えない", () => {
      const text =
        "jobs:\n  a:\n    steps:\n      - run: pnpm audit --audit-level=high\n      - uses: x/y@v1\n        with:\n          cmd: pnpm audit --ignore CVE-1\n";
      expect(checkWorkflows([{ path: "ci.yml", text }])).toHaveLength(1);
      const [clean] = step("pnpm audit --audit-level=high");
      expect(
        checkWorkflows([{ ...clean!, text: `# pnpm audit --ignore X\n${clean!.text}` }])
      ).toEqual([]);
    });

    it("(3) 呼出 0 件 → RED", () => {
      expect(checkWorkflows(step("pnpm lint"))).toHaveLength(1);
    });
  });
});
