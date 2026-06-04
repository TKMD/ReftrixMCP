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
| 2   | **gdpr-delete** / GDPR 削除契約         | `data.delete` → screenshot / blob / vector (pgvector) / audit_logs の残存状態が定義通り<br>GDPR Art.17 同期削除<br>Screenshot 7d TTL cron<br>GDPR Art.30 audit_logs 記録 (削除件数 0 超のすべての run)                                                                                                                                                                                                                         | pipeline-engineer + legal-compliance-counsel   | `INV-DATA-DELETE-002` | `tests/regression/standing/gdpr-delete/`      |
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
