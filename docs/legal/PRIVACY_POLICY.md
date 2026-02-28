# Reftrix プライバシーポリシー / Privacy Policy

[日本語版](#日本語版) | [English Version](#english-version)

---

## 日本語版

### Reftrix プライバシーポリシー

**バージョン**: 0.1.0
**施行日**: 2026年3月1日
**最終更新**: 2026年2月23日

---

### はじめに

本プライバシーポリシーは、Reftrix（以下「本ソフトウェア」）におけるデータの取り扱いについて説明するものです。

Reftrixは、AGPL-3.0-onlyライセンスのもとで提供されるオープンソースソフトウェアであり、Webデザインの分析・パターン抽出を目的としたセルフホスト型プラットフォームです。本ソフトウェアは、MCPプロトコル（Model Context Protocol）を介してAIエージェントからの操作を受け付け、指定されたURLのWebページを取得・分析し、その結果をユーザーが管理するデータベースに保存します。

本ソフトウェアはセルフホスト型であり、SaaS（Software as a Service）として提供されるものではありません。したがって、Reftrixプロジェクトの開発者（以下「プロジェクト」）がユーザーのデータを収集・保管・管理することはありません。データの管理責任は、本ソフトウェアを運用するユーザー自身にあります。

---

### 第1条: 収集する情報

本ソフトウェアは、その機能の一部として、以下の情報を処理します。これらの情報は、ユーザーが明示的に指定したURLに対してのみ取得されます。

#### 1.1 クロール対象ページのコンテンツデータ

| データ種別 | 内容 | 保存形式 |
|-----------|------|---------|
| HTML | 対象ページのHTMLソースコード（DOMPurifyによるサニタイズ済み） | テキスト |
| CSS | 対象ページのスタイルシート情報 | テキスト |
| JavaScript | 対象ページのアニメーション・インタラクション関連コード | テキスト |
| スクリーンショット | Playwrightにより取得された対象ページの画面キャプチャ | PNG画像 |

#### 1.2 メタデータ

| データ種別 | 内容 |
|-----------|------|
| URL | クロール対象ページのURL |
| ページタイトル | HTMLの`<title>`タグから取得 |
| ドメイン名 | URLから抽出されたドメイン情報 |
| OGP情報 | Open Graph Protocolメタタグ（og:title, og:description, og:image等） |
| クロール日時 | データ取得時のタイムスタンプ |

#### 1.3 分析結果データ

| データ種別 | 内容 |
|-----------|------|
| レイアウトパターン | ページのレイアウト構造の分析結果（セクション構成、グリッド、配色等） |
| モーションパターン | CSSアニメーション・トランジション・スクロール連動要素の検出結果 |
| 品質スコア | デザイン品質の評価スコア（独自性、技巧性、文脈適合性等） |
| ナラティブ分析 | ページの視覚的なストーリーテリング要素の分析結果 |
| 背景デザイン | 背景画像・パターン・グラデーション等の検出結果 |

#### 1.4 Embeddingベクトルデータ

本ソフトウェアは、multilingual-e5-baseモデル（ONNX Runtime）を使用して、分析結果から768次元のEmbeddingベクトルを生成します。これらのベクトルデータは、類似デザインの検索（ベクトル検索）に使用されます。

#### 1.5 Vision AI分析結果

Ollama（llama3.2-vision）を使用したスクリーンショットの視覚分析結果がテキストデータとして保存されます。デフォルト設定ではこの処理はローカル環境（localhost）で完結しますが、運用者がOllamaサーバーのURLをリモートホストに設定した場合は、スクリーンショット画像が当該リモートサーバーに送信されます（第3条2項参照）。

#### 1.6 収集しない情報

本ソフトウェア（セルフホスト版）は、Reftrixプロジェクトとして以下の情報を中央収集しません。

- ユーザーアカウント情報（ログインID、パスワード等）
- 利用者の個人情報（氏名、住所、電話番号等）
- 利用状況のテレメトリ・使用統計
- ブラウザフィンガープリント

**IPアドレスについて**: Reftrixプロジェクトがユーザーのアクセス元IPアドレスを中央収集することはありません。ただし、運用者の環境（Webサーバー、リバースプロキシ、OS等）のアクセスログにIPアドレスが記録される場合があります。これは運用者のインフラ設定に依存するものであり、その管理は運用者の責任です。また、クローリング時には、運用者サーバーの送信元IPアドレスがクロール対象サイトに観測されます（第3条2項参照）。なお、GDPRにおいてIPアドレスは個人データに該当し得るため（前文30項）、EU/EEA域内で運用する場合は適切な取扱いが求められます。

**Cookieについて**: Reftrix自身はトラッキング目的のCookieを使用しませんが、クローリング時にクロール対象サイトからCookieを受領する場合があります（第7条2項参照）。

---

### 第2条: 情報の利用目的

本ソフトウェアが処理する情報は、以下の目的にのみ使用されます。

1. **Webデザインパターンの分析・分類**: クロールしたページのレイアウト、モーション、品質を構造化データとして抽出・分類すること
2. **類似デザイン検索**: Embeddingベクトルを用いたセマンティック検索により、類似するデザインパターンを発見すること（ハイブリッド検索: ベクトル検索60% + 全文検索40%）
3. **デザイン品質評価**: 独自の評価基準に基づくデザイン品質の定量的評価を行うこと
4. **デザインナレッジの蓄積**: Webデザインのトレンド・パターンをRAG（Retrieval-Augmented Generation）可能な形式でナレッジベースに蓄積すること

本ソフトウェアは、上記以外の目的（広告、マーケティング、プロファイリング、ユーザー追跡等）のためにデータを利用することはありません。

---

### 第3条: 第三者への提供

#### 3.1 セルフホスト版

本ソフトウェアはセルフホスト型であり、収集・分析したデータはユーザーが管理するPostgreSQLサーバー上にのみ保存されます。プロジェクトがユーザーのデータにアクセスすること、または第三者に提供することはありません。

ユーザーが自身のデータを第三者に提供するかどうかは、ユーザー自身の判断と責任によります。

#### 3.2 外部通信

本ソフトウェアは、以下の外部通信を行います。

| 通信先 | 目的 | データ内容 |
|--------|------|-----------|
| クロール対象Webサイトおよび当該ページが参照する第三者ドメイン（CDN、外部フォントサービス、画像ホスティング等） | Webページの取得・レンダリング（Playwright経由） | HTTPリクエスト（User-Agentヘッダー含む）。ページのレンダリングに必要なサブリソース（CSS、JavaScript、画像、フォント等）の取得、DNSの名前解決、TLS接続の確立、リダイレクトの追従を含む |
| Ollamaサーバー | Vision AI分析 | スクリーンショット画像 |

**クロール対象サイトへの情報露出**: クローリング時には、運用者サーバーの送信元IPアドレスおよびUser-Agent文字列（デフォルト: `Reftrix/0.1.0`を含む識別子）がクロール対象サイトおよび第三者リソースの提供元に観測されます。

**Ollamaサーバーについて**: デフォルト設定ではlocalhostのOllamaサーバー（`http://localhost:11434`）に接続します。この場合、スクリーンショット画像はローカル環境内でのみ処理されます。ただし、運用者がOllamaサーバーのURLをリモートホストに変更した場合は、スクリーンショット画像が当該リモートサーバーに送信されます。リモートOllamaサーバーを使用する場合は、通信経路の暗号化（TLS）およびデータの取扱いについて運用者自身が責任を負ってください。

**SSRF対策**: プライベートIPアドレスおよびメタデータサービスへのアクセスはブロックされます。

---

### 第4条: クロール対象ページの個人情報（重要）

#### 4.1 個人情報の含有リスク

本ソフトウェアがクロールするWebページには、以下のような個人情報（個人情報保護法第2条第1項に定義される「個人情報」）が含まれる可能性があります。

- 氏名、メールアドレス、電話番号
- 人物写真・肖像画像
- 住所、所在地情報
- SNSアカウント情報
- その他、特定の個人を識別できる情報

#### 4.2 データ最小化の原則

本ソフトウェアは、Webデザインのパターン分析を目的としており、個人情報の取得を目的としていません。以下のデータ最小化措置を講じています。

- **HTMLサニタイゼーション**: DOMPurify 3.3.xを使用し、取得したHTMLからXSS攻撃ベクトル（`<script>`タグ、`javascript:` URL、イベントハンドラ属性等）を除去します。また、プロジェクトのサニタイザー設定（`FORBID_TAGS`）により、`<link>`・`<base>`・`<iframe>`等の一部の外部リソース参照タグも除去されます。ただし、`<img>`・`<video>`等のコンテンツ要素に含まれる外部URLはデザイン分析に必要なため保持されます
- **分析対象の限定**: デザインパターン（レイアウト構造、配色、アニメーション等）の分析に必要な情報のみを抽出対象とします
- **SSRF対策**: プライベートIPアドレス、クラウドメタデータサービスへのアクセスをブロックし、意図しない内部ネットワーク情報の取得を防止します

#### 4.2.1 [EU] GDPRにおけるWebスクレイピングとAIに関する最新動向

EDPB（欧州データ保護委員会）は2024年12月17日にOpinion 28/2024を公表し、AIモデル開発におけるデータ保護の見解を示しました。同意見書は、公開されているデータであってもGDPRの保護対象であること、Webスクレイピングによる個人データの無差別収集は「正当利益」の均衡テストにおいて不利に評価される可能性があることを明確にしています。

また、2025年には以下のエンフォースメント事例が報告されています。
- フランスCNIL: KASPRに対し20万ユーロの罰金（データスクレイピング関連、アクセス権侵害）
- オランダDPA: Clearview AIに対し3,050万ユーロの罰金（同意なきWeb画像スクレイピング）
- ポーランドDPA: データブローカーに対し22万ユーロの罰金（公開レジストリのスクレイピング）

運用者がEU/EEA域内の個人データを含むページをクロールする場合は、GDPRに基づく適法な処理根拠（第6条）を確保する必要があります。EDPBは、Webスクレイピングに関する専用ガイドラインの策定を進めており（2024-2025年作業計画）、今後の動向に注意が必要です。

#### 4.3 robots.txt尊重ポリシー

本ソフトウェアは、クロール対象サイトのrobots.txtを尊重することを推奨します。運用者は、robots.txtの指示に従い、クロールが許可されていないページへのアクセスを控えるべきです。

- robots.txtのDisallow指示を遵守すること
- Crawl-delay指示がある場合はそれに従うこと
- 適切なUser-Agentを設定し、ボットであることを明示すること
- サイト管理者からクロール停止の要請があった場合は速やかに対応すること

#### 4.4 削除リクエストへの対応

クロール対象ページの運営者または個人情報の本人から、データの削除リクエストがあった場合、運用者は以下の手順で対応してください。

1. **リクエストの受付**: 削除リクエストの内容を確認し、対象データを特定する
2. **対象データの特定**: PostgreSQLデータベースから該当するURL・ドメインに紐づくすべてのデータを検索する
3. **データの削除**: 以下のデータを完全に削除する
   - クロールしたHTML/CSS/JS/スクリーンショット
   - 分析結果（レイアウトパターン、モーション、品質スコア等）
   - Embeddingベクトルデータ
   - メタデータ（URL、タイトル、OGP情報等）
4. **削除完了の通知**: リクエスト元に削除完了を通知する

---

### 第5条: データの保存と削除

#### 5.1 保存先

すべてのデータは、ユーザーが管理するPostgreSQLサーバー（pgvector拡張使用）上に保存されます。プロジェクトが管理する中央サーバーやクラウドストレージへのデータ転送は行われません。

#### 5.2 保存期間

データの保存期間はユーザーが決定します。本ソフトウェアは、自動的なデータ削除・有効期限機能を内蔵していません。ユーザーは、自身のデータ管理ポリシーに従い、適切な保存期間を設定してください。

#### 5.3 削除方法

データの削除は、PostgreSQLデータベースに対する直接的な操作により実行できます。以下のデータカテゴリごとに削除が可能です。

- 特定URLに関連する全データの削除
- 特定ドメインに関連する全データの削除
- 特定期間に取得されたデータの一括削除
- Embeddingベクトルデータのみの削除

---

### 第6条: セキュリティ対策

本ソフトウェアは、取り扱うデータの安全性を確保するために、以下のセキュリティ対策を実装しています。

| 対策 | 内容 | 実装技術 |
|------|------|---------|
| HTMLサニタイゼーション | 取得したHTMLからXSS攻撃ベクトルを除去 | DOMPurify 3.3.x |
| SSRF対策 | プライベートIP・メタデータサービスへのアクセスをブロック | URLバリデーション + IPアドレスフィルタリング |
| 入力バリデーション | すべてのMCPツール入力をスキーマで検証 | Zod |
| SQLインジェクション対策 | パラメータ化クエリによるデータベースアクセス | Prisma ORM |
| データベースアクセス制御 | Row Level Security（RLS）によるデータ分離をサポート（主要テーブルに対しマイグレーションで段階的に有効化。全テーブルへの適用状況は運用者が確認してください） | PostgreSQL 18.x |

運用者は、RLSポリシーの有効化状況を自身の環境で確認するとともに、追加的なセキュリティ対策（ファイアウォール設定、TLS/SSL暗号化、データベースアクセス認証の強化等）を自身の責任で実施することを推奨します。

---

### 第7条: Cookie・トラッキング

#### 7.1 Reftrix自体のトラッキング技術

本ソフトウェア（セルフホスト版）は、MCPプロトコルによるAPI通信のみを使用しており、Reftrix自身がトラッキング目的で以下の技術を組み込むことはありません。

- トラッキング目的のCookie（ファーストパーティ・サードパーティを問わず）
- Webビーコン・トラッキングピクセル
- ブラウザフィンガープリンティング
- アクセス解析ツール（Google Analytics等）
- 広告トラッキング技術

#### 7.2 クローリングに伴うCookie・第三者通信（重要）

ただし、本ソフトウェアのWebクローリング機能（Playwright経由）は、ヘッドレスブラウザによりクロール対象ページを実際にレンダリングするため、以下の処理がクローリングセッション中に発生し得ます。

- **Cookieの受領**: クロール対象サイトが設定するCookie（セッションCookie、トラッキングCookie等）がブラウザコンテキスト内で受領・保持されます。これらのCookieはクローリングセッション終了時にブラウザコンテキストの破棄とともに消去されますが、セッション中は対象サイトからの読み取りが可能です
- **JavaScript実行**: クロール対象ページのJavaScriptが実行されるため、ページ内に埋め込まれたサードパーティスクリプト（アクセス解析、広告タグ、CDN等）による外部ドメインへの通信が発生する可能性があります
- **サブリソース取得**: CSS、JavaScript、画像、フォント等のサブリソースが、クロール対象ドメイン以外の第三者ドメイン（CDN、外部サービス等）から取得される場合があります

これらの処理はクロール対象ページの取得・レンダリングに付随して発生するものであり、Reftrixプロジェクトのサーバーへデータが送信されることはありません。また、クローリングはサーバーサイドで実行されるため、エンドユーザーの端末から外部への情報送信を発生させるものではありません。

#### 7.3 電気通信事業法との関係

改正電気通信事業法（2023年6月16日施行）における外部送信規律（電気通信事業法第27条の12）は、「利用者の電気通信設備」から外部に情報を送信させる行為を対象としています。本ソフトウェアのクローリングはサーバーサイドで実行されるため、利用者の端末に対するCookieの設定や外部送信を行うものではなく、同条の直接の規律対象にはあたらないと考えられます（総務省外部送信規律FAQ Q2-9参照）。

ただし、運用者が本ソフトウェアを他のシステム（WebUI等）と統合して利用する場合は、ユーザー自身の責任において、適用される法令に基づくCookie・外部送信に関する通知・同意取得を行う必要があります。

---

### 第7条の2: AI規制への対応

#### 7-2.1 EU AI Act（EU人工知能規則）

本ソフトウェアは、ONNX Runtime（multilingual-e5-baseモデル）によるEmbedding生成およびOllama（llama3.2-vision）によるVision AI分析機能を含んでいます。EU AI Act（Regulation (EU) 2024/1689）の観点から、本ソフトウェアのAI機能は以下のように分類されると考えられます。

- **Embeddingベクトル生成**: Webデザインの類似性検索のためのベクトル生成であり、自然人の権利に直接影響を与える意思決定に使用されるものではないため、「最小リスク」（minimal risk）に分類されると考えられます
- **Vision AI分析**: スクリーンショットのデザイン品質評価に使用され、人物の識別やプロファイリングを目的としないため、「限定リスク」（limited risk）に分類されると考えられます

ただし、AI規制の解釈は急速に発展しており、最終的な分類は各国の監督当局の判断に依存します。EU AI Actの段階的施行スケジュールは以下のとおりです。

| 施行日 | 内容 |
|--------|------|
| 2025年2月2日 | 禁止されるAI行為、AI リテラシー義務 |
| 2025年8月2日 | 汎用AIモデル（GPAI）の義務、国家監督機関の指定 |
| 2026年8月2日 | 高リスクAIシステム（Annex III）の義務、透明性義務（第50条） |
| 2027年8月2日 | 規制製品に組み込まれた高リスクAIシステムの義務 |

運用者は、自身のAI利用形態が各法域のAI規制に該当するかどうかを確認し、必要な対応を行ってください。

#### 7-2.2 児童の個人情報保護

**[US] COPPA（児童オンラインプライバシー保護法）**

本ソフトウェアがクロールするWebページには、13歳未満の児童に関する個人情報が含まれる可能性があります。2025年4月22日に公布されたCOPPA規則の改正（2025年6月23日施行、遵守期限2026年4月22日）により、「個人情報」の定義拡大、保護者への通知・同意要件の強化、データ保持・セキュリティ義務の厳格化が行われています。

本ソフトウェアは、児童のWebサイトを意図的にクロール対象とするものではありませんが、運用者は以下の点に留意してください。

- 児童向けWebサイト（.kids.usドメイン等）のクロールを避けること
- クロール対象ページに児童の個人情報が含まれている可能性がある場合は、当該データの速やかな削除を検討すること
- 自身の法域において児童のデータ保護に関する追加的な義務がないか確認すること

**[JP] こどもの個人情報保護**

個人情報保護法の「3年ごと見直し」（2024年-2026年検討中）において、こどもの個人情報保護の強化が主要論点の一つとなっています。2026年1月9日に公表された「制度改正方針」では、こどもの保有個人データについて、違法行為の有無を問わず利用停止請求を可能とする方針が示されています。改正法案は2026年の通常国会への提出が予定されていますが、施行時期は未定です。

---

### 第8条: 国際データ移転

#### 8.1 セルフホスト環境

本ソフトウェアはセルフホスト型であるため、データの保存場所はユーザーが選択するサーバーの所在地に依存します。国際データ移転の適法性は、ユーザーが自身の運用環境に基づいて判断する必要があります。

#### 8.2 各法域における考慮事項

**[JP] 日本 -- 個人情報保護法**

個人情報保護法第28条に基づき、個人データを外国にある第三者に提供する場合は、原則として本人の同意が必要です。ただし、個人情報保護委員会が定める「個人の権利利益を保護する上で我が国と同等の水準にあると認められる個人情報の保護に関する制度を有している外国」（EU/EEA、英国等）への移転は例外が認められます。また、「個人情報取扱事業者が講ずべきこととされている措置に相当する措置を継続的に講ずるために必要な体制」を整備している場合も、同意なしの移転が可能です。

**[EU] EU/EEA -- GDPR**

GDPR第44条から第49条に基づき、EU/EEA域内の個人データを域外に移転する場合は、以下のいずれかの根拠が必要です。

- 十分性認定（日本はEUから十分性認定を受けています）
- 標準契約条項（Standard Contractual Clauses: SCC）
- 拘束的企業準則（Binding Corporate Rules: BCR）
- データ主体の明示的同意
- その他GDPR第49条に定める例外事由

**[US] 米国 -- CCPA/CPRA**

CCPA/CPRA（カリフォルニア州消費者プライバシー法/カリフォルニア州プライバシー権利法）は、データの国際移転について直接的な制限を設けていませんが、カリフォルニア州の消費者の個人情報を取り扱う事業者は、消費者の権利行使を保障する義務を負います。2025年9月22日にOAL（Office of Administrative Law）により承認された改正規則は2026年1月1日に発効しており、以下の義務が段階的に適用されます。

**リスクアセスメント義務**（2026年1月1日より適用開始）: 個人情報の販売・共有、機微個人情報の処理、ADMTの訓練用データ処理等、「消費者のプライバシーに重大なリスクを及ぼす処理活動」に対してリスクアセスメントの実施が求められます。2026年1月1日以前から継続する処理活動については、2027年12月31日までに完了する経過措置があります。2026年-2027年に実施したリスクアセスメントの証明書および概要は、2028年4月1日までにCPPAへ提出する必要があり、それ以降は毎年4月1日が提出期限です。

**自動意思決定技術（ADMT）義務**（2027年1月1日より遵守開始）: ADMTを用いた「重要な意思決定」（金融・住宅・教育・雇用・医療に影響を与える決定）を行う事業者には、消費者への事前通知義務、オプトアウト権の付与、およびADMTの論理・結果に関するアクセス権の保障が求められます。2027年4月1日以降、ADMT使用に関するリスクアセスメントの実施義務も適用されます。

**サイバーセキュリティ監査義務**（売上規模により段階適用）: 個人情報の販売・共有から収益の50%以上を得る事業者、または年間売上2,500万ドル以上かつ25万人以上の消費者データ等を処理する事業者は、年次のサイバーセキュリティ監査を実施し、CPPAに証明書を提出する義務があります。提出期限は売上規模により異なります。
- 2026年売上1億ドル超の事業者: 2028年4月1日
- 2027年売上5,000万ドル-1億ドルの事業者: 2029年4月1日
- 2028年売上5,000万ドル未満の事業者: 2030年4月1日

**注意**: 上記の適用対象・遵守期限は事業者の売上規模・処理活動の内容により異なります。詳細はCPPA公式サイトおよび改正規則の条文を確認してください。

---

### 第9条: 権利行使

#### 9.1 [JP] 個人情報保護法に基づく権利

個人情報保護法第33条から第39条に基づき、保有個人データの本人は以下の権利を有します。

| 権利 | 条文 | 内容 |
|------|------|------|
| 開示請求権 | 第33条 | 保有個人データの開示を請求する権利 |
| 訂正等請求権 | 第34条 | 内容が事実でない場合に訂正・追加・削除を請求する権利 |
| 利用停止等請求権 | 第35条 | 利用目的外利用・不正取得の場合に利用停止・消去を請求する権利 |
| 第三者提供停止請求権 | 第35条第5項 | 第三者提供の停止を請求する権利 |

本ソフトウェアはセルフホスト型であるため、これらの権利行使への対応は運用者の責任です。運用者は、本人からの請求に対して適切に対応できる体制を整備してください。

#### 9.2 [EU] GDPRに基づくデータ主体の権利

GDPR第15条から第22条に基づき、データ主体は以下の権利を有します。

| 権利 | 条文 | 内容 |
|------|------|------|
| アクセス権 | 第15条 | 自己の個人データへのアクセスおよびコピーを取得する権利 |
| 訂正権 | 第16条 | 不正確な個人データの訂正を求める権利 |
| 消去権（忘れられる権利） | 第17条 | 個人データの消去を求める権利 |
| 処理制限権 | 第18条 | 個人データの処理の制限を求める権利 |
| データポータビリティ権 | 第20条 | 構造化された一般的に使用される機械可読形式でデータを受け取る権利 |
| 異議申立権 | 第21条 | 個人データの処理に対して異議を申し立てる権利 |
| 自動意思決定に関する権利 | 第22条 | プロファイリングを含む自動処理のみに基づく意思決定の対象とならない権利 |

運用者がEU/EEA域内の個人のデータを処理する場合は、これらの権利行使に対応できる技術的・組織的措置を講じる必要があります。

#### 9.3 [US] CCPA/CPRAに基づく消費者の権利

CCPA/CPRA（カリフォルニア州民法典第1798.100条以下）に基づき、カリフォルニア州の消費者は以下の権利を有します。

| 権利 | 内容 |
|------|------|
| 知る権利 | 収集された個人情報のカテゴリ、目的、第三者への開示等を知る権利 |
| 削除権 | 収集された個人情報の削除を要求する権利 |
| 訂正権 | 不正確な個人情報の訂正を要求する権利 |
| オプトアウト権 | 個人情報の販売・共有のオプトアウトを要求する権利 |
| 非差別権 | プライバシー権の行使を理由とする差別を受けない権利 |
| 個人情報の利用・開示の制限権 | 機微個人情報の利用・開示を制限する権利 |

2026年1月1日発効の改正CCPA規則により、リスクアセスメント義務（2026年1月1日開始）およびADMT関連義務（2027年1月1日から遵守開始）が新たに導入されています。

**リスクアセスメント義務**: 個人情報の販売・共有、機微個人情報の処理等の「重大なリスクを及ぼす処理活動」について、2026年1月1日からリスクアセスメントの実施が求められます。2026年以前から継続する処理活動には経過措置があり、2027年12月31日までの完了が認められます。証明書・概要の初回提出期限は2028年4月1日です。

**ADMT義務**: ADMTを用いた「重要な意思決定」（significant decisions: 金融・住宅・教育・雇用・医療に影響を与える決定）を行う事業者には、事前通知義務、オプトアウト権の付与、ADMTの論理・結果に関するアクセス権の保障が求められます（遵守開始: 2027年1月1日）。

**注意**: 適用対象・遵守期限は事業者の状況（売上規模・処理活動の内容等）により異なります。

---

### 第10条: 改定と通知

#### 10.1 改定手続き

本プライバシーポリシーは、以下の場合に改定されることがあります。

- 適用法令（個人情報保護法、GDPR、CCPA/CPRA等）の改正
- 本ソフトウェアの機能追加・変更に伴うデータ処理内容の変更
- セキュリティ上の理由による改定

#### 10.2 通知方法

改定時は、以下の方法で通知します。

- GitHubリポジトリにおける本ドキュメントの更新（コミット履歴により変更内容を確認可能）
- CHANGELOG.mdへの記載
- メジャーバージョンアップ時のリリースノートへの記載

#### 10.3 バージョン管理

本プライバシーポリシーのすべての変更は、Gitバージョン管理により追跡可能です。過去のバージョンはリポジトリの履歴から参照できます。

---

### 第11条: 運用者の責任

本ソフトウェアはセルフホスト型であるため、運用者は自身の法域において適用されるデータ保護法令を遵守する責任を負います。運用者は、特に以下の事項について自身で判断・対応する必要があります。

1. **利用目的の特定と公表**: クロールしたデータの利用目的を明確にし、必要に応じて公表すること
2. **個人情報の取扱い**: クロール対象ページに含まれる個人情報の適切な取扱い
3. **削除リクエストへの対応**: データ主体からの削除リクエストに対する適時の対応
4. **セキュリティ対策**: データベースの暗号化、アクセス制御、バックアップ等の追加的セキュリティ措置
5. **国際データ移転**: 越境データ移転に関する法令遵守
6. **データ処理契約**: 第三者にデータ処理を委託する場合のデータ処理契約（DPA）の締結
7. **robots.txtの尊重**: クロール対象サイトのrobots.txtおよび利用規約の遵守
8. **アクセスログの管理**: 運用環境のアクセスログ（IPアドレスを含み得る）の適切な管理・保存期間の設定

---

### 第12条: お問い合わせ

本プライバシーポリシーに関するお問い合わせは、GitHubリポジトリのIssueまたはプロジェクトが指定する連絡手段を通じてお寄せください。

- **メール**: info@reftrix.io
- **リポジトリ**: https://github.com/TKMD/ReftrixMCP
- **Issue**: https://github.com/TKMD/ReftrixMCP/issues

---
---

## English Version

### Reftrix Privacy Policy

**Version**: 0.1.0
**Effective Date**: March 1, 2026
**Last Updated**: February 23, 2026

---

### Introduction

This Privacy Policy describes how data is handled in Reftrix (hereinafter "the Software").

Reftrix is open-source software provided under the AGPL-3.0-only license. It is a self-hosted platform designed for analyzing web design patterns and extracting design knowledge. The Software accepts operations from AI agents via the MCP protocol (Model Context Protocol), retrieves and analyzes web pages at user-specified URLs, and stores the results in a database managed by the user.

The Software is self-hosted and is not provided as a SaaS (Software as a Service). Accordingly, the Reftrix project developers (hereinafter "the Project") do not collect, store, or manage user data. Responsibility for data management lies solely with the user operating the Software.

---

### Section 1: Information Collected

The Software processes the following information as part of its functionality. This information is retrieved only from URLs explicitly specified by the user.

#### 1.1 Crawled Page Content Data

| Data Type | Description | Storage Format |
|-----------|-------------|----------------|
| HTML | HTML source code of the target page (sanitized with DOMPurify) | Text |
| CSS | Stylesheet information from the target page | Text |
| JavaScript | Animation and interaction-related code from the target page | Text |
| Screenshots | Screen captures of the target page obtained via Playwright | PNG images |

#### 1.2 Metadata

| Data Type | Description |
|-----------|-------------|
| URL | URL of the crawled page |
| Page Title | Extracted from the HTML `<title>` tag |
| Domain Name | Domain information extracted from the URL |
| OGP Information | Open Graph Protocol meta tags (og:title, og:description, og:image, etc.) |
| Crawl Timestamp | Timestamp of when the data was retrieved |

#### 1.3 Analysis Result Data

| Data Type | Description |
|-----------|-------------|
| Layout Patterns | Analysis results of the page's layout structure (section composition, grid, color scheme, etc.) |
| Motion Patterns | Detection results of CSS animations, transitions, and scroll-linked elements |
| Quality Scores | Design quality evaluation scores (originality, craftsmanship, contextuality, etc.) |
| Narrative Analysis | Analysis results of the page's visual storytelling elements |
| Background Design | Detection results of background images, patterns, gradients, etc. |

#### 1.4 Embedding Vector Data

The Software uses the multilingual-e5-base model (ONNX Runtime) to generate 768-dimensional embedding vectors from analysis results. These vector data are used for similar design search (vector search).

#### 1.5 Vision AI Analysis Results

Visual analysis results from screenshots using Ollama (llama3.2-vision) are stored as text data. Under the default configuration, this processing is performed entirely in the local environment (localhost). However, if the operator configures the Ollama server URL to point to a remote host, screenshot images will be transmitted to that remote server (see Section 3.2).

#### 1.6 Information Not Collected

The Reftrix project does not centrally collect the following information from the self-hosted version:

- User account information (login IDs, passwords, etc.)
- Users' personal information (names, addresses, phone numbers, etc.)
- Usage telemetry or usage statistics
- Browser fingerprints

**Regarding IP addresses**: The Reftrix project does not centrally collect users' source IP addresses. However, IP addresses may be recorded in the operator's environment (web server, reverse proxy, OS, etc.) access logs. This depends on the operator's infrastructure configuration and is the operator's responsibility to manage. Additionally, during crawling, the operator server's source IP address is observable by crawled target sites (see Section 3.2). Note that under the GDPR, IP addresses may constitute personal data (Recital 30), so appropriate handling is required when operating within the EU/EEA.

**Regarding cookies**: Reftrix itself does not use cookies for tracking purposes. However, during crawling, cookies may be received from crawled target sites (see Section 7.2).

---

### Section 2: Purpose of Use

Information processed by the Software is used solely for the following purposes:

1. **Web design pattern analysis and classification**: Extracting and classifying layout, motion, and quality of crawled pages as structured data
2. **Similar design search**: Discovering similar design patterns through semantic search using embedding vectors (hybrid search: 60% vector search + 40% full-text search)
3. **Design quality evaluation**: Performing quantitative evaluation of design quality based on proprietary evaluation criteria
4. **Design knowledge accumulation**: Accumulating web design trends and patterns in a knowledge base in a RAG (Retrieval-Augmented Generation)-capable format

The Software does not use data for any other purposes (including advertising, marketing, profiling, or user tracking).

---

### Section 3: Disclosure to Third Parties

#### 3.1 Self-Hosted Version

The Software is self-hosted, and all collected and analyzed data is stored exclusively on the PostgreSQL server managed by the user. The Project does not access user data or provide it to third parties.

Whether the user provides their data to third parties is at the user's sole discretion and responsibility.

#### 3.2 External Communications

The Software makes the following external communications:

| Destination | Purpose | Data Content |
|-------------|---------|--------------|
| Crawled websites and third-party domains referenced by those pages (CDNs, external font services, image hosting, etc.) | Web page retrieval and rendering (via Playwright) | HTTP requests (including User-Agent header). Includes retrieval of sub-resources (CSS, JavaScript, images, fonts, etc.) necessary for page rendering, DNS name resolution, TLS connection establishment, and redirect following |
| Ollama Server | Vision AI analysis | Screenshot images |

**Information exposed to crawled sites**: During crawling, the operator server's source IP address and User-Agent string (default: an identifier including `Reftrix/0.1.0`) are observable by the crawled target sites and third-party resource providers.

**Regarding the Ollama server**: By default, the Software connects to a localhost Ollama server (`http://localhost:11434`). In this case, screenshot images are processed only within the local environment. However, if the operator changes the Ollama server URL to a remote host, screenshot images will be transmitted to that remote server. When using a remote Ollama server, the operator is responsible for ensuring encryption of the communication channel (TLS) and appropriate data handling.

**SSRF prevention**: Access to private IP addresses and metadata services is blocked.

---

### Section 4: Personal Information in Crawled Pages (Important)

#### 4.1 Risk of Personal Information Inclusion

Web pages crawled by the Software may contain personal information (as defined under applicable data protection laws), including:

- Names, email addresses, phone numbers
- Personal photographs and portrait images
- Addresses and location information
- Social media account information
- Other information that can identify a specific individual

#### 4.2 Data Minimization Principle

The Software is designed for web design pattern analysis and does not intend to collect personal information. The following data minimization measures are implemented:

- **HTML Sanitization**: DOMPurify 3.3.x is used to remove XSS attack vectors (`<script>` tags, `javascript:` URLs, event handler attributes, etc.) from retrieved HTML. Additionally, the project's sanitizer configuration (`FORBID_TAGS`) removes certain external resource reference tags such as `<link>`, `<base>`, and `<iframe>`. However, external URLs in content elements such as `<img>` and `<video>` are retained as they are necessary for design analysis
- **Limited Analysis Scope**: Only information necessary for design pattern analysis (layout structure, color schemes, animations, etc.) is targeted for extraction
- **SSRF Prevention**: Access to private IP addresses and cloud metadata services is blocked to prevent unintended acquisition of internal network information

#### 4.2.1 [EU] Latest Developments in GDPR on Web Scraping and AI

The European Data Protection Board (EDPB) published Opinion 28/2024 on December 17, 2024, providing guidance on data protection aspects of AI model development. The opinion clarifies that publicly available data remains subject to GDPR protection and that indiscriminate collection of personal data through web scraping may be assessed unfavorably in the legitimate interest balancing test.

Additionally, the following enforcement cases were reported in 2025:
- French CNIL: EUR 200,000 fine against KASPR (data scraping, breach of right of access)
- Dutch DPA: EUR 30.5 million fine against Clearview AI (web image scraping without consent)
- Polish DPA: EUR 220,000 fine against a data broker (scraping of public registries)

When operators crawl pages containing personal data of individuals within the EU/EEA, they must ensure a lawful basis for processing under Article 6 of the GDPR. The EDPB is in the process of developing dedicated guidelines on web scraping (2024-2025 work programme), and operators should monitor future developments.

#### 4.3 robots.txt Compliance Policy

The Software recommends that operators respect the robots.txt of crawled sites. Operators should:

- Comply with Disallow directives in robots.txt
- Follow Crawl-delay directives when present
- Set an appropriate User-Agent to clearly identify the bot
- Promptly respond to requests from site administrators to stop crawling

#### 4.4 Handling Deletion Requests

When a deletion request is received from the operator of a crawled page or the individual whose personal information is concerned, the operator should follow these steps:

1. **Receive the request**: Review the deletion request and identify the target data
2. **Identify target data**: Search the PostgreSQL database for all data associated with the relevant URL or domain
3. **Delete data**: Completely delete the following:
   - Crawled HTML/CSS/JS/screenshots
   - Analysis results (layout patterns, motion, quality scores, etc.)
   - Embedding vector data
   - Metadata (URL, title, OGP information, etc.)
4. **Confirm deletion**: Notify the requester that deletion has been completed

---

### Section 5: Data Storage and Deletion

#### 5.1 Storage Location

All data is stored on the PostgreSQL server (with pgvector extension) managed by the user. No data is transferred to central servers or cloud storage managed by the Project.

#### 5.2 Retention Period

Data retention periods are determined by the user. The Software does not include automatic data deletion or expiration features. Users should set appropriate retention periods in accordance with their own data management policies.

#### 5.3 Deletion Methods

Data can be deleted through direct operations on the PostgreSQL database. Deletion is available for the following data categories:

- All data related to a specific URL
- All data related to a specific domain
- Bulk deletion of data retrieved within a specific time period
- Deletion of embedding vector data only

---

### Section 6: Security Measures

The Software implements the following security measures to ensure the safety of processed data:

| Measure | Description | Implementation |
|---------|-------------|----------------|
| HTML Sanitization | Remove XSS attack vectors from retrieved HTML | DOMPurify 3.3.x |
| SSRF Prevention | Block access to private IPs and metadata services | URL validation + IP address filtering |
| Input Validation | Validate all MCP tool inputs against schemas | Zod |
| SQL Injection Prevention | Database access via parameterized queries | Prisma ORM |
| Database Access Control | Support data isolation through Row Level Security (RLS), progressively enabled via migrations on key tables. Operators should verify the RLS enablement status for all tables in their environment | PostgreSQL 18.x |

Operators are recommended to verify the RLS policy enablement status in their own environment and to implement additional security measures (firewall configuration, TLS/SSL encryption, database access authentication hardening, etc.) at their own responsibility.

---

### Section 7: Cookies and Tracking

#### 7.1 Reftrix's Own Tracking Technologies

The Software (self-hosted version) uses only MCP protocol API communication. Reftrix itself does not incorporate the following technologies for tracking purposes:

- Cookies for tracking purposes (whether first-party or third-party)
- Web beacons or tracking pixels
- Browser fingerprinting
- Analytics tools (such as Google Analytics)
- Advertising tracking technologies

#### 7.2 Cookies and Third-Party Communications During Crawling (Important)

However, the Software's web crawling functionality (via Playwright) renders target pages using a headless browser, which means the following processing may occur during crawling sessions:

- **Cookie reception**: Cookies set by the crawled target site (session cookies, tracking cookies, etc.) are received and held within the browser context. These cookies are deleted when the browser context is destroyed at the end of the crawling session, but during the session they may be read by the target site
- **JavaScript execution**: As JavaScript on the crawled target page is executed, third-party scripts embedded in the page (analytics, advertising tags, CDNs, etc.) may initiate communications to external domains
- **Sub-resource retrieval**: Sub-resources such as CSS, JavaScript, images, and fonts may be retrieved from third-party domains (CDNs, external services, etc.) other than the crawled target domain

These processes occur incidentally as part of retrieving and rendering the target page and do not result in data being transmitted to the Reftrix project's servers. Additionally, crawling is executed on the server side and does not cause information transmission from end-user terminals to external parties.

#### 7.3 Relationship with the Telecommunications Business Act

The external data transmission regulations under the amended Telecommunications Business Act (enforced June 16, 2023) (Article 27-12 of the Telecommunications Business Act) target actions that cause "the user's telecommunications equipment" to transmit information externally. Since the Software's crawling is executed on the server side and does not set cookies on or cause external transmissions from users' terminals, it is not considered to fall directly under the scope of this article (see MIC External Transmission Regulations FAQ Q2-9).

However, if the operator integrates the Software with other systems (such as a WebUI), the operator is responsible for ensuring compliance with applicable laws regarding cookies and external data transmission, including obtaining necessary consent.

---

### Section 7-2: AI Regulation Compliance

#### 7-2.1 EU AI Act

The Software includes AI functionalities such as embedding generation using ONNX Runtime (multilingual-e5-base model) and Vision AI analysis using Ollama (llama3.2-vision). From the perspective of the EU AI Act (Regulation (EU) 2024/1689), the Software's AI features are considered to be classified as follows:

- **Embedding vector generation**: Used for vector generation for web design similarity search and not used for decision-making that directly affects the rights of natural persons; therefore, it is considered to be classified as "minimal risk"
- **Vision AI analysis**: Used for design quality evaluation of screenshots and not intended for identification or profiling of individuals; therefore, it is considered to be classified as "limited risk"

However, the interpretation of AI regulations is rapidly evolving, and the final classification depends on the judgment of supervisory authorities in each country. The phased enforcement schedule of the EU AI Act is as follows:

| Effective Date | Content |
|----------------|---------|
| February 2, 2025 | Prohibited AI practices, AI literacy obligations |
| August 2, 2025 | General-purpose AI model (GPAI) obligations, designation of national supervisory authorities |
| August 2, 2026 | High-risk AI system (Annex III) obligations, transparency obligations (Article 50) |
| August 2, 2027 | Obligations for high-risk AI systems embedded in regulated products |

Operators should verify whether their use of AI falls under AI regulations in their respective jurisdictions and take necessary measures.

#### 7-2.2 Protection of Children's Personal Information

**[US] COPPA (Children's Online Privacy Protection Act)**

Web pages crawled by the Software may contain personal information of children under the age of 13. The amended COPPA Rule published on April 22, 2025 (effective June 23, 2025, compliance deadline April 22, 2026) includes expanded definitions of "personal information," enhanced parental notice and consent requirements, and stricter data retention and security obligations.

The Software does not intentionally target children's websites for crawling, but operators should note the following:

- Avoid crawling websites directed at children (e.g., .kids.us domains)
- Consider promptly deleting data if crawled pages may contain children's personal information
- Verify whether additional obligations regarding children's data protection exist in their jurisdiction

**[JP] Protection of Children's Personal Information**

In the triennial review of the APPI (under consideration 2024-2026), strengthening protection of children's personal information is one of the major discussion points. The "institutional reform policy" published on January 9, 2026, indicates a policy to enable requests for cessation of use of children's retained personal data regardless of the presence or absence of unlawful acts. The amendment bill is expected to be submitted to the ordinary Diet session in 2026, but the enforcement date has not been determined.

---

### Section 8: International Data Transfers

#### 8.1 Self-Hosted Environment

As the Software is self-hosted, the location of data storage depends on the server location chosen by the user. The legality of international data transfers must be determined by the user based on their own operating environment.

#### 8.2 Considerations by Jurisdiction

**[JP] Japan -- Act on the Protection of Personal Information (APPI)**

Under Article 28 of the APPI, the consent of the data subject is generally required when providing personal data to a third party in a foreign country. However, exceptions are recognized for transfers to countries that have been recognized by the Personal Information Protection Commission as having "a system for the protection of personal information that is recognized as equivalent to that of Japan" (EU/EEA, United Kingdom, etc.). Transfers without consent are also permitted when "the systems necessary for continuously taking measures equivalent to those that a business operator handling personal information is required to take" have been established.

**[EU] EU/EEA -- GDPR**

Under Articles 44 through 49 of the GDPR, any transfer of personal data from within the EU/EEA to outside the region requires one of the following bases:

- Adequacy decision (Japan has received an adequacy decision from the EU)
- Standard Contractual Clauses (SCC)
- Binding Corporate Rules (BCR)
- Explicit consent of the data subject
- Other derogations under Article 49 of the GDPR

**[US] United States -- CCPA/CPRA**

The CCPA/CPRA (California Consumer Privacy Act/California Privacy Rights Act) does not impose direct restrictions on international data transfers. However, businesses handling the personal information of California consumers are obligated to ensure that consumer rights can be exercised. The amended regulations approved by OAL (Office of Administrative Law) on September 22, 2025, became effective on January 1, 2026, with obligations phased in as follows:

**Risk Assessment Obligations** (effective January 1, 2026): Risk assessments are required for processing activities that present "significant risk to consumers' privacy," including selling/sharing personal information, processing sensitive personal information, and processing personal information to train ADMT. For processing activities that began before January 1, 2026, and continue thereafter, a transitional provision allows completion by December 31, 2027. Attestations and summaries for assessments conducted in 2026-2027 must be submitted to the CPPA by April 1, 2028, with annual submissions on April 1 thereafter.

**Automated Decision-Making Technology (ADMT) Obligations** (compliance begins January 1, 2027): Businesses using ADMT for "significant decisions" (decisions affecting finances, housing, education, employment, or healthcare) are required to provide pre-use notices to consumers, offer opt-out rights, and ensure consumer access to explanations of ADMT logic and outcomes. ADMT-specific risk assessments must also be conducted beginning April 1, 2027.

**Cybersecurity Audit Obligations** (phased by revenue): Businesses meeting the applicable thresholds (deriving 50%+ revenue from selling/sharing personal information, or having $25M+ revenue and processing data of 250,000+ consumers or sensitive data of 50,000+ consumers) must conduct annual independent cybersecurity audits. The first certification submission deadlines are tiered by revenue:
- Businesses with over $100 million in 2026 revenue: April 1, 2028
- Businesses with $50 million to $100 million in 2027 revenue: April 1, 2029
- Businesses with less than $50 million in 2028 revenue: April 1, 2030

**Note**: Applicability thresholds, compliance deadlines, and specific obligations vary depending on the business's revenue, processing activities, and other factors. Please refer to the CPPA website and the text of the amended regulations for details.

---

### Section 9: Exercise of Rights

#### 9.1 [JP] Rights Under the APPI

Under Articles 33 through 39 of the APPI, data subjects have the following rights regarding retained personal data:

| Right | Article | Description |
|-------|---------|-------------|
| Right to Disclosure | Art. 33 | Right to request disclosure of retained personal data |
| Right to Correction | Art. 34 | Right to request correction, addition, or deletion when content is inaccurate |
| Right to Cease Use | Art. 35 | Right to request cessation of use or deletion in cases of unauthorized use or acquisition |
| Right to Stop Third-Party Provision | Art. 35(5) | Right to request cessation of third-party provision |

As the Software is self-hosted, responding to these rights is the responsibility of the operator. Operators should establish systems to appropriately respond to requests from data subjects.

#### 9.2 [EU] Data Subject Rights Under the GDPR

Under Articles 15 through 22 of the GDPR, data subjects have the following rights:

| Right | Article | Description |
|-------|---------|-------------|
| Right of Access | Art. 15 | Right to access and obtain a copy of personal data |
| Right to Rectification | Art. 16 | Right to request rectification of inaccurate personal data |
| Right to Erasure (Right to be Forgotten) | Art. 17 | Right to request erasure of personal data |
| Right to Restriction of Processing | Art. 18 | Right to request restriction of processing of personal data |
| Right to Data Portability | Art. 20 | Right to receive data in a structured, commonly used, machine-readable format |
| Right to Object | Art. 21 | Right to object to the processing of personal data |
| Right Related to Automated Decision-Making | Art. 22 | Right not to be subject to decisions based solely on automated processing, including profiling |

When the operator processes data of individuals within the EU/EEA, technical and organizational measures must be implemented to respond to the exercise of these rights.

#### 9.3 [US] Consumer Rights Under the CCPA/CPRA

Under the CCPA/CPRA (California Civil Code Section 1798.100 et seq.), California consumers have the following rights:

| Right | Description |
|-------|-------------|
| Right to Know | Right to know the categories of personal information collected, purposes, and disclosures to third parties |
| Right to Delete | Right to request deletion of collected personal information |
| Right to Correct | Right to request correction of inaccurate personal information |
| Right to Opt-Out | Right to opt out of the sale or sharing of personal information |
| Right to Non-Discrimination | Right not to be discriminated against for exercising privacy rights |
| Right to Limit Use and Disclosure | Right to limit the use and disclosure of sensitive personal information |

The amended CCPA regulations, effective January 1, 2026, introduce risk assessment obligations and ADMT-related obligations on a phased timeline.

**Risk Assessment Obligations**: Processing activities that present "significant risk to consumers' privacy" (including selling/sharing personal information, processing sensitive personal information, etc.) require risk assessments beginning January 1, 2026. For processing activities that existed before January 1, 2026, transitional provisions allow completion by December 31, 2027. The first attestation and summary submission to the CPPA is due by April 1, 2028.

**ADMT Obligations**: Businesses using ADMT for "significant decisions" (defined as decisions affecting finances, housing, education, employment, or healthcare) must comply with pre-use notification obligations, opt-out rights, and consumer access to ADMT logic and outcomes beginning January 1, 2027.

**Note**: Applicability thresholds, compliance deadlines, and specific obligations vary depending on the business's circumstances (revenue, processing activities, etc.).

---

### Section 10: Amendments and Notices

#### 10.1 Amendment Procedures

This Privacy Policy may be amended in the following cases:

- Amendments to applicable laws (APPI, GDPR, CCPA/CPRA, etc.)
- Changes in data processing resulting from additions or modifications to the Software's functionality
- Amendments for security reasons

#### 10.2 Notification Methods

Amendments will be communicated through:

- Updates to this document in the GitHub repository (changes can be verified through commit history)
- Entry in CHANGELOG.md
- Inclusion in release notes for major version upgrades

#### 10.3 Version Control

All changes to this Privacy Policy are traceable through Git version control. Previous versions can be referenced from the repository history.

---

### Section 11: Operator Responsibilities

As the Software is self-hosted, operators are responsible for complying with data protection laws applicable in their jurisdiction. Operators must independently determine and address the following matters:

1. **Specification and publication of purposes of use**: Clearly define and, as necessary, publish the purposes for which crawled data is used
2. **Handling of personal information**: Appropriately handle personal information contained in crawled pages
3. **Responding to deletion requests**: Timely response to deletion requests from data subjects
4. **Security measures**: Additional security measures such as database encryption, access control, and backups
5. **International data transfers**: Compliance with laws regarding cross-border data transfers
6. **Data processing agreements**: Entering into Data Processing Agreements (DPA) when entrusting data processing to third parties
7. **Respecting robots.txt**: Compliance with robots.txt and terms of service of crawled sites
8. **Access log management**: Appropriate management and retention period configuration for access logs in the operating environment (which may include IP addresses)

---

### Section 12: Contact

For inquiries regarding this Privacy Policy, please contact us through the GitHub repository Issues or other contact methods designated by the Project.

- **Email**: info@reftrix.io
- **Repository**: https://github.com/TKMD/ReftrixMCP
- **Issues**: https://github.com/TKMD/ReftrixMCP/issues

---
---

## 法的調査の参考資料 / Legal Research References

### 調査日 / Research Date: 2026-02-18（初回作成）、2026-02-18（クロスレビュー・最新法令検証）、2026-02-18（CCPA/CPRA期限記述修正）、2026-02-18（クロール関連指摘修正: Cookie・外部通信・IP・Ollama）

### 参照した法令・ガイドライン / Statutes and Guidelines Referenced

**[JP] 日本法**
- 個人情報の保護に関する法律（個人情報保護法 / APPI）-- 令和5年改正を含む最新版
  - 第2条（定義）、第17条（利用目的の特定）、第21条（取得に際しての利用目的の通知等）
  - 第28条（外国にある第三者への提供の制限）
  - 第33条-第39条（保有個人データに関する事項の公表等、開示、訂正等、利用停止等）
  - 2024年「いわゆる3年ごと見直し」中間整理（個人情報保護委員会、2024年6月公表）
  - 2025年1月22日「追加検討事項」公表（牛島総合法律事務所記事参照）
  - 2026年1月9日「3年ごと見直しに係る制度改正方針」公表（課徴金制度導入、こどもの個人情報保護強化等）
  - 改正法案は2025年通常国会提出見送り → 2026年通常国会提出予定（施行時期未定）
- 電気通信事業法 -- 2023年6月16日施行改正（外部送信規律）
  - 第27条の12（外部送信規律 / いわゆるCookie規制）
  - 総務省外部送信規律FAQ（Q2-9: サーバー間連携・RPAは「利用者の利用に伴い受信される情報」に非該当）
- 不正競争防止法 -- 令和5年改正を含む最新版
- 著作権法 -- 第30条の4（著作物に表現された思想又は感情の享受を目的としない利用）

**[EU] EU法**
- General Data Protection Regulation (GDPR) -- Regulation (EU) 2016/679
  - Articles 5-6 (Principles, Lawful Basis)
  - Articles 12-14 (Transparency, Information)
  - Articles 15-22 (Data Subject Rights)
  - Articles 44-49 (International Data Transfers)
  - Recital 30 (Online identifiers, including IP addresses, as personal data)
  - EDPB Opinion 28/2024 on AI models and data protection (2024年12月17日公表)
  - EDPB 2024-2025 Work Programme: Web scraping guidelines（策定中）
  - 日EU間十分性認定: 2019年採択、2023年4月第1回レビュー完了、次回レビュー2027年頃予定
- EU AI Act -- Regulation (EU) 2024/1689 (enacted 2024)
  - Phase 1: 2025年2月2日（禁止AI行為、AIリテラシー義務）
  - Phase 2: 2025年8月2日（GPAIモデル義務、国家監督機関指定）
  - Phase 3: 2026年8月2日（高リスクAIシステム義務、透明性義務）
  - Phase 4: 2027年8月2日（規制製品組み込みAI義務）

**[US] 米国法**
- California Consumer Privacy Act (CCPA) -- Cal. Civ. Code Sec. 1798.100 et seq.
- California Privacy Rights Act (CPRA) -- 2020年11月投票承認
- CCPA/CPRA改正規則 -- 2025年9月22日OAL承認、2026年1月1日発効
  - リスクアセスメント: 2026年1月1日から適用開始（非ADMT処理活動を含む独立した義務）
    - 2026年以前から継続する処理活動: 2027年12月31日までの経過措置
    - 証明書・概要の初回提出期限: 2028年4月1日（2026-2027年分）、以後毎年4月1日
    - トリガー活動: 個人情報の販売・共有、機微個人情報の処理、ADMT訓練用データ処理等
  - 自動意思決定技術（ADMT）: 遵守開始2027年1月1日（事前通知・オプトアウト権・アクセス権）
    - ADMT固有のリスクアセスメント: 2027年4月1日から
  - サイバーセキュリティ監査: 売上規模により段階適用
    - 2026年売上1億ドル超: 2028年4月1日（初回提出期限）
    - 2027年売上5,000万-1億ドル: 2029年4月1日
    - 2028年売上5,000万ドル未満: 2030年4月1日
    - 適用閾値: 売上の50%以上が個人情報の販売・共有に由来、または年間売上2,500万ドル以上かつ25万人以上の消費者データ処理等
- Children's Online Privacy Protection Act (COPPA) -- 16 CFR Part 312
  - FTC COPPA規則改正: 2025年4月22日公布、2025年6月23日施行、遵守期限2026年4月22日
  - 「個人情報」定義の拡大、保護者通知・同意要件の強化、データ保持・セキュリティ義務の厳格化

### 参照したWebリソース / Web Resources Referenced

**APPI / 個人情報保護法**
- [Data Protection Laws and Regulations 2025-2026 Japan (ICLG)](https://iclg.com/practice-areas/data-protection-laws-and-regulations/japan)
- [Japan's DPA publishes interim summary of amendments (IAPP)](https://iapp.org/news/a/japan-s-dpa-publishes-interim-summary-of-amendments-to-data-protection-regulations)
- [個人情報保護法 いわゆる3年ごと見直しについて（個人情報保護委員会）](https://www.ppc.go.jp/personalinfo/3nengotominaoshi/)
- [2025年の個人情報保護法改正はどうなる？（トレンドマイクロ）](https://www.trendmicro.com/ja_jp/jp-security/25/b/expertview-20250212-01.html)
- [個人情報保護法改正の追加検討事項の公表（2025年1月22日）（牛島総合法律事務所）](https://www.ushijima-law.gr.jp/client-alert_seminar/client-alert/20250123appi/)
- [【2026年最新】個人情報保護法の基礎と企業対応・改正動向（BUSINESS LAWYERS）](https://www.businesslawyers.jp/articles/1485)
- [個人情報保護・プライバシー 2025年の振り返りと2026年の展望（長島・大野・常松法律事務所）](https://www.nagashima.com/publications/publication20260116-2/)
- [Upcoming Amendments to the APPI in 2025 (Anderson Mori & Tomotsune)](https://www.amt-law.com/en/insights/others/publication_0029311_en_001/)

**GDPR / EU法**
- [Web Scraping Under GDPR and CCPA: Compliance Guide for 2026](https://iswebscrapinglegal.com/blog/gdpr-ccpa-web-scraping/)
- [The state of web scraping in the EU (IAPP)](https://iapp.org/news/a/the-state-of-web-scraping-in-the-eu)
- [GDPR Chapter 3 - Rights of the data subject](https://gdpr-info.eu/chapter-3/)
- [GDPR Recital 30 - Online identifiers for profiling and identification](https://gdpr.verasafe.com/recital-30/)
- [Is an IP Address Considered Personal Data Under GDPR? (CookieYes)](https://www.cookieyes.com/blog/ip-address-personal-data-gdpr/)
- [Data scraping: French SA fined KASPR EUR 200,000 (EDPB)](https://www.edpb.europa.eu/news/news/2025/data-scraping-french-sa-fined-kaspr-eu200-000_en)
- [EDPB Opinion 28/2024 on AI models and data protection](https://www.edpb.europa.eu/system/files/2024-12/edpb_opinion_202428_ai-models_en.pdf)
- [Web Scraping for AI Development: The CNIL builds on EDPB Guidance (Clifford Chance)](https://www.cliffordchance.com/insights/resources/blogs/talking-tech/en/articles/2025/06/web-scraping-for-ai-development--the-cnil-builds-on-edpb-guidanc.html)
- [EDPB releases opinion on personal data use in AI model development (IAPP)](https://iapp.org/news/a/edpb-opinion-sheds-light-on-lawful-ai-training-dpa-discretion)

**EU AI Act**
- [EU AI Act Implementation Timeline](https://artificialintelligenceact.eu/implementation-timeline/)
- [EU AI Act Timeline: Key Compliance Dates & Deadlines (DataGuard)](https://www.dataguard.com/eu-ai-act/timeline)
- [Latest wave of obligations under the EU AI Act (DLA Piper)](https://www.dlapiper.com/en-us/insights/publications/2025/08/latest-wave-of-obligations-under-the-eu-ai-act-take-effect)
- [The EU AI Act: 6 Steps to Take Before 2 August 2026 (Orrick)](https://www.orrick.com/en/Insights/2025/11/The-EU-AI-Act-6-Steps-to-Take-Before-2-August-2026)

**CCPA/CPRA**
- [California Finalizes Regulations (CPPA)](https://cppa.ca.gov/announcements/2025/20250923.html)
- [CCPA Updates, Cybersecurity Audits, Risk Assessments, ADMT, and Insurance Regulations (CPPA)](https://cppa.ca.gov/regulations/ccpa_updates.html)
- [California Finalizes CCPA Regulations for ADMT (Skadden)](https://www.skadden.com/insights/publications/2025/10/california-finalizes-cppa-regulations)
- [CPPA finalizes rules on ADMT, risk assessments, and cybersecurity audits (White & Case)](https://www.whitecase.com/insight-alert/cppa-finalizes-rules-admt-risk-assessments-and-cybersecurity-audits-requirements)
- [Revised CCPA Regulations Effective Jan. 1, 2026 (Greenberg Traurig)](https://www.gtlaw.com/en/insights/2025/9/revised-and-new-ccpa-regulations-set-to-take-effect-on-jan-1-2026-summary-of-near-term-action-items)
- [California Expands the Cybersecurity & Privacy Impact of the CCPA (Alston & Bird)](https://www.alston.com/en/insights/publications/2025/10/ccpa-cybersecurity-audits-admt-risk-assessments)
- [Risk Assessments Under the New CCPA Regulations Commence Jan. 1, 2026 (Brownstein)](https://www.bhfs.com/insight/risk-assessments-under-the-new-ccpa-regulations-commence-jan-1-2026/)
- [California's CCPA Cybersecurity Audit Rule Takes Effect (Ropes & Gray)](https://www.ropesgray.com/en/insights/alerts/2026/01/californias-ccpa-cybersecurity-audit-rule-takes-effect-what-businesses-need-to-know)
- [CCPA Requirements 2026: Complete Compliance Guide](https://secureprivacy.ai/blog/ccpa-requirements-2026-complete-compliance-guide)
- [CCPA/CPRA amended regulations approved and effective January 1, 2026 (FMG Law)](https://www.fmglaw.com/cyber-privacy-security/ccpa-cpra-amended-regulations-approved-and-effective-january-1-2026/)

**COPPA**
- [Children's Online Privacy in 2025: The Amended COPPA Rule (Loeb & Loeb)](https://www.loeb.com/en/insights/publications/2025/05/childrens-online-privacy-in-2025-the-amended-coppa-rule)
- [FTC's 2025 COPPA Final Rule Amendments (Securiti)](https://securiti.ai/ftc-coppa-final-rule-amendments/)
- [Children's Online Privacy Protection Rule (FTC)](https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa)

**電気通信事業法**
- [スクレイピングの法律的注意点 (IT弁護士 中野秀俊)](https://it-bengosi.com/blog/scraping/)
- [改正電気通信事業法 Cookie規制 (Priv Lab)](https://privtech.co.jp/blog/law/revised-telecommunications-business-law-cookie.html)
- [外部送信規律 法令・ガイドライン（総務省）](https://www.soumu.go.jp/main_sosiki/joho_tsusin/d_syohi/gaibusoushin_kiritsu_00001.html)
- [外部送信規律FAQ（総務省）](https://www.soumu.go.jp/main_sosiki/joho_tsusin/d_syohi/gaibusoushin_kiritsu_00002.html)

**IPアドレスの個人情報該当性**
- [IPアドレスの個人情報該当性 (IT弁護士 中野秀俊)](https://it-bengosi.com/blog/address/)
- [IPアドレスの個人情報該当性 (實原隆志, 長崎大学リポジトリ)](https://reposit.sun.ac.jp/dspace/bitstream/10561/1110/1/v15p17_jitsuhara.pdf)
- [GDPR and IP Addresses (ipdetect.org)](https://ipdetect.org/articles/gdpr-ip-addresses)

---

## 免責事項 / Disclaimer

本プライバシーポリシーは一般的な法的情報の提供を目的としており、特定の事案に対する法的助言を構成するものではありません。本ソフトウェアの運用に際して具体的な法的判断が必要な場合は、各法域において資格を有する弁護士にご相談ください。

特に、Webスクレイピング・クローリングに関する法的リスク（著作権法、不正競争防止法、個人情報保護法等）は、対象サイトの利用規約、robots.txt、およびデータの内容により大きく異なります。運用者は、自身の利用形態に適した法的アドバイスを個別に取得することを強く推奨します。

This Privacy Policy is provided for general informational purposes only and does not constitute legal advice for any specific situation. If specific legal decisions are needed in operating the Software, please consult a qualified attorney in the relevant jurisdiction.

In particular, legal risks related to web scraping and crawling (copyright law, unfair competition prevention law, data protection laws, etc.) vary significantly depending on the target site's terms of service, robots.txt, and the nature of the data involved. Operators are strongly recommended to obtain legal advice tailored to their specific use case.

**法的調査日 / Legal Research Date: 2026-02-18（クロスレビュー完了、CCPA/CPRA期限記述修正、クロール関連指摘修正）**
