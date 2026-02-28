# Reftrix 利用規約 / Terms of Service

**バージョン / Version**: 0.1.0
**施行日 / Effective Date**: 2026年3月1日 / March 1, 2026
**最終更新 / Last Updated**: 2026年3月1日 / March 1, 2026

---

[日本語版](#日本語版) | [English Version](#english-version)

---

# 日本語版

## Reftrix 利用規約

### 第1条: サービスの定義と範囲

#### 1.1 サービスの概要

Reftrix（以下「本ソフトウェア」）は、Webデザインの構造化分析を行うオープンソースソフトウェアプラットフォームです。Model Context Protocol（MCP）を介して、AIアシスタント（Claude等）からツール呼び出しにより以下の機能を提供します。

- **レイアウト分析（Layout Analysis）**: Webページのセクション分割、デザインパターンの抽出
- **モーション検出（Motion Detection）**: CSS/JSアニメーションの検出・分類
- **品質評価（Quality Evaluation）**: Vision LLMを活用したデザイン品質スコアリング
- **Embedding生成・類似検索**: multilingual-e5-baseモデルによるベクトル化とpgvectorによる類似検索
- **Webページ取込（Page Ingestion）**: URL指定によるHTML/CSS/JS/スクリーンショットの取得

#### 1.2 提供形態

本ソフトウェアは、以下の形態で提供されます。

**(a) オープンソース版（セルフホスト）**

GNU Affero General Public License v3.0（AGPL-3.0-only）に基づき、ソースコードが公開されています。利用者は自身の環境にインストールし、セルフホストで運用します。オープンソース版の利用にあたっては、AGPL-3.0ライセンスの条件が適用されます。

**(b) 商用ライセンス版**

AGPL-3.0のコピーレフト義務（特にネットワーク経由での利用時のソースコード開示義務）を回避するための商用ライセンスが別途提供されます。商用ライセンスの条件は、個別のライセンス契約に定められます。

#### 1.3 アクセス方法

本ソフトウェアの主要な利用インターフェースは、MCP（Model Context Protocol）です。利用者は、MCP対応のAIアシスタントを通じて本ソフトウェアの機能を呼び出します。本ソフトウェアは、ホスト型SaaSとしてではなく、利用者が自身のインフラストラクチャ上でホストする形態で提供されます。

#### 1.4 適用範囲

本利用規約は、形態を問わず本ソフトウェアを利用するすべての利用者に適用されます。なお、オープンソース版の利用に関しては、AGPL-3.0ライセンスの条件が本利用規約に優先します。AGPL-3.0ライセンスと本利用規約の間に矛盾がある場合は、AGPL-3.0ライセンスが優先されます。

---

### 第2条: 利用条件

#### 2.1 AGPL-3.0の遵守義務

オープンソース版を利用する場合、利用者はAGPL-3.0ライセンスのすべての条件を遵守する義務を負います。特に以下の義務に留意してください。

**(a) ソースコード開示義務（AGPL-3.0 第13条）**

本ソフトウェアを修正し、その修正版をネットワーク経由で第三者に提供する場合、当該修正版のCorresponding Source（対応するソースコード）を、ネットワークサーバー経由で無償で利用可能にしなければなりません。

**(b) 著作権表示の維持**

本ソフトウェアのすべてのコピーまたは改変物に、適切な著作権表示、ライセンス表示、および保証の否認に関する表示を維持しなければなりません。

**(c) 同一ライセンスの適用**

本ソフトウェアを基にした派生著作物は、同じくAGPL-3.0ライセンスの下で配布しなければなりません。

#### 2.2 禁止行為

利用者は、以下の行為を行ってはなりません。

**(a) 悪意あるスクレイピング**

- 分析対象Webサイトの利用規約に明示的に違反するスクレイピング
- 分析対象Webサイトのrobots.txtの指定を無視したアクセス
- Webサイトの正常な運営を妨害する頻度・方法でのアクセス（DoS的利用）

**(b) 違法行為**

- 著作権法（日本国著作権法、米国Copyright Act、EU著作権指令等）に違反するコンテンツの分析・複製・配布
- 不正競争防止法（日本国不正競争防止法第2条第1項各号）に該当する行為
- コンピュータ不正アクセス禁止法（不正アクセス行為の禁止等に関する法律）に違反するアクセス
- 個人情報保護法（日本国個人情報の保護に関する法律）、GDPR（EU一般データ保護規則）、CCPA/CPRA（カリフォルニア州消費者プライバシー法）その他適用法令に違反する個人データの収集・処理

**(c) 権利侵害**

- 第三者の知的財産権（著作権、商標権、特許権、営業秘密等）を侵害する目的での本ソフトウェアの使用
- 分析対象Webサイトのコンテンツを、適法な目的を超えて複製・再配布する行為

**(d) システムへの攻撃**

- 本ソフトウェアのセキュリティ機能の回避または無効化
- リバースエンジニアリング（AGPL-3.0で許可される範囲を除く）
- 本ソフトウェアを利用した他のシステムへの攻撃

#### 2.3 利用上の注意

**(a) レート制限**

利用者は、分析対象Webサイトへのアクセスにおいて、合理的なレート制限を設定・遵守する責任を負います。本ソフトウェアのデフォルト設定を尊重し、対象サイトへの過度な負荷を回避してください。

**(b) robots.txtの尊重**

本ソフトウェアはWebページのクロール機能を備えています。利用者は、分析対象Webサイトのrobots.txtの指定を確認し、これを尊重する義務を負います。

**(c) 利用規約の確認**

利用者は、分析対象Webサイトの利用規約を確認し、当該サイトの利用規約が自動化されたアクセスを禁止している場合は、そのサイトへのアクセスを行わないものとします。

---

### 第3条: 知的財産権

#### 3.1 ソフトウェアの知的財産権

本ソフトウェアのソースコードは、AGPL-3.0-onlyライセンスの下で提供されます。著作権は「Reftrix Contributors」に帰属します。AGPL-3.0ライセンスに基づき付与される権利の範囲は、当該ライセンスの条文に定めるとおりです。

#### 3.2 分析結果データの帰属

**(a) 利用者の分析結果**

利用者が本ソフトウェアを使用して生成した分析結果データ（レイアウト構造データ、モーション検出結果、品質評価スコア、Embeddingベクトル等）に関する権利は、以下のとおりとします。

- 利用者自身が入力したデータに基づく分析結果は、利用者に帰属します
- ただし、分析結果がAGPL-3.0の「covered work」に該当する場合は、AGPL-3.0の条件が適用されます

**(b) 集約データ**

プロジェクト管理者は、利用者の分析結果を個人または組織を特定できない形に匿名化・集約した統計データを、ソフトウェアの改善目的で利用する場合があります。

#### 3.3 分析対象サイトの著作権への配慮

**(a) 利用者の責任**

利用者は、本ソフトウェアを使用してWebサイトを分析する際、分析対象サイトの著作権を尊重する義務を負います。

**(b) 引用・情報解析の範囲**

日本国著作権法第30条の4（著作物に表現された思想又は感情の享受を目的としない利用）および第47条の5（電子計算機による情報処理及びその結果の提供に付随する軽微利用等）の規定に基づき、情報解析目的での著作物の利用は、一定の条件の下で許容されます。

ただし、文化審議会著作権分科会法制度小委員会「AIと著作権に関する考え方について」（令和6年3月15日）が示すとおり、著作物に表現された思想又は感情の「享受」を目的とする利用が併存する場合、第30条の4は適用されません。利用者は、本ソフトウェアの利用が純粋に情報解析目的であること、および著作権者の利益を不当に害しないことを確認する責任を負います。

**(c) スクリーンショット**

本ソフトウェアが取得するスクリーンショットは、分析対象サイトの表示を忠実に再現するものであり、分析対象サイトの著作物の複製に該当する可能性があります。利用者は、スクリーンショットの利用が適用法令の下で許容される範囲に限定されることを理解し、適法な範囲でのみ利用するものとします。

#### 3.4 貢献者の知的財産権

本ソフトウェアへのコード貢献に関する知的財産権の取り扱いは、[貢献者ライセンス契約（CLA）](../../CLA.md)に定めるとおりとします。

---

### 第4条: 免責事項・責任制限

#### 4.1 現状有姿（AS-IS）での提供

本ソフトウェアは「現状有姿（AS-IS）」で提供されます。プロジェクト管理者は、明示的または黙示的を問わず、商品性、特定目的への適合性、権利の非侵害性、正確性、完全性、利用可能性、セキュリティについて、いかなる保証も行いません。

この保証の否認は、AGPL-3.0第15条および第16条の規定と整合するものです。

#### 4.2 責任の限定

適用法令で許容される最大限の範囲において、プロジェクト管理者、貢献者、またはその他の関係者は、以下について一切の責任を負いません。

**(a) 間接損害・結果損害**

利益の喪失、データの喪失または破損、営業の中断、代替サービスの取得費用、その他の間接的、偶発的、特別な、結果的、または懲罰的な損害

**(b) 分析対象サイトとの紛争**

利用者が本ソフトウェアを使用して第三者のWebサイトを分析したことに起因する、当該第三者との間の著作権侵害、利用規約違反、その他の紛争

**(c) 分析結果の不正確性**

本ソフトウェアが生成する分析結果（品質スコア、レイアウト分析、モーション検出結果等）の正確性、完全性、または信頼性

**(d) セキュリティインシデント**

利用者のセルフホスト環境における設定不備、脆弱性、またはセキュリティインシデント

#### 4.3 責任の上限

万一、前項の免責にもかかわらず責任が生じる場合、プロジェクト管理者の責任の総額は、利用者がプロジェクト管理者に対して直近12か月間に支払った金額（オープンソース版の場合は0円）を上限とします。

#### 4.4 消費者保護法との関係

本条の免責事項および責任制限は、適用される消費者保護法（日本国消費者契約法第8条第1項・第2項・第3項、第8条の2、第8条の3、第10条を含む）によって制限される場合があります。

特に、消費者契約法第8条第3項（令和4年改正・令和5年6月1日施行）に基づき、事業者の損害賠償責任の一部を免除する条項のうち、軽過失の場合にのみ適用されることを明らかにしていないものは無効とされます。本条の責任制限は、プロジェクト管理者の故意または重大な過失による損害には適用されません（軽過失の場合にのみ適用されます）。

消費者契約法その他の強行法規により無効とされる条項がある場合、当該条項のみが無効となり、本利用規約のその他の条項の有効性には影響しません。

---

### 第5条: データの取り扱い

#### 5.1 プライバシーポリシー

本ソフトウェアにおける個人データの取り扱いについては、別途定める[プライバシーポリシー](./PRIVACY_POLICY.md)をご確認ください。

#### 5.2 クロールデータの保存

**(a) セルフホスト環境**

本ソフトウェアがクロールしたデータ（HTML、CSS、JS、スクリーンショット、Embeddingベクトル等）は、利用者がセルフホストするPostgreSQLデータベースに保存されます。データの管理・保護の責任は利用者に帰属します。

**(b) データの最小化**

利用者は、本ソフトウェアの設定オプション（`include_html: false`、`include_screenshot: false`等）を活用し、必要最小限のデータのみを保存することを推奨します。

#### 5.3 データの削除

利用者は、自身のセルフホスト環境に保存されたデータを、いつでも削除することができます。本ソフトウェアが提供するデータ削除機能を利用するか、データベースに直接アクセスして削除を行ってください。

#### 5.4 外部送信規律

改正電気通信事業法第27条の12（令和5年6月16日施行）に基づく外部送信規律について、本ソフトウェアはセルフホスト型であり、プロジェクト管理者が直接利用者にサービスを提供するものではないため、外部送信規律の義務はプロジェクト管理者に対しては適用されません。ただし、利用者が本ソフトウェアを利用して第三者にサービスを提供する場合、当該利用者自身が電気通信事業法上の義務（外部送信規律を含む）を遵守する責任を負う場合があります。

#### 5.5 クロール対象サイトに含まれる個人情報

本ソフトウェアがクロールするWebページには、個人情報（氏名、メールアドレス、画像等）が含まれる場合があります。利用者は、以下の義務を負います。

- クロール対象サイトに含まれる個人情報の取り扱いについて、適用法令（個人情報保護法、GDPR、CCPA等）を遵守すること
- 不要な個人情報を速やかに削除すること
- 個人情報を第三者に開示・提供しないこと（法令上の義務がある場合を除く）

---

### 第6条: 利用規約の変更・サービス提供の終了

#### 6.1 利用規約の変更

**(a) 変更手続き**

プロジェクト管理者は、以下の場合に本利用規約を変更することができます。

- 利用者の一般の利益に適合する場合
- 変更が契約の目的に反せず、かつ変更の必要性、変更後の内容の相当性、その他の事情に照らして合理的である場合

**(b) 通知方法**

利用規約の変更は、本リポジトリ上での公開（GitHubリリースノート、CHANGELOG、または本ファイルの更新）によって通知します。重大な変更の場合は、少なくとも30日前に変更内容を公開します。

**(c) 変更の効力**

変更後の利用規約は、通知に定める効力発生日をもって発効します。効力発生日以降に本ソフトウェアの利用を継続した場合、利用者は変更後の利用規約に同意したものとみなします。

本項の規定は、民法第548条の4（定型約款の変更）の要件に適合するものとします。

#### 6.2 サービス提供の終了

**(a) オープンソース版**

AGPL-3.0ライセンスに基づき、本ソフトウェアのソースコードは公開されています。プロジェクト管理者が積極的な開発を終了した場合でも、AGPL-3.0の条件の下で、コミュニティは引き続きソースコードを利用・修正・配布する権利を有します。

**(b) 商用ライセンス版**

商用ライセンスのサポート終了条件は、個別のライセンス契約に定められます。

---

### 第7条: 準拠法・紛争解決

#### 7.1 準拠法

本利用規約は、日本国法に準拠し、日本国法に従って解釈されるものとします。法の抵触に関する規定は適用されません。

#### 7.2 紛争解決

本利用規約に起因または関連して生じるすべての紛争は、まず当事者間の誠実な協議により解決を図るものとします。協議により解決しない場合は、東京地方裁判所を第一審の専属的合意管轄裁判所とします。

**消費者に関する特則**: 本条の紛争解決規定は、消費者契約法その他の消費者保護法令により消費者に認められる権利を制限するものではありません。消費者契約法第12条に基づく適格消費者団体による差止請求、および民事訴訟法に基づく消費者の法定管轄の利益は、本条の規定にかかわらず保護されます。

#### 7.3 差止請求

前項にかかわらず、知的財産権の侵害またはその恐れがある場合、プロジェクト管理者は適切な管轄裁判所に対して差止請求を行う権利を留保します。

---

### 第8条: 一般条項

#### 8.1 完全合意

本利用規約、AGPL-3.0ライセンス、プライバシーポリシー、および適用される場合は商用ライセンス契約は、本ソフトウェアの利用に関する当事者間の完全な合意を構成します。

#### 8.2 分離可能性

本利用規約のいずれかの条項が管轄裁判所により無効または執行不能と判断された場合、当該条項のみが無効となり、残りの条項は引き続き完全な効力を有するものとします。

#### 8.3 権利の不放棄

プロジェクト管理者が本利用規約のいずれかの条項の違反に対して権利を行使しなかった場合でも、その後の違反に対する権利の放棄を意味するものではありません。

#### 8.4 譲渡

利用者は、プロジェクト管理者の書面による事前の同意なく、本利用規約上の権利または義務を第三者に譲渡することはできません。

#### 8.5 定型約款としての位置づけ

本利用規約は、民法第548条の2に定める「定型約款」に該当します。利用者は、本ソフトウェアの利用を開始することにより、本利用規約の個別の条項にも合意したものとみなされます（民法第548条の2第1項第2号）。ただし、民法第548条の2第2項に基づき、利用者の権利を制限しまたは義務を加重する条項であって、信義則に反して利用者の利益を一方的に害するものは、合意しなかったものとみなされます。

#### 8.6 連絡先

本利用規約に関するご質問は、以下にお問い合わせください。

- **GitHub Issues**: [https://github.com/TKMD/ReftrixMCP/issues](https://github.com/TKMD/ReftrixMCP/issues)
- **メール / Email**: [info@reftrix.io](mailto:info@reftrix.io)

---

---

# English Version

## Reftrix Terms of Service

### Section 1: Service Definition and Scope

#### 1.1 Service Overview

Reftrix (the "Software") is an open-source software platform for structural analysis of web design. Through the Model Context Protocol (MCP), it provides the following capabilities via tool invocations from AI assistants (such as Claude):

- **Layout Analysis**: Web page section segmentation and design pattern extraction
- **Motion Detection**: CSS/JS animation detection and classification
- **Quality Evaluation**: Design quality scoring using Vision LLM
- **Embedding Generation and Similarity Search**: Vectorization with multilingual-e5-base model and similarity search via pgvector
- **Page Ingestion**: HTML/CSS/JS/screenshot retrieval from specified URLs

#### 1.2 Delivery Model

The Software is provided in the following forms:

**(a) Open-Source Version (Self-Hosted)**

Source code is available under the GNU Affero General Public License v3.0 (AGPL-3.0-only). Users install and operate the Software on their own infrastructure. Use of the open-source version is subject to the terms of the AGPL-3.0 license.

**(b) Commercial License**

A separate commercial license is available for users who wish to avoid the copyleft obligations of the AGPL-3.0 (particularly the source code disclosure obligation for network use under Section 13). Terms of the commercial license are defined in a separate license agreement.

#### 1.3 Access Method

The primary user interface for the Software is MCP (Model Context Protocol). Users invoke the Software's functionality through MCP-compatible AI assistants. The Software is provided as a self-hosted solution, not as a hosted SaaS platform.

#### 1.4 Scope of Application

These Terms of Service apply to all users of the Software regardless of the form of use. For use of the open-source version, the AGPL-3.0 license terms take precedence over these Terms of Service. In the event of any conflict between the AGPL-3.0 license and these Terms, the AGPL-3.0 license shall prevail.

---

### Section 2: Terms of Use

#### 2.1 AGPL-3.0 Compliance Obligations

When using the open-source version, users are obligated to comply with all terms of the AGPL-3.0 license. Pay particular attention to the following obligations:

**(a) Source Code Disclosure Obligation (AGPL-3.0 Section 13)**

If you modify the Software and make the modified version available to third parties over a network, you must make the Corresponding Source of such modified version available at no charge via a network server.

**(b) Copyright Notice Preservation**

All copies or modifications of the Software must retain the appropriate copyright notice, license notice, and warranty disclaimer.

**(c) Same License Application**

Derivative works based on the Software must be distributed under the same AGPL-3.0 license.

#### 2.2 Prohibited Activities

Users shall not engage in the following activities:

**(a) Malicious Scraping**

- Scraping that explicitly violates the terms of service of the target website
- Accessing target websites in disregard of their robots.txt directives
- Accessing target websites at a frequency or in a manner that disrupts their normal operation (DoS-like usage)

**(b) Illegal Activities**

- Analysis, reproduction, or distribution of content in violation of copyright laws (Japan Copyright Act, US Copyright Act, EU Copyright Directives, etc.)
- Acts constituting unfair competition under the Japan Unfair Competition Prevention Act (Article 2, Paragraph 1)
- Unauthorized access in violation of the Japan Act on Prohibition of Unauthorized Computer Access
- Collection or processing of personal data in violation of the Japan Act on Protection of Personal Information (APPI), EU General Data Protection Regulation (GDPR), California Consumer Privacy Act/California Privacy Rights Act (CCPA/CPRA), or other applicable laws

**(c) Rights Infringement**

- Use of the Software for the purpose of infringing third-party intellectual property rights (copyrights, trademarks, patents, trade secrets, etc.)
- Reproduction or redistribution of target website content beyond lawful purposes

**(d) System Attacks**

- Circumvention or disabling of the Software's security features
- Reverse engineering (except to the extent permitted by the AGPL-3.0)
- Use of the Software to attack other systems

#### 2.3 Usage Guidelines

**(a) Rate Limiting**

Users are responsible for configuring and observing reasonable rate limits when accessing target websites. Respect the Software's default settings and avoid placing excessive load on target sites.

**(b) Respecting robots.txt**

The Software includes web page crawling capabilities. Users are obligated to check and respect the robots.txt directives of target websites.

**(c) Terms of Service Review**

Users must review the terms of service of target websites. If a target site's terms of service prohibit automated access, users shall not access that site using the Software.

---

### Section 3: Intellectual Property Rights

#### 3.1 Software Intellectual Property

The Software's source code is provided under the AGPL-3.0-only license. Copyright belongs to "Reftrix Contributors." The scope of rights granted under the AGPL-3.0 license is as set forth in the terms of that license.

#### 3.2 Ownership of Analysis Results

**(a) User Analysis Results**

Regarding analysis result data generated by users through the Software (layout structure data, motion detection results, quality evaluation scores, embedding vectors, etc.):

- Analysis results based on data input by the user belong to the user
- However, if analysis results constitute a "covered work" under the AGPL-3.0, the terms of the AGPL-3.0 shall apply

**(b) Aggregated Data**

The Maintainers may use analysis results that have been anonymized and aggregated in a manner that does not identify any individual or organization, for the purpose of improving the Software.

#### 3.3 Respect for Target Site Copyrights

**(a) User Responsibility**

Users are obligated to respect the copyrights of target websites when analyzing them with the Software.

**(b) Quotation and Information Analysis Scope**

Under certain conditions, the use of copyrighted works for information analysis purposes may be permitted under applicable laws, such as Article 30-4 (Use Not Aimed at Enjoying Expressed Thoughts or Sentiments) and Article 47-5 (Minor Use Incidental to Computer Information Processing) of the Japan Copyright Act, or similar fair use or text and data mining exceptions in other jurisdictions.

However, as clarified in the Agency for Cultural Affairs' "Approach to AI and Copyright" (March 15, 2024), Article 30-4 does not apply when the purpose of "enjoying" the expressed thoughts or sentiments coexists with the information analysis purpose. Users bear the responsibility of confirming that their use of the Software is purely for information analysis purposes and does not unduly prejudice the interests of copyright holders.

**(c) Screenshots**

Screenshots captured by the Software faithfully reproduce the display of the target website and may constitute reproduction of copyrighted works on the target site. Users acknowledge that the use of screenshots is limited to the extent permitted under applicable law and shall use them only within lawful bounds.

#### 3.4 Contributor Intellectual Property

The treatment of intellectual property rights for code contributions to the Software is governed by the [Contributor License Agreement (CLA)](../../CLA.md).

---

### Section 4: Disclaimers and Limitation of Liability

#### 4.1 AS-IS Provision

THE SOFTWARE IS PROVIDED "AS IS." THE MAINTAINERS MAKE NO WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT, ACCURACY, COMPLETENESS, AVAILABILITY, OR SECURITY.

This warranty disclaimer is consistent with the provisions of Sections 15 and 16 of the AGPL-3.0.

#### 4.2 Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE MAINTAINERS, CONTRIBUTORS, OR OTHER RELATED PARTIES SHALL NOT BE LIABLE FOR:

**(a) Indirect and Consequential Damages**

Loss of profits, loss or corruption of data, business interruption, cost of procuring substitute services, or any other indirect, incidental, special, consequential, or punitive damages.

**(b) Disputes with Target Sites**

Any copyright infringement claims, terms of service violations, or other disputes between the user and third parties arising from the user's analysis of third-party websites using the Software.

**(c) Inaccuracy of Analysis Results**

The accuracy, completeness, or reliability of analysis results generated by the Software (quality scores, layout analysis, motion detection results, etc.).

**(d) Security Incidents**

Configuration errors, vulnerabilities, or security incidents in the user's self-hosted environment.

#### 4.3 Liability Cap

In the event that liability arises notwithstanding the foregoing disclaimers, the total liability of the Maintainers shall not exceed the aggregate amount paid by the user to the Maintainers in the twelve (12) months preceding the event giving rise to liability (which shall be zero for the open-source version).

#### 4.4 Consumer Protection Laws

The disclaimers and limitations of liability in this Section may be limited by applicable consumer protection laws, including Article 8 (Paragraphs 1, 2, and 3), Articles 8-2, 8-3, and Article 10 of the Japan Consumer Contract Act. If any provision is rendered invalid by consumer protection laws or other mandatory provisions of law, only that provision shall be invalid, and the validity of the remaining provisions of these Terms shall not be affected.

In particular, pursuant to Article 8, Paragraph 3 of the Japan Consumer Contract Act (as amended in 2022, effective June 1, 2023), any provision that partially exempts a business operator from liability for damages but does not clearly state that it applies only to cases of ordinary negligence (excluding gross negligence) shall be invalid. The limitations of liability in this Section shall not apply to damages caused by the gross negligence or willful misconduct of the Maintainers (they apply only in cases of ordinary negligence).

---

### Section 5: Data Handling

#### 5.1 Privacy Policy

For information regarding the handling of personal data by the Software, please refer to the separate [Privacy Policy](./PRIVACY_POLICY.md).

#### 5.2 Crawled Data Storage

**(a) Self-Hosted Environment**

Data crawled by the Software (HTML, CSS, JS, screenshots, embedding vectors, etc.) is stored in the PostgreSQL database hosted by the user. The responsibility for managing and protecting such data rests with the user.

**(b) Data Minimization**

Users are encouraged to utilize the Software's configuration options (such as `include_html: false`, `include_screenshot: false`) to store only the minimum necessary data.

#### 5.3 Data Deletion

Users may delete data stored in their self-hosted environment at any time, either through the Software's data deletion functionality or by directly accessing the database.

#### 5.4 External Transmission Rules

Regarding the external transmission rules under Article 27-12 of the amended Telecommunications Business Act (effective June 16, 2023), the Software is self-hosted and the Maintainers do not directly provide services to users, so the external transmission rules do not apply to the Maintainers. However, if users use the Software to provide services to third parties, such users may be responsible for complying with the Telecommunications Business Act obligations (including external transmission rules) on their own.

#### 5.5 Personal Information on Crawled Sites

Web pages crawled by the Software may contain personal information (names, email addresses, images, etc.). Users are obligated to:

- Comply with applicable laws (APPI, GDPR, CCPA, etc.) regarding the handling of personal information contained in crawled sites
- Promptly delete unnecessary personal information
- Not disclose or provide personal information to third parties (except as required by law)

---

### Section 6: Modifications and Termination

#### 6.1 Modifications to Terms

**(a) Modification Procedure**

The Maintainers may modify these Terms of Service in the following cases:

- When the modification is consistent with the general interest of users
- When the modification is not contrary to the purpose of the agreement and is reasonable in light of the necessity for modification, the appropriateness of the modified content, and other relevant circumstances

**(b) Notice Method**

Modifications to these Terms will be notified through publication in this repository (via GitHub release notes, CHANGELOG, or updates to this file). For material changes, the modified terms will be published at least thirty (30) days in advance.

**(c) Effectiveness of Modifications**

Modified Terms shall become effective on the effective date specified in the notice. Continued use of the Software after the effective date constitutes acceptance of the modified Terms.

These provisions are intended to comply with the requirements of Article 548-4 of the Japan Civil Code (Modification of Standard Form Contracts).

#### 6.2 Termination of Service

**(a) Open-Source Version**

The Software's source code is publicly available under the AGPL-3.0 license. Even if the Maintainers cease active development, the community retains the right to use, modify, and distribute the source code under the terms of the AGPL-3.0.

**(b) Commercial License**

Support termination conditions for the commercial license are defined in the separate license agreement.

---

### Section 7: Governing Law and Dispute Resolution

#### 7.1 Governing Law

These Terms of Service shall be governed by and construed in accordance with the laws of Japan, without regard to its conflict of law provisions.

#### 7.2 Dispute Resolution

All disputes arising out of or in connection with these Terms of Service shall first be resolved through good-faith consultation between the parties. If consultation fails to resolve the dispute, the Tokyo District Court shall have exclusive jurisdiction as the court of first instance.

**Special Provisions for Consumers**: The dispute resolution provisions of this Section shall not limit any rights granted to consumers under the Consumer Contract Act or other consumer protection laws. Injunctive relief by qualified consumer organizations under Article 12 of the Consumer Contract Act, and consumers' statutory jurisdictional interests under the Code of Civil Procedure, are preserved notwithstanding this Section.

#### 7.3 Injunctive Relief

Notwithstanding the foregoing, in cases of intellectual property infringement or threatened infringement, the Maintainers reserve the right to seek injunctive relief from any court of competent jurisdiction.

---

### Section 8: General Provisions

#### 8.1 Entire Agreement

These Terms of Service, the AGPL-3.0 license, the Privacy Policy, and, where applicable, the Commercial License Agreement constitute the entire agreement between the parties regarding the use of the Software.

#### 8.2 Severability

If any provision of these Terms is found invalid or unenforceable by a court of competent jurisdiction, only that provision shall be invalid, and the remaining provisions shall continue in full force and effect.

#### 8.3 No Waiver

Failure by the Maintainers to enforce any provision of these Terms shall not constitute a waiver of the right to enforce such provision in the future.

#### 8.4 Assignment

Users may not assign any rights or obligations under these Terms to any third party without the prior written consent of the Maintainers.

#### 8.5 Deemed Acceptance

These Terms of Service constitute "standard form contract terms" (teikeiyakkan) as defined in Article 548-2 of the Japan Civil Code. By commencing use of the Software, users are deemed to have agreed to the individual provisions of these Terms (Article 548-2, Paragraph 1, Item 2 of the Civil Code). However, pursuant to Article 548-2, Paragraph 2 of the Civil Code, provisions that restrict the rights of or impose obligations on the user and that unilaterally harm the user's interests contrary to the principle of good faith shall be deemed not to have been agreed upon.

#### 8.6 Contact

For questions about these Terms of Service, please contact:

- **GitHub Issues**: [https://github.com/TKMD/ReftrixMCP/issues](https://github.com/TKMD/ReftrixMCP/issues)
- **Email**: [info@reftrix.io](mailto:info@reftrix.io)

---

---

**免責事項 / Disclaimer**

本利用規約は一般的な法的情報の提供を目的としており、特定の事案に対する法的助言を構成するものではありません。
具体的な法的判断が必要な場合は、資格を有する弁護士にご相談ください。

This Terms of Service is provided for general informational purposes only and does not constitute legal advice
for any specific situation. Please consult a qualified attorney for specific legal decisions.

法的調査日 / Legal Research Date: 2026-02-18

---

## 法的調査ログ / Legal Research Log

本利用規約の作成にあたり、以下の法的調査を実施しました。

### 調査項目

| 調査対象 | 調査日 | 情報源 |
|---------|--------|--------|
| AGPL-3.0ライセンス条文（Section 13: Remote Network Interaction） | 2026-02-18 | GNU.org、FSF |
| 日本国民法 第548条の2〜4（定型約款） | 2026-02-18 | e-Gov法令検索、法律事務所解説 |
| 日本国著作権法 第30条の4、第47条の5（情報解析目的の利用） | 2026-02-18 | e-Gov法令検索 |
| 文化庁「AIと著作権に関する考え方について」（令和6年3月15日） | 2026-02-18 | 文化庁著作権課 |
| 日本国消費者契約法 第8条第1項〜第3項、第8条の2、第8条の3、第10条 | 2026-02-18 | e-Gov法令検索 |
| 消費者契約法 令和4年改正（サルベージ条項規制・第8条第3項） | 2026-02-18 | 消費者庁逐条解説、法律事務所解説 |
| 日本国不正競争防止法 第2条第1項 | 2026-02-18 | e-Gov法令検索 |
| 電気通信事業法 第27条の12（外部送信規律・令和5年6月16日施行） | 2026-02-18 | 総務省、法律事務所解説 |
| 仲裁法（平成15年法律第138号）附則第3条（消費者仲裁合意） | 2026-02-18 | e-Gov法令検索 |
| 経済産業省「電子商取引及び情報財取引等に関する準則」2025年改訂版 | 2026-02-18 | 経済産業省 |
| 特定商取引法改正動向（デジタル取引検討会 2026年設置予定） | 2026-02-18 | 消費者庁 |
| Webスクレイピングの法的適法性（日本法・米国法） | 2026-02-18 | 法律事務所解説、学術論文 |
| 米国CFAA: hiQ Labs v. LinkedIn, Van Buren v. United States判例 | 2026-02-18 | 第9巡回区控訴裁判所、連邦最高裁判所 |
| DMCA Section 512 セーフハーバー | 2026-02-18 | 米国著作権局、EFF |
| EU Digital Services Act 執行状況（2025-2026年） | 2026-02-18 | 欧州委員会 |
| GDPR手続規則（2026年1月1日発効） | 2026-02-18 | Gibson Dunn、Morrison Foerster |
| AGPL-3.0デュアルライセンスプロジェクト事例（Nextcloud、GitLab、Mattermost） | 2026-02-18 | 各プロジェクト公式サイト |
| OSSライセンスコンプライアンスベストプラクティス | 2026-02-18 | FOSSA、Vaultinum |

### 参照した法令

| 法令名 | 条文 | 関連条項 |
|--------|------|---------|
| 民法 | 第548条の2 | 第8条 8.5項（定型約款のみなし合意） |
| 民法 | 第548条の4 | 第6条 6.1項（定型約款の変更） |
| 著作権法 | 第30条の4 | 第3条 3.3項(b)（情報解析目的利用） |
| 著作権法 | 第47条の5 | 第3条 3.3項(b)（軽微利用） |
| 消費者契約法 | 第8条第1項〜第3項、第8条の2、第8条の3、第10条 | 第4条 4.4項（消費者保護・免責制限） |
| 消費者契約法 | 第12条 | 第7条 7.2項（適格消費者団体差止請求） |
| 不正競争防止法 | 第2条第1項 | 第2条 2.2項(b)（禁止行為） |
| 個人情報保護法 | 全般 | 第5条 5.5項（個人情報取扱い） |
| 電気通信事業法 | 第27条の12 | 第5条 5.4項（外部送信規律） |
| AGPL-3.0 | 第13条、第15条、第16条 | 第2条 2.1項、第4条 4.1項 |
