# Reftrix ライセンス FAQ / License FAQ

[日本語版](#日本語版) | [English Version](#english-version)

---

## 日本語版

**バージョン**: 0.1.0
**法的調査日**: 2026-02-18

---

### 目次

1. [一般的な AGPL FAQ](#1-一般的な-agpl-faq)
2. [コピーレフト境界 FAQ](#2-コピーレフト境界-faq)
3. [デュアルライセンス FAQ](#3-デュアルライセンス-faq)
4. [セルフホスティング FAQ](#4-セルフホスティング-faq)
5. [免責事項](#5-免責事項)

---

### 1. 一般的な AGPL FAQ

#### Q1.1: AGPL-3.0とは何ですか？GPL-3.0との違いは？

**A**: AGPL-3.0（GNU Affero General Public License version 3）は、Free Software Foundation（FSF）が策定した強力なコピーレフトライセンスです。GPL-3.0と基本的に同じ条件を持ちますが、**第13条（Remote Network Interaction）** が追加されている点が最大の違いです。

**GPL-3.0の場合**: ソフトウェアを「配布」（distribute/convey）したときのみ、ソースコード公開義務が発生します。サーバー上でソフトウェアを動作させ、ユーザーにネットワーク越しでサービスを提供するだけでは、GPL上の「配布」には該当しません。これはいわゆる「SaaS抜け穴」（SaaS loophole）と呼ばれるものです。

**AGPL-3.0の場合**: GPL-3.0の全条件に加えて、第13条により、ソフトウェアを**改変**した上で、ユーザーが**コンピューターネットワーク越しにリモートで対話**できる状態にした場合、そのユーザーに対してソースコードを提供する義務が発生します。

具体的には、AGPL-3.0 Section 13は以下のように規定しています:

> "if you modify the Program, your modified version must prominently offer all users interacting with it remotely through a computer network [...] an opportunity to receive the Corresponding Source of your version"

**重要な構成要件**:
1. プログラムを**改変**（modify）していること
2. ユーザーが**コンピューターネットワーク越しに遠隔で対話**していること
3. 改変版の **Corresponding Source**（対応するソースコード）の提供義務

未改変のReftrixをそのまま使用する場合、Section 13の義務は発動しません。ただし、Reftrixを配布する場合には、AGPL-3.0の通常の条件（Section 4-6）に基づきソースコードの提供義務があります。

**参考**:
- [AGPL-3.0 全文](https://www.gnu.org/licenses/agpl-3.0.html)
- [FSF: AGPLv3の基本](https://www.fsf.org/bulletin/2021/fall/the-fundamentals-of-the-agplv3)
- [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html)

---

#### Q1.2: Reftrixを使用するとき、自分のコードもAGPLにする必要がありますか？

**A**: **場合によります。** 以下のケースを区別する必要があります。

**(a) Reftrixを改変せずに使用する場合**: あなた自身のコードをAGPLにする必要は**ありません**。

**(b) MCPクライアント（Claude Desktop等）からReftrixのMCPツールを呼び出すだけの場合**: MCPクライアント側のコードをAGPLにする必要は**ありません**。MCPプロトコル（JSON-RPC 2.0）を介した対話は、標準的なプロトコルによるプロセス間通信であり、「combined work」（結合著作物）を構成しないと解釈するのが合理的です（詳細は [Q2.1](#q21) を参照）。

**(c) Reftrixのソースコードを改変し、そのまま配布する場合**: 改変部分を含む全体をAGPL-3.0でライセンスし、ソースコードを提供する必要があります（AGPL-3.0 Section 5(c)）。

**(d) Reftrixのソースコードを改変し、ネットワーク越しにサービスとして提供する場合**: 改変版のソースコードを、当該サービスのユーザーが取得できるようにする必要があります（AGPL-3.0 Section 13）。

---

#### Q1.3: 商用利用は可能ですか？

**A**: **はい。** AGPL-3.0は商用利用を禁止していません。以下の条件を遵守する限り、商用利用は自由に行えます:

1. **AGPL-3.0の条件を遵守すること**: 配布時のソースコード提供義務、改変時の変更の明示、ライセンス通知の維持等
2. **Section 13の義務**: 改変版をネットワーク越しに提供する場合は、ソースコードの提供

AGPL-3.0の義務の遵守が難しい場合（例: 自社のプロプライエタリコードと密結合した改変版を作成し、そのソースコードを公開したくない場合）は、[商用ライセンス](#q31-商用ライセンスはいつ必要ですか)の取得を検討してください。

**参考**: [FOSSA: Open Source Software Licenses 101: The AGPL License](https://fossa.com/blog/open-source-software-licenses-101-agpl-license/)

---

### 2. コピーレフト境界 FAQ

#### Q2.1: Claude DesktopからMCP経由でReftrixを使う場合、Claude DesktopのソースコードをAGPLで公開する必要がありますか？

**A**: **いいえ、その必要はないと考えられます。**

GNU GPL FAQでは、プログラム間の通信メカニズムと境界について以下のように述べています:

> "Pipes, sockets and command-line arguments are communication mechanisms normally used between two separate programs. So when they are used for communication, the modules normally are separate programs."

（パイプ、ソケット、コマンドライン引数は、通常、2つの別々のプログラム間で使用される通信メカニズムです。そのため、これらが通信に使用される場合、モジュールは通常、別々のプログラムです。）

Reftrixは**MCP（Model Context Protocol）サーバー**として動作し、Claude Desktop等のMCPクライアントとは**JSON-RPC 2.0プロトコル**を介して通信します。この通信方式は以下の理由から、AGPLのコピーレフトが伝播しない「separate programs」（独立したプログラム）の関係であると解釈するのが合理的です:

1. **標準プロトコルの使用**: MCP/JSON-RPC 2.0は公開された標準プロトコルであり、Reftrix固有の内部データ構造を共有するものではない
2. **独立した実行**: Reftrixサーバーとクライアントは独立したプロセスとして実行される
3. **交換可能性**: MCPクライアントはReftrix以外のMCPサーバーとも同一のプロトコルで通信でき、逆にReftrixは任意のMCPクライアントからの呼び出しを受け付ける

したがって、Claude DesktopとReftrixの関係はAGPL-3.0 Section 5に定義される「aggregate」（集合物）に該当し、AGPLの効力はClaude Desktop側のコードには及ばないと解釈されます。

**ただし重要な注意**: GNU GPL FAQは同時に以下の但し書きも付しています:

> "But if the semantics of the communication are intimate enough, exchanging complex internal data structures, that too could be a basis to consider the two parts as combined into a larger program."

（しかし、通信のセマンティクスが十分に密接で、複雑な内部データ構造を交換する場合、それも2つの部分がより大きなプログラムに結合されていると見なす根拠になりえます。）

MCPプロトコルでは標準的なJSON形式のリクエスト/レスポンスを交換するのみであり、Reftrix固有の複雑な内部データ構造を共有するものではないため、「intimate communication」に該当する可能性は低いと考えます。

**法的確定性**: この解釈はFSFの公式見解やGNU GPL FAQに基づく合理的な解釈ですが、MCPプロトコルとAGPLの関係について確定的な判例は存在しません。最終的な法的判断は、具体的な事実関係に基づいて行われます。不確実性を完全に排除したい場合は、[商用ライセンス](#q31-商用ライセンスはいつ必要ですか)の取得をご検討ください。

**参考**:
- [GNU GPL FAQ: Separate Programs](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)
- [MCP Specification: Transports](https://modelcontextprotocol.io/legacy/concepts/transports)

---

#### Q2.2: StdIO transport（ローカルプロセス間通信）の場合のコピーレフト境界は？

**A**: StdIO transportはReftrixのデフォルトの通信方式です。StdIO（標準入出力）は**ローカルプロセス間通信（IPC）** であり、コンピューターネットワーク越しの通信ではありません。

**コピーレフト境界の分析**:

| 観点 | 評価 |
|------|------|
| **AGPL Section 13の適用** | **非適用の可能性が高い** -- StdIOはネットワーク通信ではなく、「コンピューターネットワーク越しの遠隔対話」に該当しない |
| **「separate programs」の要件** | **充足** -- パイプを通じた通信はGNU GPL FAQで「通常、別々のプログラム」と明示されている |
| **「aggregate」の該当性** | **該当する可能性が高い** -- 同一マシン上で独立して動作する別々のプログラム |

**結論**: StdIO transport利用時は:
1. **AGPL Section 13（ネットワーク利用義務）は適用されない可能性が高い** -- ネットワーク通信が行われていないため
2. **MCPクライアントへのコピーレフト伝播はない** -- パイプ通信による独立プログラム間の通信

ただし、Reftrixを**配布**する場合（例: パッケージとして他者に渡す場合）には、配布に関するAGPL-3.0の通常の義務（Section 4-6）が適用されます。

---

#### Q2.3: HTTP/SSE transport（ネットワーク通信）の場合のコピーレフト境界は？

**A**: HTTP/SSE transportを使用する場合、StdIOの場合とは異なる考慮が必要です。

**AGPL Section 13の適用分析**:

| 条件 | HTTP/SSE transportでの該当性 |
|------|---------------------------|
| (1) プログラムを改変している | ユーザーがReftrixを改変している場合に該当 |
| (2) ネットワーク越しの遠隔対話 | **該当する** -- HTTP/SSEはネットワーク通信である |
| (3) ソースコード提供義務 | (1)と(2)を共に満たす場合に発生 |

**ケース別分析**:

**(a) 未改変のReftrixをHTTP transportで運用する場合**:
- Section 13は「**modify the Program**」を要件としているため、未改変であれば義務は発生しません
- ただし、ReftrixをHTTPサーバーとして公開する際には、セキュリティ面から適切なアクセス制御を推奨します

**(b) 改変したReftrixをHTTP transportで運用する場合**:
- **Section 13の義務が発生します**: 改変版のCorresponding Source（対応するソースコード）を、ネットワーク越しで対話するユーザーが取得できるようにする必要があります
- 具体的には、ソースコードへのダウンロードリンクの提示等が求められます

**MCPクライアントへの影響（HTTP/SSE transportの場合）**:
- HTTP/SSE transport経由であっても、MCPプロトコル（JSON-RPC 2.0）を介した通信は標準プロトコルによる独立プログラム間の通信であり、**MCPクライアント側のコードにAGPLの義務は及ばない**と解釈するのが合理的です
- ただし、Section 13の義務は**Reftrixサーバー側の改変版ソースコード**に対して発生します

---

#### Q2.4: 自作のMCPクライアントからReftrixサーバーを呼び出す場合は？

**A**: 自作のMCPクライアントを開発してReftrixサーバーを呼び出す場合、クライアント側のコードにAGPLの義務は及ばないと考えられます。

**根拠**:

1. **プロトコル境界**: 自作のMCPクライアントとReftrixサーバーは、MCPプロトコル（JSON-RPC 2.0）という標準的なプロトコルを介して通信する独立したプログラムです

2. **GNU GPL FAQの基準**: パイプやソケットを通じた通信は「通常、別々のプログラム間」で使用されるメカニズムであり、MCPのJSON-RPCもこれに該当します

3. **「aggregate」としての性質**: AGPL-3.0 Section 5末尾の定義による「aggregate」（「その性質上covered workの拡張ではなく、covered workと結合してより大きなプログラムを形成するものではない、独立した著作物の編集物」）に該当します

**自作MCPクライアントの設計指針**:
- MCPプロトコル仕様に準拠した標準的なJSON-RPCリクエスト/レスポンスのみを交換すること
- Reftrixの内部データ構造やソースコードの一部をクライアント側にコピーしないこと
- Reftrixのライブラリコードを直接import/linkしないこと（そうした場合は「combined work」と見なされるリスクがある）

**注意**: Reftrixの`packages/`内のライブラリ（例: `@reftrix/core`）を自作アプリケーションに直接importして使用する場合は、AGPLのコピーレフトが及ぶ可能性があります。MCPプロトコル経由でのツール呼び出しと、ライブラリとしての直接利用は、法的に異なる取り扱いとなります。

---

#### Q2.5: Reftrixの分析結果（データ・レポート）にAGPLは適用されますか？

**A**: **一般的には適用されません。**

AGPL-3.0 Section 2は以下のように規定しています:

> "The output from running a covered work is covered by this License only if the output, given its content, constitutes a covered work."

（covered workの実行出力は、その内容がcovered workを構成する場合にのみ、本ライセンスの対象となります。）

Reftrixが生成する出力データ（レイアウト分析結果、モーション検出結果、品質評価スコア、Embeddingベクトル等）は、Reftrixのソースコード自体を含むものではないため、これらの出力データにAGPL-3.0は適用されません。

**具体例**:

| 出力の種類 | AGPLの適用 | 理由 |
|-----------|-----------|------|
| レイアウト分析結果（JSON） | **非適用** | 分析データであり、Reftrixのソースコードではない |
| モーション検出結果 | **非適用** | 同上 |
| 品質評価スコア | **非適用** | 数値データであり、プログラムではない |
| Embeddingベクトル | **非適用** | 数値配列であり、プログラムではない |
| 生成されたReactコード（layout.generate_code） | **非適用** | テンプレートからの生成出力であり、Reftrixのコピーではない |
| スクリーンショット画像 | **非適用** | 対象Webページの複製であり、Reftrixのソースコードではない |

したがって、Reftrixの分析結果を自由に利用でき、その利用にあたってAGPL義務は発生しません。

ただし、スクリーンショット画像については、**対象Webサイトの著作権**が別途問題となる点にご注意ください（AGPLの問題ではなく、著作権法上の問題です）。

---

### 3. デュアルライセンス FAQ

#### Q3.1: 商用ライセンスはいつ必要ですか？

**A**: 以下のいずれかに該当する場合、商用ライセンスの取得を推奨します:

| ケース | 商用ライセンスの要否 | 理由 |
|--------|--------------------|----|
| Reftrixを改変せずにMCP経由で使用 | **不要** | AGPL義務が発生しない |
| Reftrixを改変して社内利用（外部提供なし） | **不要**（注意点あり） | 配布・ネットワーク提供がなければAGPL義務は限定的 |
| Reftrixを改変してSaaSとして外部提供 | **推奨** | Section 13により改変版のソースコード公開義務が発生 |
| Reftrixの改変版を配布（ソース公開不可） | **必要** | AGPL-3.0では改変版の配布時にソース公開が必須 |
| Reftrixのpackagesをライブラリとして自社プロダクトに組み込み | **推奨** | combined workとしてAGPLが自社コードに伝播する可能性 |
| AGPL-3.0ライセンスが社内ポリシーで禁止されている | **必要** | 例: [Google AGPL Policy](https://opensource.google/documentation/reference/using/agpl-policy)のように、AGPLコードの利用自体を禁止している企業がある |

**一般的な指針**: AGPL-3.0の条件（特にソースコード公開義務）を遵守できる場合は、商用ライセンスは不要です。AGPL-3.0の条件がビジネスモデルと両立しない場合に、商用ライセンスが必要となります。

---

#### Q3.2: 商用ライセンスの取得方法は？

**A**: 商用ライセンスについては、Reftrixプロジェクトの管理チームにお問い合わせください。

**連絡方法**:
- **メール**: [licence@reftrix.io](mailto:licence@reftrix.io)
- GitHub Issues: [https://github.com/TKMD/ReftrixMCP/issues](https://github.com/TKMD/ReftrixMCP/issues) にて「commercial license」のラベルでIssueを作成

商用ライセンスの主な内容:
- AGPL-3.0のコピーレフト義務（ソースコード公開義務）の免除
- Section 13（ネットワーク利用時のソースコード提供義務）の免除
- プロプライエタリソフトウェアへの組み込み許可
- 個別のサポート・保証条件（オプション）

---

#### Q3.3: example/ ディレクトリのコードのライセンスは？

> **注**: `example/` ディレクトリはOSSリリースパッケージには含まれていません。以下はメインリポジトリの `example/` ディレクトリに関する説明です。

**A**: サンプルコードは、Reftrixリポジトリの一部としてAGPL-3.0-onlyでライセンスされています。

ただし、`example/`ディレクトリのコードは、Reftrixの主要機能（MCPサーバー、packages/）とは**独立したアプリケーション**です。

**実用上の注意**:
- `example/`のコードはReftrixのMCPツールの利用方法を示す参考実装であり、本番利用を意図したものではありません
- `example/`のコードを参考にして独自のアプリケーションを一から作成する場合（コードをコピーせずにアイデアのみを参考にする場合）、AGPLの義務は発生しません。著作権法はアイデアではなく表現を保護します
- `example/`のコードの一部をコピーして自作アプリケーションに組み込む場合は、AGPL-3.0の条件に従う必要があります

---

### 4. セルフホスティング FAQ

#### Q4.1: 社内でReftrixをセルフホストする場合、ソースコード公開義務はありますか？

**A**: **社内利用に限定される場合、ソースコード公開義務は発生しない可能性が高いです。**

AGPL-3.0の義務は以下の2つの場面で発生します:

1. **配布（conveying）**: ソフトウェアを第三者に渡す行為（Section 4-6）
2. **ネットワーク越しのリモート対話**: 改変版をネットワーク越しで第三者が利用する行為（Section 13）

**社内セルフホスティングの分析**:

| 利用形態 | 配布に該当？ | Section 13に該当？ | ソース公開義務 |
|---------|------------|-------------------|-------------|
| 社内サーバーで社員のみが利用 | いいえ | 議論あり（注1） | **発生しない可能性が高い** |
| 社内サーバーで顧客にも公開 | いいえ（ただし注2） | **はい**（改変時） | **発生する可能性あり** |
| 社内でReftrixを改変し、改変版を社外に配布 | **はい** | N/A | **発生する** |

**注1**: 同一組織内での利用は「propagation」に含まれますが、FSFの見解では、組織内部での利用はSection 13の「users interacting with it remotely」に該当しないとする解釈が一般的です。社員はサービスの「ユーザー」ではなく、組織の一部として利用していると解されます。ただし、この点に関する確定的な判例は存在しません。

**注2**: ソフトウェアのコピーを顧客に渡していない場合は「配布」には該当しませんが、ネットワーク越しに顧客がサービスを利用する場合はSection 13の対象になります。

**推奨事項**: 社内利用に限定する場合でも、以下を推奨します:
- 改変の有無を記録に残す
- 将来的な利用範囲の拡大に備えて、AGPL-3.0への準拠体制を整備する
- 不確実性を排除したい場合は商用ライセンスを検討する

---

#### Q4.2: Reftrixを改変してSaaSとして提供する場合は？

**A**: **AGPL-3.0 Section 13の義務が発生します。**

Reftrixを改変し、SaaS（Software as a Service）として第三者に提供する場合、Section 13により以下の義務が生じます:

1. **Corresponding Sourceの提供**: 改変版のソースコード一式を、SaaSのユーザーが取得できる手段を提供する
2. **提供手段**: ネットワークサーバーからの無料ダウンロードなど、ソフトウェアのコピーを容易にする標準的または慣習的な手段
3. **対象範囲**: Reftrixの改変版全体のCorresponding Source（ビルドスクリプト、依存関係情報等を含む）

**具体的な準拠方法の例**:
- SaaSのUI上に「ソースコード」リンクを設置し、GitHubリポジトリ等へのリンクを提供
- 改変版のソースコードをGitHubの公開リポジトリで公開
- AGPL-3.0ライセンスの全文をソースコードに同梱

**AGPL義務を回避したい場合**: Reftrixの商用ライセンスを取得することで、Section 13を含むAGPLの義務を免除できます（[Q3.1](#q31-商用ライセンスはいつ必要ですか) を参照）。

---

### 5. 免責事項

---

**免責事項 / Disclaimer**

本FAQは一般的な法的情報の提供を目的としており、特定の事案に対する法的助言を構成するものではありません。
特に、MCPプロトコルとAGPLコピーレフト境界の関係は、法的に確定していない領域です。
具体的な法的判断が必要な場合は、資格を有する弁護士にご相談ください。

法的調査日 / Legal Research Date: 2026-02-18

---

---

## English Version

**Version**: 0.1.0
**Legal Research Date**: 2026-02-18

---

### Table of Contents

1. [General AGPL FAQ](#1-general-agpl-faq)
2. [Copyleft Boundary FAQ](#2-copyleft-boundary-faq)
3. [Dual Licensing FAQ](#3-dual-licensing-faq)
4. [Self-Hosting FAQ](#4-self-hosting-faq)
5. [Disclaimer](#5-disclaimer)

---

### 1. General AGPL FAQ

#### Q1.1: What is AGPL-3.0? How does it differ from GPL-3.0?

**A**: AGPL-3.0 (GNU Affero General Public License version 3) is a strong copyleft license published by the Free Software Foundation (FSF). It shares nearly all conditions with GPL-3.0, but adds **Section 13 (Remote Network Interaction)**, which is the key difference.

**GPL-3.0**: Source code disclosure obligations are triggered only when you "convey" (distribute) the software. Running software on a server and providing services to users over a network, without distributing copies, does not trigger GPL obligations. This is known as the "SaaS loophole."

**AGPL-3.0**: In addition to all GPL-3.0 conditions, Section 13 requires that if you **modify** the program and make it available for users to **interact with remotely through a computer network**, you must provide those users with an opportunity to receive the Corresponding Source of your modified version.

Specifically, AGPL-3.0 Section 13 states:

> "if you modify the Program, your modified version must prominently offer all users interacting with it remotely through a computer network [...] an opportunity to receive the Corresponding Source of your version"

**Key requirements**:
1. You must have **modified** the program
2. Users must be **interacting with it remotely through a computer network**
3. You must provide the **Corresponding Source** of your modified version

If you use an unmodified version of Reftrix, Section 13 obligations are not triggered. However, if you distribute Reftrix, the standard AGPL-3.0 conveying obligations (Sections 4-6) apply.

**References**:
- [AGPL-3.0 Full Text](https://www.gnu.org/licenses/agpl-3.0.html)
- [FSF: The Fundamentals of the AGPLv3](https://www.fsf.org/bulletin/2021/fall/the-fundamentals-of-the-agplv3)
- [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html)

---

#### Q1.2: When I use Reftrix, do I need to license my own code under AGPL?

**A**: **It depends.** The following cases should be distinguished:

**(a) Using Reftrix without modification**: You do **not** need to license your code under AGPL.

**(b) Calling Reftrix MCP tools from an MCP client (e.g., Claude Desktop)**: You do **not** need to license your MCP client code under AGPL. Communication via the MCP protocol (JSON-RPC 2.0) constitutes standard inter-process communication between separate programs, and does not create a "combined work" (see [Q2.1](#q21-1) for details).

**(c) Modifying Reftrix source code and distributing it**: You must license the entire modified work under AGPL-3.0 and provide the source code (AGPL-3.0 Section 5(c)).

**(d) Modifying Reftrix and providing it as a network service**: You must make the modified version's source code available to users who interact with it over the network (AGPL-3.0 Section 13).

---

#### Q1.3: Can I use Reftrix commercially?

**A**: **Yes.** AGPL-3.0 does not prohibit commercial use. You may use Reftrix commercially as long as you comply with AGPL-3.0 conditions:

1. **Compliance with AGPL-3.0**: Source code provision upon distribution, marking modifications, maintaining license notices, etc.
2. **Section 13 obligations**: Providing source code when serving modified versions over a network

If AGPL-3.0 obligations are incompatible with your business model (e.g., you want to create a modified version tightly integrated with proprietary code without disclosing the source), consider obtaining a [commercial license](#q31-when-is-a-commercial-license-needed).

**Reference**: [FOSSA: Open Source Software Licenses 101: The AGPL License](https://fossa.com/blog/open-source-software-licenses-101-agpl-license/)

---

### 2. Copyleft Boundary FAQ

#### Q2.1: If I use Reftrix via MCP from Claude Desktop, do I need to release Claude Desktop's source code under AGPL?

**A**: **No, this is not considered necessary.**

The GNU GPL FAQ states regarding communication mechanisms between programs:

> "Pipes, sockets and command-line arguments are communication mechanisms normally used between two separate programs. So when they are used for communication, the modules normally are separate programs."

Reftrix operates as an **MCP (Model Context Protocol) server** and communicates with MCP clients such as Claude Desktop via the **JSON-RPC 2.0 protocol**. This communication model is reasonably interpreted as a relationship between "separate programs" to which AGPL copyleft does not propagate, for the following reasons:

1. **Standard protocol**: MCP/JSON-RPC 2.0 is a published standard protocol and does not share Reftrix-specific internal data structures
2. **Independent execution**: The Reftrix server and client run as independent processes
3. **Interchangeability**: MCP clients can communicate with any MCP server using the same protocol, and vice versa

Therefore, the relationship between Claude Desktop and Reftrix qualifies as an "aggregate" as defined in AGPL-3.0 Section 5, and AGPL obligations do not extend to the client-side code.

**Important caveat**: The GNU GPL FAQ also notes:

> "But if the semantics of the communication are intimate enough, exchanging complex internal data structures, that too could be a basis to consider the two parts as combined into a larger program."

Since MCP protocol exchanges only standard JSON-formatted requests and responses, without sharing Reftrix-specific complex internal data structures, the risk of being considered "intimate communication" is low.

**Legal certainty**: This interpretation is based on reasonable reading of the FSF's official positions and the GNU GPL FAQ. However, no definitive case law exists regarding the relationship between MCP protocol and AGPL. For complete certainty, consider obtaining a [commercial license](#q31-when-is-a-commercial-license-needed).

**References**:
- [GNU GPL FAQ: Mere Aggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)
- [MCP Specification: Transports](https://modelcontextprotocol.io/legacy/concepts/transports)

---

#### Q2.2: What is the copyleft boundary for StdIO transport (local inter-process communication)?

**A**: StdIO transport is Reftrix's default communication method. StdIO (standard input/output) is **local inter-process communication (IPC)**, not network communication.

**Copyleft boundary analysis**:

| Aspect | Assessment |
|--------|-----------|
| **AGPL Section 13 applicability** | **Likely not applicable** -- StdIO is not network communication and does not constitute "interacting remotely through a computer network" |
| **"Separate programs" requirement** | **Met** -- Pipe-based communication is explicitly identified as "normally between separate programs" in the GNU GPL FAQ |
| **"Aggregate" qualification** | **Likely qualifies** -- Independent programs running on the same machine |

**Conclusion**: When using StdIO transport:
1. **AGPL Section 13 (network use obligation) is likely not applicable** -- no network communication occurs
2. **No copyleft propagation to MCP clients** -- communication between independent programs via pipes

Note that if you **distribute** Reftrix (e.g., distribute it as a package to third parties), the standard AGPL-3.0 conveying obligations (Sections 4-6) still apply.

---

#### Q2.3: What is the copyleft boundary for HTTP/SSE transport (network communication)?

**A**: When using HTTP/SSE transport, different considerations apply compared to StdIO.

**AGPL Section 13 applicability analysis**:

| Condition | Applicability with HTTP/SSE transport |
|-----------|--------------------------------------|
| (1) Program is modified | Applies if the user has modified Reftrix |
| (2) Remote interaction via network | **Applies** -- HTTP/SSE is network communication |
| (3) Source code provision obligation | Triggered when both (1) and (2) are met |

**Case analysis**:

**(a) Running unmodified Reftrix over HTTP transport**:
- Section 13 requires "**modify** the Program" -- no obligation if unmodified
- Security-appropriate access controls are still recommended

**(b) Running modified Reftrix over HTTP transport**:
- **Section 13 obligations are triggered**: You must make the Corresponding Source of your modified version available to users interacting via the network
- This can be accomplished by providing a download link to the source code

**Impact on MCP clients (HTTP/SSE transport)**:
- Even over HTTP/SSE, communication via MCP protocol (JSON-RPC 2.0) remains a standard protocol interaction between independent programs -- **AGPL obligations do not extend to MCP client code**
- However, Section 13 obligations do apply to the **modified Reftrix server source code itself**

---

#### Q2.4: What if I call Reftrix server from my own custom MCP client?

**A**: If you develop your own MCP client to call the Reftrix server, AGPL obligations do not extend to your client code.

**Rationale**:

1. **Protocol boundary**: Your MCP client and Reftrix server communicate via MCP protocol (JSON-RPC 2.0), a standard protocol between independent programs
2. **GNU GPL FAQ criteria**: Communication via pipes and sockets is "normally used between two separate programs"
3. **"Aggregate" nature**: Qualifies as an aggregate under AGPL-3.0 Section 5 ("separate and independent works, which are not by their nature extensions of the covered work")

**Design guidelines for custom MCP clients**:
- Exchange only standard JSON-RPC requests/responses conforming to the MCP protocol specification
- Do not copy Reftrix internal data structures or source code into your client
- Do not directly import/link Reftrix library code (doing so may constitute a "combined work")

**Note**: If you directly import and use Reftrix `packages/` libraries (e.g., `@reftrix/core`) in your application, AGPL copyleft may extend to your code. MCP protocol tool invocations and direct library usage have different legal implications.

---

#### Q2.5: Does AGPL apply to Reftrix's analysis output (data and reports)?

**A**: **Generally, no.**

AGPL-3.0 Section 2 states:

> "The output from running a covered work is covered by this License only if the output, given its content, constitutes a covered work."

Output data generated by Reftrix (layout analysis results, motion detection results, quality evaluation scores, embedding vectors, etc.) does not contain Reftrix's own source code, so AGPL-3.0 does not apply to this output.

**Examples**:

| Output Type | AGPL Applicability | Reason |
|------------|-------------------|--------|
| Layout analysis results (JSON) | **Not applicable** | Analysis data, not Reftrix source code |
| Motion detection results | **Not applicable** | Same as above |
| Quality evaluation scores | **Not applicable** | Numerical data, not a program |
| Embedding vectors | **Not applicable** | Numerical arrays, not a program |
| Generated React code (layout.generate_code) | **Not applicable** | Template-generated output, not a copy of Reftrix |
| Screenshot images | **Not applicable** | Reproduction of target web pages, not Reftrix source code |

You may freely use Reftrix's analysis output without AGPL obligations.

Note that screenshot images may be subject to the **target website's copyright** (this is a copyright law issue, not an AGPL issue).

---

### 3. Dual Licensing FAQ

#### Q3.1: When is a commercial license needed?

**A**: A commercial license is recommended in the following cases:

| Case | Commercial License | Reason |
|------|-------------------|--------|
| Using unmodified Reftrix via MCP | **Not needed** | No AGPL obligation triggered |
| Modifying for internal use (no external provision) | **Not needed** (with caveats) | Limited AGPL obligations without distribution or network provision |
| Modifying and providing as SaaS externally | **Recommended** | Section 13 triggers source code disclosure |
| Distributing modified version (without source disclosure) | **Needed** | AGPL-3.0 requires source disclosure upon distribution |
| Embedding Reftrix packages as libraries in your product | **Recommended** | May constitute a combined work, extending AGPL to your code |
| Internal policy prohibits AGPL-3.0 | **Needed** | e.g., [Google AGPL Policy](https://opensource.google/documentation/reference/using/agpl-policy) prohibits use of AGPL code |

**General guideline**: A commercial license is not needed if you can comply with AGPL-3.0 conditions (especially source code disclosure). It is needed when AGPL-3.0 conditions are incompatible with your business model.

---

#### Q3.2: How do I obtain a commercial license?

**A**: For commercial licensing inquiries, please contact the Reftrix project team.

**Contact methods**:
- **Email**: [licence@reftrix.io](mailto:licence@reftrix.io)
- GitHub Issues: Create an issue with the "commercial license" label at [https://github.com/TKMD/ReftrixMCP/issues](https://github.com/TKMD/ReftrixMCP/issues)

A commercial license typically covers:
- Exemption from AGPL-3.0 copyleft obligations (source code disclosure)
- Exemption from Section 13 (network use source code provision)
- Permission to incorporate into proprietary software
- Custom support and warranty terms (optional)

---

#### Q3.3: What is the license for code in the example/ directory?

> **Note**: The `example/` directory is not included in the OSS release package. The following describes the `example/` directory in the main repository.

**A**: Example code is licensed under AGPL-3.0-only as part of the Reftrix repository.

However, the `example/` code consists of **independent applications** separate from Reftrix's core functionality (MCP server, packages/).

**Practical notes**:
- The `example/` code serves as reference implementations demonstrating how to use Reftrix's MCP tools, and is not intended for production use
- If you create your own application inspired by `example/` code (using only ideas without copying code), AGPL obligations do not arise. Copyright protects expression, not ideas
- If you copy portions of `example/` code into your own application, AGPL-3.0 conditions apply to the copied portions

---

### 4. Self-Hosting FAQ

#### Q4.1: If I self-host Reftrix internally, is there an obligation to disclose source code?

**A**: **If use is limited to internal organization use, source code disclosure is likely not required.**

AGPL-3.0 obligations are triggered in two scenarios:

1. **Conveying**: Distributing copies of the software to third parties (Sections 4-6)
2. **Remote network interaction**: Making modified versions available for third parties to interact with over a network (Section 13)

**Self-hosting analysis**:

| Usage Pattern | Conveyance? | Section 13? | Source Disclosure |
|--------------|------------|------------|------------------|
| Internal server, employees only | No | Debatable (Note 1) | **Likely not required** |
| Internal server, also accessible to customers | No (but Note 2) | **Yes** (if modified) | **May be required** |
| Modifying and distributing externally | **Yes** | N/A | **Required** |

**Note 1**: Internal use within an organization constitutes "propagation" but the FSF's general interpretation is that internal organizational use does not qualify as "users interacting with it remotely" under Section 13. Employees are part of the organization, not external users of the service. However, no definitive case law exists on this point.

**Note 2**: If no copies are provided to customers, it is not "conveying," but if customers interact with the service over a network, Section 13 may apply.

**Recommendations**: Even for internal-only use:
- Document whether any modifications were made
- Prepare an AGPL-3.0 compliance framework in case usage scope expands
- Consider a commercial license if you want to eliminate uncertainty

---

#### Q4.2: What about modifying Reftrix and providing it as SaaS?

**A**: **AGPL-3.0 Section 13 obligations are triggered.**

If you modify Reftrix and provide it as SaaS (Software as a Service) to third parties, Section 13 requires:

1. **Providing Corresponding Source**: Making the complete source code of the modified version available through a means accessible to SaaS users
2. **Method of provision**: Free download from a network server, or other standard means of facilitating copying of software
3. **Scope**: The complete Corresponding Source of the modified version (including build scripts, dependency information, etc.)

**Example compliance methods**:
- Place a "Source Code" link in the SaaS UI linking to a GitHub repository
- Publish the modified version's source code in a public GitHub repository
- Include the full AGPL-3.0 license text with the source code

**To avoid AGPL obligations**: Obtain a Reftrix commercial license, which exempts you from AGPL obligations including Section 13 (see [Q3.1](#q31-when-is-a-commercial-license-needed)).

---

### 5. Disclaimer

---

**Disclaimer**

This FAQ is provided for general informational purposes only and does not constitute legal advice
for any specific situation. In particular, the relationship between the MCP protocol and AGPL copyleft
boundaries is a legally unsettled area. Please consult a qualified attorney for specific legal decisions.

Legal Research Date: 2026-02-18

---

## References

### Primary Sources

- [AGPL-3.0 Full Text](https://www.gnu.org/licenses/agpl-3.0.html)
- [GNU GPL FAQ](https://www.gnu.org/licenses/gpl-faq.html)
- [FSF: The Fundamentals of the AGPLv3](https://www.fsf.org/bulletin/2021/fall/the-fundamentals-of-the-agplv3)
- [MCP Specification](https://modelcontextprotocol.io/)
- [MCP Transports](https://modelcontextprotocol.io/legacy/concepts/transports)

### Additional Resources

- [FOSSA: The AGPL License](https://fossa.com/blog/open-source-software-licenses-101-agpl-license/)
- [Vaultinum: Guide to AGPL Compliance](https://vaultinum.com/blog/essential-guide-to-agpl-compliance-for-tech-companies)
- [Google AGPL Policy](https://opensource.google/documentation/reference/using/agpl-policy)
- [TLDRLegal: AGPL-3.0 Explained](https://www.tldrlegal.com/license/gnu-affero-general-public-license-v3-agpl-3-0)
- [Snyk: Is an AGPL License the Right Choice?](https://snyk.io/learn/agpl-license/)
- [SPDX License List](https://spdx.org/licenses/)

### Related Reftrix Documents

- [LICENSE](../../LICENSE) -- AGPL-3.0-only license text
- [CLA.md](../../CLA.md) -- Contributor License Agreement
- [CONTRIBUTING.md](../../CONTRIBUTING.md) -- Contribution guidelines
- [TERMS_OF_SERVICE.md](./TERMS_OF_SERVICE.md) -- Terms of Service
- [PRIVACY_POLICY.md](./PRIVACY_POLICY.md) -- Privacy Policy

---

*Reftrix License FAQ v0.1.0*
*Prepared by: Legal Compliance Counsel (AI-assisted analysis)*
*Legal Research Date: 2026-02-18*
