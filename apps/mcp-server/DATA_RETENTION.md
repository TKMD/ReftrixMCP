# データ保持ポリシー / Data Retention Policy

**対象 / Scope**: Reftrix Preference Profiling, Part-Level Analysis, Section Visual Embedding & v0.3.0 Tables
**最終更新 / Last Updated**: 2026-03-29
**バージョン / Version**: 2.1.0

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

## 変更履歴 / Changelog

| 日付 / Date | バージョン / Version | 内容 / Description                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-03-29  | 2.1.0                | Phase 5 一時ファイル（RAW decode最適化）の透明性記述を追加（ディスク書き出し、パーミッション、finallyライフサイクル、PII保護）/ Added Phase 5 temporary files (RAW decode optimization) transparency description (disk write, permissions, finally lifecycle, PII protection)                                                                                         |
| 2026-03-27  | 2.0.0                | v0.3.0テーブル追記: audit_logs（365日保持、GDPR Art.30）、search_logs（90日推奨、profileId NULL化連動）、design_snapshots + design_snapshot_sections（CASCADE DELETE連動）/ Added v0.3.0 tables: audit_logs (365-day retention, GDPR Art.30), search_logs (90-day recommended, profileId anonymization), design_snapshots + design_snapshot_sections (CASCADE DELETE) |
| 2026-03-14  | 1.5.0                | Blank Image Detection + Dynamic Fallback (v0.1.9) のデータフロー・PII保護・上限記述を追加 / Added data flow, PII protection, and cap description for Blank Image Detection + Dynamic Fallback (v0.1.9)                                                                                                                                                                |
| 2026-03-14  | 1.4.0                | Section Screenshot Fallback (v0.1.6) のフォールバック機構透明性記述を追加（メモリ上一時保持、DB非保存） / Added fallback mechanism transparency for Section Screenshot Fallback (v0.1.6) (in-memory only, not persisted to DB)                                                                                                                                        |
| 2026-03-13  | 1.3.0                | Section Visual Embedding データ保持セクション追加（section_embeddings.vision_embedding、PII保護、CASCADE削除） / Added Section Visual Embedding data retention section (section_embeddings.vision_embedding, PII protection, CASCADE deletion)                                                                                                                        |
| 2026-03-13  | 1.2.0                | Part-Level Analysis データ保持セクション追加（component_parts / component_part_embeddings テーブル、PII保護、CASCADE削除） / Added Part-Level Analysis data retention section (component_parts / component_part_embeddings tables, PII protection, CASCADE deletion)                                                                                                  |
| 2026-03-11  | 1.1.0                | クロールデータ保持セクション追加 / Added crawl data retention section                                                                                                                                                                                                                                                                                                 |
| 2026-03-08  | 1.0.0                | 初版作成 / Initial version                                                                                                                                                                                                                                                                                                                                            |
