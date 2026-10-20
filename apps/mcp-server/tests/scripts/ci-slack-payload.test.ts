// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * CO-R2-53 — ci.yml の Slack 通知 payload が commit 文字列で壊れないことの回帰 test
 * Regression test: the ci.yml Slack payload must not break on commit text (CO-R2-53).
 *
 * 欠陥 / Defect: notify job が commit message を inline `payload:` template へ
 * `${{ }}` で直接埋め込んでいたため、ASCII の二重引用符を含む commit で
 * slack-github-action の parse が失敗し run-level failure になっていた
 * (run 36412126150 / 37226367199)。
 * The notify job interpolated the commit message straight into the inline
 * `payload:` template, so a commit containing an ASCII double quote made the
 * action fail to parse the payload (runs 36412126150 / 37226367199).
 *
 * 修正後の契約 / Contract after the fix: payload は jq が env 経由の値から
 * `.json` file として組み立て、送信 step は `payload-file-path` で読む。
 * jq builds the payload as a `.json` file from env-only inputs and the send
 * step reads it via `payload-file-path`.
 *
 * Regression domain: none (CI tooling)。共有 helper: `slack-payload-step.helper.ts`。
 *
 * @module tests/scripts/ci-slack-payload.test
 */

import { describeSlackPayloadContract } from "./slack-payload-step.helper";

describeSlackPayloadContract({
  workflow: ".github/workflows/ci.yml",
  jobId: "notify",
  title: "Reftrix CI",
  commitFence: "`",
  commitSource:
    "${{ github.event.head_commit.message || github.event.pull_request.title || 'N/A' }}",
  fieldCount: 9,
});
