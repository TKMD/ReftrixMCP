# データ保持ポリシー / Data Retention Policy

**対象 / Scope**: Reftrix Preference Profiling (`preference.hear` / `preference.get` / `preference.reset`)
**最終更新 / Last Updated**: 2026-03-08
**バージョン / Version**: 1.0.0

---

## 1. 対象データ / Data in Scope

### 対象テーブル / Tables

| テーブル / Table | 内容 / Description | 主なカラム / Key Columns |
|---|---|---|
| `preference_profiles` | ユーザー嗜好プロファイル / User preference profiles | `id`, `name`, `preference_text`, `preference_embedding` (768-dim vector), `interaction_count`, `created_at`, `updated_at` |
| `preference_signals` | 個別フィードバック記録 / Individual feedback records | `id`, `profile_id` (FK), `signal_type`, `signal_weight`, `target_type`, `target_id`, `feedback_text`, `created_at` |

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

| 条項 / Article | 内容 / Subject | Reftrixでの対応 / Reftrix Implementation |
|---|---|---|
| **Art. 5(1)(e)** | 保存制限の原則 / Storage limitation | ユーザーが明示的に削除可能。自動期限切れなし（ローカルツールとして適切）。 / User can explicitly delete. No auto-expiry (appropriate for local tool). |
| **Art. 6(1)(f)** | 正当な利益 / Legitimate interest | ユーザーの自発的な使用に基づくパーソナライズ。 / Personalization based on voluntary user engagement. |
| **Art. 13/14** | 情報提供義務 / Information obligations | 本ドキュメントおよび `preference.hear` の `profiling_notice` で通知。 / Informed via this document and `profiling_notice` in `preference.hear`. |
| **Art. 17** | 忘れられる権利 / Right to erasure | `preference.reset(hard_delete: true)` で完全削除。 / Full deletion via `preference.reset(hard_delete: true)`. |
| **Art. 20** | データポータビリティの権利 / Right to data portability | `preference.get(include_signals: true)` でJSON形式エクスポート。 / JSON export via `preference.get(include_signals: true)`. |

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

## 6. セキュリティ措置 / Security Measures

| 措置 / Measure | 実装状況 / Implementation |
|---|---|
| 入力バリデーション / Input validation | Zodスキーマによる全入力検証 / All inputs validated via Zod schemas |
| エラーメッセージサニタイズ / Error message sanitization | `sanitizeErrorMessage()` でDB構造の漏洩防止 / `sanitizeErrorMessage()` prevents DB structure leakage |
| PII配慮ログ / PII-aware logging | `profileId.slice(0, 8) + '...'` でtruncate / Truncated with `profileId.slice(0, 8) + '...'` |
| 監査証跡 / Audit trail | `hard_delete` は全環境で `logger.warn` 出力 / `hard_delete` outputs `logger.warn` in all environments |
| CASCADE削除 / CASCADE deletion | `preference_signals` はプロファイル削除時に自動削除 / `preference_signals` auto-deleted on profile deletion |

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

法的調査日 / Legal Research Date: 2026-03-08

---

## 変更履歴 / Changelog

| 日付 / Date | バージョン / Version | 内容 / Description |
|---|---|---|
| 2026-03-08 | 1.0.0 | 初版作成 / Initial version |
