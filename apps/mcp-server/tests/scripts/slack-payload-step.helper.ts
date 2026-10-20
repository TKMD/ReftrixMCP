// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CO-R2-53 — Slack 通知 payload step の共有 test helper
 * Shared test helper for the Slack notification payload step (CO-R2-53).
 *
 * workflow YAML から notify job の step を取り出し、`Build Slack payload` step の
 * `run:` script を GitHub Actions 既定 shell (`bash --noprofile --norc -eo pipefail`)
 * と同じ形で実行する。生成された payload file は slackapi/slack-github-action@v2.1.0
 * の `getContentPayloadFilePath` と同じ規則 (`.json` 拡張子 → `JSON.parse`) で読む。
 *
 * Extracts the notify-job steps from a workflow file and executes the
 * `Build Slack payload` step script the way GitHub Actions does
 * (`bash --noprofile --norc -eo pipefail`). The generated payload file is read
 * with the same rule as slackapi/slack-github-action@v2.1.0
 * `getContentPayloadFilePath` (`.json` extension → `JSON.parse`).
 *
 * @module tests/scripts/slack-payload-step.helper
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { load } from "js-yaml";
import { afterAll, describe, expect, it } from "vitest";

/** repo root (tests/scripts/ から 4 階層上) / repo root, 4 levels above tests/scripts/ */
export const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** Slack payload を組み立てる step の id / id of the step that builds the payload */
export const PAYLOAD_STEP_ID = "slack-payload";

/** workflow step の最小 shape / minimal shape of a workflow step */
export interface WorkflowStep {
  readonly name?: string;
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly with?: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * workflow file を読み、指定 job の steps を返す。
 * Reads a workflow file and returns the steps of the given job.
 */
export function loadJobSteps(workflowRelPath: string, jobId: string): WorkflowStep[] {
  const raw: unknown = load(fs.readFileSync(path.join(REPO_ROOT, workflowRelPath), "utf-8"));
  if (!isRecord(raw) || !isRecord(raw.jobs)) {
    throw new Error(`${workflowRelPath}: jobs mapping not found`);
  }
  const job = raw.jobs[jobId];
  if (!isRecord(job) || !Array.isArray(job.steps)) {
    throw new Error(`${workflowRelPath}: job ${jobId} has no steps`);
  }
  return job.steps.filter(isRecord) as WorkflowStep[];
}

/**
 * commit message / PR title として来うる敵対的な文字列。
 * Hostile strings that can arrive as a commit message or PR title.
 */
export const HOSTILE_COMMIT_MESSAGES: readonly string[] = [
  'fix(ci): ASCII double quote " in subject',
  'fix(ci): "fully quoted" subject',
  "fix(ci): backslash \\ and \\n literal and trailing \\",
  'fix(ci): subject\n\nbody line 1\nbody line 2 with a " quote',
  "fix(ci): carriage\r\nreturn and\ttab",
  "fix(ci): single ' quote and `backtick` and ```fence```",
  "fix(ci): shell $(touch PWNED_SUBST) and `touch PWNED_TICK` and ${HOME}",
  "fix(ci): expression ${{ secrets.SLACK_WEBHOOK_URL }} literal",
  "fix(ci): yaml-ish {a: [b, c]} # comment: x",
  "fix(ci): unicode 日本語 ✓ \u2028 sep",
];

/** payload step 実行結果 / result of executing the payload step */
export interface PayloadStepResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly payloadPath: string | undefined;
  readonly workDir: string;
}

/**
 * `Build Slack payload` step の run script を GitHub Actions と同じ shell で実行する。
 * 環境は最小 (PATH + RUNNER_TEMP + GITHUB_OUTPUT + 渡された env) に限定する。
 *
 * Executes the step script with the GitHub Actions default shell. The environment
 * is limited to PATH + RUNNER_TEMP + GITHUB_OUTPUT + the provided env.
 */
export function runPayloadStep(
  runScript: string,
  env: Readonly<Record<string, string>>
): PayloadStepResult {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "co-r2-53-slack-"));
  const githubOutput = path.join(workDir, "github_output");
  fs.writeFileSync(githubOutput, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", runScript], {
    cwd: workDir,
    env: {
      PATH: process.env.PATH ?? "",
      RUNNER_TEMP: workDir,
      GITHUB_OUTPUT: githubOutput,
      ...env,
    },
    encoding: "utf-8",
  });
  const outputs = fs.readFileSync(githubOutput, "utf-8");
  const match = /^path=(.*)$/m.exec(outputs);
  return {
    status: result.status,
    stderr: result.stderr,
    payloadPath: match?.[1],
    workDir,
  };
}

/**
 * slackapi/slack-github-action@v2.1.0 `getContentPayloadFilePath` の `.json` 分岐と同じく
 * `JSON.parse` で読む。workflow は `.json` file だけを生成するため、他の拡張子は error。
 *
 * Parses the payload file the way the action's `.json` branch of
 * `getContentPayloadFilePath` does (`JSON.parse`). The workflows only emit `.json`
 * files, so any other extension is an error.
 */
export function parsePayloadFileLikeAction(payloadPath: string): unknown {
  const content = fs.readFileSync(payloadPath, "utf-8");
  if (payloadPath.endsWith(".json")) {
    return JSON.parse(content);
  }
  throw new Error(`unsupported payload file extension: ${payloadPath}`);
}

/** payload の mrkdwn 本文 (blocks[0].text.text) を取り出す / extract the header mrkdwn text */
export function headerText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.attachments)) {
    throw new Error("payload.attachments missing");
  }
  const attachment: unknown = payload.attachments[0];
  if (!isRecord(attachment) || !Array.isArray(attachment.blocks)) {
    throw new Error("attachments[0].blocks missing");
  }
  const block: unknown = attachment.blocks[0];
  if (!isRecord(block) || !isRecord(block.text) || typeof block.text.text !== "string") {
    throw new Error("blocks[0].text.text missing");
  }
  return block.text.text;
}

/** payload の fields テキスト一覧 / list of field texts */
export function fieldTexts(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.attachments)) return [];
  const attachment: unknown = payload.attachments[0];
  if (!isRecord(attachment) || !Array.isArray(attachment.blocks)) return [];
  const block: unknown = attachment.blocks[1];
  if (!isRecord(block) || !Array.isArray(block.fields)) return [];
  return block.fields.flatMap((f: unknown) =>
    isRecord(f) && typeof f.text === "string" ? [f.text] : []
  );
}

/** 契約の workflow 別パラメータ / per-workflow parameters of the contract */
export interface SlackPayloadContract {
  /** repo root 相対の workflow path / workflow path relative to the repo root */
  readonly workflow: string;
  /** notify job id */
  readonly jobId: string;
  /** header に出る title / title shown in the header */
  readonly title: string;
  /** commit 文字列を囲む mrkdwn fence / mrkdwn fence around the commit text */
  readonly commitFence: string;
  /** SLACK_COMMIT env の値（完全一致）/ exact value of the SLACK_COMMIT env */
  readonly commitSource: string;
  /** fields 行数 / number of field rows */
  readonly fieldCount: number;
}

/**
 * CO-R2-53 の契約を 1 workflow に対して検証する describe を登録する。
 * Registers the CO-R2-53 contract suite for one workflow.
 */
export function describeSlackPayloadContract(contract: SlackPayloadContract): void {
  describe(`${contract.workflow} Slack payload (CO-R2-53)`, () => {
    const steps = loadJobSteps(contract.workflow, contract.jobId);
    const payloadStep = steps.find((s) => s.id === PAYLOAD_STEP_ID);
    const sendStep = steps.find((s) => (s.uses ?? "").startsWith("slackapi/slack-github-action@"));
    const workDirs: string[] = [];

    afterAll(() => {
      for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true });
    });

    it("send step reads a .json payload file built by the payload step, not an inline template", () => {
      expect(sendStep, "slack-github-action step").toBeDefined();
      expect(sendStep?.with?.payload, "inline `payload:` must not be used").toBeUndefined();
      expect(sendStep?.with?.["payload-file-path"]).toBe(
        "${{ steps." + PAYLOAD_STEP_ID + ".outputs.path }}"
      );
      expect(sendStep?.with?.["payload-templated"], "templating must stay off").toBeUndefined();
      expect(steps.indexOf(payloadStep as WorkflowStep)).toBeLessThan(
        steps.indexOf(sendStep as WorkflowStep)
      );
    });

    it("payload step receives free text only through env (no expression inside run:)", () => {
      expect(payloadStep, `step id ${PAYLOAD_STEP_ID}`).toBeDefined();
      expect(payloadStep?.run ?? "").not.toContain("${{");
      expect(payloadStep?.env?.SLACK_COMMIT ?? "").toBe(contract.commitSource);
      expect(payloadStep?.env?.SLACK_TITLE).toBe(contract.title);
      expect(payloadStep?.env?.SLACK_COMMIT_FENCE).toBe(contract.commitFence);
    });

    it.each(HOSTILE_COMMIT_MESSAGES.map((m) => [JSON.stringify(m), m]))(
      "builds a payload that parses and keeps the commit text verbatim: %s",
      (_label, message) => {
        const env: Record<string, string> = {
          ...(payloadStep?.env ?? {}),
          SLACK_STATUS: "failure",
          SLACK_COLOR: "#dc3545",
          SLACK_EMOJI: ":x:",
          SLACK_BRANCH: "main",
          SLACK_COMMIT: message,
          SLACK_ACTOR: "octocat",
          SLACK_RUN_URL: "https://github.com/TKMD/Reftrix/actions/runs/1",
        };
        const result = runPayloadStep(payloadStep?.run ?? "exit 97", env);
        workDirs.push(result.workDir);
        expect(result.status, result.stderr).toBe(0);
        expect(result.payloadPath ?? "").toMatch(/\.json$/);

        const payload = parsePayloadFileLikeAction(result.payloadPath ?? "");
        const fence = contract.commitFence;
        expect(headerText(payload)).toBe(
          ":x: *" +
            contract.title +
            " failure*\n*Branch:* `main`\n*Commit:* " +
            fence +
            message +
            fence +
            "\n*Author:* octocat"
        );
        expect(fieldTexts(payload)).toHaveLength(contract.fieldCount);
        // shell substitution in the commit text must never execute
        expect(fs.existsSync(path.join(result.workDir, "PWNED_SUBST"))).toBe(false);
        expect(fs.existsSync(path.join(result.workDir, "PWNED_TICK"))).toBe(false);
      }
    );
  });
}
