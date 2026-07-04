# テスト要件 / Testing Requirements

## 評価メトリクス / Evaluation Metrics

| メトリクス / Metric | 定義 / Definition                                                       | 目標 / Target | 評価方法 / Evaluation Method |
| ------------------- | ----------------------------------------------------------------------- | ------------- | ---------------------------- |
| `pass@1`            | 初回試行で成功 / Pass on first attempt                                  | ≥ 85%         | 自動（Vitest + CI）          |
| `pass^3`            | 3回連続成功（一貫性必須） / 3 consecutive passes (consistency required) | ≥ 70%         | 自動（Vitest + CI）          |
| Statement Coverage  | ステートメントカバレッジ                                                | > 80%         | 自動（Vitest --coverage）    |
| Branch Coverage     | 分岐カバレッジ                                                          | > 70%         | 自動（Vitest --coverage）    |
| Function Coverage   | 関数カバレッジ                                                          | > 85%         | 自動（Vitest --coverage）    |
| E2E Success Rate    | E2Eテスト成功率                                                         | 100%          | 自動（Playwright + CI）      |

## TDD必須 / TDD Required

### ✅ PASS基準（pass^3: 3回連続成功必須） / PASS Criteria (pass^3: 3 consecutive passes required)

1. **Red**: 失敗するテストを先に書く / Write a failing test first
   - ✅ テストファイルのコミットタイムスタンプが実装ファイルより古い / Test file commit timestamp is older than implementation file
   - ✅ テストが最初は失敗することを確認（CIログで検証） / Confirm test initially fails (verified via CI logs)
2. **Green**: テストを通す最小限のコード / Write minimal code to pass the test
   - ✅ すべてのテストが通過（`pnpm test` で 0 failed） / All tests pass (`pnpm test` with 0 failed)
3. **Refactor**: コードを改善 / Improve the code
   - ✅ リファクタリング後もテストが通過（回帰なし） / Tests still pass after refactoring (no regression)
   - ✅ カバレッジが維持または向上 / Coverage maintained or improved

### ❌ FAIL基準 / FAIL Criteria

- ❌ 実装コードが先にコミットされている（TDDサイクル違反） / Implementation code committed before tests (TDD cycle violation)
- ❌ テストが1つでもfailed状態でマージ / Merging with any failed test
- ❌ テストファイルが存在しない実装コード / Implementation code without test files
- ❌ リファクタリングでテストが壊れた（回帰） / Tests broken by refactoring (regression)

### TDD検証方法 / TDD Verification

**自動検証（Git履歴） / Automated Verification (Git History)**:

```bash
# テストファイルが実装ファイルより先にコミットされていることを確認
git log --follow --format="%H %ai" -- tests/search.test.ts
git log --follow --format="%H %ai" -- src/search.ts
```

**CI環境での検証 / CI Verification**:

- プルリクエストの各コミットでテスト実行
- 初期コミットでテストが失敗→後続コミットで成功の流れを確認

テストなしのコードはマージ不可。 / Code without tests cannot be merged.

## Test Isolation 規約 / Test Isolation Standards

### 1. Principle: 1 Test = 1 Mock Cycle 契約 / Principle: 1 Test = 1 Mock Cycle Contract

各 `it()` block は **独立した `beforeEach` cycle で fresh mock を引く** こと。**複数 mock cycle (e.g. dispose + re-init、setup + reset + reload) を 1 test 内に詰め込む** と、`vi.doMock` hoisting timing miss / ESM module cache stale reference / async I/O scheduling race などの race condition が構造的に発生する。これらは 1-line fix では closure できず、test reshape (1 test = 1 mock cycle 契約への restructure) が **describe-block-level / it()-level race の closure path として necessary** となる。

Each `it()` block must **acquire a fresh mock via an independent `beforeEach` cycle`**. **Embedding multiple mock cycles (e.g. dispose + re-init, setup + reset + reload) within a single test** structurally introduces race conditions such as `vi.doMock` hoisting timing misses, ESM module cache stale references, or async I/O scheduling races. These are not closable by 1-line fixes; test reshape (restructure to the 1 test = 1 mock cycle contract) is **necessary as a closure path for describe-block-level / it()-level races**.

> **重要 / Critical — necessary but not sufficient**: §1 の "1 test = 1 mock cycle" 契約は describe-block-level / it()-level race を消滅させるが、**race の root cause が `vi.doMock` の async hoisting timing にある場合 (intra-file 同 process 内 sequential test 間の race) は §1 単独では closure 不可能**。この場合 §3 (File-level Isolation: `vi.mock` + `vi.hoisted` への移行) が **追加で必要**。empirical evidence: ADR-0020 Amendment 3 (1 test = 1 mock cycle 適用) → ~10% intra-file flake 残存 → Amendment 4 (vi.mock + vi.hoisted) で zero-flake 達成。
>
> **Critical — necessary but not sufficient**: The "1 test = 1 mock cycle" contract in §1 eliminates describe-block-level / it()-level races, but **when the race root cause lies in `vi.doMock`'s async hoisting timing (intra-file races between sequential tests in the same process), §1 alone cannot close it**. In such cases, §3 (File-level Isolation: migration to `vi.mock` + `vi.hoisted`) is **additionally necessary**. Empirical evidence: ADR-0020 Amendment 3 (applying 1 test = 1 mock cycle) → ~10% intra-file flake persisted → Amendment 4 (vi.mock + vi.hoisted) achieved zero-flake.

> **DRIFT-U20-01 evidence (2026-05-01)**: §1 alone は intra-file race を防げない事が `service-coverage.test.ts` で empirically 立証 (5 `vi.doMock` + 4 `vi.doUnmock` で directory pass^5 2/5 fail)。§3 (file-level `vi.mock` + `vi.hoisted`) と組み合わせる必要あり。 / DRIFT-U20-01 evidence (2026-05-01): §1 alone cannot prevent intra-file race, empirically proven on `service-coverage.test.ts` (5 `vi.doMock` + 4 `vi.doUnmock` yielded directory pass^5 2/5 fail). Must be combined with §3 (file-level `vi.mock` + `vi.hoisted`).

### 2. ESM Module Cache Discipline / ESM モジュールキャッシュ規律

`vi.doMock` を使用する test では **`beforeEach` 先頭** に `vi.resetModules()` を呼び、ESM module cache を fresh state に clear すること (sibling file pattern に整合)。

When using `vi.doMock`, call `vi.resetModules()` **at the head of `beforeEach`** to clear the ESM module cache to a fresh state (aligned with the sibling file pattern).

```typescript
// ✅ PASS pattern / 正例
describe("Service with mocked module", () => {
  beforeEach(() => {
    vi.resetModules(); // ✅ clear cache BEFORE each test
    // ... mock factory setup
  });

  it("first behaviour", async () => {
    /* ... */
  });
  it("second behaviour", async () => {
    /* ... */
  }); // gets fresh mock via beforeEach
});

// ❌ FAIL pattern / 反例 (afterEach に配置すると最初の test を救えない)
describe("Service with mocked module", () => {
  // ❌ no resetModules in beforeEach
  afterEach(() => {
    vi.resetModules(); // ❌ too late — first test already polluted
  });
});
```

`afterEach` への配置は **最初の test を救えない** ため不十分。`vi.resetModules()` は test の **直前** で実行する必要がある。

Placement in `afterEach` **cannot save the first test** and is insufficient. `vi.resetModules()` must execute **immediately before** each test.

### 3. File-level Isolation / ファイルレベル分離

#### Vitest pool: forks の structural guarantee と limitation / Structural Guarantee and Limitation of Vitest pool: forks

Vitest `pool: "forks"` 設定は **inter-file isolation** を OS-level process boundary で保証する — 各 test file は separate forked process で実行され、`require.cache` / ESM module registry / mock 内部 state は process 間で共有不可能。一方、**intra-file** (同 file 内 sequential test execution) は同 process 内で実行されるため、`vi.doMock` 等の dynamic mock の race window は依然存在する。Path B' (file split: race の生じる test 群を独立 file に isolate) は inter-file race を OS process boundary で消滅させるが、isolated file 内の intra-file race には触れないため、§1 + §2 + Path B' の組み合わせでも intra-file flake が残存する場合がある (empirical: ADR-0020 Supplementary #3 verification 9/10 PASS)。

Vitest's `pool: "forks"` configuration guarantees **inter-file isolation** via OS-level process boundary — each test file runs in a separate forked process, so `require.cache` / ESM module registry / mock internal state cannot be shared between processes. On the other hand, **intra-file** (sequential test execution within the same file) runs in the same process, so the race window of dynamic mocks like `vi.doMock` still exists. Path B' (file split: isolating tests with race into independent files) eliminates inter-file race via OS process boundary, but does not address intra-file race within the isolated file, so even the combination of §1 + §2 + Path B' may leave intra-file flake (empirical: ADR-0020 Supplementary #3 verification at 9/10 PASS).

#### vi.mock vs vi.doMock の選択 / Choice between vi.mock and vi.doMock

- **`vi.mock(path, factory)`**: Vitest が自動的に file 先頭にヒstingt、imports 前に解決、static、deterministic。File 全体で mock semantic が固定 (file-level permanent mock)。
- **`vi.doMock(path, factory)`**: Test runtime から呼ぶ dynamic mock、test ごとに mock 切替可能だが async hoisting timing race を構造的に持つ。

- **`vi.mock(path, factory)`**: Auto-hoisted by Vitest to the top of the file, resolved before imports, static, deterministic. Mock semantic is fixed for the entire file (file-level permanent mock).
- **`vi.doMock(path, factory)`**: Dynamic mock called from test runtime, allows per-test mock switching but structurally carries an async hoisting timing race.

#### 推奨パターン / Recommended Patterns

1. **単一 mock semantic per file**: 当該 file 全 tests が同 mock を期待する場合 (例: mocked-ONNX 専用 file) → `vi.mock` を優先。Path B' (file split) と組み合わせると inter-file (process boundary) + intra-file (static hoisting) の double structural guarantee が成立。
2. **Per-test mock toggling**: 同 file 内で mock ON/OFF を切替えたい場合 → `vi.doMock` を使うが §1 (1 test = 1 mock cycle) + §2 (`vi.resetModules()` in `beforeEach`) の組み合わせが necessary。ただし empirical evidence (DINOv2 case) では 30-run 中 ~10% intra-file flake 残存 → file split + `vi.mock` conversion が canonical fix。

3. **Single mock semantic per file**: When all tests in the file expect the same mock (e.g., a dedicated mocked-ONNX file) → prefer `vi.mock`. Combined with Path B' (file split), this establishes a double structural guarantee — inter-file (process boundary) + intra-file (static hoisting).
4. **Per-test mock toggling**: When toggling mocks ON/OFF within the same file → use `vi.doMock` but the combination of §1 (1 test = 1 mock cycle) + §2 (`vi.resetModules()` in `beforeEach`) is necessary. However, empirical evidence (DINOv2 case) shows ~10% intra-file flake persists in 30 runs → file split + `vi.mock` conversion is the canonical fix.

#### vi.hoisted() pattern

`vi.mock` factory が test 内 mock state (例: mockSession) を参照する必要がある場合、`vi.hoisted(() => ({ ... }))` で hoisted scope に pre-construct する:

When `vi.mock` factory needs to reference test-level mock state (e.g., mockSession), pre-construct it in hoisted scope via `vi.hoisted(() => ({ ... }))`:

```typescript
// ✅ PASS pattern / 正例: vi.hoisted で mockSession を pre-construct
const { mockSession } = vi.hoisted(() => {
  const session = { run: vi.fn(), release: vi.fn().mockResolvedValue(undefined) };
  return { mockSession: session };
});

vi.mock("module-name", () => ({
  /* factory references mockSession from hoisted scope */
}));

// Now imports work normally with mocked module (static top-level import)
import { Service } from "../src/service.js";

// ❌ FAIL pattern / 反例: hoisted scope 外の reference は TDZ error
const mockSession = { run: vi.fn() }; // ❌ not hoisted
vi.mock("module-name", () => ({
  /* factory references mockSession → TDZ ReferenceError */
}));
```

#### Anti-patterns (file-level)

- ❌ **`vi.doMock` を file-level で使う** / Using `vi.doMock` at file-level — Vitest が hoist しないため imports は real module を bind し、mock が effective にならない
- ❌ **`vi.mock` factory 内で hoisted scope 外の mockSession を参照** / Referencing mockSession outside hoisted scope from `vi.mock` factory — TDZ (Temporal Dead Zone) error が発生
- ❌ **Mocked + non-mocked describe blocks を同 file に co-locate** / Co-locating mocked + non-mocked describe blocks in the same file — intra-file mock state leak が発生 (Path B' [file split] が canonical fix)

#### Cross-references / 関連参照

- **ADR-0020 Amendment 4** (`packages/ml/tests/dinov2/service-mocked-onnx.test.ts` canonical example) — `vi.doMock` → `vi.mock` + `vi.hoisted` 7-change implementation contract / 7-change implementation contract for `vi.doMock` → `vi.mock` + `vi.hoisted` migration
- **ADR-0020 Amendment 4 §5.5 Scope Expansion** (`packages/ml/tests/dinov2/service-coverage.test.ts` canonical example) — DRIFT-U20-01 Pattern (a) per-test override 適用例 / DRIFT-U20-01 Pattern (a) per-test override application
- **INV-DINOV2-MOCK-FILE-ISOLATION-001** — IO Supplementary Decision #3 anchor `019de376-...` で導入された file-level mock isolation invariant (Path B' file split) / File-level mock isolation invariant introduced by IO Supplementary Decision #3 (Path B' file split)

#### Directory-level pass^N Invariant / ディレクトリレベル pass^N 不変条件 (DRIFT-U20-02)

File-level isolation (本 §3) は necessary だが directory-level の test isolation guarantee は保証しない。同 directory 内の異なる test file が独立した process で走るが、各 file 内 (intra-file) は同 process — 同 file 内の `vi.doMock` async race は file-split で消えない (DRIFT-U20-01 case study 参照)。

File-level isolation (this §3) is necessary but does not guarantee directory-level test isolation. Different test files within the same directory run in independent processes, yet **within a file (intra-file) they share a single process** — the `vi.doMock` async race within a file is **not** eliminated by file split (see DRIFT-U20-01 case study).

**Recommended pre-merge gate**: 重要 mock 含む directory に対し: / For directories containing critical mocks:

1. **Isolation pass^N**: 各 test file 単独で N (推奨 N≥10) 連続 PASS / Each test file passes individually for N consecutive runs (recommended N ≥ 10)
2. **Directory pass^N**: 同 directory の全 test file を N (推奨 N≥10) 連続 PASS / All test files in the same directory pass for N consecutive runs (recommended N ≥ 10)

両 segment で 0 fail なら structural fix 確証。Empirical guarantee は file-level `vi.mock` + `vi.hoisted` の structural impossibility (Vitest auto-hoisting, ESM static binding) と complementary。

If both segments yield 0 fail, structural fix is empirically corroborated. The empirical guarantee is **complementary** to the structural impossibility of file-level `vi.mock` + `vi.hoisted` (Vitest auto-hoisting, ESM static binding).

**Gate command** (DINOv2 directory canonical) / ゲートコマンド (DINOv2 directory canonical):

```bash
cd packages/ml
# Isolation pass^10 (single file)
for i in $(seq 1 10); do pnpm test tests/dinov2/<file>.test.ts; done
# Directory pass^10 (all files in directory)
for i in $(seq 1 10); do pnpm test tests/dinov2/; done
```

ANSI color codes が grep matching に干渉する場合 `sed 's/\x1b\[[0-9;]*m//g'` で pre-strip。 / If ANSI color codes interfere with grep matching, pre-strip via `sed 's/\x1b\[[0-9;]*m//g'`.

#### Canonical examples (updated 2026-05-01)

Option A'' pattern (`vi.mock` + `vi.hoisted`) の canonical examples は **2 files に拡張**: / Canonical examples for the Option A'' pattern (`vi.mock` + `vi.hoisted`) are now expanded to **2 files**:

1. `packages/ml/tests/dinov2/service-mocked-onnx.test.ts` — file-split origin (Path B') + `vi.mock` conversion (Option A''、IO Decision #3 + User Path ii) / file-split origin + `vi.mock` conversion
2. `packages/ml/tests/dinov2/service-coverage.test.ts` — DRIFT-U20-01 fix、Pattern (a) per-test override 例 / DRIFT-U20-01 fix, Pattern (a) per-test override exemplar

両 file は file-level `vi.mock` + `vi.hoisted` を使用、`vi.doMock` を一切使わない。dynamic mock semantic toggling が file 内で必要な場合は file split を優先。

Both files use file-level `vi.mock` + `vi.hoisted` and never `vi.doMock`. When dynamic mock semantic toggling is needed within a file, prefer file split.

### 4. Reshape 推奨パターン / Recommended Reshape Pattern

1 test 内に **2 つ以上の mock cycle** が必要な場合 (例: `dispose() → re-initialize`、`setup → reset → reload`、`init → invalidate → re-init`)、`it()` を **分離** すること。1 mock cycle per test の単純構造に restructure することで、race condition の発生 surface を構造的に消滅させる。

When **two or more mock cycles** (e.g. `dispose() → re-initialize`, `setup → reset → reload`, `init → invalidate → re-init`) are required in a single test, **split into separate `it()` blocks**. Restructuring to a simple 1-mock-cycle-per-test pattern structurally eliminates the race condition surface.

```typescript
// ❌ Anti-pattern / 反例: 1 test 内に 2 mock cycle
it("should handle dispose and re-initialize", async () => {
  // mock cycle 1: initial setup
  const service = await createService();
  await service.dispose();
  // mock cycle 2: re-initialize (← vi.doMock hoisting race here)
  const service2 = await createService();
  expect(service2).toBeDefined();
});

// ✅ Reshape pattern / 正例: 2 it() に split (1 test = 1 mock cycle)
it("should dispose cleanly", async () => {
  const service = await createService();
  await service.dispose();
  expect(service.isDisposed).toBe(true);
});

it("should re-initialize after dispose via fresh mock cycle", async () => {
  // beforeEach で vi.resetModules() 経由 fresh mock injection
  const service = await createService();
  expect(service).toBeDefined();
});
```

### 5. Anti-Patterns / 禁止事項

- ❌ **`.skip()` / `.todo()` で flaky test を隠蔽** / Hiding flaky tests via `.skip()` / `.todo()` — `## Standing Regression Suite` 節で全面禁止 (例外は 4-domain standing regression のみ)
- ❌ **vitest `retry: N` で structural bug を mask** / Masking structural bugs with `retry: N` — `pass^3 ≥ 70%` の semantic を erosion し、CI green を artificial に演出する
- ❌ **`vi.doMock` を test body 内で複数回 re-call して mock leak を test-by-test patch** / Repeatedly calling `vi.doMock` in test bodies to patch mock leaks test-by-test — hoisting timing race の root cause を mask する局所対症療法であり、`it()` 分離による structural fix を阻害

### 6. Cross-references / 関連参照

- **ADR-0020 Amendment 3** (` — DINOv2 test reshape の rationale および Option A/B/C 比較 (superseded by Amendment 4 / Amendment 4 によって supersede) / DINOv2 test reshape rationale and Option A/B/C comparison (superseded by Amendment 4)
- **ADR-0020 Amendment 4** (`— DINOv2 mocked-ONNX file-level`vi.mock`+`vi.hoisted` structural fix (Path B' + Option A'' composition で zero-flake 達成) / Structural fix achieving zero-flake via Path B' + Option A'' composition
- **INV-DINOV2-TEST-ISOLATION-001** — IO Supplementary Decision #1 anchor `019de32d-...` で導入された describe-block-level mock leak closure invariant / Mock leak closure invariant introduced by IO Supplementary Decision #1
- **INV-DINOV2-MOCK-FILE-ISOLATION-001** — IO Supplementary Decision #3 anchor `019de376-...` で導入された file-level mock isolation invariant (Path B' file split + Amendment 4 vi.mock + vi.hoisted で carryover closure 完了) / File-level mock isolation invariant; carryover closed via Path B' file split + Amendment 4 vi.mock + vi.hoisted
- **Canonical example (it()-level reshape)**: `packages/ml/tests/dinov2/service.test.ts` — Amendment 3 で 1 test = 1 mock cycle 契約に reshape した参照実装 / Reference implementation reshaped to the 1 test = 1 mock cycle contract under Amendment 3
- **Canonical example (file-level isolation)**: `packages/ml/tests/dinov2/service-mocked-onnx.test.ts` — Amendment 4 で `vi.mock` + `vi.hoisted` に rewrite した参照実装 (Path B' file split + Option A'' composition) / Reference implementation rewritten to `vi.mock` + `vi.hoisted` under Amendment 4 (Path B' file split + Option A'' composition)
- **Canonical example (Pattern (a) per-test override, DRIFT-U20-01)**: `packages/ml/tests/dinov2/service-coverage.test.ts` — Amendment 4 §5.5 Scope Expansion で `vi.doMock`×5 + `vi.doUnmock`×4 → 1 `vi.mock` + 1 `vi.hoisted` に rewrite、isolation pass^10 + directory pass^10 = 20/20 PASS / Reference implementation rewritten under Amendment 4 §5.5 Scope Expansion: `vi.doMock`×5 + `vi.doUnmock`×4 → 1 `vi.mock` + 1 `vi.hoisted`; isolation pass^10 + directory pass^10 = 20/20 PASS

### 7. Host-RAM-Dependent Threshold × Mocked Absolute RSS — Determinism Pattern / 実機RAM依存閾値 × mocked絶対rss の決定論化パターン (FIND-IMPL-V0-L-03, tracked, deadline 2026-05-31)

memory 系 standing test が `MEMORY_DEGRADATION_THRESHOLD_MB` / `MEMORY_CRITICAL_THRESHOLD_MB` のような **実機 `os.totalmem()` から解決される閾値** (`export let` 値) を読みつつ、同じ test 内で **固定の絶対 rss を mock** (`vi.spyOn(process, "memoryUsage")`) する場合、**CI-only flake が構造的に発生する**。dev box (≥64GB RAM) では閾値が cap (12288/14336MB) に saturate するが、小型 CI runner (≤~9.4GB RAM) では `totalMb*0.7` に下がるため、固定 mock rss が dev box では閾値以下 (PASS) でも CI runner では閾値超過 (`shouldAbort=true` → branch 早期 break) となり、host RAM 依存で結果が分岐する。

When a memory-domain standing test reads a **threshold resolved from the host's real `os.totalmem()`** (an `export let` value like `MEMORY_DEGRADATION_THRESHOLD_MB` / `MEMORY_CRITICAL_THRESHOLD_MB`) while **mocking a fixed absolute rss** (`vi.spyOn(process, "memoryUsage")`) in the same test, a **CI-only flake arises structurally**: on a dev box (≥64GB RAM) the threshold saturates at the cap (12288/14336MB), but on a small CI runner (≤~9.4GB RAM) it drops to `totalMb*0.7`, so a fixed mocked rss that is below the threshold on the dev box (PASS) exceeds it on the CI runner (`shouldAbort=true` → early branch break) — the outcome bifurcates by host RAM.

**Canonical determinism pattern / 決定論化パターン**: 当該 test 内で **pressure-gate を固定 dev-baseline 閾値に spy stub** する。host RAM 由来の `export let` 閾値ではなく、固定リテラル (production cap と同値) に対して mocked rss を評価することで、結果を host-RAM 非依存に固定する。INV が検証する本来の対象 (例: 固定定数 `PER_CHUNK_RSS_BUDGET_MB` に対する budget delta) はそのまま mocked `process.memoryUsage()` を読み続けるよう **untouched** に残す。

**Canonical determinism pattern**: **spy-stub the pressure gate to fixed dev-baseline thresholds** inside the test. Evaluate the mocked rss against a fixed literal (equal to the production cap) instead of the host-RAM-derived `export let` threshold, pinning the outcome host-RAM-independently. Leave the INV's actual subject (e.g. a budget delta against the fixed constant `PER_CHUNK_RSS_BUDGET_MB`) **untouched** so it keeps reading the mocked `process.memoryUsage()`.

```typescript
// ✅ Determinism pattern / 決定論化パターン
const FIXED_DEGRADATION_THRESHOLD_MB = 12288; // = production DEGRADATION_CAP_MB
const FIXED_CRITICAL_THRESHOLD_MB = 14336; // = production CRITICAL_CAP_MB
// pressure gate を固定閾値で評価 (host RAM 非依存)。SSOT import 化が将来候補。
vi.spyOn(phaseTypes, "checkMemoryPressure").mockImplementation(() => ({
  shouldDegrade: currentRssMb >= FIXED_DEGRADATION_THRESHOLD_MB,
  shouldAbort: currentRssMb >= FIXED_CRITICAL_THRESHOLD_MB,
  rssMb: currentRssMb,
  heapUsedMb: 32,
}));
```

**横展開参照点 / Cross-cutting reference point**: memory pressure / RSS / VRAM 閾値を読む memory 系 standing test (large-page domain 等) は本パターンを適用すること。残課題 (tracked, deadline 2026-05-31): (i) 固定閾値の production cap (`worker-memory-profile.ts` の `DEGRADATION_CAP_MB` / `CRITICAL_CAP_MB`) からの **SSOT import 化** (coupling-drift 検出)、(ii) namespace-member spy (`vi.spyOn(<namespace>, "checkMemoryPressure")`) の esbuild-transform 依存を DI seam に置換。

**Cross-cutting reference point**: memory-domain standing tests reading memory-pressure / RSS / VRAM thresholds (e.g. the large-page domain) should adopt this pattern. Tracked open items (deadline 2026-05-31): (i) **SSOT-import** the fixed thresholds from the production caps (`DEGRADATION_CAP_MB` / `CRITICAL_CAP_MB` in `worker-memory-profile.ts`) for coupling-drift detection, and (ii) replace the esbuild-transform-dependent namespace-member spy (`vi.spyOn(<namespace>, "checkMemoryPressure")`) with a DI seam.

**Canonical example / 参照実装**: `apps/mcp-server/tests/regression/standing/large-page/inv-phase5-coldload-delta-exclusion-001.test.ts` (`installRssModel`) — branch 4 (loop-head 3× budget anomalous arena proceed) の CI-only flake を本パターンで決定論化 (IO 実測 6/6 PASS) / determinised the branch 4 (loop-head 3× budget anomalous arena proceed) CI-only flake via this pattern (IO-verified 6/6 PASS).

**Cross-ref**: FIND-IMPL-V0-L-01 (固定閾値 SSOT-derive 候補) / FIND-IMPL-V0-L-02 (heap-abort OR-branch 非再現) / FIND-IMPL-V0-L-04 (namespace-spy esbuild 依存) / TDA-L-01 (canonical determinism pattern 横展開) / `apps/mcp-server/src/services/worker-memory-profile.ts` (`DEGRADATION_CAP_MB` / `CRITICAL_CAP_MB` SSOT).

### 8. Mirror-Gate Cross-Parity — worker gate vs in-process gate drift risk / Mirror-Gate Cross-Parity — worker gate と in-process gate の drift リスク (TDA-IMPL-L-02, tracked, deadline 2026-06-15 = T+1d)

ONNX execution-device gate が **2 つの独立実装で mirror され、SSOT でない**場合、一方が drift すると worker/in-process gate の非対称が再発しうる。これは embedding fix PR-1 (CORE gate parity、IO Impl Decision = APPROVE `019ec66d`) の re-audit で TDA-IMPL-L-02 (L) として確認された構造的リスクである。

When an ONNX execution-device gate is **mirrored by two independent implementations rather than an SSOT**, a drift in one can re-introduce the worker/in-process asymmetry. This is the structural risk confirmed as TDA-IMPL-L-02 (L) in the embedding fix PR-1 (CORE gate parity, IO Impl Decision = APPROVE `019ec66d`) re-audit.

**事実 / Facts**:

- **worker gate**: `packages/ml/src/embeddings/worker-thread-device.ts` の `resolveWorkerEffectiveDevice(resolvedProvider)` (resolved provider を尊重、`config.device` 非参照) + `canSwitchToCuda(verifyCuda, isLdSet)` (`verifyCudaAvailability` AND `isLdLibraryPathSetAtOsLevel`)。
- **in-process gate**: `packages/ml/src/embeddings/service.ts:472` の `resolveInProcessDevice` (CUDA-unbacked 時に gate 結果 `resolved`→cpu を返す)。
- 両者は **同一 gate 契約を表現する mirror** であり共有 SSOT ではない。in-process のみを修正した PR-1 GPU-COORD `85e8fb3b` (FIND-IMPL-PR1-H-NEW-01) が残した worker-path coverage gap を、PR-1 CORE fix が worker gate 追加で塞いだ経緯。

**現状の実害なし根拠 / Why no current real harm**: 両 gate が同契約を表現し、worker は `INV-EMBEDDING-WORKER-CUDA-GATE-001` (large-page standing、8 cases) + in-process は既存 in-process test で **双方 pin 済**。すなわち drift は CI で検出可能であり、現リリースサイクルで非対称が再発する経路はない → **L severity** (docs 記録 + tracked、deadline 2026-06-15 = T+1d)。

The two gates express the same contract and are **both pinned** — the worker by `INV-EMBEDDING-WORKER-CUDA-GATE-001` (large-page standing, 8 cases) and the in-process by the existing in-process test — so drift is CI-detectable and there is no path for the asymmetry to re-emerge in the current release cycle → **L severity** (docs record + tracked, deadline 2026-06-15 = T+1d).

**Defense-in-depth 候補 / Defense-in-depth candidate** (将来 PR、owner capture-embedding-engineer + search-engineer): (a) worker / in-process **両 gate を assert する cross-parity INV** を large-page standing に追加する、OR (b) 共有 gate predicate に **統合** (`resolveInProcessDevice` の "config.device 非cuda passthrough" 差分を保ったまま、CUDA-unbacked 判定を共有 helper 化)。後者は意図的差分 (worker は init line 82-95 で `resolvedProvider` を確定済ゆえ `config.device` 参照不要、in-process は `config.device` を直接 source とする構造差) を保存する必要がある。/ (a) add a cross-parity INV asserting both gates in the large-page standing suite, OR (b) consolidate into a shared gate predicate (factoring the CUDA-unbacked decision into a shared helper while preserving `resolveInProcessDevice`'s intentional "config.device non-cuda passthrough" difference).

**Cross-ref**: Finding Registry `(TDA-IMPL-L-02) /`packages/ml/src/embeddings/worker-thread-device.ts`(worker gate,`resolveWorkerEffectiveDevice`/`canSwitchToCuda`) ↔ `packages/ml/src/embeddings/service.ts:472`(in-process gate,`resolveInProcessDevice`) / `INV-EMBEDDING-WORKER-CUDA-GATE-001` (`apps/mcp-server/tests/regression/standing/large-page/inv-embedding-worker-cuda-gate-001.test.ts`, worker pin) / `85e8fb3b`(FIND-IMPL-PR1-H-NEW-01, in-process-only origin) /`.claude/rules/security.md`§"Embedding worker-thread CUDA gate parity" (SEC-IMPL-PR1-L-01) / IO Impl Decision = APPROVE`019ec66d` (Phase 3 docs-sync landing).

### 9. Crop-retention standing test — cross-`.test.ts` const import + byte-window pin defense-in-depth (W6 Issue A PR-3b, TPA-02 / TDA-05, tracked, L, deadline 2026-06-25 = T+1d) / Crop-retention standing test — cross-`.test.ts` const import + byte-window pin defense-in-depth

**JP**: W6 Issue A PR-3b (crop GDPR cascade + retention INV、IO Plan Decision V0 = CONDITIONAL `019ef9b2-3c92`) の Impl 監査で確認された **L severity の test-infra defense-in-depth tracked-issue 2 件**。いずれも現リリースサイクルで実害なし (L severity、docs 記録 + tracked、deadline 2026-06-25 = T+1d)。

- **TPA-02** (L、cross-`.test.ts` const import): `INV-CROP-RETENTION-001` (`inv-crop-retention-001.test.ts`) の 3s SLA assertion (#4) は `SLA_WITHIN_MS=3000` 定数を **別 `.test.ts` (`inv-data-delete-002-core.test.ts:82`) から import** して SSOT-derive する (F-08、`3000` literal 再宣言を回避し CWE-209 truncateId SSOT-derive rigor と同 pattern)。これは literal hardcode より優れるが、**test ファイル間の import 依存**は production import ではないため、`inv-data-delete-002-core.test.ts` の rename / SLA_WITHIN_MS の移動で `inv-crop-retention-001.test.ts` が壊れうる脆結合 surface を持つ。**現状の実害なし根拠**: 両 test は同一 gdpr-delete standing directory にあり、SLA_WITHIN_MS は GDPR Art.12(3)/Art.17 "without undue delay" の運用契約 (ADR-0016) で安定。**defense-in-depth 候補** (将来 PR、owner test-qa-engineer): `SLA_WITHIN_MS` を **非 test の shared SSOT module** (例: `apps/mcp-server/src/services/gdpr-constants.ts` 等) に移し、両 test がそこから import する (test↔test import 依存を production-SSOT import に昇格)。
- **TDA-05** (L、byte-window pin → scoped function-slice): `INV-CROP-COVERAGE-PARITY-001` surface 5 の C5 配線 AST-pin は、現状 `processDynamicFallbackBatch` 関数本体を **byte-window (offset 範囲) で slice** して save callsite ≥1 を pin する (F-05 scoped AST-pin)。これは file-wide regex の false-GREEN を回避するが、**byte-window は関数の前後に code 挿入されると drift しうる** (関数定義位置が動くと window 境界がずれる)。**現状の実害なし根拠**: surface 5 は C5 欠落を確実に検出し (false-GREEN なし)、関数境界 marker (関数名 + 終端) で window を再計算する fallback を持つ。**defense-in-depth 候補** (将来 PR、owner pipeline-engineer + test-qa-engineer): byte-window pin を **AST parser ベースの scoped function-slice** (関数 AST node を抽出して body 内 callsite を pin) に移行し、byte-offset drift を構造的に排除する。

**EN**: **2 L-severity test-infra defense-in-depth tracked-issues** confirmed during the Impl audit of W6 Issue A PR-3b (crop GDPR cascade + retention INV, IO Plan Decision V0 = CONDITIONAL `019ef9b2-3c92`). Neither causes real harm in the current release cycle (L severity, docs record + tracked, deadline 2026-06-25 = T+1d). **TPA-02** (L, cross-`.test.ts` const import): the `INV-CROP-RETENTION-001` 3s-SLA assertion (#4) SSOT-derives the `SLA_WITHIN_MS=3000` constant by **importing it from another `.test.ts` (`inv-data-delete-002-core.test.ts:82`)** (F-08, avoiding a `3000` literal re-declaration, same pattern as the CWE-209 truncateId SSOT-derive rigor); this is better than a hardcoded literal, but the **test-to-test import dependency** is not a production import, so a rename of `inv-data-delete-002-core.test.ts` / a move of `SLA_WITHIN_MS` could break `inv-crop-retention-001.test.ts` — a brittle-coupling surface. No current real harm because both tests live in the same gdpr-delete standing directory and `SLA_WITHIN_MS` is stable under the GDPR Art.12(3)/Art.17 "without undue delay" operational contract (ADR-0016). Defense-in-depth candidate (future PR, owner test-qa-engineer): move `SLA_WITHIN_MS` to a **non-test shared SSOT module** (e.g. `apps/mcp-server/src/services/gdpr-constants.ts`) so both tests import from there (promoting the test↔test import dependency to a production-SSOT import). **TDA-05** (L, byte-window pin → scoped function-slice): the `INV-CROP-COVERAGE-PARITY-001` surface-5 C5-wiring AST-pin currently **slices the `processDynamicFallbackBatch` function body by a byte-window (offset range)** to pin ≥1 save callsite (F-05 scoped AST-pin); this avoids the file-wide-regex false-GREEN, but a **byte-window can drift when code is inserted around the function** (the window boundary shifts if the function definition moves). No current real harm because surface 5 reliably detects a missing C5 (no false-GREEN) and recomputes the window via function-boundary markers (function name + terminator). Defense-in-depth candidate (future PR, owner pipeline-engineer + test-qa-engineer): migrate the byte-window pin to an **AST-parser-based scoped function-slice** (extract the function AST node and pin the in-body callsite), structurally eliminating byte-offset drift.

**Cross-ref**: Finding Registry `(TPA-02 / F-05 / F-08) /`apps/mcp-server/tests/regression/standing/gdpr-delete/inv-crop-retention-001.test.ts`(#4 SLA assertion,`SLA_WITHIN_MS`import) /`apps/mcp-server/tests/regression/standing/gdpr-delete/inv-data-delete-002-core.test.ts:82` (`SLA_WITHIN_MS`SSOT) /`apps/mcp-server/tests/regression/standing/large-page/inv-crop-coverage-parity-001.test.ts`(surface 5 byte-window pin) /`apps/mcp-server/src/workers/phases/phase-5-embedding.ts` (`processDynamicFallbackBatch:2911`) / `.claude/rules/security.md`§"Crop dir cascade`buildSafeCropDir`inline UUID validation defense-in-depth" (TDA-04) / IO Plan Decision V0 = CONDITIONAL`019ef9b2-3c92`/ IO Impl Decision V0 = CONDITIONAL`019ef9dc-0a60`.

### 10. Crop-cut clamp duplication — embedding-crop clamp vs viewable-PNG clamp residual (W6 Issue A PR-4a, TDA-IMPL-PR4A-L-01, tracked, L, deadline 2026-06-27 = T+1d) / Crop-cut clamp duplication — embedding-crop clamp と viewable-PNG clamp の残存 duplication

**JP**: W6 Issue A PR-4a (crop serve route + backfill、[ADR-0042](../specs/adr/ADR-0042-webui-internal-read-api.md) Amendment 12、IO Impl Decision V1 = APPROVE `019f028c`) は F-M-02 で crop-cut + truncation/clamp-gate を shared SSOT helper `cutCropFromScreenshot` (`crop-persistence.helper.ts`) に抽出し、backfill path (`scripts/backfill-crops.ts`) がこの SSOT 経由で viewable PNG crop を切り出すようにした (clamp-zero / off-screen / truncated bbox → null honest-skip)。一方、Phase 5 の **embedding-crop clamp** (224-downscale 専用 buffer 生成時の bbox clamp、`phase-5-embedding.ts` inline) は `cutCropFromScreenshot` SSOT を経由せず、embedding 用 raw buffer の clamp logic を別途持つ。すなわち「embedding 用 224-downscale crop の clamp」と「viewable PNG crop の clamp (SSOT)」が 2 箇所に残存する (TDA-IMPL-PR4A-L-01)。

**現状の実害なし根拠 / Why no current real harm**: (1) **両 clamp は別 output target** — embedding-crop clamp は DINOv2/e5 推論用の 224-downscale raw buffer を生成 (`.raw()` 直行、viewable PNG 中間物なし)、viewable-PNG clamp は human-viewing 用の `.png().toBuffer()` を生成。両者は同じ bbox-clamp 論理を共有するが output format/用途が異なるため、単純な full unify は terminal-marker state-machine (embedding skip_reason / crop skip-reason の判定) と entangle する。(2) **viewable-PNG path は SSOT 済** — PR-4a で導入した backfill crop と Phase 5 viewable crop はいずれも `cutCropFromScreenshot` SSOT を経由するため、viewable crop の clamp drift は構造的に防止済 (PR-4a が解決した範囲)。(3) **embedding-crop clamp は behavior-correct** — 既存 Phase 5 embedding は正しく clamp しており、本 duplication は coupling-drift latent surface に留まる。よって現リリースサイクルで実害はない → **L severity** (docs 記録 + tracked、deadline 2026-06-27 = T+1d)。**defensible**: embedding-crop clamp と viewable-PNG clamp の分離は terminal-marker state-machine と entangle するため、full unify は scope-creep であり PR-4a の minimal-scope を破る。

**Defense-in-depth 候補 / Defense-in-depth candidate** (将来 PR、owner pipeline-engineer + capture-embedding-engineer): embedding-crop clamp の bbox-clamp 部分を `cutCropFromScreenshot` SSOT の clamp core (output format-agnostic な clamp-only sub-helper) に集約し、224-downscale raw buffer 生成と viewable PNG 生成が **同じ clamp SSOT** を共有するよう refactor する。terminal-marker state-machine (skip_reason 判定) は clamp core から分離して各 path に残す (clamp の純粋部分のみ SSOT 化、判定は path 固有)。`INV-CROP-COVERAGE-PARITY-001` の clamp-honest-skip assert を embedding path にも拡張可能。

**EN**: W6 Issue A PR-4a (crop serve route + backfill, [ADR-0042](../specs/adr/ADR-0042-webui-internal-read-api.md) Amendment 12, IO Impl Decision V1 = APPROVE `019f028c`) extracted the crop-cut + truncation/clamp-gate into the shared SSOT helper `cutCropFromScreenshot` (`crop-persistence.helper.ts`) under F-M-02, so the backfill path (`scripts/backfill-crops.ts`) cuts the viewable PNG crop via this SSOT (a clamp-zero / off-screen / truncated bbox → null honest-skip). However, Phase 5's **embedding-crop clamp** (the bbox clamp when generating the 224-downscale-only buffer, inline in `phase-5-embedding.ts`) does NOT route through the `cutCropFromScreenshot` SSOT and keeps its own clamp logic for the embedding raw buffer. So "the embedding 224-downscale crop clamp" and "the viewable PNG crop clamp (SSOT)" remain in two places (TDA-IMPL-PR4A-L-01). No current real harm because (1) the two clamps target different outputs — the embedding-crop clamp generates a 224-downscale raw buffer for DINOv2/e5 inference (straight to `.raw()`, no viewable PNG intermediate), while the viewable-PNG clamp generates a `.png().toBuffer()` for human viewing; they share the same bbox-clamp logic but differ in output format/purpose, so a naive full unify would entangle with the terminal-marker state-machine (the embedding skip_reason / crop skip-reason determination); (2) the viewable-PNG path is already SSOT — both the PR-4a backfill crop and the Phase 5 viewable crop route through `cutCropFromScreenshot`, so viewable-crop clamp drift is structurally prevented (the scope PR-4a resolved); and (3) the embedding-crop clamp is behavior-correct — the existing Phase 5 embedding clamps correctly, so this duplication is a coupling-drift latent surface only. Hence no real harm in the current release cycle → **L severity** (docs record + tracked, deadline 2026-06-27 = T+1d). **Defensible**: separating the embedding-crop clamp from the viewable-PNG clamp entangles with the terminal-marker state-machine, so a full unify is scope-creep that would break PR-4a's minimal scope. Defense-in-depth candidate (future PR, owner pipeline-engineer + capture-embedding-engineer): consolidate the bbox-clamp part of the embedding-crop clamp into the `cutCropFromScreenshot` SSOT's clamp core (an output-format-agnostic clamp-only sub-helper), refactoring so the 224-downscale raw buffer generation and the viewable PNG generation share the **same clamp SSOT**; keep the terminal-marker state-machine (skip_reason determination) separate per path (SSOT-ize only the pure clamp part, leaving the determination path-specific); the `INV-CROP-COVERAGE-PARITY-001` clamp-honest-skip assert can be extended to the embedding path too.

**Cross-ref**: Finding Registry `(TDA-IMPL-PR4A-L-01 / F-M-02 crop-cut SSOT extraction) /`apps/mcp-server/src/services/part/crop-persistence.helper.ts` (`cutCropFromScreenshot`SSOT clamp/honest-skip) /`apps/mcp-server/src/workers/phases/phase-5-embedding.ts`(inline embedding-crop clamp, 224-downscale raw buffer) /`apps/mcp-server/scripts/backfill-crops.ts`(viewable PNG crop via the SSOT) /`INV-CROP-COVERAGE-PARITY-001`(clamp-honest-skip pin) /`.claude/rules/security.md`§"Crop serve route`hasCrop`part-path READ-sink belt asymmetry" (SEC-IMPL-PR4A-L-01) / IO Impl Decision V1 = APPROVE`019f028c`.

### 11. webui crop drill panel — hand-mirror contract-parity + raw `<img>` dimensions + handle scheme SSOT (W6 Issue A PR-4b, TDA-IMPL-PR4B-L-01 / TPA-IMPL-PR4B-L-01 / TPA-IMPL-PR4B-L-02, tracked, L, deadline 2026-06-27 = T+1d) / webui crop ドリルパネル — hand-mirror contract-parity + raw `<img>` dimensions + handle scheme SSOT

**JP**: W6 Issue A PR-4b (webui crop viewer、[ADR-0042](../specs/adr/ADR-0042-webui-internal-read-api.md) Amendment 12 consumer、IO Impl Decision V0 = APPROVE `019f02fc`) の Impl 監査で確認された **L severity の test/UI-hardening tracked-issue 3 件**。いずれも現リリースサイクルで実害なし (L severity、docs 記録 + tracked、deadline 2026-06-27 = T+1d)。

- **TDA-IMPL-PR4B-L-01** (L、hand-mirror contract-parity): webui の `SectionSummary`/`PartSummary` interface (`apps/webui/src/lib/api/internal-client.ts`) は backend `apps/mcp-server/src/api/internal/page-detail.service.ts` の同名 type の **hand-mirror** であり (cross-process HTTP 境界ゆえ intentional、W1 `TDA-IMPL-02` precedent)、PR-4b で `hasCrop: boolean` + `PartSummary.sectionPatternId: string` を additive 追加した。一方、webui hand-mirror と backend 型との間に **machine contract-parity test (type-shape diff / codegen) が存在しない** — backend が新 field を足す/型を変える drift は webui の **consumer typecheck / runtime でのみ捕捉**され、専用 CI guard がない。**現状の実害なし根拠**: (1) field を読む側 (drill panel) は typed summary 経由ゆえ、backend が emit する field を webui interface が欠くと `pnpm typecheck` が RED 化 (F-M-A の `sectionPatternId` 欠落も typecheck-RED で捕捉)。(2) hand-mirror は cross-process HTTP 境界の意図的設計 (webui は `@reftrixmcp/database` を import 不可、`INV-WEBUI-READONLY-NEGATIVE-001`) であり、共有型 import は layer-boundary を破る。よって drift は consumer typecheck で遅延検出され実害なし。**defense-in-depth 候補** (将来 PR、owner test-qa-engineer + backend-api-developer): webui hand-mirror と backend 型の **type-shape parity test** (例: backend type の field 集合を JSON snapshot 化し webui test で diff) OR **codegen** (backend type から webui mirror を生成) を導入し、drift を CI で先行検出する。

- **TPA-IMPL-PR4B-L-01** (L、raw `<img>` dimensions): drill panel の crop tile (`apps/webui/src/components/section-part-drill-panel.tsx`) は `hasCrop:true` 時に raw `<img src={src} alt={alt} loading="lazy" className="block h-auto w-full" />` を render するが、**`width`/`height` 属性を持たない** (crop aspect-ratio が section/part 毎に可変ゆえ `next/image` ではなく raw `<img>`、CLS guard は `min-height` reservation のみ — F-L-3)。**現状の実害なし根拠**: (1) **pre-backfill では crop 0 件** — disk に crop 0 件の今日では全 item が `hasCrop:false` で 視覚未取得 placeholder を render し、crop `<img>` 自体が描画されない (dominant render)。(2) CLS guard の `min-height` reservation が crop branch にのみ適用済 (空 placeholder には reserve しない、F-L-3) ゆえ、crop 出現後も layout-shift は min-height で緩和される。(3) `loading="lazy"` + `h-auto w-full` で aspect-ratio 自体は image 由来で正しく描画 (歪まない)。よって実害なし。**defense-in-depth 候補** (将来 PR、owner frontend-engineer): crop 出現後の CLS をさらに縮退させるため、crop tile に **aspect-ratio CSS** (`aspect-[w/h]` token OR intrinsic `width`/`height` 属性、backend が crop dimensions を `hasCrop` と共に emit する場合) を導入する。crop dimensions は現状 wire に載らないため (existence boolean のみ、CWE-209 minimisation)、aspect-ratio CSS は backend の crop-dimensions emit と連関 (PII 非該当の dimension のみ追加)。

- **TPA-IMPL-PR4B-L-02** (L、handle scheme SSOT): drill panel は machine-identity handle を **inline template literal** で構築する (`` `reftrix:page/${pageId}/section/${sectionId}` `` / `` `reftrix:page/${pageId}/section/${sectionPatternId}/part/${partId}` ``、`section-part-drill-panel.tsx`)。`reftrix:page/...` の handle scheme prefix/segment 構造が **SSOT const 化されておらず** inline literal として drill panel 内に直書きされている。**現状の実害なし根拠**: (1) handle は **machine identity の表示文字列** であり、section.inspect MCP tool (`reftrix:page/<id>/section/<id>` を解決する read tool、PR-1) の解決対象 scheme と論理的に一致するが、両者は別 process (webui display vs mcp-server tool) で同一 scheme を独立に構築する。(2) handle 構造は安定 (`reftrix:page/<pageId>/section/<sectionId>[/part/<partId>]`) で、scheme drift は section.inspect resolution の失敗として捕捉される (T1 = tool handler + INV)。(3) inline literal は behavior-correct (正しい handle 文字列を生成、copyable)。よって coupling-drift latent surface に留まり実害なし。**defense-in-depth 候補** (将来 PR、owner frontend-engineer + backend-api-developer): handle scheme の prefix/segment 構造を **webui-local SSOT const** (例: `buildSectionHandle(pageId, sectionId)` / `buildPartHandle(pageId, sectionPatternId, partId)` helper) に集約し、将来 handle を render する別 webui component が同一 SSOT を import するよう統一する。mcp-server 側 section.inspect の handle scheme とは別 process ゆえ webui-local SSOT で webui boundary 内の drift を防止 (cross-process の scheme 一致は section.inspect の INV が担保)。

**EN**: **3 L-severity test/UI-hardening tracked-issues** confirmed during the Impl audit of W6 Issue A PR-4b (webui crop viewer, [ADR-0042](../specs/adr/ADR-0042-webui-internal-read-api.md) Amendment 12 consumer, IO Impl Decision V0 = APPROVE `019f02fc`). None cause real harm in the current release cycle (L severity, docs record + tracked, deadline 2026-06-27 = T+1d). **TDA-IMPL-PR4B-L-01** (L, hand-mirror contract-parity): the webui `SectionSummary`/`PartSummary` interfaces (`apps/webui/src/lib/api/internal-client.ts`) are a **hand-mirror** of the same-named types in the backend `apps/mcp-server/src/api/internal/page-detail.service.ts` (intentional across the cross-process HTTP boundary, W1 `TDA-IMPL-02` precedent), and PR-4b additively added `hasCrop: boolean` + `PartSummary.sectionPatternId: string`; however, there is **no machine contract-parity test (type-shape diff / codegen) between the webui hand-mirror and the backend types** — a backend drift (adding a new field / changing a type) is caught **only by the webui consumer typecheck / runtime**, with no dedicated CI guard. No current real harm because (1) the reading side (the drill panel) goes through the typed summary, so if the webui interface lacks a field the backend emits, `pnpm typecheck` goes RED (the F-M-A `sectionPatternId` omission is also typecheck-RED-caught); and (2) the hand-mirror is the intentional cross-process HTTP-boundary design (the webui cannot import `@reftrixmcp/database`, `INV-WEBUI-READONLY-NEGATIVE-001`), so a shared-type import would break the layer boundary — so drift is lazily detected by the consumer typecheck, no real harm. Defense-in-depth candidate (future PR, owner test-qa-engineer + backend-api-developer): introduce a **type-shape parity test** (e.g. JSON-snapshot the backend type's field set and diff it in a webui test) OR **codegen** (generate the webui mirror from the backend type) so drift is detected ahead-of-time in CI. **TPA-IMPL-PR4B-L-01** (L, raw `<img>` dimensions): the drill panel's crop tile (`apps/webui/src/components/section-part-drill-panel.tsx`) renders a raw `<img src={src} alt={alt} loading="lazy" className="block h-auto w-full" />` when `hasCrop:true`, but it has **no `width`/`height` attributes** (a raw `<img>`, NOT `next/image`, because the crop aspect-ratio varies per section/part; the CLS guard is a `min-height` reservation only — F-L-3). No current real harm because (1) **pre-backfill, there are 0 crops** — with 0 crops on disk today, every item is `hasCrop:false` and renders the 視覚未取得 placeholder, so the crop `<img>` itself is not drawn (the dominant render); (2) the CLS-guard `min-height` reservation is applied only on the crop branch (not on the empty placeholder, F-L-3), so even after crops appear the layout-shift is mitigated by the min-height; and (3) `loading="lazy"` + `h-auto w-full` draws the aspect-ratio correctly from the image (no distortion). Hence no real harm. Defense-in-depth candidate (future PR, owner frontend-engineer): to further shrink the post-backfill CLS, introduce **aspect-ratio CSS** on the crop tile (an `aspect-[w/h]` token OR intrinsic `width`/`height` attributes, when the backend emits the crop dimensions alongside `hasCrop`); since crop dimensions are not on the wire today (existence boolean only, CWE-209 minimisation), the aspect-ratio CSS is coupled with a backend crop-dimensions emit (adding only non-PII dimensions). **TPA-IMPL-PR4B-L-02** (L, handle scheme SSOT): the drill panel builds the machine-identity handle with an **inline template literal** (`` `reftrix:page/${pageId}/section/${sectionId}` `` / `` `reftrix:page/${pageId}/section/${sectionPatternId}/part/${partId}` ``, `section-part-drill-panel.tsx`); the `reftrix:page/...` handle-scheme prefix/segment structure is **not SSOT-const-ized** and is inlined inside the drill panel. No current real harm because (1) the handle is a **machine-identity display string** that logically matches the scheme resolved by the section.inspect MCP tool (the read tool resolving `reftrix:page/<id>/section/<id>`, PR-1), but the two build the same scheme independently in different processes (webui display vs mcp-server tool); (2) the handle structure is stable (`reftrix:page/<pageId>/section/<sectionId>[/part/<partId>]`), so a scheme drift would surface as a section.inspect resolution failure (T1 = the tool handler + INV); and (3) the inline literal is behavior-correct (it generates the correct, copyable handle string). Hence this is a coupling-drift latent surface only, no real harm. Defense-in-depth candidate (future PR, owner frontend-engineer + backend-api-developer): consolidate the handle-scheme prefix/segment structure into a **webui-local SSOT const** (e.g. `buildSectionHandle(pageId, sectionId)` / `buildPartHandle(pageId, sectionPatternId, partId)` helpers) so a future webui component rendering a handle imports the same SSOT; because the mcp-server section.inspect handle scheme is a different process, the webui-local SSOT prevents drift within the webui boundary (cross-process scheme agreement is guaranteed by the section.inspect INV).

**Cross-ref**: Finding Registry `(TDA-IMPL-PR4B-L-01 / TPA-IMPL-PR4B-L-01 / TPA-IMPL-PR4B-L-02) /`apps/webui/src/lib/api/internal-client.ts`(webui`SectionSummary`/`PartSummary`hand-mirror) ↔`apps/mcp-server/src/api/internal/page-detail.service.ts`(backend types,`hasCrop:158/185`/`sectionPatternId:169`) / `apps/webui/src/components/section-part-drill-panel.tsx`(raw`<img>`no width/height + inline handle template literals) /`apps/webui/src/components/crop-handle-copy.tsx`(copy island) /`INV-WEBUI-READONLY-NEGATIVE-001` (`INV-WEBUI-CROP-READONLY`layer boundary, no`@reftrixmcp/database`import) /`apps/mcp-server/src/tools/section/inspect.tool.ts`(section.inspect handle-scheme resolver, PR-1) /`.claude/rules/security.md`§"webui crop proxy`UUID_EARLY_REJECT`inline literal vs mcp-server SSOT validator" (SEC-IMPL-PR4B-L-01 = TDA-IMPL-PR4B-L-02) / IO Impl Decision V0 = APPROVE`019f02fc`.

**Status update (W7b-0, IO Impl Decision = APPROVE `019f2b92-7df1`): TPA-IMPL-PR4B-L-02 (handle scheme SSOT) → FIXED — 他 2 件は OPEN のまま**. `.claude/rules/security.md` §"L-tracked defense-in-depth bundle PR — tracked-issue status update" と同じ supersede 方式に従い、**TPA-IMPL-PR4B-L-02 の 1 件のみ** status を canonical に更新する (origin prose は origin record として保持)。

**JP**: W7b-0 が documented candidate どおり、handle scheme の prefix/segment 構造を `apps/webui/src/lib/handle.ts` の `buildSectionHandle(pageId, sectionId)` / `buildPartHandle(pageId, sectionPatternId, partId)` (署名まで candidate と一致、`sectionPatternId` 保持) に SSOT 集約した。drill-panel (`apps/webui/src/components/section-part-drill-panel.tsx`) が同 SSOT を import し、inline `reftrix:page/${…}` template literal 残存 0。`INV-WEBUI-CROP-TILE-HANDLE-SSOT` (`apps/webui/tests/security/crop-tile-handle-ssot.test.ts` の handle-builder SSOT leg) が inline 残存 0 を pin。

**EN**: W7b-0 consolidated the handle-scheme prefix/segment structure into `buildSectionHandle(pageId, sectionId)` / `buildPartHandle(pageId, sectionPatternId, partId)` in `apps/webui/src/lib/handle.ts` (signatures match the candidate, `sectionPatternId` preserved) exactly per the documented candidate. The drill panel (`apps/webui/src/components/section-part-drill-panel.tsx`) imports the same SSOT, leaving **0** inline `reftrix:page/${…}` template literals; the handle-builder SSOT leg of `INV-WEBUI-CROP-TILE-HANDLE-SSOT` (`apps/webui/tests/security/crop-tile-handle-ssot.test.ts`) pins the 0-inline-residue.

**OPEN のまま (W7b-0 では close されない) / Still OPEN (NOT closed by W7b-0)** — over-claim guard (LCC-I02): 本 §11 の他 2 件は **W7b-0 の scope 外** であり **OPEN のまま**。FIXED と扱ってはならない:

- **TDA-IMPL-PR4B-L-01** (hand-mirror contract-parity) — **OPEN**: webui↔mcp-server の type-shape parity test / codegen は未導入 / the type-shape parity test / codegen is not introduced.
- **TPA-IMPL-PR4B-L-01** (raw `<img>` dimensions) — **OPEN**: crop tile の aspect-ratio CSS / intrinsic width/height は未導入 (backend crop-dimensions emit に連関) / the aspect-ratio CSS / intrinsic width/height is not introduced (coupled with a backend crop-dimensions emit).

**Cross-ref (W7b-0 status update)**: `apps/webui/src/lib/handle.ts` (`buildSectionHandle` / `buildPartHandle` SSOT) / `apps/webui/src/components/section-part-drill-panel.tsx` (drill-panel consumer) / `apps/webui/tests/security/crop-tile-handle-ssot.test.ts` (`INV-WEBUI-CROP-TILE-HANDLE-SSOT` handle-builder leg) / `.claude/rules/security.md` §"webui crop proxy `UUID_EARLY_REJECT` inline literal vs mcp-server SSOT validator" (SEC-IMPL-PR4B-L-01 W7b-0 FIXED, same PR) / IO Impl Decision = APPROVE `019f2b92-7df1`.

### 12. Transform-level `page.evaluate` `__name`-injection standing INV + DOD-DISCOVERY-01 honest coverage framing (W6 Issue A `__name` fix, large-page, deadline 2026-07-02 = T+1d) / transform レベル `page.evaluate` `__name`-injection standing INV + DOD-DISCOVERY-01 honest coverage framing

**JP**: W6 Issue A の `__name` ReferenceError 修正で **新 standing regression** `INV-PAGE-EVALUATE-NO-NAME-INJECTION-001`（H、large-page、`tests/regression/standing/large-page/inv-page-evaluate-no-name-injection-001.test.ts`）を追加した。これは **transform レベル不変条件**（esbuild + ts-morph を production source に適用）で、`runBboxPageEvaluate`（`part-bbox-playwright.service.ts`）の `page.evaluate` callback **body span** が tsx-faithful な `keepNames` transform 下で `__name(...)` を **0 件** emit することを assert する。host が worker をどう起動するか（tsx vs dist）に関係なく SOURCE が tsx 下で `__name` を emit し得ないことを assert するため **host 非依存**（M-4 launch-path severity 曖昧性に頑健）。

**load-bearing なテスト設計詳細 / load-bearing test-design details**:

- **L-11 body-span scoping（make-or-break）**: `__name(` の count は `page.evaluate` 引数 callback の **body span** に scope する（transform 済 module 全体ではない）。module 全体の output は外側 `runBboxPageEvaluate` 自身の keepNames `__name` wrap（callback 外）+ file 内の無関係 wrap ~16 個を含むため、whole-module count は clean fix を **false-RED** にする（TDA controlled mutation 実証: CLEAN scoped `nameInBody`=0 / whole-module=14、MUTATED scoped=1 で回帰検出可）。AST locator が `page.evaluate`/`evaluateHandle` の引数 callback body のみを取り出す。
- **非空虚性 2-guard（M-3）**: (a) positive-control — named-bound な `page.evaluate` callback fixture が **同一 transform** 下で callback body に `__name` を emit することを assert（0-count assertion が空虚でないことの証明）、(b) locator-guard — AST-locate が gate function 内の callback を **≥1 件**抽出したことを assert（「0 件発見→vacuous GREEN」を構造排除）。
- **L-3 provenance guard**: transform opts（`keepNames` + `minifyWhitespace`）を導入済 tsx 自身の frozen transform options から derive/pin する（option literal の手動維持を避け config-drift false-GREEN を防止）。将来 tsx が keepNames/minifyWhitespace を drop すると provenance guard が drift を RED-flag する。
- **orthogonal-complementary**: 既存 `INV-TOLERANCE-NON-GATING-001`（semantic parity: Node SSOT との等価性を Layer (i) AST-pin + Layer (ii)/(iii) jsdom で pin）と直交相補。本 INV は **serialize 安全性**（`__name` 非注入）を別軸で pin し、`INV-TOLERANCE-NON-GATING-001` は無改変・GREEN のまま。同一 `page.evaluate` callback を 2 軸（semantic 等価 + serialize 安全）で守る。
- **Tier1-only + Tier2 deferred**: landing は Tier1（`runBboxPageEvaluate`）のみ。codebase-wide な Tier2 scan は follow-up PR に deferred — PRE-step 2 が motion/animation detector（webgl-animation-detector / runtime-animation-detector）に追加の tsx-reachable な unsafe `page.evaluate` body を発見しており（本 PR scope 外）、allowlist-free な Tier2 INV を同梱すると landing 時 standing-RED = P0 incident になるため（M-2 / plan §5.5 / §9 case-C）。`H-NEW-02-motion-name-injection`（owner pipeline-engineer / motion ドメイン、deadline 2026-07-02）として cross-domain follow-up に tracked。
- **検証**: 新 INV file = vitest 26 passed; FULL standing 4 ドメイン 138 files・956 tests passed・0 failed（IO ground-truth）。

**DOD-DISCOVERY-01 — honest coverage framing（必須、over-claim 禁止）**: `__name` 修正は既存ページ crop coverage lift の **必要条件だが十分条件ではない**。修正時点で `section_patterns` の **0 / 4919** のみが `layout_info.sectionSelector` を持つ（WRITE path は PR-2 / F-M-04 で追加され、既存 section は全て PR-2 以前 ingest）。新 containment gate は `if (!part.sectionSelector) return null`（`part-bbox-playwright.service.ts:819`）ゆえ、既存ページの backfill は **throw 除去後も `resolvedCount: 0`**（`__name` 修正と完全直交）。既存ページ coverage を上げるには **全ページ再解析**（sectionSelector を popul; 原 RCA `019f033c` Q1 領域 = より大きい別 effort、owner triangle-principal-agent / pipeline-engineer、User 判断）が必要。一方 **fresh `page.analyze`** は sectionSelector を popul し `resolvedCount > 0` になる（stripe.com 実測: sectionSelector 0→14 + resolvedCount 0→18 + warn 消失）。したがって本 PR の DoD は「fix が bbox 解決を機能させる」ことの実証であり、「既存ページの coverage が上がる」ことの実証ではない（この区別を honest に維持し、CI でも coverage 向上を assert しない）。

**EN**: The W6 Issue A `__name` ReferenceError fix adds the **new standing regression** `INV-PAGE-EVALUATE-NO-NAME-INJECTION-001` (H, large-page, `tests/regression/standing/large-page/inv-page-evaluate-no-name-injection-001.test.ts`): a **transform-level invariant** (esbuild + ts-morph over the production source) asserting that the `runBboxPageEvaluate` (`part-bbox-playwright.service.ts`) `page.evaluate` callback **body span** emits **zero** `__name(...)` under a tsx-faithful `keepNames` transform. It is **host-independent by construction** (it asserts the SOURCE cannot emit `__name` under tsx regardless of how a host launches the worker, tsx vs dist — robust to the M-4 launch-path severity ambiguity). Load-bearing test-design details: **L-11 body-span scoping (make-or-break)** — the `__name(` count is scoped to the `page.evaluate` argument-callback body, NOT the whole transformed module, because the whole-module output also carries the OUTER `runBboxPageEvaluate` keepNames `__name` wrap (+ ~16 unrelated wraps in the file), so a whole-module count would false-RED a clean fix (TDA controlled mutation: CLEAN scoped `nameInBody`=0 / whole-module=14, MUTATED scoped=1 detects regression); the AST locator extracts only the `page.evaluate`/`evaluateHandle` argument-callback body. **non-vacuity 2-guard (M-3)** — (a) a positive-control named-bound `page.evaluate` callback fixture MUST emit `__name` in its body under the same transform (proves the 0-count is not vacuous), (b) the AST locator-guard MUST extract ≥1 callback inside the gate function (structurally excludes "0 found → vacuous GREEN"). **L-3 provenance guard** — the transform opts (`keepNames` + `minifyWhitespace`) are derived/pinned from the installed tsx's own frozen transform options (no manual literal maintenance; config-drift false-GREEN prevented); a future tsx dropping keepNames/minifyWhitespace RED-flags the drift. **orthogonal-complementary** — it complements the existing `INV-TOLERANCE-NON-GATING-001` (semantic parity vs the Node SSOT, Layer (i) AST-pin + Layer (ii)/(iii) jsdom) on a different axis: this INV pins **serialize-safety** (no `__name` injection) while `INV-TOLERANCE-NON-GATING-001` stays untouched and GREEN — the same `page.evaluate` callback is guarded on two axes (semantic equivalence + serialize safety). **Tier1-only + Tier2 deferred** — it lands Tier1 (`runBboxPageEvaluate`) only; a codebase-wide Tier2 scan is deferred to a follow-up PR because PRE-step 2 found additional tsx-reachable unsafe `page.evaluate` bodies in the motion/animation detectors (webgl-animation-detector / runtime-animation-detector, out of THIS PR's scope), so an allowlist-free Tier2 INV would land standing-RED = a P0 incident (M-2 / plan §5.5 / §9 case-C); tracked as the cross-domain follow-up `H-NEW-02-motion-name-injection` (owner pipeline-engineer / motion domain, deadline 2026-07-02). Verification: the new INV file = vitest 26 passed; FULL standing 4-domain 138 files・956 tests passed・0 failed (IO ground-truth). **DOD-DISCOVERY-01 — honest coverage framing (mandatory, no over-claim)**: the `__name` fix is a **necessary but NOT sufficient** condition for existing-page crop coverage lift. At fix-time only **0 / 4919** `section_patterns` carry a `layout_info.sectionSelector` (the WRITE path was added in PR-2 / F-M-04; all existing sections were ingested before PR-2), and the new containment gate is `if (!part.sectionSelector) return null` (`part-bbox-playwright.service.ts:819`), so an existing-page backfill returns `resolvedCount: 0` **even after the throw is removed** (fully orthogonal to `__name`). Lifting existing-page coverage requires a **full re-analysis of every page** (populating sectionSelector; the original RCA `019f033c` Q1 region — a larger, separate effort, owner triangle-principal-agent / pipeline-engineer, User decision), whereas a fresh `page.analyze` populates sectionSelector and yields `resolvedCount > 0` (empirically on stripe.com: sectionSelector 0→14 + resolvedCount 0→18 + warn disappeared). This PR's DoD therefore proves "the fix makes bbox resolution function", NOT "existing-page coverage rises" — keep this distinction honest and do NOT assert a coverage gain in CI.

**Cross-ref**: Finding Registry `(M-3 / M-2 / M-4 / L-3 / L-11 / DOD-DISCOVERY-01 / H-NEW-02; IO Impl Decision = APPROVE) /`apps/mcp-server/tests/regression/standing/large-page/inv-page-evaluate-no-name-injection-001.test.ts` (`INV-PAGE-EVALUATE-NO-NAME-INJECTION-001`) / `apps/mcp-server/src/services/part/part-bbox-playwright.service.ts` (`runBboxPageEvaluate`; `if (!part.sectionSelector) return null` `:819`) / `INV-TOLERANCE-NON-GATING-001`(orthogonal-complementary, untouched) /`apps/mcp-server/src/tools/page/handlers/layout-handler.ts:1092`+`apps/mcp-server/src/services/worker-db-save.service.ts:325`(sectionSelector producer/persist, PR-2 / F-M-04) /`.claude/rules/security.md` §"`sanitizeErrorMessage`on server-side logs masks root cause" (SEC-L-01 = L-1) /`.claude/rules/git-workflow.md` §Standing Regression (large-page domain).

## カバレッジ目標 / Coverage Targets

| 指標 / Indicator           | 目標 / Target                         |
| -------------------------- | ------------------------------------- |
| ステートメント / Statement | > 80%                                 |
| ブランチ / Branch          | > 70%                                 |
| 関数 / Function            | > 85%                                 |
| E2E                        | 主要フロー100% / All major flows 100% |

## テストフレームワーク / Test Frameworks

| 種別 / Type      | ツール / Tool | バージョン / Version               |
| ---------------- | ------------- | ---------------------------------- |
| Unit/Integration | Vitest        | 4.x（全パッケージ / all packages） |
| E2E              | Playwright    | 1.57.0                             |

## Vitest設定 / Vitest Configuration

メモリ枯渇防止のため最大3ワーカー:

Max 3 workers to prevent memory exhaustion:

```bash
pnpm test --maxWorkers=3
```

### vitest.config.mts推奨設定 / Recommended vitest.config.mts

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    pool: "forks",
    maxWorkers: 3, // 各ワーカー約3.5GB消費 / ~3.5GB per worker
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    // テスト環境変数設定 / Test environment variables
    env: {
      NODE_ENV: "test",
      MCP_SKIP_RATE_LIMIT: "true",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["node_modules/", "dist/", "tests/", "**/*.test.ts", "**/*.config.ts"],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 80,
      },
    },
    // タイムアウト設定 / Timeout configuration
    // Video Mode / Lighthouse 統合テストは60秒必要 / Video Mode / Lighthouse integration tests need 60s
    testTimeout: 60000,
    hookTimeout: 60000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
```

## E2Eテスト（Playwright） / E2E Tests (Playwright)

### ✅ PASS基準（pass@1: 初回成功率 100%） / PASS Criteria (pass@1: 100% first-attempt success rate)

**必須要件 / Required**:

- ✅ Playwright + Chromium使用 / Use Playwright + Chromium
- ✅ スクリーンショット撮影・目視確認 / Screenshot capture and visual verification
- ✅ 保存先: Playwrightの設定に従う（デフォルト: `test-results/`） / Save location follows Playwright config (default: `test-results/`)
- ✅ すべてのE2Eテストが通過（0 failed） / All E2E tests pass (0 failed)

**主要フロー（E2E 100%必須） / Major Flows (E2E 100% required)**:

**MCPサーバー向け / For MCP Server**:

1. ✅ MCPツール実行（layout.ingest, motion.detect, quality.evaluate） / MCP tool execution
2. ✅ Embedding生成・ベクトル検索 / Embedding generation and vector search
3. ✅ HTMLサニタイゼーション・SSRF対策 / HTML sanitization and SSRF protection
4. ✅ エラーハンドリング（無効入力、タイムアウト） / Error handling (invalid input, timeout)

5. ✅ ページ表示・ナビゲーション / Page rendering and navigation
6. ✅ アクセシビリティ検証（WCAG 2.1 AA） / Accessibility verification (WCAG 2.1 AA)
7. ✅ レスポンシブデザイン確認 / Responsive design verification
8. ✅ エラーページ表示 / Error page display

### ❌ FAIL基準 / FAIL Criteria

- ❌ 主要フローのいずれかが通過しない / Any major flow fails
- ❌ スクリーンショットが保存されていない / Screenshots not saved
- ❌ Playwrightの代わりにPuppeteerを使用 / Using Puppeteer instead of Playwright
- ❌ テストが環境依存で不安定（flaky） / Tests are environment-dependent and flaky

### 環境設計（重要） / Environment Design (Important)

**各試行が清潔な環境から開始 / Each trial starts from a clean environment**:

```typescript
// ✅ 良い例: 各テストで独立した状態
test.beforeEach(async ({ page, context }) => {
  // ローカルストレージ・Cookie・キャッシュをクリア
  await context.clearCookies();
  await page.evaluate(() => localStorage.clear());
  await page.goto("http://localhost:YOUR_APP_PORT");
});

// ❌ 悪い例: 状態が残る
test("test 1", async ({ page }) => {
  await page.fill("#input", "value1");
  // 次のテストに状態が漏れる可能性
});
```

**テスト対象 / Test Targets**:

- 新規ページ作成時 / When creating new pages
- UIコンポーネントの重要な変更 / Significant UI component changes
- ユーザーフロー / User flows
- フォーム送信・バリデーション / Form submission and validation

### フレームキャプチャ（アニメーション検証） / Frame Capture (Animation Verification)

**デフォルト設定**: 15px/frame、30fps等価、PNG出力

**詳細仕様**: [references/testing-frame-analysis.md](./references/testing-frame-analysis.md)

## テストコマンド / Test Commands

```bash
pnpm test                          # 全テスト（Vitest）
pnpm test:watch                    # ウォッチモード
pnpm test:coverage                 # カバレッジ
pnpm --filter @reftrixmcp/mcp-server test:e2e             # E2Eテスト（CI） / E2E tests (CI)
pnpm --filter @reftrixmcp/mcp-server test:e2e:playwright  # E2Eテスト（ローカルPlaywright） / E2E tests (local Playwright)
```

## Preference Profiling テスト / Preference Profiling Tests

Phase 3（セキュリティ監査修復）で追加されたテストスイート:

Test suites added during Phase 3 (security audit remediation):

| テストファイル / Test File                          | テスト数 / Tests | 対象 / Coverage                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/services/preference-profile.service.test.ts` | 29               | サービス層ユニットテスト: getSamples, processFeedback, getProfile, resetProfile, deleteProfile, getSignals, confidence計算, DI/ファクトリー / Service layer unit tests: getSamples, processFeedback, getProfile, resetProfile, deleteProfile, getSignals, confidence calculation, DI/factory |
| `tests/tools/preference/security.test.ts`           | 13               | セキュリティテスト: SQLインジェクション防御, 不正UUID, 超長文字列, エラーメッセージサニタイズ / Security tests: SQL injection defense, invalid UUID, oversized strings, error message sanitization                                                                                           |

### v0.2.0 Tier 1 テストスイート / v0.2.0 Tier 1 Test Suites

| テストファイル / Test File                    | テスト数 / Tests | 対象 / Coverage                                                                                       |
| --------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `tests/middleware/rate-limiter.test.ts`       | 37               | Token Bucket, Redis/インメモリ, 3ティア, NaN防御 / Token Bucket, Redis/in-memory, 3-tier, NaN defense |
| `tests/services/search-cache.service.test.ts` | ~24              | LRUキャッシュ, TTL, invalidation, 統計 / LRU cache, TTL, invalidation, stats                          |
| `tests/admin/bull-board.test.ts`              | ~16              | BullMQ UI設定, Basic Auth, ポート / BullMQ UI config, Basic Auth, port                                |
| `tests/tools/search-unified.tool.test.ts`     | ~67              | 横断検索, 5サービス統合, キャッシュ / Unified search, 5-service integration, cache                    |

#### v0.2.0 追加テストスイート / v0.2.0 Additional Test Suites

| テストファイル / Test File                           | テスト数 / Tests | 対象 / Coverage                                         |
| ---------------------------------------------------- | ---------------- | ------------------------------------------------------- |
| `tests/scripts/db-migrate-safe.test.ts`              | 16               | 安全マイグレーションスクリプト / Safe migration script  |
| `tests/services/filter-unification.test.ts`          | 44               | フィルタ統一 / Filter unification                       |
| `tests/services/hnsw-iterative-scan.test.ts`         | 7                | HNSW反復スキャン / HNSW iterative scan                  |
| `tests/tools/design/search-by-image.tool.test.ts`    | 54               | 画像検索ツール / Image search tool                      |
| `tests/utils/sanitize-error.test.ts`                 | 30               | エラーサニタイズユーティリティ / Error sanitize utility |
| `tests/workers/phases/phase-parallelization.test.ts` | 16               | Phase 1/3逐次実行 / Phase 1/3 sequential execution      |

## 品質ゲート（CI必須） / Quality Gates (CI Required)

- テストカバレッジ 80%以上 / Test coverage above 80%
- E2Eテスト 100%パス / E2E tests 100% pass
- ESLintエラー 0件 / ESLint errors: 0
- TypeScriptエラー 0件 / TypeScript errors: 0
- フォーマット準拠 / Format compliance: `pnpm format:check`
- セキュリティ脆弱性（High/Critical）0件 / Security vulnerabilities (High/Critical): 0

## lint/typecheckの実行 / Running lint/typecheck

タスク完了時は必ず `pnpm lint`、`pnpm typecheck`、`pnpm format:check` を実行してコードの正確性を確認する。

Always run `pnpm lint`, `pnpm typecheck`, `pnpm format:check` upon task completion to verify code correctness.

---

## Standing Regression Suite / 常設 regression suite (最重要 / CRITICAL)

### 目的 / Purpose

Reftrix は 4 つの critical ドメインに **常設 regression suite** を持つ。このスイートは CI で常時実行され、新規変更が既存の不変条件を破壊しないことを保証する。失敗は **P0 incident** 扱い。

Reftrix maintains a **standing regression suite** for 4 critical domains. This suite runs on every CI invocation and ensures new changes do not break existing invariants. Failures are **P0 incidents**.

### 4 ドメイン / 4 Domains

| #   | Domain                                  | 不変条件 / Invariants                                                                                                                                                                                                                                                                                                                                                                                                          | Owner Agent                                    | 代表 INV-\*           | 配置 / Location                               |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | --------------------- | --------------------------------------------- |
| 1   | **large-page** / 大規模ページ処理       | page.analyze >100 parts → backfill worker 経由で completed/failed/skipped\_\* の終端状態に到達<br>Phase 5 fork 分離 (ONNX Runtime OOM 回避)<br>RSS メモリ閾値 (warn 2.5GB / kill 4GB)<br>Stall recovery + Pre-Return Pause<br>Embedding backfill Queue (jobId uniqueness, `embeddingBackfillStatus` transitions)                                                                                                               | pipeline-engineer + capture-embedding-engineer | `INV-PAGE-QUEUE-001`  | `tests/regression/standing/large-page/`       |
| 2   | **gdpr-delete** / GDPR 削除契約         | `data.delete` → screenshot / blob / vector (pgvector) / audit_logs の残存状態が定義通り<br>GDPR Art.17 同期削除<br>Screenshot 保持 = `data.delete` まで (TTL cron 撤去済 / ADR-0041 / `INV-SCREENSHOT-RETENTION-001`)<br>GDPR Art.30 audit_logs 記録 (削除件数 0 超のすべての run)                                                                                                                                             | pipeline-engineer + legal-compliance-counsel   | `INV-DATA-DELETE-002` | `tests/regression/standing/gdpr-delete/`      |
| 3   | **worker-lifecycle** / Worker 生存管理  | WorkerSupervisor 再起動 (maxJobsBeforeRestart=1)<br>Pre-Return Pause パターン (success path pause + failure path no-pause + resume 分岐)<br>Redis dual-run lock (`WorkerActiveLockService` + UUID nonce + 60s TTL + 30s heartbeat)<br>discriminated union API (`tryAcquireLock` / `probeExistingLock`) fail-open vs fail-closed<br>IPC boundary (child_process.fork) Zod 再検証<br>heartbeat timeout (60s)<br>3-phase shutdown | pipeline-engineer                              | `INV-WORKER-LOCK-003` | `tests/regression/standing/worker-lifecycle/` |
| 4   | **schema-enum-sync** / Schema-enum 同期 | Prisma schema ↔ TypeScript type ↔ Zod schema ↔ OpenAPI / MCP tool spec の4箇所で enum 値が完全一致<br>`EmbeddingSkipReason` (12 values)、`EmbeddingBackfillStatus` (7 values)、その他全 enum の exhaustive mapping<br>enum value drift 検出 (CI で型不一致を即 fail)                                                                                                                                                           | backend-api-developer + platform-engineer      | `INV-SCHEMA-ENUM-004` | `tests/regression/standing/schema-enum-sync/` |

### 運用ルール / Operational Rules

| ルール / Rule                                | 詳細 / Details                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **配置 / Location**                          | `tests/regression/standing/<domain>/` 配下に domain 別サブディレクトリ                                                            |
| **CI 実行 / CI execution**                   | `.github/workflows/` に `regression-standing` job を常設。`pnpm test:regression:standing` で全4ドメイン実行                       |
| **PR 要件 / PR requirements**                | 標準 `pnpm test` に加え、4ドメインに該当する PR は **standing regression suite が必ず PASS** であること                           |
| **失敗時 / On failure**                      | **P0 incident** — pipeline-engineer / security-engineer へ即時エスカレート。merge 即時ブロック                                    |
| **4ドメイン該当変更 / Changes in 4 domains** | IO の Finding Registry で `Regression domain:` フィールド必須記入、該当 domain の standing suite への test landing を required に |
| **CI-failing 要件 / CI-failing requirement** | standing regression のテストは必ず CI で fail する実行可能テスト。`.skip` / `.todo` / `describe.skip` 禁止                        |
| **INV-\* との対応 / INV-\* mapping**         | 各 standing test は必ず 1 つ以上の INV-\* に紐付く (test 内で `// INV-PAGE-QUEUE-001` コメントで明示)                             |

### テストコマンド / Test Commands

```bash
# 全 standing regression suite 実行
pnpm test:regression:standing

# ドメイン別実行
pnpm test:regression:standing --filter large-page
pnpm test:regression:standing --filter gdpr-delete
pnpm test:regression:standing --filter worker-lifecycle
pnpm test:regression:standing --filter schema-enum-sync
```

### 失敗時の対応 / Failure Response

standing regression の fail は **P0 incident** 扱い:

1. **即時 merge block** — PR が standing regression で fail → merge 禁止 (IO は自動 BLOCK)
2. **即時エスカレーション** — pipeline-engineer (worker-lifecycle / large-page) または security-engineer (gdpr-delete) または backend-api-developer (schema-enum-sync) へ通知
3. **一時的 disable 禁止** — `.skip` で放置することは禁止。必ず fail 原因を修正するか INV-\* を改訂 (ADR 必須) する

### 関連ドキュメント / Related

- Workflow: `CLAUDE.md` "常設 Regression Suite / Standing Regression Suite" セクション
- IO: `.claude/agents/integration-owner.md` "Standing Regression Suite" セクション
- ADR-0007 (Phase 5 Queue-based Backfill): large-page domain の背景
- ADR-0011 (Worker Dual-run Lock): worker-lifecycle domain の背景

---

## 真実の源泉 / Source of Truth (for Tests)

**テストはコード化された契約と同列に正典 (T1 Canonical)**。docs と矛盾した時はテストが勝つ。テスト自体を stale なドキュメントに合わせて書き換えることは禁止。

**Tests are T1 Canonical source of truth**, alongside coded contracts. When docs contradict tests, tests win. Never rewrite tests to match stale docs.

詳細は `CLAUDE.md` の "真実の源泉 / Source of Truth Hierarchy" セクション参照。
