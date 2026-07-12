// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * FIND-NPMPUB-VERIFY-SIGPIPE-01 [H] — publish.yml `tar | grep` SIGPIPE-guard regression
 *
 * IO Impl Decision V0 (CONDITIONAL) Unblock #2 の CI-failing regression test
 * (owner: test-qa-engineer)。Registry:
 * `
 * §"IO Impl Decision V0" / Unblock Conditions #2 / FIND-NPMPUB-VERIFY-SIGPIPE-01。
 *
 * ## 欠陥 / Defect
 * `.github/workflows/publish.yml` の verify/publish loop 内で `tar ... | grep -q …`
 * を **SIGPIPE guard 無し**で書くと、GitHub Actions 既定 shell (`bash -eo pipefail`)
 * 下で大型 tarball (mcp-server ~2600 files / listing ~150KB ≫ 64KB pipe buffer) の
 * 検証が **決定論的に false-fail** する: `grep -q` は最初の一致で早期 exit しパイプを
 * 閉じる → `tar` がまだ listing を書いている途中で SIGPIPE (exit 141) を受け →
 * `pipefail` が pipeline exit を 141 に昇格 → verify job RED → `needs: verify` の
 * publish job が永久に起動しない = flagship publish happy-path 完全 break。
 *
 * ## Guard 形式 / Guard form
 * `(tar … 2>/dev/null || true) | grep …` — subshell `(...)` が load-bearing:
 * subshell が無いと `tar … || true | grep` は演算子優先順位で
 * `tar … || (true | grep)` と誤結合するため、`|| true` は必ず subshell 内で
 * `tar` にのみ束縛させる必要がある。subshell 内の `|| true` が tar の SIGPIPE
 * (exit 141) を吸収し、pipeline exit は grep の結果 (存在=0 / 不在=1) に委ねられる。
 *
 * ## 2 層構成 / Two layers
 * - **Layer 1 (source-pin sweep)**: publish.yml の全 `run:` block を走査し、`tar` を
 *   パイプに接続する全箇所が guard 形式であることを assert。特定行番号への brittle
 *   pin は避けパターンベース。unguarded な `tar … | grep` が 1 箇所でも再導入されたら
 *   RED になる網羅 sweep (`tar -tzf` list-form / `tar -xzOf` extract-form 双方を対象。
 *   どちらも grep 早期 exit で SIGPIPE を受けうる)。
 * - **Layer 2 (functional)**: 合成 tarball (>64KB listing、LICENSE を先頭側に配置) を
 *   生成し、`bash -c 'set -eo pipefail; (tar -tzf … || true) | grep …'` で guarded
 *   形式が (a) LICENSE 検出 → exit 0 / (b) LICENSE 欠落 → exit 非 0 (fail-closed) を
 *   assert。pipe buffer 依存で不安定にならない決定論的設計 (SIGPIPE 発火の実証は
 *   Layer 1 の source-pin が担い、Layer 2 は guarded 形式の正しさに徹する)。
 *
 * ## Red-before / Green-after (dev-time, once — test code には含めない)
 * publish.yml の LICENSE-presence 行を一時的に unguarded へ mutate → Layer 1 が RED
 * (unguarded 検出) → `/tmp` byte-exact backup から復元 → byte-identical 確認。
 * publish.yml は uncommitted 新規ファイルゆえ `git checkout` 復元は不可 (`cp` 復元)。
 *
 * Cross-ref: IO Impl Decision V0 anchor `019f5310-4e4e` / Unblock #2 (verifier: TDA +
 * test-qa-engineer) / H = code + CI で落ちる実行可能テスト (accepted-risk 禁止、
 * skip/todo 禁止、Regression domain: none = CI/release-tooling)。
 *
 * @module tests/scripts/publish-yml-sigpipe-guard.test
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** repo root の `.github/workflows/publish.yml` (tests/scripts/ から 4 階層上) */
const PUBLISH_YML_PATH = path.resolve(__dirname, "../../../../.github/workflows/publish.yml");

/**
 * publish.yml の全 `run:` block (block-scalar `run: |` + single-line `run: cmd`) から
 * shell script 本文を抽出する。YAML block-scalar は `run:` key より深い indent の行の
 * 連続で、dedent (indent ≤ run: の indent) で終端する。step の `name:` / `env:` field 等を
 * sweep 対象から除外するため run block に限定 (whole-file scan より false-positive 耐性が高い)。
 */
function extractRunScripts(yamlText: string): string[] {
  const lines = yamlText.split("\n");
  const scripts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const blockMatch = lines[i].match(/^(\s*)run:\s*\|\s*$/);
    if (blockMatch) {
      const baseIndent = blockMatch[1].length;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const line = lines[j];
        if (line.trim() === "") {
          body.push(line);
          continue;
        }
        const indent = line.length - line.trimStart().length;
        if (indent <= baseIndent) break; // dedent → block end
        body.push(line);
      }
      scripts.push(body.join("\n"));
      i = j - 1;
      continue;
    }
    // single-line `run: <cmd>` (no block scalar) — capture the command text
    const inlineMatch = lines[i].match(/^\s*run:\s+(?!\|)(\S.*)$/);
    if (inlineMatch) {
      scripts.push(inlineMatch[1]);
    }
  }
  return scripts;
}

/**
 * run script 群から shell 論理行を収集する。純粋な shell コメント行 (trim 後 `#` 始まり)
 * は除外する — publish.yml のコメントには `# (tar || true) absorbs SIGPIPE …` /
 * `# unified tar|pipe guard style …` のように `tar` + pipe を含むものがあり、除外しないと
 * source-pin sweep が false-positive する。
 */
function collectShellLines(runScripts: string[]): string[] {
  return runScripts
    .flatMap((s) => s.split("\n"))
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

/** `tar` コマンドの出力がパイプに接続されている行か (word-boundary `tar` + 実パイプ `|`)。 */
function isTarPipeLine(line: string): boolean {
  const hasTarWord = /\btar\b/.test(line); // "tarball"/"targets" は \b で除外される
  const hasRealPipe = /[^|]\|(?!\|)/.test(line); // 単一 `|` (|| は除外)
  return hasTarWord && hasRealPipe;
}

/**
 * `(tar … || true) | …` の guard 形式か。subshell `(...)` + `|| true` + その後の実パイプ。
 * subshell が無いと `|| true` が tar に束縛されない (演算子優先順位) ため subshell を必須とする。
 */
function isGuardedTarPipe(line: string): boolean {
  return /\(\s*tar\b[^)]*\|\|\s*true\s*\)\s*\|(?!\|)/.test(line);
}

describe("FIND-NPMPUB-VERIFY-SIGPIPE-01 — Layer 1: publish.yml source-pin sweep", () => {
  const yamlText = fs.readFileSync(PUBLISH_YML_PATH, "utf-8");
  const runScripts = extractRunScripts(yamlText);
  const shellLines = collectShellLines(runScripts);
  const tarPipeLines = shellLines.filter(isTarPipeLine);

  it("run: block を抽出できる (非空虚) / extracts run: blocks (non-vacuous)", () => {
    // guard sweep が「run block を見つけられず vacuous GREEN」になる退行を構造排除
    expect(runScripts.length).toBeGreaterThan(0);
    expect(shellLines.length).toBeGreaterThan(0);
  });

  it("tar-pipe 箇所を少なくとも 1 つ検出する (sweep 非空虚) / finds ≥1 tar-pipe (non-vacuous sweep)", () => {
    // tar-pipe が 0 件 → 「全て guarded」が vacuous に真になる退行を構造排除。
    // 執筆時点の実数は 5 (LICENSE-presence / prisma index.js / index.d.ts の tar -tzf 3 +
    // workspace: / LICENSE-fulltext の tar -xzOf 2)。count は release-manager が
    // check を増減しうるため厳密 pin せず ≥1 のみ assert。
    expect(tarPipeLines.length).toBeGreaterThan(0);
  });

  it("全ての tar-pipe 箇所が SIGPIPE guard 形式である / every tar-pipe is SIGPIPE-guarded", () => {
    const unguarded = tarPipeLines.filter((line) => !isGuardedTarPipe(line)).map((l) => l.trim());
    // unguarded な `tar … | grep` が 1 箇所でも再導入されたら、その行内容を晒して RED になる。
    expect(unguarded).toEqual([]);
  });

  it("LICENSE-presence assertion (H の欠陥点) が guard 済である / the LICENSE-presence check (the H defect site) is guarded", () => {
    // FIND-NPMPUB-VERIFY-SIGPIPE-01 の origin 行を「行番号」ではなく「内容」で pin する
    // (brittle な line-number pin を回避)。`grep -q '^package/LICENSE$'` の tar-pipe 行を特定。
    const licenseLines = tarPipeLines.filter((line) =>
      /grep\s+-q(?:i)?\s+['"]\^package\/LICENSE\$['"]/.test(line)
    );
    expect(licenseLines.length).toBeGreaterThan(0); // LICENSE-presence check が存在すること
    for (const line of licenseLines) {
      expect(isGuardedTarPipe(line)).toBe(true);
    }
  });
});

describe("FIND-NPMPUB-VERIFY-SIGPIPE-01 — Layer 2: guarded-form functional correctness", () => {
  let workDir: string;
  let tgzWithLicense: string;
  let tgzWithoutLicense: string;
  let listingBytes = 0;

  // 合成 tarball 生成: >64KB listing + LICENSE 先頭側配置。
  // (mcp-server ~2600 files / listing ~150KB ≫ 64KB pipe buffer の実シナリオを faithful に再現)
  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "sigpipe-guard-"));
    const rootDir = path.join(workDir, "root");
    const pkgDir = path.join(rootDir, "package");
    fs.mkdirSync(pkgDir, { recursive: true });

    // package/LICENSE (AGPL full-text spot-check と同じ先頭シグネチャ)
    fs.writeFileSync(
      path.join(pkgDir, "LICENSE"),
      "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\n"
    );

    // filler 群 (>64KB listing に到達させるための多数 entry)
    const FILLER_COUNT = 2500;
    const fillerNames: string[] = [];
    for (let i = 0; i < FILLER_COUNT; i++) {
      const name = `package/filler-${String(i).padStart(6, "0")}-padpadpadpadpadpad.txt`;
      fs.writeFileSync(path.join(rootDir, name), "");
      fillerNames.push(name);
    }

    // manifest: LICENSE を先頭に配置 (grep が listing 先頭で match し、real runner なら
    // tar が残りを書く前に grep がパイプを閉じる = SIGPIPE 発火条件)。
    const manifestWith = path.join(workDir, "manifest_with.txt");
    const manifestWithout = path.join(workDir, "manifest_without.txt");
    fs.writeFileSync(manifestWith, ["package/LICENSE", ...fillerNames].join("\n") + "\n");
    fs.writeFileSync(manifestWithout, fillerNames.join("\n") + "\n");

    tgzWithLicense = path.join(workDir, "with-license.tgz");
    tgzWithoutLicense = path.join(workDir, "without-license.tgz");

    const buildWith = spawnSync(
      "tar",
      ["-czf", tgzWithLicense, "-C", rootDir, "-T", manifestWith],
      { encoding: "utf-8" }
    );
    expect(buildWith.status).toBe(0);
    const buildWithout = spawnSync(
      "tar",
      ["-czf", tgzWithoutLicense, "-C", rootDir, "-T", manifestWithout],
      { encoding: "utf-8" }
    );
    expect(buildWithout.status).toBe(0);

    // listing byte 数を実測 (>64KB を保証、非空虚性)
    const listing = spawnSync("tar", ["-tzf", tgzWithLicense], { encoding: "utf-8" });
    expect(listing.status).toBe(0);
    listingBytes = Buffer.byteLength(listing.stdout, "utf-8");
  });

  afterAll(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  // publish.yml の LICENSE-presence check と byte 一致の guarded 形式を faithful に実行する。
  const GUARDED_LICENSE_CHECK = `set -eo pipefail; (tar -tzf "$TARBALL" 2>/dev/null || true) | grep -q '^package/LICENSE$'`;

  function runGuarded(tarball: string): number {
    const res = spawnSync("bash", ["-c", GUARDED_LICENSE_CHECK], {
      env: { ...process.env, TARBALL: tarball },
      encoding: "utf-8",
    });
    return res.status ?? -1;
  }

  it("合成 tarball の listing が >64KB である (非空虚) / synthetic tarball listing exceeds 64KB", () => {
    // >64KB listing = SIGPIPE 発火の前提条件。faithful な再現であることを担保。
    expect(listingBytes).toBeGreaterThan(64 * 1024);
  });

  it("(a) LICENSE 存在 → guarded check は exit 0 / present LICENSE yields exit 0", () => {
    expect(runGuarded(tgzWithLicense)).toBe(0);
  });

  it("(b) LICENSE 欠落 → guarded check は exit 非 0 (fail-closed) / missing LICENSE yields non-zero (fail-closed)", () => {
    // guarded 形式は SIGPIPE を吸収しつつも「LICENSE が本当に無い」場合は fail-closed で
    // reject する (LCC M-LCC-1 の 5/5 coverage 非弱体化 = discriminating power 保持)。
    expect(runGuarded(tgzWithoutLicense)).not.toBe(0);
  });
});
