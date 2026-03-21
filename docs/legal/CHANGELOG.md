# 法務ドキュメント変更履歴 / Legal Document Changelog

**法的調査日 / Legal Research Date**: 2026-03-08

---

## [0.1.1] - 2026-03-08 (Preference Profiling GDPR Compliance)

> ソフトウェアバージョン v0.1.3 に対応 / Corresponds to software version v0.1.3

### Preference Profiling機能に伴う法務ドキュメント更新 / Legal Document Updates for Preference Profiling Feature

#### PRIVACY_POLICY.md (更新 / Updated: v0.1.0 → v0.1.1)

- **第1条7項追加 / Section 1.7 added**: 嗜好プロファイルデータの収集項目を追加（嗜好テキスト、嗜好ベクトル、フィードバック記録、フィードバック回数） / Added preference profile data collection items (preference text, preference embedding, feedback records, interaction count)
- **第2条更新 / Section 2 updated**: 「検索結果のパーソナライズ」を利用目的に追加。「プロファイリング」を禁止目的リストから除外し、GDPR Art. 22(1)適用範囲外の説明を追加 / Added "search result personalization" to purposes of use. Removed "profiling" from prohibited purposes list and added GDPR Art. 22(1) out-of-scope explanation
- **第5条4項追加 / Section 5.4 added**: `preference.reset` による嗜好データ削除方法（ソフトリセット / ハードデリート）を追加 / Added preference data deletion methods via `preference.reset` (soft reset / hard delete)
- **参照リンク追加 / Reference links added**: `apps/mcp-server/PRIVACY.md` および `apps/mcp-server/DATA_RETENTION.md` への参照を追加 / Added references to `apps/mcp-server/PRIVACY.md` and `apps/mcp-server/DATA_RETENTION.md`

#### TERMS_OF_SERVICE.md (軽微な更新 / Minor Update)

- **第1条1項更新 / Section 1.1 updated**: 機能リストに「嗜好プロファイリング（Preference Profiling）」を追加（日本語版・英語版） / Added "Preference Profiling" to feature list (both Japanese and English versions)

#### 新規ドキュメント（`apps/mcp-server/` 配下） / New Documents (under `apps/mcp-server/`)

- **`PRIVACY.md`**: プロファイリングプライバシーポリシー（GDPR Art. 6/13/14/22対応、8セクション、日英バイリンガル） / Profiling Privacy Policy (GDPR Art. 6/13/14/22 compliant, 8 sections, bilingual)
- **`DATA_RETENTION.md`**: データ保持ポリシー（GDPR Art. 5/6/13/14/17/20対応、ソフトリセット・ハードデリート・データエクスポート仕様） / Data Retention Policy (GDPR Art. 5/6/13/14/17/20 compliant, soft reset, hard delete, data export specifications)

### 確認済み事項 / Verified Items

#### CONTRIBUTING.md

- **確認結果 / Result**: プロファイリング/GDPR関連の貢献ガイドライン追加は不要。既存のコーディング規約（`sanitizeErrorMessage()`, `truncateId()`, Zodバリデーション）が十分にカバー / No profiling/GDPR-specific contributing guidelines needed. Existing coding standards cover the necessary patterns

#### `apps/mcp-server/PRIVACY.md` / `DATA_RETENTION.md` — OSS同期確認 / OSS Sync Verification

- **確認結果 / Result**: `.ossfilter` で除外されていないため、OSS同期時に `oss/apps/mcp-server/` に含まれる。`PRIVACY_POLICY.md` から相互参照リンクを追加済み / Not excluded by `.ossfilter`, so included in OSS sync. Cross-reference links added from `PRIVACY_POLICY.md`

---

## [0.1.0] - 2026-03-01 (OSS Release Prep v3 Audit)

### 8エージェント監査結果の法務関連対応 / Legal Actions from 8-Agent Audit

#### Legal-H1 (修正済み / Fixed)

- **内容**: `.env.example` に `REFTRIX_RESPECT_ROBOTS_TXT="true"` が未設定だった
- **対応**: `.env.example` に環境変数を追加（デフォルト: `"true"`）
- **関連ファイル**: `.env.example` (L49-52)
- **法的根拠**: robots.txt尊重はWebスクレイピングの合法性確保において重要な要素。[JP] 不正競争防止法上のアクセス制御に対する配慮、[US] CFAA/ToS遵守、[EU] GDPR正当利益バランステスト

#### Legal-H2 (修正済み / Fixed)

- **内容**: `PRIVACY_POLICY.md` の最終更新日が古かった
- **対応**: 最終更新日を 2026-02-23 に更新（日本語版・英語版両方）
- **関連ファイル**: `docs/legal/PRIVACY_POLICY.md`

#### AI_MODEL_LICENSES.md 日付修正 / Date Correction

- **内容**: 法的調査日が将来日付（2026-03-01）に設定されていた
- **対応**: 全3箇所を 2026-02-23 に修正
- **関連ファイル**: `docs/legal/AI_MODEL_LICENSES.md` (L4, L474, L516)

### 確認済み事項 / Verified Items

#### THIRDPARTY_LICENSES.md

- **確認結果**: NarrativeSearchService が `@reftrix/ml` の `EmbeddingService` クラスを直接使用する変更は、ライセンス互換性に影響なし
- **理由**: `@reftrix/ml` はReftrixプロジェクトの内部パッケージであり、AGPL-3.0-only が適用される。`EmbeddingService` が内部的に使用する `onnxruntime-node` (MIT) および `multilingual-e5-base` モデル (MIT) は、既に THIRDPARTY_LICENSES.md に記載済み。Class版への移行は依存関係の変更を伴わないため、サードパーティライセンスへの影響はなし
- **総パッケージ数**: 804（変更なし）
- **生成日**: 2026-02-18（再生成不要と判断）

#### AI_MODEL_LICENSES.md

- **確認結果**: multilingual-e5-base の MITライセンス表記は最新
- **検証方法**: WebSearch にて HuggingFace 公式ページ (https://huggingface.co/intfloat/multilingual-e5-base) を確認。MIT License であることを再確認
- **ONNX Runtime**: MIT License、変更なし
- **Llama 3.2 Vision EU制限**: 依然有効。Llama 4（2025年4月リリース）でも全モデルがマルチモーダルのためEU制限が継続中。EU AI Act完全施行（2026年8月2日）後のMeta方針変更の可能性あり

#### NOTICE (oss/NOTICE)

- **確認結果**: 帰属表示は正確
- **検証項目**:
  - Copyright年: 2025-2026 -- 正確
  - ライセンス参照: AGPL-3.0-only -- 正確
  - 主要依存パッケージ: 15パッケージ記載 -- 全て正確（ライセンス表記含む）
  - MLモデル: multilingual-e5-base (MIT License) -- 正確、バンドルされていない旨の記載あり
  - THIRDPARTY_LICENSES.md への参照: あり -- 正確

### 最新法令動向メモ / Regulatory Update Notes (2026-02-23)

#### [JP] 個人情報保護法改正

- 2026年1月9日公表の「制度改正方針」に基づく改正法案が2026年通常国会に提出予定
- 主要改正点: 課徴金制度導入、こどもの個人情報保護強化、漏洩報告の合理化
- PRIVACY_POLICY.md 第7条の2（7-2.2項）に記載済み。施行後の更新が必要

#### [EU] EU AI Act

- 2026年8月2日: 高リスクAIシステム（Annex III）義務、透明性義務（第50条）施行予定
- Article 50 Code of Practice: 2026年6月頃に最終版公表予定
- PRIVACY_POLICY.md 第7条の2（7-2.1項）に施行スケジュール記載済み

#### [US] CCPA/CPRA

- 2026年1月1日発効の改正規則: リスクアセスメント義務が適用開始
- ADMT義務: 2027年1月1日から遵守開始
- PRIVACY_POLICY.md 第8条（8.2項）および第9条（9.3項）に記載済み

#### [EU] Meta Llama EU制限

- Llama 4でも全モデルがマルチモーダルのためEU域内制限継続
- AI_MODEL_LICENSES.md に記載済み（Section 3.3, 3.4）

---

## ドキュメント一覧 / Document Inventory

| ドキュメント                 | パス                                       | 最終更新   | 状態                                         |
| ---------------------------- | ------------------------------------------ | ---------- | -------------------------------------------- |
| THIRDPARTY_LICENSES.md       | `/THIRDPARTY_LICENSES.md`                  | 2026-02-18 | 最新                                         |
| AI_MODEL_LICENSES.md         | `/docs/legal/AI_MODEL_LICENSES.md`         | 2026-02-23 | 更新済み                                     |
| PRIVACY_POLICY.md            | `/docs/legal/PRIVACY_POLICY.md`            | 2026-03-08 | 更新済み（v0.1.1: Preference Profiling対応） |
| TERMS_OF_SERVICE.md          | `/docs/legal/TERMS_OF_SERVICE.md`          | 2026-03-08 | 更新済み（Preference Profiling追加）         |
| PRIVACY.md (Profiling)       | `/apps/mcp-server/PRIVACY.md`              | 2026-03-08 | 新規作成                                     |
| DATA_RETENTION.md            | `/apps/mcp-server/DATA_RETENTION.md`       | 2026-03-08 | 新規作成                                     |
| LICENSE_FAQ.md               | `/docs/legal/LICENSE_FAQ.md`               | --         | 確認済み                                     |
| LEGAL_RISK_ASSESSMENT.md     | `/docs/legal/LEGAL_RISK_ASSESSMENT.md`     | 2026-02-22 | 最新                                         |
| ROBOTS_TXT_COMPLIANCE.md     | `/docs/legal/ROBOTS_TXT_COMPLIANCE.md`     | --         | 確認済み                                     |
| HYBRID_SEARCH_LEGAL_AUDIT.md | `/docs/legal/HYBRID_SEARCH_LEGAL_AUDIT.md` | --         | 確認済み                                     |
| NOTICE                       | `/oss/NOTICE`                              | --         | 最新                                         |
| .env.example                 | `/.env.example`                            | 2026-02-23 | 更新済み                                     |

---

**免責事項 / Disclaimer**

本文書は一般的な法的情報の提供を目的としており、特定の事案に対する法的助言を構成するものではありません。
具体的な法的判断が必要な場合は、資格を有する弁護士にご相談ください。

This document is provided for general informational purposes only and does not constitute legal advice
for any specific situation. Please consult a qualified attorney for specific legal decisions.

法的調査日 / Legal Research Date: 2026-02-23
