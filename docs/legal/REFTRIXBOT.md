# ReftrixBot

ReftrixBot is the crawler of [Reftrix](https://github.com/TKMD/ReftrixMCP), an open-source (AGPL-3.0-only) MCP server that analyzes the layout, motion and visual design of public web pages. Reftrix is self-hosted: each operator runs their own copy, so requests that carry this name come from whoever runs Reftrix, not from a central service.

ReftrixBot は [Reftrix](https://github.com/TKMD/ReftrixMCP) のクローラーです。Reftrix は公開 Web ページのレイアウト・モーション・見た目を分析するオープンソース（AGPL-3.0-only）の MCP サーバーです。Reftrix は各自が自分の環境で動かすため、この名前のリクエストは中央のサービスではなく、Reftrix を動かしている各運用者から送られます。

## User-Agent

Pages are opened in Chromium with a Chrome-compatible User-Agent that always ends with the ReftrixBot token:

ページは Chromium で開き、User-Agent は Chrome 互換の文字列の末尾に必ず ReftrixBot のトークンを付けます:

```
Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<version> Safari/537.36 (compatible; ReftrixBot/1.0; +https://github.com/TKMD/ReftrixMCP/blob/main/docs/legal/REFTRIXBOT.md)
```

For viewports named `mobile` (in `responsive.capture`, `page.analyze` with `responsiveOptions`, and `quality.evaluate` with `responsive_evaluation`) the same Chromium uses the Android form, with mobile and touch emulation so the Client Hints say the same:

`mobile` という名前の viewport（`responsive.capture`、`responsiveOptions` 付きの `page.analyze`、`responsive_evaluation` 付きの `quality.evaluate`）では、同じ Chromium の Android 版の形を使い、Client Hints も同じ内容になるようモバイルとタッチのエミュレーションを付けます:

```
Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<version> Mobile Safari/537.36 (compatible; ReftrixBot/1.0; +https://github.com/TKMD/ReftrixMCP/blob/main/docs/legal/REFTRIXBOT.md)
```

The Android part is the fixed value Chrome itself sends; the host OS is not Android. The `Sec-CH-UA` brands are left as they are and include `HeadlessChrome`.

Android の部分は Chrome 自身が送る固定値で、実際に動いている OS は Android ではありません。`Sec-CH-UA` のブランドは変えておらず、`HeadlessChrome` を含みます。

`<version>` is the version of the Chromium that Reftrix runs. Plain HTTP requests (for example the robots.txt fetch) use `Mozilla/5.0 (compatible; ReftrixBot/1.0; +https://github.com/TKMD/ReftrixMCP/blob/main/docs/legal/REFTRIXBOT.md)`.

`<version>` は Reftrix が動かす Chromium のバージョンです。ブラウザを使わない HTTP リクエスト（robots.txt の取得など）は `Mozilla/5.0 (compatible; ReftrixBot/1.0; +https://github.com/TKMD/ReftrixMCP/blob/main/docs/legal/REFTRIXBOT.md)` を使います。

## robots.txt

Every Reftrix tool that opens a URL it is given checks robots.txt (RFC 9309) with the product token `ReftrixBot` before opening it: the page-intake tools (`page.analyze`, `page.batch_analyze`, `layout.ingest`, `quality.evaluate` given a URL, and the follow-up captures they run), `motion.detect`, `accessibility.audit`, `performance.evaluate`, `responsive.capture`, and `design.search_by_image` for an image URL. The check is on by default. It can be turned off for the whole server (`REFTRIX_RESPECT_ROBOTS_TXT=false`), and `page.analyze`, `page.batch_analyze` and `layout.ingest` also accept `respect_robots_txt: false` per call; the other tools have no per-call override. A robots.txt that cannot be fetched (timeout, server error) is treated as a refusal. Only the URL given to the tool is checked; redirect targets and the files a page loads (stylesheets, images, scripts) are not checked separately. To block ReftrixBot:

Reftrix のツールのうち、渡された URL を開くものはすべて、開く前に robots.txt（RFC 9309）を `ReftrixBot` のトークンで確認します。対象は、ページを取り込むツール（`page.analyze`、`page.batch_analyze`、`layout.ingest`、URL を渡した `quality.evaluate`、およびそれらが続けて行う撮影）、`motion.detect`、`accessibility.audit`、`performance.evaluate`、`responsive.capture`、画像 URL を渡した `design.search_by_image` です。確認は既定で有効です。サーバー全体では `REFTRIX_RESPECT_ROBOTS_TXT=false` で止められ、`page.analyze`・`page.batch_analyze`・`layout.ingest` は呼び出しごとの `respect_robots_txt: false` も受け付けます。ほかのツールには呼び出しごとの上書きはありません。robots.txt を取得できないとき（タイムアウト、サーバーエラー）は拒否として扱います。確認するのはツールに渡した URL だけで、リダイレクト先や、ページが読み込むファイル（スタイルシート、画像、スクリプト）は個別には確認しません。ReftrixBot を拒否するには次のように書きます:

```
User-agent: ReftrixBot
Disallow: /
```

## What it does not do / しないこと

- It does not hide that it is a bot: no stealth plugins, no `navigator.webdriver` spoofing, no User-Agent rotation, no per-site User-Agent overrides, no CAPTCHA solving and no proxies used to get around blocks. A page that robots.txt disallows is not processed, and an error response such as HTTP 403 is not retried with another identity. / bot であることを隠しません。stealth プラグイン、`navigator.webdriver` の偽装、User-Agent のローテーション、サイトごとの User-Agent の上書き、CAPTCHA の突破、ブロックを避けるための proxy は使いません。robots.txt で拒否されたページは処理せず、HTTP 403 などのエラー応答を別の名乗りでやり直すこともしません。
- It does not store, extract or redistribute web font files. Fonts are used only to render the page. What Reftrix stores is the page's HTML, the external CSS it references, the screenshot and the analysis results (layout, parts, motion, embeddings). / Web フォントのファイルを保存・抽出・再配布しません。フォントは描画にだけ使います。Reftrix が保存するのは、ページの HTML、参照している外部 CSS、スクリーンショット、分析結果（レイアウト、パーツ、モーション、embedding）です。
- Stored screenshots are deleted on a schedule and on request; see `apps/mcp-server/DATA_RETENTION.md`. / 保存したスクリーンショットは期限と要求に応じて削除します（`apps/mcp-server/DATA_RETENTION.md`）。

## Operators / 運用者の方へ

Operators are responsible for following the terms of the sites they analyze and the laws that apply to them. Keep the robots.txt check enabled.

分析するサイトの規約と、適用される法令を守るのは運用者の責任です。robots.txt の確認は有効のままにしてください。

## Contact / 連絡先

Questions or problems with ReftrixBot: open an issue at <https://github.com/TKMD/ReftrixMCP/issues>. Because Reftrix is self-hosted, the project cannot stop a specific operator's copy; please also block the token in robots.txt.

ReftrixBot についての質問や問題は <https://github.com/TKMD/ReftrixMCP/issues> に issue を作ってください。Reftrix は各自が動かすため、プロジェクトから特定の運用者の Reftrix を止めることはできません。robots.txt でのトークンの拒否も併せてお願いします。
