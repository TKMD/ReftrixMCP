# Hybrid Search 法務監査レポート / Hybrid Search Legal Audit Report

**バージョン / Version**: 1.0.0
**監査日 / Audit Date**: 2026-02-22
**法的調査日 / Legal Research Date**: 2026-02-22
**対象機能 / Target Feature**: Hybrid Search（ベクトル検索 60% + 全文検索 40%、RRF統合）
**対象法域 / Jurisdictions**: 日本、米国、EU / Japan, United States, EU
**監査者 / Auditor**: Legal Compliance Counsel
**監査結果 / Audit Result**: **PASS（条件付き） / PASS (Conditional)**

---

[日本語版](#日本語版) | [English Version](#english-version)

---

# 日本語版

## 目次

1. [監査概要](#1-監査概要)
2. [監査対象の技術構成](#2-監査対象の技術構成)
3. [法的分析](#3-法的分析)
4. [監査結果](#4-監査結果)
5. [アクションアイテム](#5-アクションアイテム)
6. [免責事項](#6-免責事項)

---

## 1. 監査概要

### 1.1 背景

Reftrixは、Webデザインの構造化ナレッジを管理するプラットフォームであり、クロールしたWebページの情報をベクトルDB（pgvector HNSW）に格納し、セマンティック検索を提供している。v6.12.0以降、ベクトル検索（コサイン類似度）に加えて、PostgreSQLのtsvector/tsqueryに基づく全文検索を組み合わせたHybrid Search（RRF: Reciprocal Rank Fusion、ベクトル60% + 全文40%）が実装された。

本監査は、このHybrid Search機能の法的コンプライアンスを評価するものである。

### 1.2 監査スコープ

| 対象 | 範囲 |
|------|------|
| 機能 | Hybrid Search（ベクトル検索 + 全文検索のRRF統合） |
| データフロー | text_representation生成 -> tsvectorインデックス -> tsquery検索 -> RRFスコア統合 |
| 法域 | 日本（著作権法、個人情報保護法）、米国（Copyright Act、CFAA）、EU（GDPR、DSM Directive） |
| 既存ドキュメント | LEGAL_RISK_ASSESSMENT.md (v0.2.0)、PRIVACY_POLICY.md (v0.1.0)、ROBOTS_TXT_COMPLIANCE.md (v1.0.0) |

---

## 2. 監査対象の技術構成

### 2.1 Hybrid Searchのアーキテクチャ

```
                 ユーザークエリ
                      |
          +-----------+-----------+
          |                       |
    ベクトル検索 (60%)       全文検索 (40%)
    (pgvector cosine)      (tsvector/tsquery)
          |                       |
    類似度スコア             ts_rank_cdスコア
          |                       |
          +-----------+-----------+
                      |
               RRF (Reciprocal Rank Fusion)
                      |
                 統合結果
```

### 2.2 text_representation フィールド

全文検索インデックスの対象となる`text_representation`フィールドは、クロールしたWebページのレイアウト分析結果をテキスト形式で表現したものである。以下の情報を含む:

| 含まれる情報 | 例 | 個人情報リスク |
|-------------|-----|--------------|
| レイアウトタイプ | "hero", "grid", "split" | 低 |
| CSSプロパティ | "flex", "grid-template", "position: sticky" | 低 |
| セクション構造 | "3-column layout with sidebar" | 低 |
| テキスト要素の概要 | 見出しやラベルのテキスト断片 | **中** |
| OGP/メタデータ | サイトタイトル、説明文 | **中** |

### 2.3 tsvectorインデックス

PostgreSQLの`to_tsvector('english', text_representation)`および`to_tsvector('simple', text_representation)`を使用してインデックスを生成。GINインデックスによる高速検索を実現している。

---

## 3. 法的分析

### 3.1 [JP] 日本法における分析

#### 3.1.1 著作権法

**評価: Low Risk**

全文検索インデックス（tsvector）の生成は、著作権法第30条の4第2号「情報解析の用に供する場合」に該当する。以下の理由による:

1. **情報解析目的**: text_representationは、Webページのレイアウト構造をパターンとして分類・検索するためのテキスト表現であり、元の著作物の「享受」を目的としない
2. **変容的利用**: HTML/CSSから抽出されたレイアウト情報をテキスト表現に変換する過程は、元の著作物とは異なる表現形式への変換であり、元の著作物の再現・再構成を目的としない
3. **非復元性**: tsvectorは語彙の出現頻度・位置情報のみを保持し、元のHTMLを復元することはできない

ただし、text_representationフィールドに元ページの見出しテキストやOGPメタデータがそのまま含まれる場合、当該テキストが著作物に該当する可能性がある。この場合でも、検索インデックスとしての利用は「情報解析目的」の範囲内と解釈されうるが、text_representation自体をそのままユーザーに表示する場合は「享受」目的と判断されるリスクがある。

- **根拠法令**: 著作権法第30条の4第2号; 文化庁「AIと著作権に関する考え方について」（令和6年3月）
- **発生可能性**: 低
- **影響度**: 中
- **確信度**: 有力説（第30条の4の適用は通説として支持されるが、text_representationの内容次第で変動）

#### 3.1.2 個人情報保護法（APPI）

**評価: Medium Risk**

text_representationフィールドには、クロール対象ページに含まれる個人情報（氏名、連絡先、プロフィール情報等）がテキスト断片として混入する可能性がある。全文検索インデックスに個人情報が含まれる場合:

1. **個人情報の「取得」**: text_representation生成時にWebページから個人情報を抽出する行為は、個人情報保護法第17条（適正な取得）、第21条（利用目的の特定）の対象となる
2. **保有個人データ**: 全文検索インデックスに含まれる個人情報は、検索可能な状態で保持されるため、「保有個人データ」（個人情報保護法第16条第4項）に該当する可能性がある
3. **利用目的の通知**: セルフホスト型であるため、データ管理責任は運営者に帰属するが、プライバシーポリシーにおいて全文検索インデックスでのデータ利用を明示することが望ましい

- **根拠法令**: 個人情報保護法第17条、第21条、第16条第4項; 個人情報保護委員会「個人情報保護法 いわゆる3年ごと見直しに係る制度改正方針」（2026年1月9日）
- **発生可能性**: 中（クロール対象によっては個人情報の混入は避けられない）
- **影響度**: 中～高（2026年改正で課徴金制度導入の可能性あり）
- **確信度**: 確立（個人情報がインデックスに含まれれば保護法の対象となることは明確）

#### 3.1.3 改正動向への留意

個人情報保護委員会は2026年1月9日に「3年ごと見直しに係る制度改正方針」を公表し、国会への改正案早期提出を目指している。主な改正の方向性:
- 課徴金制度の導入
- リスクベースアプローチの強化
- 適正なデータ利活用の推進

改正内容によっては、全文検索インデックスに含まれる個人情報の取り扱いに追加的な義務が課される可能性がある。

### 3.2 [US] 米国法における分析

#### 3.2.1 Copyright Act

**評価: Low Risk**

全文検索インデックスの生成は、17 U.S.C. Section 107のfair useとして許容される可能性が高い:

1. **利用の目的と性質（第1要素）**: 情報検索目的の変容的利用に該当 -- 有利
2. **著作物の性質（第2要素）**: Webデザインは創作的要素と事実的要素の混合 -- 中立
3. **利用された部分の量（第3要素）**: text_representationは元のHTMLの構造的特徴のみを抽出 -- 有利
4. **市場への影響（第4要素）**: 検索インデックスは元のWebサイトの市場を代替しない -- 有利

#### 3.2.2 CCPA/CPRA

**評価: Medium Risk**

カリフォルニア州のCCPA/CPRAにおいて、text_representationに含まれる可能性のある個人情報は「personal information」の定義（Cal. Civ. Code Section 1798.140(v)）に該当しうる。ただし、Reftrixはセルフホスト型であり、直接的なBtoC関係は想定されないため、適用リスクは限定的。

### 3.3 [EU] EU法における分析

#### 3.3.1 GDPR

**評価: Medium Risk**

全文検索インデックスに個人データが含まれる場合、GDPRの適用対象となる:

1. **処理の適法根拠（Article 6）**: 正当な利益（Article 6(1)(f)）に基づく処理として構成可能だが、データ主体の権利とのバランシングテストが必要
2. **データ最小化原則（Article 5(1)(c)）**: text_representation生成時に、デザイン分析に不要な個人データを可能な限り除外する設計が求められる
3. **保存制限原則（Article 5(1)(e)）**: 全文検索インデックスに含まれる個人データの保持期間を最小化する必要がある

- **制裁金リスク**: 最大2,000万ユーロまたは全世界年間売上の4%
- **軽減策**: text_representation生成時の個人データフィルタリング、インデックス保持期間の制限

#### 3.3.2 DSM Directive TDM例外

**評価: Low Risk**

全文検索インデックスの生成は、DSM Directive Article 3（研究目的）またはArticle 4（商用目的）のTDM例外の範囲内と解釈されうる。ただし、Article 4に基づく場合、著作権者がrobots.txt等でオプトアウトしている場合はTDM例外が適用されない。

Reftrixではrobots.txt尊重機能がデフォルト有効で実装されているため、Article 4のオプトアウトは技術的に尊重されている。

なお、欧州委員会が2025年12月に開始したTDMオプトアウトの技術プロトコルに関するステークホルダー協議（2026年1月23日締切）の結果および、2026年6月に予定されるCopyright Directiveの見直しの結果に注意が必要である。

---

## 4. 監査結果

### 4.1 総合評価

**PASS（条件付き）**

| 評価項目 | 判定 | リスクレベル | 備考 |
|---------|------|------------|------|
| AGPL-3.0互換性 | PASS | Info | Hybrid Search機能自体にライセンス固有の追加リスクなし |
| 著作権法コンプライアンス | PASS | Low | 情報解析目的の範囲内（第30条の4適用） |
| 個人情報保護（APPI/GDPR） | 条件付きPASS | Medium | text_representationへの個人情報混入リスクの設計保証が必要 |
| robots.txt/ToS尊重 | PASS | Low | 既存のrobots.txt尊重機能がHybrid Searchにも適用（クロール段階でブロック済み） |
| EU DSM Directive | PASS | Low | robots.txtオプトアウト尊重済み |
| 全文検索インデックスの透明性 | 条件付きPASS | Medium | プライバシーポリシーへの追記が望ましい |

### 4.2 PASSの条件

以下のアクションアイテムを実施することを条件として、Hybrid Search機能の法的コンプライアンスはPASSと評価する。

---

## 5. アクションアイテム

### 5.1 P2（次スプリント推奨）

| No. | アクション | 対象リスク | 詳細 |
|-----|-----------|-----------|------|
| HS-P2-1 | `text_representation`に個人情報が混入しない設計保証の文書化 | APPI, GDPR | text_representation生成ロジックにおいて、レイアウト構造情報（CSSプロパティ、セクションタイプ等）のみを含み、人名・メールアドレス・電話番号等の個人情報を含まない設計であることを文書化する。現行実装で個人情報が混入する経路がある場合、フィルタリングの実装または設計変更を検討する |
| HS-P2-2 | robots.txt尊重ロジックのHybrid Search統合における検証・テスト追加 | 著作権法、DSM Directive | Hybrid Search機能が、robots.txtでブロックされたURLのデータを検索結果に含まないことを確認するテストを追加する。クロール段階でブロックされるため論理的には問題ないが、既存DBに保存されたデータ（robots.txt変更前にクロールしたデータ）に関する取り扱いも検討する |
| HS-P2-3 | プライバシーポリシーに全文検索インデックスの使用を追記 | APPI, GDPR, 透明性 | `PRIVACY_POLICY.md`の「分析結果データ」セクションに、全文検索インデックス（tsvector）の使用目的・保存形式・保持期間を追記する。現行のプライバシーポリシーではHybrid Searchの記載はあるが、text_representationフィールドの詳細やtsvectorインデックスの存在は明示されていない |

### 5.2 P3（将来タスク）

| No. | アクション | 対象リスク | 詳細 |
|-----|-----------|-----------|------|
| HS-P3-1 | ToS確認プロセスの設計検討 | 契約法、著作権法 | クロール対象サイトのToSがスクレイピング・インデキシングを禁止していないか確認するプロセスの設計を検討する。完全な自動化は技術的に困難であるため、利用規約でユーザーに確認義務を課す方式が現実的。LEGAL_RISK_ASSESSMENT.md Section 3.4の既存分析と整合 |
| HS-P3-2 | EU DSM Directive TDMオプトアウト対応の拡張検討 | DSM Directive Article 4 | robots.txt以外のTDMオプトアウト手段（meta robots tag、X-Robots-Tag HTTPヘッダー、自然言語によるToSでのオプトアウト表明）への対応を検討する。欧州委員会の技術プロトコル協議結果（2026年1月締切）およびCopyright Directive見直し（2026年6月予定）の動向を注視 |

### 5.3 アクションアイテムとLEGAL_RISK_ASSESSMENT.mdの対応関係

| HS アクション | LEGAL_RISK_ASSESSMENT.md 関連項目 | 関係 |
|-------------|----------------------------------|------|
| HS-P2-1 | H-2（個人情報フィルタリング機能） | 関連（Hybrid Search固有の観点を追加） |
| HS-P2-2 | C-1（robots.txt尊重機能）, Section 3.4 | 関連（既存機能のHybrid Search統合確認） |
| HS-P2-3 | M-3（プライバシーポリシー整備） | 追加（全文検索インデックスの透明性追記） |
| HS-P3-1 | Section 3.4（ToSの法的拘束力） | 関連（長期的なToS確認プロセスの検討） |
| HS-P3-2 | Section 3.3.2（DSM Directive TDM） | 拡張（robots.txt以外のオプトアウト手段） |

---

## 6. 免責事項

---

**免責事項 / Disclaimer**

本分析は一般的な法的情報の提供を目的としており、特定の事案に対する法的助言を構成するものではありません。
具体的な法的判断が必要な場合は、資格を有する弁護士にご相談ください。

This analysis is provided for general informational purposes only and does not constitute legal advice
for any specific situation. Please consult a qualified attorney for specific legal decisions.

法的調査日 / Legal Research Date: 2026-02-22

---

## 参考文献

### 法令

- 著作権法（令和6年改正）: https://laws.e-gov.go.jp/law/345AC0000000048
- 個人情報保護法（令和4年改正）: https://laws.e-gov.go.jp/law/415AC0000000057
- 17 U.S.C. (US Copyright Act): https://www.law.cornell.edu/uscode/text/17
- GDPR (Regulation (EU) 2016/679): https://eur-lex.europa.eu/eli/reg/2016/679/oj
- DSM Directive (2019/790): https://eur-lex.europa.eu/eli/dir/2019/790/oj
- CCPA/CPRA: California Civil Code Section 1798.100 et seq.

### ガイドライン

- 文化庁「AIと著作権に関する考え方について」（令和6年3月15日）: https://www.bunka.go.jp/seisaku/chosakuken/aiandcopyright.html
- 個人情報保護委員会「3年ごと見直しに係る制度改正方針」（2026年1月9日）: https://blog.jpac-privacy.jp/proposedamendmentstothepersonalinformationprotectionact_2503/
- 個人情報保護・プライバシー 2025年の振り返りと2026年の展望（長島・大野・常松法律事務所）: https://www.nagashima.com/publications/publication20260116-2/
- EU DSM Directive Article 4 TDM Opt-Out分析: https://legalblogs.wolterskluwer.com/copyright-blog/the-tdm-opt-out-in-the-eu-five-problems-one-solution/
- EU Copyright Law Roundup Q4 2025: https://legalblogs.wolterskluwer.com/copyright-blog/eu-copyright-law-roundup-fourth-trimester-of-2025/

### 関連する内部ドキュメント

- `docs/legal/LEGAL_RISK_ASSESSMENT.md` (v0.2.0) -- Reftrix OSS公開法的リスク評価レポート（内部文書・本リポジトリ外）
- `docs/legal/PRIVACY_POLICY.md` (v0.1.0) -- プライバシーポリシー
- `docs/legal/ROBOTS_TXT_COMPLIANCE.md` (v1.0.0) -- robots.txtコンプライアンスガイド（内部文書・本リポジトリ外）
- `docs/legal/TERMS_OF_SERVICE.md` -- 利用規約

---

---

# English Version

## Table of Contents

1. [Audit Summary](#1-audit-summary)
2. [Technical Architecture Under Audit](#2-technical-architecture-under-audit)
3. [Legal Analysis](#3-legal-analysis)
4. [Audit Results](#4-audit-results)
5. [Action Items](#5-action-items)
6. [Disclaimer](#6-disclaimer)

---

## 1. Audit Summary

### 1.1 Background

Reftrix is a platform for managing structured knowledge of web design. It stores information from crawled web pages in a vector database (pgvector HNSW) and provides semantic search capabilities. Since v6.12.0, in addition to vector search (cosine similarity), a full-text search based on PostgreSQL's tsvector/tsquery has been combined to implement Hybrid Search (RRF: Reciprocal Rank Fusion, 60% vector + 40% full-text).

This audit evaluates the legal compliance of this Hybrid Search feature.

### 1.2 Audit Scope

| Subject | Scope |
|---------|-------|
| Feature | Hybrid Search (RRF integration of vector search + full-text search) |
| Data Flow | text_representation generation -> tsvector index -> tsquery search -> RRF score integration |
| Jurisdictions | Japan (Copyright Act, APPI), United States (Copyright Act, CFAA), EU (GDPR, DSM Directive) |
| Existing Documents | LEGAL_RISK_ASSESSMENT.md (v0.2.0), PRIVACY_POLICY.md (v0.1.0), ROBOTS_TXT_COMPLIANCE.md (v1.0.0) |

---

## 2. Technical Architecture Under Audit

### 2.1 Hybrid Search Architecture

```
                   User Query
                      |
          +-----------+-----------+
          |                       |
    Vector Search (60%)     Full-Text Search (40%)
    (pgvector cosine)      (tsvector/tsquery)
          |                       |
    Similarity Score         ts_rank_cd Score
          |                       |
          +-----------+-----------+
                      |
               RRF (Reciprocal Rank Fusion)
                      |
               Integrated Results
```

### 2.2 text_representation Field

The `text_representation` field, which serves as the target for full-text search indexing, is a textual expression of layout analysis results from crawled web pages. It includes the following information:

| Information Included | Example | Personal Data Risk |
|---------------------|---------|-------------------|
| Layout type | "hero", "grid", "split" | Low |
| CSS properties | "flex", "grid-template", "position: sticky" | Low |
| Section structure | "3-column layout with sidebar" | Low |
| Text element summaries | Text fragments from headings and labels | **Medium** |
| OGP/metadata | Site title, description | **Medium** |

### 2.3 tsvector Index

Indexes are generated using PostgreSQL's `to_tsvector('english', text_representation)` and `to_tsvector('simple', text_representation)`. High-speed search is achieved through GIN indexing.

---

## 3. Legal Analysis

### 3.1 [JP] Analysis Under Japanese Law

#### 3.1.1 Copyright Act (著作権法)

**Assessment: Low Risk**

The generation of full-text search indexes (tsvector) falls under Article 30-4, Item 2 of the Copyright Act, which permits exploitation of works "for use in information analysis." This conclusion is based on the following reasoning:

1. **Information analysis purpose**: text_representation is a textual expression designed for classifying and searching web page layout structures as patterns, and does not aim at "enjoyment" (享受) of the thoughts or sentiments expressed in the original work
2. **Transformative use**: The process of converting layout information extracted from HTML/CSS into a textual representation constitutes transformation into a different form of expression, and does not aim to reproduce or reconstruct the original work
3. **Non-reversibility**: tsvector retains only lexical frequency and position information and cannot be used to reconstruct the original HTML

However, if the text_representation field contains heading text or OGP metadata from the original page verbatim, such text may qualify as a copyrighted work. Even in such cases, use as a search index can be interpreted as within the scope of "information analysis purpose," but displaying text_representation directly to users may risk being classified as use for "enjoyment" purposes.

- **Legal basis**: Article 30-4, Item 2 of the Copyright Act; Agency for Cultural Affairs, "Approach to AI and Copyright" (March 2024)
- **Likelihood**: Low
- **Impact**: Medium
- **Confidence**: Prevailing view (有力説) (Application of Article 30-4 is supported as the prevailing interpretation, but may vary depending on the content of text_representation)

#### 3.1.2 Act on the Protection of Personal Information (APPI / 個人情報保護法)

**Assessment: Medium Risk**

The text_representation field may inadvertently include personal information (names, contact details, profile information, etc.) from crawled pages as text fragments. When personal information is contained in the full-text search index:

1. **"Acquisition" of personal information**: Extracting personal information from web pages during text_representation generation is subject to Article 17 (proper acquisition) and Article 21 (specification of purpose of use) of the APPI
2. **Retained personal data**: Personal information contained in the full-text search index, being maintained in a searchable state, may qualify as "retained personal data" (Article 16, Paragraph 4 of the APPI)
3. **Notification of purpose of use**: As a self-hosted solution, data management responsibility lies with the operator, but it is desirable to explicitly state the use of data in full-text search indexes in the privacy policy

- **Legal basis**: APPI Articles 17, 21, and 16(4); Personal Information Protection Commission, "Institutional Reform Policy for the Triennial Review" (January 9, 2026)
- **Likelihood**: Medium (depending on crawl targets, inclusion of personal information may be unavoidable)
- **Impact**: Medium to High (potential introduction of administrative surcharge system in the 2026 amendment)
- **Confidence**: Established (確立) (it is clear that personal information contained in indexes is subject to the APPI)

#### 3.1.3 Note on Pending Legislative Amendments

The Personal Information Protection Commission published its "Institutional Reform Policy for the Triennial Review" on January 9, 2026, aiming for early submission of an amendment bill to the Diet. Key directions of the amendment include:
- Introduction of an administrative surcharge system
- Strengthening of a risk-based approach
- Promotion of proper data utilization

Depending on the content of the amendments, additional obligations may be imposed on the handling of personal information contained in full-text search indexes.

### 3.2 [US] Analysis Under United States Law

#### 3.2.1 Copyright Act

**Assessment: Low Risk**

The generation of full-text search indexes is likely to be permitted as fair use under 17 U.S.C. Section 107:

1. **Purpose and character of the use (Factor 1)**: Constitutes transformative use for information retrieval purposes -- Favors fair use
2. **Nature of the copyrighted work (Factor 2)**: Web design is a mixture of creative and factual elements -- Neutral
3. **Amount and substantiality of the portion used (Factor 3)**: text_representation extracts only structural characteristics of the original HTML -- Favors fair use
4. **Effect on the market (Factor 4)**: A search index does not substitute for the market of the original website -- Favors fair use

#### 3.2.2 CCPA/CPRA

**Assessment: Medium Risk**

Under California's CCPA/CPRA, personal information potentially contained in text_representation may fall within the definition of "personal information" (Cal. Civ. Code Section 1798.140(v)). However, since Reftrix is a self-hosted solution and no direct B-to-C relationship is envisioned, the applicability risk is limited.

### 3.3 [EU] Analysis Under EU Law

#### 3.3.1 GDPR

**Assessment: Medium Risk**

If full-text search indexes contain personal data, GDPR applies:

1. **Lawful basis for processing (Article 6)**: Processing may be structured based on legitimate interests (Article 6(1)(f)), but a balancing test against the rights of data subjects is required
2. **Data minimization principle (Article 5(1)(c))**: The design should exclude personal data unnecessary for design analysis from text_representation generation to the extent possible
3. **Storage limitation principle (Article 5(1)(e))**: The retention period for personal data contained in full-text search indexes must be minimized

- **Sanctions risk**: Up to EUR 20 million or 4% of total worldwide annual turnover
- **Mitigation measures**: Filtering personal data during text_representation generation; limiting index retention periods

#### 3.3.2 DSM Directive TDM Exception

**Assessment: Low Risk**

The generation of full-text search indexes can be interpreted as falling within the TDM (Text and Data Mining) exception under DSM Directive Article 3 (research purposes) or Article 4 (commercial purposes). However, when relying on Article 4, the TDM exception does not apply if rights holders have opted out via robots.txt or similar mechanisms.

Reftrix implements robots.txt compliance as enabled by default, thereby technically respecting Article 4 opt-outs.

Note that attention should be paid to the outcomes of the European Commission's stakeholder consultation on technical protocols for TDM opt-out, which began in December 2025 (deadline January 23, 2026), as well as the review of the Copyright Directive scheduled for June 2026.

---

## 4. Audit Results

### 4.1 Overall Assessment

**PASS (Conditional)**

| Evaluation Item | Verdict | Risk Level | Notes |
|----------------|---------|------------|-------|
| AGPL-3.0 compatibility | PASS | Info | No license-specific additional risk from the Hybrid Search feature itself |
| Copyright law compliance | PASS | Low | Within the scope of information analysis purpose (Article 30-4 applicable) |
| Personal information protection (APPI/GDPR) | Conditional PASS | Medium | Design assurance against personal information inclusion in text_representation is required |
| robots.txt/ToS compliance | PASS | Low | Existing robots.txt compliance feature applies to Hybrid Search (blocked at the crawl stage) |
| EU DSM Directive | PASS | Low | robots.txt opt-out is respected |
| Full-text search index transparency | Conditional PASS | Medium | Addition to privacy policy is desirable |

### 4.2 Conditions for PASS

The legal compliance of the Hybrid Search feature is assessed as PASS, conditional upon the implementation of the following action items.

---

## 5. Action Items

### 5.1 P2 (Recommended for Next Sprint)

| No. | Action | Target Risk | Details |
|-----|--------|------------|---------|
| HS-P2-1 | Document design assurance that `text_representation` does not contain personal information | APPI, GDPR | Document that the text_representation generation logic includes only layout structural information (CSS properties, section types, etc.) and does not include personal information such as names, email addresses, or phone numbers. If pathways exist in the current implementation through which personal information may be included, consider implementing filtering or redesigning |
| HS-P2-2 | Verify and add tests for robots.txt compliance logic in Hybrid Search integration | Copyright Act, DSM Directive | Add tests to confirm that the Hybrid Search feature does not include data from URLs blocked by robots.txt in search results. While this is logically not an issue as blocking occurs at the crawl stage, also consider handling of data already stored in the DB (data crawled before robots.txt changes) |
| HS-P2-3 | Add full-text search index usage to the privacy policy | APPI, GDPR, Transparency | Add the purpose of use, storage format, and retention period for full-text search indexes (tsvector) to the "Analysis Result Data" section of `PRIVACY_POLICY.md`. The current privacy policy mentions Hybrid Search but does not explicitly describe the text_representation field details or the existence of tsvector indexes |

### 5.2 P3 (Future Tasks)

| No. | Action | Target Risk | Details |
|-----|--------|------------|---------|
| HS-P3-1 | Design a ToS verification process | Contract law, Copyright Act | Consider designing a process to verify that the ToS of crawled sites do not prohibit scraping or indexing. Since full automation is technically difficult, a practical approach is to impose a verification obligation on users through the terms of service. Align with the existing analysis in LEGAL_RISK_ASSESSMENT.md Section 3.4 |
| HS-P3-2 | Consider expanding EU DSM Directive TDM opt-out support | DSM Directive Article 4 | Consider support for TDM opt-out mechanisms beyond robots.txt (meta robots tag, X-Robots-Tag HTTP header, natural-language ToS opt-out declarations). Monitor the outcomes of the European Commission's technical protocol consultation (January 2026 deadline) and Copyright Directive review (scheduled June 2026) |

### 5.3 Mapping of Action Items to LEGAL_RISK_ASSESSMENT.md

| HS Action | LEGAL_RISK_ASSESSMENT.md Related Item | Relationship |
|-----------|--------------------------------------|-------------|
| HS-P2-1 | H-2 (Personal information filtering) | Related (adding Hybrid Search-specific perspective) |
| HS-P2-2 | C-1 (robots.txt compliance), Section 3.4 | Related (verification of existing feature integration with Hybrid Search) |
| HS-P2-3 | M-3 (Privacy policy preparation) | Addition (transparency disclosure for full-text search index) |
| HS-P3-1 | Section 3.4 (Legal enforceability of ToS) | Related (long-term ToS verification process design) |
| HS-P3-2 | Section 3.3.2 (DSM Directive TDM) | Extension (opt-out mechanisms beyond robots.txt) |

---

## 6. Disclaimer

---

**Disclaimer**

This analysis is provided for general informational purposes only and does not constitute legal advice
for any specific situation. Please consult a qualified attorney for specific legal decisions.

Legal Research Date: 2026-02-22

---

## References

### Statutes and Regulations

- Copyright Act of Japan (2024 Amendment): https://laws.e-gov.go.jp/law/345AC0000000048
- Act on the Protection of Personal Information (APPI, 2022 Amendment): https://laws.e-gov.go.jp/law/415AC0000000057
- 17 U.S.C. (US Copyright Act): https://www.law.cornell.edu/uscode/text/17
- GDPR (Regulation (EU) 2016/679): https://eur-lex.europa.eu/eli/reg/2016/679/oj
- DSM Directive (Directive (EU) 2019/790): https://eur-lex.europa.eu/eli/dir/2019/790/oj
- CCPA/CPRA: California Civil Code Section 1798.100 et seq.

### Guidelines and Commentary

- Agency for Cultural Affairs, "Approach to AI and Copyright" (March 15, 2024): https://www.bunka.go.jp/seisaku/chosakuken/aiandcopyright.html
- Personal Information Protection Commission, "Institutional Reform Policy for the Triennial Review" (January 9, 2026): https://blog.jpac-privacy.jp/proposedamendmentstothepersonalinformationprotectionact_2503/
- Personal Information Protection and Privacy: 2025 Review and 2026 Outlook (Nagashima Ohno & Tsunematsu): https://www.nagashima.com/publications/publication20260116-2/
- EU DSM Directive Article 4 TDM Opt-Out Analysis: https://legalblogs.wolterskluwer.com/copyright-blog/the-tdm-opt-out-in-the-eu-five-problems-one-solution/
- EU Copyright Law Roundup Q4 2025: https://legalblogs.wolterskluwer.com/copyright-blog/eu-copyright-law-roundup-fourth-trimester-of-2025/

### Related Internal Documents

- `docs/legal/LEGAL_RISK_ASSESSMENT.md` (v0.2.0) -- Reftrix OSS Release Legal Risk Assessment Report (internal document, not included in this repository)
- `docs/legal/PRIVACY_POLICY.md` (v0.1.0) -- Privacy Policy
- `docs/legal/ROBOTS_TXT_COMPLIANCE.md` (v1.0.0) -- robots.txt Compliance Guide (internal document, not included in this repository)
- `docs/legal/TERMS_OF_SERVICE.md` -- Terms of Service

---

*Reftrix Hybrid Search Legal Audit Report v1.0.0*
*Prepared by: Legal Compliance Counsel (AI-assisted analysis)*
*Legal Research Date: 2026-02-22*
