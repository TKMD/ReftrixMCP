# データ保持ポリシー / Data Retention Policy

**対象 / Scope**: Reftrix Preference Profiling, Part-Level Analysis, Section Visual Embedding & v0.3.0 Tables
**最終更新 / Last Updated**: 2026-04-15
**バージョン / Version**: 2.8.0

---

## 1. 対象データ / Data in Scope

### 対象テーブル / Tables

| テーブル / Table                                | 内容 / Description                                   | 主なカラム / Key Columns                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preference_profiles`                           | ユーザー嗜好プロファイル / User preference profiles  | `id`, `name`, `preference_text`, `preference_embedding` (768-dim vector), `interaction_count`, `created_at`, `updated_at`                                                                                                                                            |
| `preference_signals`                            | 個別フィードバック記録 / Individual feedback records | `id`, `profile_id` (FK), `signal_type`, `signal_weight`, `target_type`, `target_id`, `feedback_text`, `created_at`                                                                                                                                                   |
| `component_parts` / `component_part_embeddings` | UIパーツ分析データ / UI part analysis data           | `id`, `web_page_id` (FK, CASCADE), `partType`, `text_embedding` (768-dim vector), `visual_embedding` (768-dim vector, nullable), `boundingBox`, `computedStyles`, `textContent`, `innerHTML`, `piiRiskLevel`, `cssClasses`, `attributes`, `created_at`, `updated_at` |
| `section_embeddings`                            | セクション視覚ベクトル / Section visual embedding    | `section_pattern_id` (FK, CASCADE), `vision_embedding` (768-dim vector, nullable)                                                                                                                                                                                    |
| `audit_logs`                                    | 監査ログ / Audit logs (GDPR Art.30)                  | `id`, `timestamp`, `action`, `actor`, `target_type`, `target_id` (truncated), `details`, `ip_address`, `result`                                                                                                                                                      |
| `search_logs`                                   | 検索ログ / Search logs                               | `id`, `timestamp`, `query` (200字制限), `query_type`, `services`, `result_count`, `profile_id` (truncated), `latency_ms`, `cache_hit`                                                                                                                                |
| `design_snapshots` / `design_snapshot_sections` | デザインスナップショット / Design snapshots          | `id`, `web_page_id` (FK, CASCADE), `snapshot_at`, `section_count`, `text_embedding`, `vision_embedding`                                                                                                                                                              |

### データの性質 / Nature of Data

- **処理目的 / Purpose of Processing**: デザイン検索結果のパーソナライズ（嗜好に基づくリランキング） / Personalization of design search results (preference-based reranking)
- **データ主体 / Data Subjects**: Reftrixツールを使用する個人ユーザー（ローカルファースト・シングルユーザー構成） / Individual users of the Reftrix tool (local-first, single-user architecture)
- **個人データの種類 / Types of Personal Data**: デザイン嗜好テキスト、フィードバック評価（positive/negative/neutral）、コメント / Design preference text, feedback ratings (positive/negative/neutral), comments

---

## 2. 保持期間 / Retention Period

### 方針 / Policy

嗜好プロファイルデータは、ユーザーが明示的に削除するまで保持されます。自動的な期限切れや定期削除はありません。

Preference profile data is retained until the user explicitly deletes it. There is no automatic expiration or scheduled deletion.

### 根拠 / Rationale

Reftrixはローカルファースト・シングルユーザーのMCPツールとして設計されています。データは原則としてユーザーのローカル環境に保存され、嗜好プロファイルはユーザーが継続的にツールを使用する間、検索品質の向上に寄与します。

Reftrix is designed as a local-first, single-user MCP tool. Data is stored in the user's local environment, and the preference profile contributes to search quality improvement while the user continues using the tool.

### 法的根拠 / Legal Basis

- **GDPR Art. 5(1)(e)** — 保存制限の原則: 目的に必要な期間のみ保存。ユーザーが能動的に使用し続ける限り、パーソナライズ目的で保持することは適切です。 / Storage limitation principle: data kept only as long as necessary for the purpose. Retention for personalization is appropriate while the user actively uses the tool.
- **処理の法的根拠 / Legal Basis for Processing**: 正当な利益（GDPR Art. 6(1)(f)）— ユーザーが自発的にツールを使用し、検索結果のパーソナライズを求めた場合。 / Legitimate interest (GDPR Art. 6(1)(f)) — when the user voluntarily uses the tool and seeks personalized search results.

---

## 3. 削除方法 / Deletion Methods

### 3.1 ソフトリセット / Soft Reset

```
preference.reset(profile_id: "<uuid>", confirm: true)
```

- **動作 / Behavior**: `preference_text`, `preference_embedding` をクリアし、`interaction_count` を 0 にリセット。`preference_signals` は CASCADE 削除。プロファイルレコード自体は残存。 / Clears `preference_text`, `preference_embedding`, resets `interaction_count` to 0. `preference_signals` are CASCADE deleted. The profile record itself remains.
- **用途 / Use Case**: 嗜好をリセットして最初からやり直す場合。 / When the user wants to reset preferences and start fresh.
- **可逆性 / Reversibility**: シグナルデータは不可逆的に削除されます。プロファイルの枠は保持されます。 / Signal data is irreversibly deleted. The profile shell is preserved.

### 3.2 完全削除（ハードデリート） / Hard Delete

```
preference.reset(profile_id: "<uuid>", confirm: true, hard_delete: true)
```

- **動作 / Behavior**: `preference_profiles` レコードおよび関連する `preference_signals` を完全に削除。データベースから全痕跡を消去。 / Permanently deletes the `preference_profiles` record and all associated `preference_signals`. All traces are erased from the database.
- **用途 / Use Case**: GDPR「忘れられる権利」（Art. 17）に基づくデータ消去要求。 / GDPR Right to Erasure (Art. 17) data deletion request.
- **可逆性 / Reversibility**: 完全に不可逆。バックアップからの復元のみ。 / Completely irreversible. Recovery only from backups.
- **監査ログ / Audit Log**: 全環境で `logger.warn` による監査証跡を出力（PII truncate済み）。 / Audit trail via `logger.warn` in all environments (PII truncated).

### 監査証跡の例 / Audit Trail Example

```
[WARN] [PreferenceProfileService] Deleting profile (hard delete / GDPR erasure)
  { profileId: "01234567...", action: "hard_delete" }
[WARN] [PreferenceProfileService] Profile hard delete completed (GDPR erasure)
  { profileId: "01234567...", action: "hard_delete_completed" }
```

---

## 4. データエクスポート（データポータビリティ） / Data Export (Data Portability)

### GDPR Art. 20 — データポータビリティの権利 / Right to Data Portability

```
preference.get(profile_id: "<uuid>", include_signals: true)
```

- **動作 / Behavior**: プロファイルの全データ（`profile_id`, `name`, `preference_text`, `interaction_count`, `created_at`, `updated_at`）に加え、全シグナルデータ（`signal_type`, `signal_weight`, `target_type`, `target_id`, `feedback_text`, `created_at`）を構造化JSONで返却。 / Returns all profile data plus all signal data in structured JSON format.
- **出力形式 / Output Format**: JSON（機械可読、構造化、一般的に使用される形式） / JSON (machine-readable, structured, commonly used format)
- **用途 / Use Case**: ユーザーが自身のデータを確認・取得する場合。別システムへのデータ移行。 / When users want to review/retrieve their data. Data migration to another system.

### エクスポートデータ構造 / Export Data Structure

```json
{
  "success": true,
  "data": {
    "profile_id": "uuid",
    "name": "default",
    "preference_text": "...",
    "interaction_count": 5,
    "created_at": "2026-03-08T00:00:00.000Z",
    "updated_at": "2026-03-08T12:00:00.000Z",
    "signals": [
      {
        "id": "uuid",
        "signal_type": "hearing_positive",
        "signal_weight": 1.0,
        "target_type": "web_page",
        "target_id": "uuid",
        "feedback_text": "...",
        "created_at": "2026-03-08T01:00:00.000Z"
      }
    ]
  }
}
```

---

## 5. 法的根拠の詳細 / Detailed Legal Basis

### 適用されるGDPR条項 / Applicable GDPR Articles

| 条項 / Article   | 内容 / Subject                                         | Reftrixでの対応 / Reftrix Implementation                                                                                                              |
| ---------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Art. 5(1)(e)** | 保存制限の原則 / Storage limitation                    | ユーザーが明示的に削除可能。自動期限切れなし（ローカルツールとして適切）。 / User can explicitly delete. No auto-expiry (appropriate for local tool). |
| **Art. 6(1)(f)** | 正当な利益 / Legitimate interest                       | ユーザーの自発的な使用に基づくパーソナライズ。 / Personalization based on voluntary user engagement.                                                  |
| **Art. 13/14**   | 情報提供義務 / Information obligations                 | 本ドキュメントおよび `preference.hear` の `profiling_notice` で通知。 / Informed via this document and `profiling_notice` in `preference.hear`.       |
| **Art. 17**      | 忘れられる権利 / Right to erasure                      | `preference.reset(hard_delete: true)` で完全削除。 / Full deletion via `preference.reset(hard_delete: true)`.                                         |
| **Art. 20**      | データポータビリティの権利 / Right to data portability | `preference.get(include_signals: true)` でJSON形式エクスポート。 / JSON export via `preference.get(include_signals: true)`.                           |

### データ処理のライフサイクル / Data Processing Lifecycle

```
1. 収集 / Collection
   preference.hear (Mode A) → サンプル提示 / Present samples
   preference.hear (Mode B) → フィードバック受信・プロファイル更新 / Receive feedback & update profile

2. 利用 / Usage
   検索リランキング / Search reranking (preference_embedding × search results)

3. エクスポート / Export
   preference.get (include_signals: true) → 全データJSON出力 / Full data JSON export

4. 削除 / Deletion
   preference.reset (confirm: true) → ソフトリセット / Soft reset
   preference.reset (confirm: true, hard_delete: true) → 完全削除 / Hard delete
```

---

## 5.1 Usage Telemetry データ保持 / Usage Telemetry Data Retention

**v0.3.0 追加 / Added in v0.3.0**

### 対象データ / Data in Scope

MCPツール利用計測ログ（オプトイン）。`TOOL_USAGE_LOG_ENABLED=true` 設定時のみ生成。

MCP tool usage telemetry log (opt-in). Only generated when `TOOL_USAGE_LOG_ENABLED=true`.

### 記録フィールド / Recorded Fields

| フィールド / Field | 内容 / Description             | PII | 保存形式 / Format |
| ------------------ | ------------------------------ | --- | ----------------- |
| `tool`             | ツール名 / Tool name           | No  | Text              |
| `at`               | 実行時刻 / Execution timestamp | No  | ISO 8601          |
| `durationMs`       | 処理時間 / Duration in ms      | No  | Number            |
| `success`          | 成否 / Success/failure         | No  | Boolean           |

**PIIフィールドは一切含まない**: args, requestId, apiKey, error.message, query, profileId, url 等は記録対象外。

**No PII fields included**: args, requestId, apiKey, error.message, query, profileId, url, etc. are excluded.

### 保持期間 / Retention Period

- **ファイルサイズ上限 / File size limit**: 100MB（超過時にローテーション / rotated on excess）
- **ローテーション世代数 / Rotation generations**: 1世代（`.old` サフィックス / `.old` suffix）
- **推奨保持期間 / Recommended retention**: 90日（運用者がlogrotate等で管理 / managed by operator via logrotate etc.）
- **削除方法 / Deletion**: ログファイルを直接削除 / Delete the log file directly

### データ処理のライフサイクル / Data Processing Lifecycle

```
1. 生成 / Generation
   handleToolCall() → buildTelemetryEntry() → 4フィールドのみ / 4 fields only

2. 保存 / Storage
   logToolUsage() → appendFileSync → logs/tool-usage.jsonl (fire-and-forget)

3. ローテーション / Rotation
   100MB超過時 → tool-usage.jsonl.old にリネーム / Renamed to .old on excess

4. 削除 / Deletion
   運用者が手動削除 / Operator manual deletion
```

---

## 6. セキュリティ措置 / Security Measures

| 措置 / Measure                                          | 実装状況 / Implementation                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 入力バリデーション / Input validation                   | Zodスキーマによる全入力検証 / All inputs validated via Zod schemas                                          |
| エラーメッセージサニタイズ / Error message sanitization | `sanitizeErrorMessage()` でDB構造の漏洩防止 / `sanitizeErrorMessage()` prevents DB structure leakage        |
| PII配慮ログ / PII-aware logging                         | `profileId.slice(0, 8) + '...'` でtruncate / Truncated with `profileId.slice(0, 8) + '...'`                 |
| 監査証跡 / Audit trail                                  | `hard_delete` は全環境で `logger.warn` 出力 / `hard_delete` outputs `logger.warn` in all environments       |
| CASCADE削除 / CASCADE deletion                          | `preference_signals` はプロファイル削除時に自動削除 / `preference_signals` auto-deleted on profile deletion |

### 6.1 運用手順: Worker 二重稼働防止 (v0.4.0 PR7d-2+) / Operational procedures: Worker Dual-Run Prevention

AGPL-3.0 ライセンスに基づく透明性義務に従い、Worker プロセス運用の最新手順を以下に開示する。

Per AGPL-3.0 transparency obligations, the following documents the current Worker operational procedures.

- **通常運用 / Normal operation**: MCP サーバー起動時に `WorkerSupervisor` が page-analyze Worker を自動 fork する。手動起動は不要。 / The MCP server auto-forks the page-analyze Worker via `WorkerSupervisor`. Manual startup is unnecessary.
- **Redis ベース dual-run guard**: 手動 `pnpm worker:start:page` 実行時、Redis key `reftrix:worker:active:page` に既存 lock が検出された場合は `exit(1)` する（二重稼働による Queue 競合消費と `embeddingBackfillStatus` race-condition 上書き防止、GDPR Art.32(1)(b) 完全性要件、ADR-0011 参照）。 / Manual `pnpm worker:start:page` fails with `exit(1)` on detecting an existing lock in Redis key `reftrix:worker:active:page` (preventing dual-consumption and race-condition overwrites; GDPR Art.32(1)(b), see ADR-0011).
- **Fail-open / fail-closed 判別 (PR7d-3 SEC M-1)**: Redis 不可到達時は **fail-open** (warn + 起動継続) で operator を締め出さない。既存 lock 検出 / race-lost 時は **fail-closed** (`exit(1)`) で二重稼働を構造的に防止する。この判別は `WorkerActiveLockService.tryAcquireLock()` / `probeExistingLock()` の discriminated union API で明示的に区別される。 / PR7d-3 SEC M-1: Redis-unreachable is **fail-open** (warn + continue) so operators are not trapped; existing-lock / race-lost is **fail-closed** (`exit(1)`). The distinction is explicit via discriminated union APIs.
- **Opt-out (明示的手動所有) / Explicit manual-owner opt-out**: バッチスクリプト等で意図的に Worker を手動所有する場合、`REFTRIX_ALLOW_MANUAL_WORKER=true` を設定することで dual-run guard を bypass できる。推奨用法は `apps/mcp-server/scripts/_worker-spawn-helper.ts::spawnPageAnalyzeWorkerChild()` 経由（自動付与 + BullMQ `getWorkers()` pre-flight probe）。 / Set `REFTRIX_ALLOW_MANUAL_WORKER=true` to bypass the guard for intentional manual ownership. Use `spawnPageAnalyzeWorkerChild()` helper (auto-inject + pre-flight probe).
- **自動設定 env var / Auto-managed env vars**: `REFTRIX_WORKER_IS_CHILD=1` と `REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN=<UUID>` は WorkerSupervisor が fork 時に自動注入する。operator が手動設定すると dual-run guard が誤って bypass されるため **手動設定禁止**。 / `REFTRIX_WORKER_IS_CHILD=1` and `REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN=<UUID>` are injected by WorkerSupervisor on fork. **Do NOT set these manually** — doing so would incorrectly bypass the guard.
- **TTL cron 削除の audit_logs 記録 (PR7d-3 LCC MEDIUM-2)**: Screenshot TTL cron (`cleanupExpired`, 7d default) の削除件数 > 0 実行は `audit_logs` に `action=screenshot_ttl_cleanup` として記録される (GDPR Art.30 処理活動記録)。 / PR7d-3 LCC MEDIUM-2: TTL cron deletions with `deletedCount > 0` are recorded in `audit_logs` (GDPR Art.30).

---

## 7. 連絡先 / Contact

データ保護に関する質問やデータ削除要求については、プロジェクトのGitHubリポジトリをご参照ください。

For questions about data protection or data deletion requests, please refer to the project's GitHub repository.

- **GitHub**: [https://github.com/TKMD/ReftrixMCP](https://github.com/TKMD/ReftrixMCP)
- **Issues**: データ保護に関する問い合わせは GitHub Issues から送信できます。 / Data protection inquiries can be submitted via GitHub Issues.

---

## 免責事項 / Disclaimer

本ドキュメントは一般的な法的情報の提供を目的としており、特定の事案に対する法的助言を構成するものではありません。
具体的な法的判断が必要な場合は、資格を有する弁護士にご相談ください。

This document is intended to provide general legal information and does not constitute legal advice for any specific case.
If specific legal judgment is needed, please consult a qualified attorney.

法的調査日 / Legal Research Date: 2026-03-13

---

## 8. Part-Level Analysis データ保持 / Part-Level Analysis Data Retention

### 対象データ / Data in Scope

| テーブル / Table                                | カラム / Columns                                                                  | 内容 / Description                                                                                                                                                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `component_parts` / `component_part_embeddings` | `partType`, `text_embedding`, `visual_embedding`, `boundingBox`, `computedStyles` | UIパーツの構造・スタイル・ベクトルデータ（16種類: button, link, image, video, form, input, heading, card, navigation, footer, cta, hero_image, icon, badge, tag, avatar） / UI part structure, style, and vector data (16 types) |
| `component_parts` / `component_part_embeddings` | `textContent`, `innerHTML`                                                        | パーツのテキスト内容・HTML構造（`part.inspect` でopt-in取得） / Part text content and HTML structure (opt-in retrieval via `part.inspect`)                                                                                       |
| `component_parts` / `component_part_embeddings` | `piiRiskLevel`, `cssClasses`, `attributes`                                        | PIIリスク判定結果、CSSクラス名、HTML属性 / PII risk assessment result, CSS class names, HTML attributes                                                                                                                          |

### 保持方針 / Retention Policy

`component_parts` / `component_part_embeddings` は `web_pages` テーブルに CASCADE 外部キーで紐づいています。保持期間は親レコード（`web_pages`）と同一です。

`component_parts` / `component_part_embeddings` is linked to the `web_pages` table via CASCADE foreign key. The retention period is the same as the parent record (`web_pages`).

- **自動期限切れ / Auto-expiry**: なし / None
- **再分析時の動作 / Behavior on re-analysis**: `page.analyze` 再実行時に clean-slate パターン（`deleteMany` + `create`）で上書き / Overwritten using the clean-slate pattern (`deleteMany` + `create`) on `page.analyze` re-execution
- **手動削除 / Manual deletion**: WebPageレコードの削除により CASCADE で自動実行 / Automatically executed via CASCADE when a WebPage record is deleted

### PII保護 / PII Protection

`piiRiskLevel='high'` と判定されたパーツ（フォーム入力、パスワードフィールド等）では、`visual_embedding` の生成がスキップされます（カラム値は `null`）。これにより、PII を含む可能性のあるパーツのスクリーンショットからベクトルが生成されることを防止します。

Parts assessed as `piiRiskLevel='high'` (form inputs, password fields, etc.) have their `visual_embedding` generation skipped (column value is `null`). This prevents vector generation from screenshots of parts that may contain PII.

### GDPR対応 / GDPR Compliance

| 条項 / Article   | 内容 / Subject                         | 対応 / Implementation                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Art. 17**      | 忘れられる権利 / Right to erasure      | WebPage削除時に全関連 `component_parts` / `component_part_embeddings` がCASCADE削除。テキスト内容、ベクトル、バウンディングボックス、スタイル情報を含むすべてのデータが物理削除される。 / All associated `component_parts` / `component_part_embeddings` are CASCADE deleted when WebPage is deleted. All data including text content, vectors, bounding boxes, and style information is permanently removed. |
| **Art. 5(1)(c)** | データ最小化の原則 / Data minimisation | `piiRiskLevel='high'` パーツの visual embedding スキップにより、PII関連データの収集を最小化。 / Minimises PII-related data collection by skipping visual embedding for `piiRiskLevel='high'` parts.                                                                                                                                                                                                           |

---

## 9. Section Visual Embedding データ保持 / Section Visual Embedding Data Retention

### 対象データ / Data in Scope

| テーブル / Table     | カラム / Columns   | 内容 / Description                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `section_embeddings` | `vision_embedding` | セクションのスクリーンショットから生成された768次元ベクトル（DINOv2 ViT-B/14、L2正規化済み）。セクション高さ < 10px の場合はスキップ（null）。 / 768-dimensional vector generated from section screenshot (DINOv2 ViT-B/14, L2-normalized). Skipped (null) when section height < 10px. |

### 保持方針 / Retention Policy

`section_embeddings` は `section_patterns` → `web_pages` テーブルに CASCADE 外部キーで紐づいています。保持期間は親レコード（`web_pages`）と同一です。

`section_embeddings` is linked via CASCADE foreign key through `section_patterns` → `web_pages`. The retention period is the same as the parent record (`web_pages`).

- **自動期限切れ / Auto-expiry**: なし / None
- **再分析時の動作 / Behavior on re-analysis**: `page.analyze` 再実行時に clean-slate パターン（`deleteMany` + `create`）で上書き / Overwritten using the clean-slate pattern (`deleteMany` + `create`) on `page.analyze` re-execution
- **手動削除 / Manual deletion**: WebPageレコードの削除により CASCADE で自動実行 / Automatically executed via CASCADE when a WebPage record is deleted

### PII保護 / PII Protection

`piiRiskLevel='high'` と判定されたパーツ（`component_parts`）を含むセクションでは、`vision_embedding` の生成がスキップされます（カラム値は `null`）。これにより、PII を含む可能性のあるセクション領域のスクリーンショットからベクトルが生成されることを防止します（GDPR Art. 5(1)(c) データ最小化の原則）。

Sections containing parts (`component_parts`) assessed as `piiRiskLevel='high'` have their `vision_embedding` generation skipped (column value is `null`). This prevents vector generation from screenshots of section areas that may contain PII (GDPR Art. 5(1)(c) data minimisation principle).

### フォールバック機構の透明性 / Fallback Mechanism Transparency

screenshotBase64の高さ範囲外セクションに対しては、`SectionScreenshotFallbackService` によるPlaywright個別スクリーンショット取得（フォールバック）が実行される場合がある。取得されたスクリーンショットはメモリ上でのみ一時保持され、DBには保存されない。最終成果物（`vision_embedding`）は通常パスと同一のパイプラインで処理される。

For sections outside the screenshotBase64 height range, `SectionScreenshotFallbackService` may capture individual screenshots via Playwright (fallback). Captured screenshots are held temporarily in memory only and are not persisted to the database. The final artifact (`vision_embedding`) is processed through the same pipeline as the normal path.

重複ベクトル検出（コサイン類似度 > 0.995）時は、`vision_embedding` の保存をスキップする（カラム値は `null`）。これはデータ最小化原則（GDPR Art. 5(1)(c)）に沿った挙動であり、Hybrid Searchの品質向上に寄与する。

Duplicate vector detection (cosine similarity > 0.995) skips `vision_embedding` storage (column value remains `null`). This aligns with the data minimisation principle (GDPR Art. 5(1)(c)) and improves Hybrid Search quality.

#### Blank Image Detection + Dynamic Fallback (v0.1.9) / 白画像検出 + 動的フォールバック

fullPage screenshotでLazy Loading未描画セクションが白画像として取得された場合、`isBlankImage()`（Sharp stats RGB stddev < 5.0）で検出し、Section Screenshot Fallback（Playwright個別キャプチャ）で再取得する。

When fullPage screenshot captures lazy-loading unrendered sections as blank images, `isBlankImage()` (Sharp stats RGB stddev < 5.0) detects them, and Section Screenshot Fallback (Playwright individual capture) re-acquires the screenshots.

**データフロー / Data Flow**: 白画像検出 → Playwrightキャプチャ（メモリ上一時保持）→ DINOv2推論 → `vision_embedding` DB保存。画像バッファはメモリ上でのみ一時保持され、DINOv2処理後に参照解除される（GDPR Art. 5(1)(c)(e) データ最小化・保存制限の原則）。

Blank image detection → Playwright capture (held in memory only) → DINOv2 inference → `vision_embedding` saved to DB. Image buffers are held temporarily in memory only and dereferenced after DINOv2 processing (GDPR Art. 5(1)(c)(e) data minimisation and storage limitation principles).

**動的Fallback対象セクション数上限 / Dynamic Fallback Section Cap**: `MAX_DYNAMIC_FALLBACK_SECTIONS = 20`。通常Fallbackとの合計で50件上限を維持。`highPiiSectionIds` フィルタにより `piiRiskLevel='high'` パーツを含むセクションは除外される。

`MAX_DYNAMIC_FALLBACK_SECTIONS = 20`. Combined with normal fallback, the total cap of 50 sections is maintained. `highPiiSectionIds` filter excludes sections containing `piiRiskLevel='high'` parts.

#### Phase 5 一時ファイル（RAW decode最適化） / Phase 5 Temporary Files (RAW Decode Optimization)

Phase 5 メモリ制御において、DINOv2推論前のRAWピクセルデコード処理でメモリ圧力を軽減するため、一時ファイル（PNGクロップ画像 + RAWピクセルデータ）がOS一時ディレクトリ（`os.tmpdir()`）に書き出される場合がある。

In Phase 5 memory control, to reduce memory pressure during RAW pixel decoding before DINOv2 inference, temporary files (PNG crop images + RAW pixel data) may be written to the OS temporary directory (`os.tmpdir()`).

**一時ファイルの詳細 / Temporary File Details**:

| 項目 / Item                                        | 内容 / Description                                                                                                                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ディレクトリ名 / Directory name                    | `reftrix-phase5-{random}`（`fs.mkdtempSync()` でランダム生成） / `reftrix-phase5-{random}` (randomly generated via `fs.mkdtempSync()`)                                                                                                     |
| ファイル内容 / File contents                       | セクションスクリーンショットのPNGクロップ画像、RAWピクセルデータ / Section screenshot PNG crop images, RAW pixel data                                                                                                                      |
| ファイルパーミッション / File permissions          | `0o600`（所有者のみ読み書き可能） / `0o600` (owner read/write only)                                                                                                                                                                        |
| ディレクトリパーミッション / Directory permissions | `0o700`（所有者のみアクセス可能） / `0o700` (owner access only)                                                                                                                                                                            |
| ライフサイクル / Lifecycle                         | Phase 5完了後に `finally` ブロックで確実に削除。異常終了時も削除される。 / Reliably deleted in `finally` block after Phase 5 completion. Also deleted on abnormal termination.                                                             |
| PII保護 / PII protection                           | `piiRiskLevel='high'` セクションはvisual embeddingスキップのため一時ファイルも生成されない（GDPR Art. 5(1)(c)） / `piiRiskLevel='high'` sections are skipped for visual embedding, so no temporary files are generated (GDPR Art. 5(1)(c)) |

**データフロー / Data Flow**: セクションクロップ画像 → PNGファイル書き出し（`os.tmpdir()/reftrix-phase5-{random}/`）→ RAWピクセルデコード → RAWファイル書き出し → DINOv2推論 → `vision_embedding` DB保存 → 一時ディレクトリ全体を再帰削除（`finally` 保証）。

Section crop image → PNG file write (`os.tmpdir()/reftrix-phase5-{random}/`) → RAW pixel decode → RAW file write → DINOv2 inference → `vision_embedding` saved to DB → entire temporary directory recursively deleted (`finally` guaranteed).

**セキュリティ措置 / Security Measures**: 一時ファイルは制限的パーミッション（ファイル: `0o600`、ディレクトリ: `0o700`）で作成され、他ユーザーからのアクセスを防止する。ディレクトリ名は `fs.mkdtempSync()` によりランダム生成され、予測不可能なパスとなる。

Temporary files are created with restrictive permissions (files: `0o600`, directories: `0o700`) to prevent access from other users. The directory name is randomly generated by `fs.mkdtempSync()`, resulting in an unpredictable path.

### GDPR対応 / GDPR Compliance

| 条項 / Article   | 内容 / Subject                         | 対応 / Implementation                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Art. 17**      | 忘れられる権利 / Right to erasure      | WebPage削除時に全関連 `section_embeddings` がCASCADE削除。ベクトルデータを含むすべてのデータが物理削除される。 / All associated `section_embeddings` are CASCADE deleted when WebPage is deleted. All data including vector data is permanently removed. |
| **Art. 5(1)(c)** | データ最小化の原則 / Data minimisation | `piiRiskLevel='high'` パーツを含むセクションの visual embedding スキップにより、PII関連データの収集を最小化。 / Minimises PII-related data collection by skipping visual embedding for sections containing `piiRiskLevel='high'` parts.                  |

#### Screenshot 永続化（v0.4.0 Queue-based Backfill） / Screenshot Persistence (v0.4.0 Queue-based Backfill)

Phase 5 Queue-based Backfill（v0.4.0 PR1）では、Phase 0 Ingest で取得した fullPage screenshot を page.analyze 完了後も保持する。これは非同期 backfill worker が元の screenshot にアクセスできるようにするため。従来の `/tmp/reftrix-phase5-*/screenshot.png` は Phase 5 終了時に削除されるため、非同期 backfill から参照できなかった。

Phase 5 Queue-based Backfill (v0.4.0 PR1) retains the fullPage screenshot captured in Phase 0 Ingest after `page.analyze` completes, allowing async backfill workers to access the original screenshot. The previous `/tmp/reftrix-phase5-*/screenshot.png` was deleted at Phase 5 end and was unreachable from async backfill.

**保存先 / Storage Location**:

| 項目 / Item                                        | 内容 / Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ルート / Root                                      | `${REFTRIX_SCREENSHOT_ROOT}/phase5/`（デフォルト `/tmp/reftrix-screenshots/phase5/`） / `${REFTRIX_SCREENSHOT_ROOT}/phase5/` (default `/tmp/reftrix-screenshots/phase5/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ファイル名 / Filename                              | `<webPageId>.png`（webPageId は UUID v4/v7 正規表現で検証） / `<webPageId>.png` (webPageId validated by strict UUID v4/v7 regex)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| DB カラム / DB Column                              | `web_pages.screenshot_storage_path TEXT NULL`（絶対パスを保持、削除時は NULL 化） / `web_pages.screenshot_storage_path TEXT NULL` (stores absolute path, nulled on deletion)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| DB カラム (PR2) / DB Column (PR2)                  | `web_pages.embedding_backfill_status EmbeddingBackfillStatus NOT NULL DEFAULT 'not_required'`（PR2 v0.4.0: embedding skip/backfill 状態を追跡） / `web_pages.embedding_backfill_status EmbeddingBackfillStatus NOT NULL DEFAULT 'not_required'` (PR2 v0.4.0: tracks embedding skip/backfill status). Values: `not_required` / `queued` / `in_progress` / `completed` / `failed` / `skipped_memory_pressure` / `skipped_fork_error`. Partial index `idx_web_pages_embedding_backfill_status WHERE status != 'not_required'` for fast backfill queue lookup. **PII 非該当 / Not PII**: `embedding_backfill_status` は Phase 5 の処理状態メタデータ（enum 7値）であり、個人を識別可能な情報を含まない（GDPR Recital 26 の「識別不能情報」に該当）。独立した保持期間なし — `web_pages` 行の `CASCADE DELETE` で自動消去される（`data.delete` / GDPR Art.17 削除パスを含む）。 / `embedding_backfill_status` is processing-state metadata (7-value enum) for Phase 5 and contains no personally identifiable information (qualifies as "non-identifiable information" under GDPR Recital 26). No independent retention period — it is automatically removed via `CASCADE DELETE` on the `web_pages` row (including the `data.delete` / GDPR Art.17 erasure paths). |
| ファイルパーミッション / File permissions          | `0o600`（所有者のみ読み書き） / `0o600` (owner read/write only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ディレクトリパーミッション / Directory permissions | `0o700`（所有者のみアクセス可能） / `0o700` (owner access only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 書き込み方式 / Write strategy                      | Atomic rename（`<file>.tmp-<pid>-<rand>` に書き込み後 `rename()`） / Atomic rename (write to `<file>.tmp-<pid>-<rand>`, then `rename()`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| サイズ上限 / Size cap                              | デフォルト 50MB（`SCREENSHOT_MAX_BYTES` でオーバーライド可、絶対上限 500MB） / Default 50MB (override via `SCREENSHOT_MAX_BYTES`, absolute cap 500MB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 保持期間 / Retention                               | 7日 TTL（PR6 で日次 cron 自動化 / 7-day TTL, automated via daily cron in PR6）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

**保持期間の根拠 / Retention Rationale**: 7日は Queue-based Backfill の想定最長リトライウィンドウ。これを超えた screenshot は backfill 済みまたは失敗確定とみなし cron で一括削除する。

The 7-day window is the assumed maximum retry horizon for Queue-based Backfill. Screenshots older than this are considered either backfilled or definitively failed and are bulk-deleted by cron.

**削除経路 / Deletion Paths**:

1. **GDPR Art. 17 削除 / GDPR Art. 17 erasure**: `data.delete target=page|all_user_data` 実行時、`GdprDeletionService.deletePage()` / `deleteAllUserData()` が `ScreenshotPersistenceService.deleteScreenshot()` を呼び出し、DB 行削除と合わせて永続化 PNG を物理削除する。DB トランザクション成功後に best-effort で削除し、ファイル削除失敗時も DB 変更は巻き戻さない（残存ファイルは TTL cron で回収）。 / On `data.delete target=page|all_user_data`, `GdprDeletionService.deletePage()` / `deleteAllUserData()` invokes `ScreenshotPersistenceService.deleteScreenshot()`, removing the persisted PNG alongside DB rows. Best-effort deletion after DB commit; file failure does not roll back DB (orphaned files are reaped by TTL cron).
2. **TTL cron（v0.4.0 PR6 実装済） / TTL cron (implemented in v0.4.0 PR6)**: `apps/mcp-server/src/cron/screenshot-cleanup-cron.ts` が `scheduleScreenshotCleanupCron()` を `start-workers.ts` 起動時にセットアップし、デフォルト 24 時間ごとに `cleanupExpired(olderThanMs=7d, { maxBatchSize=1000 })` を呼び出す。前回実行が完了していない場合は tick を skip（オーバーラップ防止）、1実行あたり最大 1000件（絶対上限 100,000件、DoS対策）。間隔は `SCREENSHOT_CLEANUP_INTERVAL_MS`、保持期間は `SCREENSHOT_CLEANUP_OLDER_THAN_MS`、バッチサイズは `SCREENSHOT_CLEANUP_MAX_BATCH_SIZE` で個別にオーバーライド可能。 / `apps/mcp-server/src/cron/screenshot-cleanup-cron.ts` wires `scheduleScreenshotCleanupCron()` into `start-workers.ts` at startup, invoking `cleanupExpired(olderThanMs=7d, { maxBatchSize=1000 })` every 24 hours by default. Ticks overlapping a still-running sweep are skipped (pile-up prevention); max 1000 files per invocation (absolute cap 100,000, DoS defense). Interval, retention, and batch size are overridable via `SCREENSHOT_CLEANUP_INTERVAL_MS`, `SCREENSHOT_CLEANUP_OLDER_THAN_MS`, and `SCREENSHOT_CLEANUP_MAX_BATCH_SIZE` respectively.

**削除経路マトリクス / Deletion Path Matrix (v0.4.0 PR7d-3)**:

| 経路 / Path                         | PR7b 以前 / Before PR7b                                           | PR7c / After PR7c                                                                             | PR7d-1 以降 / After PR7d-1                                                                                                            | PR7d-2 / After PR7d-2                                             | PR7d-3 / After PR7d-3                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| GDPR `data.delete` (Art. 17)        | 同期削除（DB 行削除後に best-effort）                             | 同期削除（変更なし）                                                                          | 同期削除（変更なし） / synchronous (unchanged)                                                                                        | 変更なし / unchanged                                              | 変更なし / unchanged                                                                                                                  |
| Phase 5 fork orchestrator 完了時    | `cleanupScreenshotAndTmp()` で即時削除（`deleteScreenshot` 呼出） | `cleanupPhase5TmpDirOnly()` が RAW decode tmp dir のみ best-effort 削除                       | **`cleanupPhase5TempDir()` に統合**。3段 whitelist 防御（realpath + os.tmpdir() + `reftrix-phase5-raw-` prefix）を強制 / consolidated | RAW decode 書き込み先を `os.tmpdir()/reftrix-phase5-raw-*` へ修正 | 変更なし / unchanged                                                                                                                  |
| page-analyze-worker Phase 5 後処理  | `cleanupPhase5TempDir(phase5Dir)` を呼出（永続化 PNG を削除）     | `cleanupPhase5TempDir(phase5Dir)` が残存（retention-over-deletion bug 温存、ADR-0010 で検出） | **解除**。in-memory `state.screenshotPngPath` の null 化のみ / **removed** (null-out only)                                            | 変更なし / unchanged                                              | 変更なし / unchanged                                                                                                                  |
| page-analyze-worker finally         | `cleanupPhase5TempDir(phase5Dir)` を呼出                          | `cleanupPhase5TempDir(phase5Dir)` が残存                                                      | **解除**。in-memory null 化のみ / **removed**                                                                                         | 変更なし / unchanged                                              | 変更なし / unchanged                                                                                                                  |
| PR6 TTL cron (`cleanupExpired`, 7d) | 定常削除（最終回収）                                              | 定常削除 + PR7b までの即時削除分も担当                                                        | 定常削除（唯一の scheduled deletion path） / sole scheduled deletion path                                                             | 変更なし / unchanged                                              | **audit_logs 記録追加** (GDPR Art.30、削除件数 > 0 時のみ) / **audit_logs recording added** (GDPR Art.30, only when deletedCount > 0) |

**削除経路変更の理由 / Why paths changed (PR7c → PR7d-1)**:

PR7c (ADR-0009) は `phase-5-fork-orchestrator.ts` の即時削除を解除したが、`page-analyze-worker.ts` の Phase 5 後処理 / finally ブロックに残された `cleanupPhase5TempDir(path.dirname(state.screenshotPngPath))` 呼び出しが見落とされていた。v0.4.0 PR1 で `state.screenshotPngPath` の指す先が永続化パス `<REFTRIX_SCREENSHOT_ROOT>/phase5/<webPageId>.png` に変わった結果、この呼び出しが永続化ディレクトリ全体を `rmSync(recursive:true)` で破壊するようになり、Queue-based Backfill (`part_visual` / `section_visual`) の visual embedding が再び 0 件になるバグ（retention-over-deletion bug）が発生。PR7d-1 (ADR-0010) でこの 2 箇所を削除し、`cleanupPhase5TempDir` 自体に realpath + os.tmpdir() + `reftrix-phase5-raw-` prefix の 3 段 whitelist 防御を追加して、類似の誤用を型レベルでは保証できないが関数レベルで遮断する。

PR7c (ADR-0009) removed the immediate deletion in `phase-5-fork-orchestrator.ts` but overlooked two `cleanupPhase5TempDir(path.dirname(state.screenshotPngPath))` call sites in `page-analyze-worker.ts` (Phase 5 post-processing and the finally block). After v0.4.0 PR1 repointed `state.screenshotPngPath` at the persisted path `<REFTRIX_SCREENSHOT_ROOT>/phase5/<webPageId>.png`, those calls started destroying the persisted directory via `rmSync(recursive:true)`, reintroducing the zero-visual-embedding bug. PR7d-1 (ADR-0010) removes both call sites and hardens `cleanupPhase5TempDir` itself with a three-stage whitelist defense (realpath + os.tmpdir() containment + `reftrix-phase5-raw-` prefix), providing function-level protection against similar misuse.

**Historical Bug Transparency (PR7a–PR7c period) / 歴史的バグの透明性開示 (PR7a–PR7c 期間)**:

GDPR Art.17 の「不当な遅延なく削除」観点での透明性として、以下の期間における削除挙動を開示する:

For GDPR Art.17 "without undue delay" transparency, the following deletion behaviour during the noted periods is disclosed:

- **PR7a–PR7b 期間 (v0.4.0 PR1 merge 後〜PR7c 前)**: `page-analyze-worker.ts` の Phase 5 後処理 / finally に残存した `cleanupPhase5TempDir(path.dirname(state.screenshotPngPath))` が、永続化 screenshot ディレクトリ `<REFTRIX_SCREENSHOT_ROOT>/phase5/` を **意図せず即時削除していた**。結果的に Queue-based Backfill から visual embedding が生成できず、本来の 7 日間保持ポリシーが不成立だった。GDPR Art.17 の削除権は **逆に過剰に満たされていた**（利用者データはむしろ迅速に消えていた）が、Art.5(1)(a) の「公正かつ透明な処理」および Art.32(1)(b) の「システムの完全性」観点では欠陥であった。
- **PR7c 期間 (ADR-0009 merge 後〜PR7d-1 前)**: `phase-5-fork-orchestrator.ts` 側の即時削除は解除されたが、`page-analyze-worker.ts` 側の retention-over-deletion bug は残存。ADR-0009 の意図（PR6 TTL cron + GDPR 2 経路化）と実装の整合が取れていなかった。
- **PR7d-1 以降**: 2 箇所の worker cleanup を削除し、永続化 screenshot の削除経路は GDPR `data.delete`（即時）+ PR6 TTL cron（7 日）の 2 本のみに確実に集約。`cleanupPhase5TempDir` の 3 段 whitelist 防御により、同種の誤用を関数レベルで遮断。**既存の破損レコード**（`screenshotStoragePath` が NOT NULL で `embeddingBackfillStatus` が `queued` / `in_progress` のまま残るページ）は新規修復スクリプト `apps/mcp-server/scripts/repair-orphaned-backfill-records.ts` で `failed` + `skipped_screenshot_missing` 遷移させる。

- **PR7a–PR7b window**: the leftover `cleanupPhase5TempDir(path.dirname(state.screenshotPngPath))` calls in `page-analyze-worker.ts` **unintentionally deleted the persisted screenshot directory immediately** — the intended 7-day retention did not hold. Users' data was erased faster than the policy promised, which **over-satisfied** the Art.17 erasure right but violated Art.5(1)(a) fair-and-transparent processing and Art.32(1)(b) integrity-of-systems guarantees.
- **PR7c window**: the orchestrator-side immediate deletion was removed, but the worker-side retention-over-deletion bug persisted. ADR-0009 intent (PR6 TTL cron + GDPR two-path consolidation) did not match the implementation.
- **After PR7d-1**: the two worker cleanup call sites are removed; persisted-screenshot deletion is truly consolidated into GDPR `data.delete` (synchronous) and the PR6 TTL cron (7-day). `cleanupPhase5TempDir`'s three-stage whitelist defense blocks similar misuse at the function level. **Pre-existing corrupted rows** (`screenshotStoragePath` NOT NULL with `embeddingBackfillStatus` stuck at `queued` / `in_progress`) are repaired via the new `apps/mcp-server/scripts/repair-orphaned-backfill-records.ts` script, transitioning them to `failed` + `skipped_screenshot_missing`.

**Race Condition / 競合状態**:

`data.delete`（GDPR Art.17）と Backfill / TTL cron の競合は 3 シナリオ（Backfill `in_progress` / `queued` / fd open）で発生し得るが、いずれも既存の best-effort ハンドラ（FK ROLLBACK / P2025 swallow / Linux `unlink()` inode 残存特性）で吸収される。詳細は [ADR-0009 §M9 Race Condition Handling](/ 参照。

`data.delete` (GDPR Art.17) can race with Backfill / TTL cron in 3 scenarios (Backfill `in_progress` / `queued` / fd open), all absorbed by existing best-effort handlers (FK ROLLBACK / P2025 swallow / Linux `unlink()` inode persistence). See [ADR-0009 §M9 Race Condition Handling](/ for details.

**運用注記 / Operational Note**:

`WORKER_MAX_JOBS_BEFORE_RESTART=0`（永続 Worker モード、ADR-0009 で公式サポート化）を選択した場合、DINOv2 ONNX セッションが長時間プロセス内に残存するため、`data.delete` の fd open 中 inflight 時間が延長する可能性がある（通常 1-2 分 → 最大 Worker 寿命まで）。GDPR Art.17 の「不当な遅延なく削除」要件を厳密に維持するには、デフォルト（`=1`）の使用を推奨。

When `WORKER_MAX_JOBS_BEFORE_RESTART=0` (persistent-worker mode, officially supported via ADR-0009) is selected, the DINOv2 ONNX session persists in-process for extended periods, potentially extending `data.delete` fd-open inflight time (from typical 1-2 min up to the Worker lifetime). To strictly maintain GDPR Art.17's "without undue delay" requirement, the default (`=1`) is recommended.

**セキュリティ措置 / Security Measures**:

- **Path Traversal 防御 / Path Traversal defense**: 三重チェック — (1) UUID v4/v7 正規表現で `webPageId` を厳格検証（RFC 4122 準拠、version `4`/`7`、variant `8`/`9`/`a`/`b`）、(2) `path.resolve()` で絶対パス化、(3) `startsWith(phase5Dir + path.sep)` で root 配下を確認。 / Triple defense — (1) strict UUID v4/v7 regex (RFC 4122 compliant), (2) `path.resolve()` to absolute, (3) `startsWith` root-containment check.
- **Symlink 正規化 / Symlink canonicalization**: 初回 `resolveScreenshotRoot()` 呼出時に `fs.realpath()` で root を正規化・キャッシュ（symlink 経由の escape 防止）。 / First-call `fs.realpath()` canonicalization of root (defends against symlink escape).
- **サイズ上限 / Size cap**: `saveScreenshot()` は sourceBuffer サイズをチェックし、上限超過時は保存前に拒否（DoS / ディスク枯渇対策）。 / `saveScreenshot()` checks source buffer size and rejects before write (DoS / disk exhaustion defense).
- **Batch size cap**: `cleanupExpired()` は 1実行あたり最大 1000件まで（絶対上限 100,000件）。 / `cleanupExpired()` caps at 1000 files per call (absolute limit 100,000).
- **PII truncation**: `webPageId` はログ出力時に `truncateId()`（先頭8文字 + `...`）で切り詰める。 / `webPageId` is truncated via `truncateId()` (first 8 chars + `...`) in logs.

**関連環境変数 / Related Env Vars**:

| 変数 / Variable           | デフォルト / Default       | 説明 / Description                                               |
| ------------------------- | -------------------------- | ---------------------------------------------------------------- |
| `REFTRIX_SCREENSHOT_ROOT` | `/tmp/reftrix-screenshots` | Screenshot 永続化ルートディレクトリ / Root persistence directory |
| `SCREENSHOT_MAX_BYTES`    | `52428800` (50MB)          | saveScreenshot サイズ上限 / saveScreenshot size cap              |

---

## 10. クロールデータ保持（HTML/CSS） / Crawl Data Retention (HTML/CSS)

### 対象データ / Data in Scope

| テーブル / Table   | カラム / Columns                                                     | 内容 / Description                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `web_pages`        | `html`, `screenshot`                                                 | クロール時に取得したHTML（DOMPurifyサニタイズ済み）、スクリーンショット画像 / Crawled HTML (DOMPurify-sanitized), screenshot images                                                                                      |
| `section_patterns` | `htmlSnippet`, `cssSnippet`, `externalCssContent`, `externalCssMeta` | セクション単位のHTMLスニペット、ページレベルCSS（インライン+styleタグ+外部CSS実内容）、外部CSSメタデータ / Per-section HTML snippets, page-level CSS (inline + style tags + external CSS content), external CSS metadata |

### 保持方針 / Retention Policy

クロールデータは再分析時に clean-slate パターン（`deleteMany` + `create`）で上書きされます。手動削除はWebPageレコードの削除により CASCADE で自動実行されます。自動的な期限切れはありません。

Crawl data is overwritten on re-analysis using the clean-slate pattern (`deleteMany` + `create`). Manual deletion is performed automatically via CASCADE when a WebPage record is deleted. There is no automatic expiration.

### セキュリティ措置 / Security Measures

- **HTMLサニタイズ / HTML Sanitization**: すべてのクロール済みHTMLはDOMPurify 3.3.xでサニタイズ済み（`<script>`, `javascript:` URL, イベントハンドラ除去） / All crawled HTML is sanitized with DOMPurify 3.3.x (removes `<script>`, `javascript:` URLs, event handlers)
- **CSSデータ / CSS Data**: ページレベルCSS（`cssSnippet`, `externalCssContent`）はセクション単位に配布して`section_patterns`に保存。デザイン分析（レイアウト検索、コード生成）用途で保持 / Page-level CSS is distributed to sections and stored in `section_patterns`. Retained for design analysis (layout search, code generation)
- **SSRF対策 / SSRF Prevention**: 外部CSSフェッチ時はSSRFバリデーション適用済み / SSRF validation applied during external CSS fetching

---

## 11. 監査ログデータ保持 / Audit Log Data Retention

### 対象データ / Data in Scope

| テーブル / Table | カラム / Columns                                                                                    | 内容 / Description                                                                                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit_logs`     | `id`, `timestamp`, `action`, `actor`, `target_type`, `target_id`, `details`, `ip_address`, `result` | GDPR Art.30 処理活動記録。すべてのデータ操作（削除、エクスポート、分析等）の監査証跡。 / GDPR Art.30 records of processing activities. Audit trail for all data operations (deletion, export, analysis, etc.). |

### PII評価 / PII Assessment

- **PII リスク**: 低 / Low
- `target_id` は `truncateId()` 適用済み（先頭8文字 + `...`） / `target_id` has `truncateId()` applied (first 8 chars + `...`)
- `ip_address` はオプショナル（記録される場合は IPv4/IPv6 形式） / `ip_address` is optional (IPv4/IPv6 format when recorded)
- `details` JSON はサニタイズ済み（シークレット情報不含） / `details` JSON is sanitized (no secrets)

### 保持方針 / Retention Policy

- **保持期間 / Retention Period**: 365日（1年） / 365 days (1 year)
- **設計 / Design**: Append-only（通常の UPDATE/DELETE 不可、cleanup のみ例外） / Append-only (no regular UPDATE/DELETE, cleanup only exception)
- **自動期限切れ / Auto-expiry**: 365日超過レコードの定期クリーンアップ推奨 / Periodic cleanup of records older than 365 days recommended
- **手動削除 / Manual deletion**: 監査ログは法的証跡のため、通常の削除要求対象外 / Audit logs are exempt from regular deletion requests as legal evidence

### 法的根拠 / Legal Basis

| 条項 / Article   | 内容 / Subject                                    | 対応 / Implementation                                                                                                                     |
| ---------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Art. 30**      | 処理活動の記録 / Records of processing activities | すべてのデータ処理操作を監査ログとして記録。 / All data processing operations recorded as audit logs.                                     |
| **Art. 5(1)(e)** | 保存制限の原則 / Storage limitation               | 365日保持後にクリーンアップ推奨。法的義務がある期間は保持。 / Cleanup recommended after 365 days. Retained while legal obligations exist. |

---

## 12. 検索ログデータ保持 / Search Log Data Retention

### 対象データ / Data in Scope

| テーブル / Table | カラム / Columns                                                                                                                          | 内容 / Description                                                                                                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search_logs`    | `id`, `timestamp`, `query`, `query_type`, `services`, `result_count`, `top_result_id`, `filters`, `latency_ms`, `cache_hit`, `profile_id` | 検索クエリ・パフォーマンス・結果の記録。ファセット検索分析とMLフィードバックループ基盤。 / Search query, performance, and result recording. Foundation for facet search analysis and ML feedback loop. |

### PII評価 / PII Assessment

- **PII リスク**: 低 / Low
- `profile_id` は `truncateId()` 適用済み（先頭8文字 + `...`、VarChar(50)） / `profile_id` has `truncateId()` applied (first 8 chars + `...`, VarChar(50))
- `query` は 200文字に制限 / `query` is truncated to 200 characters
- `top_result_id` は truncated UUID / `top_result_id` is a truncated UUID

### 保持方針 / Retention Policy

- **保持期間 / Retention Period**: 90日推奨 / 90 days recommended
- **設計 / Design**: Append-only（通常の UPDATE/DELETE 不可） / Append-only (no regular UPDATE/DELETE)
- **自動期限切れ / Auto-expiry**: 90日超過レコードの定期クリーンアップ推奨 / Periodic cleanup of records older than 90 days recommended
- **手動削除 / Manual deletion**: `data.delete target=profile` 実行時に該当 `profile_id` を NULL化（匿名化） / On `data.delete target=profile`, the corresponding `profile_id` is set to NULL (anonymized)

### GDPR対応 / GDPR Compliance

| 条項 / Article   | 内容 / Subject                         | 対応 / Implementation                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Art. 17**      | 忘れられる権利 / Right to erasure      | プロファイル削除時に `search_logs.profile_id` を NULL化（匿名化）。ログ自体は検索品質分析用途で匿名化済みレコードとして保持。 / On profile deletion, `search_logs.profile_id` is set to NULL (anonymized). Logs are retained as anonymized records for search quality analysis. |
| **Art. 5(1)(c)** | データ最小化の原則 / Data minimisation | `query` 200文字制限、`profile_id` truncateId()、`top_result_id` truncated UUID による最小化。 / Minimised via `query` 200-char limit, `profile_id` truncateId(), `top_result_id` truncated UUID.                                                                                |
| **Art. 5(1)(e)** | 保存制限の原則 / Storage limitation    | 90日保持後にクリーンアップ推奨。 / Cleanup recommended after 90 days.                                                                                                                                                                                                           |

---

## 13. デザインスナップショットデータ保持 / Design Snapshot Data Retention

### 対象データ / Data in Scope

| テーブル / Table           | カラム / Columns                                                                                                          | 内容 / Description                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `design_snapshots`         | `id`, `web_page_id`, `snapshot_at`, `section_count`, `overall_score`, `metadata`, `created_at`                            | 特定時点のWebページデザイン状態を記録するスナップショット。デザイン変更の時系列追跡に使用。 / Point-in-time snapshot of web page design state. Used for temporal design change tracking. |
| `design_snapshot_sections` | `id`, `snapshot_id`, `section_type`, `section_name`, `position_index`, `text_embedding`, `vision_embedding`, `created_at` | スナップショット内の個別セクションデータ（Embedding含む）。 / Individual section data within a snapshot (including embeddings).                                                          |

### PII評価 / PII Assessment

- **PII リスク**: なし / None
- `design_snapshots` は `web_page_id`（FK）のみでユーザー識別情報を含まない / `design_snapshots` contains only `web_page_id` (FK), no user-identifying information
- `design_snapshot_sections` は Embedding データのみ（`text_embedding`, `vision_embedding`）でPII不含 / `design_snapshot_sections` contains only embedding data (`text_embedding`, `vision_embedding`), no PII

### 保持方針 / Retention Policy

- **保持期間 / Retention Period**: 親レコード（`web_pages`）と同一 / Same as parent record (`web_pages`)
- **CASCADE DELETE**: `design_snapshots` は `web_pages` に対して `onDelete: Cascade`。`design_snapshot_sections` は `design_snapshots` に対して `onDelete: Cascade`。 / `design_snapshots` has `onDelete: Cascade` on `web_pages`. `design_snapshot_sections` has `onDelete: Cascade` on `design_snapshots`.
- **自動期限切れ / Auto-expiry**: なし（親レコードのライフサイクルに従う） / None (follows parent record lifecycle)
- **手動削除 / Manual deletion**: WebPage レコードの削除により CASCADE で自動実行 / Automatically executed via CASCADE when a WebPage record is deleted

### GDPR対応 / GDPR Compliance

| 条項 / Article   | 内容 / Subject                         | 対応 / Implementation                                                                                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Art. 17**      | 忘れられる権利 / Right to erasure      | WebPage 削除時に全関連 `design_snapshots` および `design_snapshot_sections` が CASCADE 削除。ベクトルデータを含むすべてのデータが物理削除される。 / All associated `design_snapshots` and `design_snapshot_sections` are CASCADE deleted when WebPage is deleted. All data including vector data is permanently removed. |
| **Art. 5(1)(c)** | データ最小化の原則 / Data minimisation | PII を含まないデザイン構造データのみ保持。 / Only PII-free design structure data is retained.                                                                                                                                                                                                                            |

---

## 14. BullMQ embedding-backfill Queue（v0.4.0 PR4）/ BullMQ embedding-backfill Queue (v0.4.0 PR4)

### 対象データ / Data in Scope

page.analyze の Phase 5 (Embedding) で 1 ページあたり Part 件数が `PART_SYNC_THRESHOLD`（デフォルト 100）を超えた場合、残余を非同期処理する BullMQ Queue。

BullMQ queue that asynchronously processes remaining Part embeddings when page.analyze Phase 5 (Embedding) exceeds `PART_SYNC_THRESHOLD` (default 100) Parts per page.

- **保存先 / Storage**: Redis (port <!-- gen:port-redis -->27379<!-- /gen:port-redis -->)
- **Queue 名 / Queue name**: `embedding-backfill`
- **ジョブペイロード / Job payload**:
  - `webPageId` (UUID v4/v7)
  - `category` (`part_text` | `part_visual`)
  - `screenshotStoragePath` (optional, `part_visual` 用の `${REFTRIX_SCREENSHOT_ROOT}/phase5/<webPageId>.png` 絶対パス)
  - `requiresBboxResolution` (optional boolean)
  - `createdAt` (ISO 8601)
  - `requestId` (optional, ≤128 chars)

### PII 評価 / PII Assessment

- **PII 含有 / PII**: なし / None
- `webPageId` は UUID v7 で個人識別性なし / `webPageId` is UUID v7 with no personal identifier
- `screenshotStoragePath` は Phase 5 ディレクトリ配下の path のみで、`validateScreenshotPath()` により allowlist + realpath 検証済み / `screenshotStoragePath` is constrained to the Phase 5 directory and validated via `validateScreenshotPath()` (allowlist + realpath)
- ジョブ結果 (`EmbeddingBackfillJobResult`) は件数・処理時間・エラー概要のみで PII を含まない / The job result contains only counts, durations, and a sanitized error summary — no PII

### 保持期間 / Retention Period

| 種別 / State            | 保持期間 / Retention                              | BullMQ オプション / Option                                   |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| 完了ジョブ / Completed  | 24時間 または 最新 1,000 件 / 24h or latest 1,000 | `removeOnComplete: { age: 86400, count: 1000 }`              |
| 失敗ジョブ / Failed     | 7日 または 最新 500 件 / 7 days or latest 500     | `removeOnFail: { age: 604800, count: 500 }`                  |
| リトライ / Retry policy | 最大 3 回、exponential backoff (5s から)          | `attempts: 3, backoff: { type: "exponential", delay: 5000 }` |

### 削除経路 / Deletion Path

- **自動 / Automatic**: 上記 BullMQ retention policy による自動失効 / Automatic expiry via the BullMQ retention policy above
- **手動 / Manual**: `data.delete` MCP ツールで web_page を削除する際、Queue 側のジョブも連動削除（GDPR Art. 17 忘れられる権利） / When `data.delete` MCP tool removes a web_page, related queue jobs are removed in tandem (GDPR Art. 17 Right to Erasure)
- **Jobs 手動削除 / Manual job removal**: Redis から直接 `bull:embedding-backfill:*` キーを削除することも可（運用者向け） / Operators may directly delete `bull:embedding-backfill:*` keys from Redis

### セキュリティ措置 / Security Measures

- **入力検証 / Input validation**: 投入時 (`addEmbeddingBackfillJob`) および Worker 受信時 (`processBackfillJob`) の 2 か所で Zod スキーマ (`EmbeddingBackfillJobDataSchema`) により parse（defense in depth、SEC M-1 / v0.4.0 PR4 audit）。不正 UUID / 改行混入 / 長大文字列 (>512 chars) を拒否 / Zod-validated at both enqueue (`addEmbeddingBackfillJob`) and worker receipt (`processBackfillJob`) boundaries (defense in depth, SEC M-1 / v0.4.0 PR4 audit). Rejects invalid UUID / newline injection / oversized strings (>512 chars)
- **Path Traversal 防御 / Path traversal defense**: `screenshotStoragePath` は Worker 内で `validateScreenshotPath()` を通し、allowlist + `fs.promises.realpath` で symlink 解消 + 実ファイル確認を実施（SEC H-1 / L-1 / v0.4.0 PR4 audit） / `screenshotStoragePath` passes through `validateScreenshotPath()` inside the worker — allowlist + `fs.promises.realpath` symlink resolution + real-file check (SEC H-1 / L-1 / v0.4.0 PR4 audit)
- **PII ログ保護 / PII-safe logging**: 全ログで `webPageId` は先頭 8 文字 + `...` に truncate / All logs truncate `webPageId` to the first 8 chars + `...`
- **エラーサニタイズ / Error sanitization**: Queue / Worker 内の全 catch で `sanitizeErrorMessage` を経由してスタックトレースや DB 内部構造の漏洩を防御 / Every catch in queue / worker routes error messages through `sanitizeErrorMessage` to avoid leaking stack traces or DB internals

### GDPR 対応 / GDPR Compliance

| 条項 / Article   | 内容 / Subject                         | 対応 / Implementation                                                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Art. 17**      | 忘れられる権利 / Right to erasure      | `data.delete` による web_page 削除時に、対応する `<webPageId>__<category>` ジョブを BullMQ Queue から削除 / On `data.delete` web_page removal, the associated `<webPageId>__<category>` jobs are removed from the BullMQ queue                                            |
| **Art. 5(1)(c)** | データ最小化の原則 / Data minimisation | ペイロードには webPageId / category / (optional) storage path のみ保持。HTML / スクリーンショット / embedding ベクトルは Queue に持たない / Payload contains only webPageId / category / (optional) storage path; HTML / screenshots / embeddings never live in the queue |
| **Art. 5(1)(e)** | 保存制限の原則 / Storage limitation    | BullMQ の `removeOnComplete` / `removeOnFail` TTL により自動失効 / Automatic expiry via BullMQ `removeOnComplete` / `removeOnFail` TTL                                                                                                                                    |

### 自動メンテナンスタスク（v0.4.0 PR6）/ Automated Maintenance Tasks (v0.4.0 PR6)

v0.4.0 PR6 で `start-workers.ts` 起動時に以下の定期タスクが自動セットアップされる。Worker shutdown 時に `stop()` で停止される。

v0.4.0 PR6 sets up the following periodic tasks automatically at `start-workers.ts` startup, and stops them via `stop()` on worker shutdown.

| タスク / Task                 | 頻度 / Frequency       | 目的 / Purpose                                                                                                                                                                                                                                                                           | ソース / Source                        | 環境変数 / Env Vars                                                                                                        |
| ----------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Screenshot TTL cleanup        | 24時間ごと / every 24h | 7 日を超過した screenshot を削除 + DB `screenshotStoragePath` を NULL 化 / Delete screenshots older than 7d and NULL the DB path                                                                                                                                                         | `cron/screenshot-cleanup-cron.ts`      | `SCREENSHOT_CLEANUP_INTERVAL_MS`, `SCREENSHOT_CLEANUP_OLDER_THAN_MS`, `SCREENSHOT_CLEANUP_MAX_BATCH_SIZE`                  |
| Backfill stale reconciliation | 1時間ごと / every 1h   | `embedding_backfill_status = 'in_progress'` かつ Queue に job が無い stale 行を DB 完全性で `completed` / `failed` に補正（CAS で worker 競合回避） / Reconciles stale in_progress rows with no queue job to completed / failed based on DB completeness (CAS guard against worker race) | `cron/backfill-reconciliation-cron.ts` | `BACKFILL_RECONCILIATION_INTERVAL_MS`, `BACKFILL_RECONCILIATION_STALE_THRESHOLD_MS`, `BACKFILL_RECONCILIATION_BATCH_LIMIT` |
| Worker orphan recovery        | 起動時 / at startup    | 前回クラッシュ / 再起動時に active 状態のまま残ったジョブを `categorizeByProgress()` で failed / retry に振り分け / On startup, reroute orphaned active jobs to failed / retry via `categorizeByProgress()`                                                                              | `scripts/start-workers.ts`             | —                                                                                                                          |

**設計判断 / Design decisions**:

- 自動タスクはすべて non-fatal: エラー発生時も worker 本体の動作に影響しない。 / All maintenance tasks are non-fatal: errors never block the worker's main loop.
- 前回実行が未完了の場合 tick は skip（pile-up 防止）。 / Ticks overlapping a still-running sweep are skipped (pile-up prevention).
- CLI `apps/mcp-server/src/scripts/reconcile-backfill.ts` は運用者手動実行専用として残存。production では `--confirm` または `--dry-run` 必須（誤発火防止、SEC LOW-2）。 / CLI remains for manual operator use; production requires `--confirm` or `--dry-run` (SEC LOW-2, prevents accidental runs).

### 遡及修復スクリプト `repair-page-analyze.ts` (v0.4.0 PR7e-α) / Retrospective repair script (v0.4.0 PR7e-alpha)

`apps/mcp-server/scripts/repair-page-analyze.ts` は、PR7e-Ω 7 バグクラスタにより `embeddingBackfillStatus` が `in_progress` / `skipped_memory_pressure` / `skipped_fork_error` のまま 1 時間以上放置されたページを救出する遡及修復スクリプト。`part_visual` + `section_visual` ジョブを `embedding-backfill` Queue に再投入し、`embeddingBackfillStartedAt` を現在時刻で再設定する。**遡及処理は GDPR Art. 5(1)(e) (storage limitation) の範囲内**であり、personal data の保管期間を延長しない。本スクリプトは `embeddingBackfillStatus` の遷移とジョブ再投入のみを行い、新規 embedding は通常の Queue-based Backfill Worker が既存 retention 規約 (7d TTL) に従って生成する。全実行 (dry-run / confirm 両モード) は `audit_logs` に `action=embedding_backfill_repair` / `embedding_backfill_repair_dryrun` で記録される (GDPR Art. 30 処理活動記録)。

`apps/mcp-server/scripts/repair-page-analyze.ts` is a retrospective repair script that rescues pages whose `embeddingBackfillStatus` has been stuck at `in_progress` / `skipped_memory_pressure` / `skipped_fork_error` for more than 1 hour due to the PR7e-Ω seven-bug cluster. It re-enqueues `part_visual` + `section_visual` jobs onto the `embedding-backfill` Queue and resets `embeddingBackfillStartedAt` to NOW. **The retrospective reprocessing is within the scope of GDPR Art. 5(1)(e) (storage limitation)** and does not extend the retention period of personal data. The script only transitions `embeddingBackfillStatus` and re-enqueues jobs; new embeddings are generated by the regular Queue-based Backfill Worker under the existing 7-day TTL retention policy. Every execution (both dry-run and confirm modes) is recorded in `audit_logs` with `action=embedding_backfill_repair` / `embedding_backfill_repair_dryrun` (GDPR Art. 30 processing activity records).

運用要件 / Operational requirements:

- `REFTRIX_REPAIR_ALLOW_PRODUCTION=true` を production で明示 (未設定時は拒否 / refused when unset)
- `--operator=<name>` 必須 (actor 記録) / mandatory (actor tracking)
- 二段確認 `--confirm --yes` が揃わないと書込禁止 / writes require both `--confirm` and `--yes`
- `REFTRIX_REPAIR_MAX_PAGES=100` 上限 (CWE-770) / upper bound (CWE-770)
- `WorkerActiveLockService.probeExistingLock` pre-flight — active worker lock 検出で即 exit / exits immediately on active-worker-lock detection
- `updateMany` CAS guard で並列 Worker の race を回避 / `updateMany` CAS guard avoids races with concurrent Workers
- `sha256(webPageId|operator|runId)` idempotency key (SEC MED-4)
- Details ADR-0012 参照 / See ADR-0012

---

## 変更履歴 / Changelog

| 日付 / Date | バージョン / Version | 内容 / Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-04-16  | 2.9.0                | v0.4.0 PR7e-α: 遡及修復スクリプト `repair-page-analyze.ts` セクション追加。PR7e-Ω 7 バグクラスタで放置された stale backfill 行を救出。`part_visual` + `section_visual` 再投入。GDPR Art. 5(1)(e) 整合性を明記 (遡及処理は保管期間を延長しない)。audit_logs (`embedding_backfill_repair` / `_repair_dryrun` action) で Art. 30 処理活動記録。9 SEC ガードレール + SEC MED-4 idempotency key (sha256) + WorkerActiveLockService pre-flight probe。ADR-0012 参照。 / v0.4.0 PR7e-alpha: added retrospective repair script `repair-page-analyze.ts` section. Rescues stale backfill rows left behind by the PR7e-Omega 7-bug cluster, re-enqueuing `part_visual` + `section_visual`. Explicitly documents GDPR Art. 5(1)(e) alignment (retrospective reprocessing does not extend retention). audit_logs (`embedding_backfill_repair` / `_repair_dryrun` action) records Art. 30 processing activity. 9 SEC guardrails + SEC MED-4 idempotency key (sha256) + WorkerActiveLockService pre-flight probe. See ADR-0012.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-04-15  | 2.8.0                | v0.4.0 PR7d-3: ドキュメント同期 + 監査要件対応。`cleanupExpired` の TTL cron 実行で削除件数 > 0 時に `audit_logs` にエントリ作成 (action=`screenshot_ttl_cleanup`, actor=`system:screenshot-cleanup-cron`, GDPR Art.30)。`repair-orphaned-backfill-records.ts` が dry-run / confirm 両モードで `audit_logs` にエントリ作成 (action=`backfill_orphaned_repaired`)。Worker 二重稼働防止 (PR7d-2) の env var 3 件 (`REFTRIX_ALLOW_MANUAL_WORKER` / `REFTRIX_WORKER_IS_CHILD` / `REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN`) を Worker 設定表に正式記載。SEC M-1 対応として `WorkerActiveLockService` に discriminated union API (`tryAcquireLock` / `probeExistingLock`) を追加し fail-open vs fail-closed を明示的に区別。ADR-0011 参照。 / v0.4.0 PR7d-3: documentation sync + audit compliance. `cleanupExpired`'s TTL cron now writes an `audit_logs` entry when `deletedCount > 0` (action=`screenshot_ttl_cleanup`, actor=`system:screenshot-cleanup-cron`, GDPR Art.30). `repair-orphaned-backfill-records.ts` writes an `audit_logs` entry in both dry-run and confirm modes (action=`backfill_orphaned_repaired`). Dual-run prevention (PR7d-2) env vars (`REFTRIX_ALLOW_MANUAL_WORKER` / `REFTRIX_WORKER_IS_CHILD` / `REFTRIX_WORKER_SUPERVISOR_BOOT_TOKEN`) are formally documented in the Worker configuration table. Per SEC M-1, `WorkerActiveLockService` gained discriminated union APIs (`tryAcquireLock` / `probeExistingLock`) to distinguish fail-open vs. fail-closed explicitly. See ADR-0011. |
| 2026-04-15  | 2.7.0                | v0.4.0 PR7d-1: PR7c の見落とし補修 — `page-analyze-worker.ts` の Phase 5 後処理 / finally に残っていた `cleanupPhase5TempDir(path.dirname(state.screenshotPngPath))` 呼び出し 2 箇所を削除。永続化された screenshot (`<REFTRIX_SCREENSHOT_ROOT>/phase5/`) の retention-over-deletion bug を解消。併せて `cleanupPhase5TempDir` に 3 段 whitelist 防御（realpath + os.tmpdir() + `reftrix-phase5-raw-` prefix）を追加し、fork orchestrator の `cleanupPhase5TmpDirOnly` を削除して `cleanupPhase5TempDir` に統合（DRY）。既存破損レコード修復スクリプト `repair-orphaned-backfill-records.ts` を追加し、新 enum 値 `skipped_screenshot_missing` で遷移可能化。ADR-0010 参照。 / v0.4.0 PR7d-1: PR7c oversight fix — removed the two `cleanupPhase5TempDir(path.dirname(state.screenshotPngPath))` call sites that remained in `page-analyze-worker.ts` (Phase 5 post-processing and finally), resolving the retention-over-deletion bug on the persisted screenshot directory. Added a three-stage whitelist defense to `cleanupPhase5TempDir` (realpath + os.tmpdir() + `reftrix-phase5-raw-` prefix) and folded `cleanupPhase5TmpDirOnly` into it (DRY). Added a repair script `repair-orphaned-backfill-records.ts` and a new enum value `skipped_screenshot_missing` to transition pre-existing corrupted rows. See ADR-0010.                                                                                                                                                                             |
| 2026-04-15  | 2.6.0                | v0.4.0 PR7c: Phase 5 Screenshot 即時削除を解除し、削除責務を (1) GDPR `data.delete` (Art. 17 即時) + (2) PR6 TTL cron (7d) の 2 経路に統一。Phase 5 fork orchestrator の `cleanupScreenshotAndTmp()` を `cleanupPhase5TmpDirOnly()` に改名して RAW decode tmp dir のみ best-effort 削除に変更。これにより Queue-based Backfill (`part_visual` / `section_visual`) が screenshot を参照可能になり visual embedding が実生成される。併せて Pre-Return Pause の resume 補完 (`applyPreReturnPauseAndMemoryGate()` helper) で RSS 軽量 Worker の永久 pause バグを解消。ADR-0009 参照。 / v0.4.0 PR7c: Removed Phase 5's immediate screenshot deletion. Deletion consolidated into two paths: (1) GDPR `data.delete` (Art. 17 immediate) + (2) PR6 TTL cron (7d). Phase 5 fork orchestrator's `cleanupScreenshotAndTmp()` is renamed to `cleanupPhase5TmpDirOnly()` and now only best-effort removes the RAW decode tmp dir. Queue-based Backfill (`part_visual` / `section_visual`) can now actually read the screenshot and generate visual embeddings. Also fixes the RSS-light worker permanent-pause bug via `applyPreReturnPauseAndMemoryGate()` helper. See ADR-0009.                                                                                                                                                                                                                                                                                                                                      |
| 2026-04-13  | 2.5.0                | v0.4.0 PR7a + PR7b: Phase 5 Skip Recovery 全活性化。`embeddingBackfillRetryCount` (INT, retry cap 5, 無限ループ防御) + `embeddingBackfillSkippedAt` (TIMESTAMPTZ, 7d TTL, GDPR Art. 5(1)(e)) 追加。7d TTL cron で `skipped_*` → `failed` (reason=`skip_recovery_expired`) 遷移。新規 audit*logs action: `backfill_retry_exhausted` / `skip_recovery_expired` / `embedding_backfill_queue_jobs_removed`（全て `truncateTargetId` 適用）。ADR-0008 (Accepted) 参照。/ v0.4.0 PR7a + PR7b: Phase 5 Skip Recovery activation. Added `embeddingBackfillRetryCount` (INT, retry cap 5, infinite-loop defense) + `embeddingBackfillSkippedAt` (TIMESTAMPTZ, 7d TTL, GDPR Art. 5(1)(e)). 7d TTL cron transitions `skipped*\*`→`failed` with reason=`skip_recovery_expired`. New audit_logs actions: `backfill_retry_exhausted`/`skip_recovery_expired`/`embedding_backfill_queue_jobs_removed`(all with`truncateTargetId`). See ADR-0008 (Accepted).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-04-13  | 2.4.0                | v0.4.0 PR6: TTL cron 統合（Screenshot cleanup 24h + backfill reconciliation 1h、`updateMany` CAS で worker 競合回避、`embeddingBackfillStartedAt` 専用列で stale 判定、CLI production `--confirm`/`--dry-run` 必須 SEC LOW-2）。 / v0.4.0 PR6: TTL cron integration (screenshot cleanup 24h + backfill reconciliation 1h, CAS via `updateMany` avoids worker race, stale detection uses dedicated `embeddingBackfillStartedAt` column, CLI production requires `--confirm`/`--dry-run` — SEC LOW-2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-04-12  | 2.3.0                | BullMQ embedding-backfill Queue (v0.4.0 PR4) セクション追加。Redis port <!-- gen:port-redis -->27379<!-- /gen:port-redis -->、24h/7d retention、Zod 投入/受信 2 段検証 (SEC M-1)、Path Traversal allowlist + realpath 再適用 (SEC H-1/L-1)、GDPR Art. 17/5(1)(c)/5(1)(e) 対応 / Added BullMQ embedding-backfill Queue (v0.4.0 PR4) section. Redis port <!-- gen:port-redis -->27379<!-- /gen:port-redis -->, 24h/7d retention, Zod validation at enqueue + receipt (SEC M-1), path traversal allowlist + realpath re-applied (SEC H-1/L-1), GDPR Art. 17/5(1)(c)/5(1)(e) compliance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-04-12  | 2.2.0                | Screenshot Persistence (v0.4.0 PR1) セクション追加。保存先 `${REFTRIX_SCREENSHOT_ROOT}/phase5/<webPageId>.png`、`web_pages.screenshot_storage_path` カラム、GDPR Art. 17 削除経路統合、Path Traversal 三重防御、Symlink 正規化、サイズ上限 (50MB default / `SCREENSHOT_MAX_BYTES`)、cleanupExpired batch size cap、7日 TTL / Added Screenshot Persistence (v0.4.0 PR1) section. Storage at `${REFTRIX_SCREENSHOT_ROOT}/phase5/<webPageId>.png`, `web_pages.screenshot_storage_path` column, GDPR Art. 17 deletion path integration, triple Path Traversal defense, symlink canonicalization, size cap (50MB default / `SCREENSHOT_MAX_BYTES`), cleanupExpired batch size cap, 7-day TTL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2026-03-29  | 2.1.0                | Phase 5 一時ファイル（RAW decode最適化）の透明性記述を追加（ディスク書き出し、パーミッション、finallyライフサイクル、PII保護）/ Added Phase 5 temporary files (RAW decode optimization) transparency description (disk write, permissions, finally lifecycle, PII protection)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-03-27  | 2.0.0                | v0.3.0テーブル追記: audit_logs（365日保持、GDPR Art.30）、search_logs（90日推奨、profileId NULL化連動）、design_snapshots + design_snapshot_sections（CASCADE DELETE連動）/ Added v0.3.0 tables: audit_logs (365-day retention, GDPR Art.30), search_logs (90-day recommended, profileId anonymization), design_snapshots + design_snapshot_sections (CASCADE DELETE)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-03-14  | 1.5.0                | Blank Image Detection + Dynamic Fallback (v0.1.9) のデータフロー・PII保護・上限記述を追加 / Added data flow, PII protection, and cap description for Blank Image Detection + Dynamic Fallback (v0.1.9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-03-14  | 1.4.0                | Section Screenshot Fallback (v0.1.6) のフォールバック機構透明性記述を追加（メモリ上一時保持、DB非保存） / Added fallback mechanism transparency for Section Screenshot Fallback (v0.1.6) (in-memory only, not persisted to DB)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-03-13  | 1.3.0                | Section Visual Embedding データ保持セクション追加（section_embeddings.vision_embedding、PII保護、CASCADE削除） / Added Section Visual Embedding data retention section (section_embeddings.vision_embedding, PII protection, CASCADE deletion)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-03-13  | 1.2.0                | Part-Level Analysis データ保持セクション追加（component_parts / component_part_embeddings テーブル、PII保護、CASCADE削除） / Added Part-Level Analysis data retention section (component_parts / component_part_embeddings tables, PII protection, CASCADE deletion)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2026-03-11  | 1.1.0                | クロールデータ保持セクション追加 / Added crawl data retention section                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-03-08  | 1.0.0                | 初版作成 / Initial version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
