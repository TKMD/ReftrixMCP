# Third-Party Licenses / サードパーティライセンス

This file lists the principal third-party dependencies used by ReftrixMCP,
along with their respective licenses.

本ファイルは、ReftrixMCPが使用する主要なサードパーティ依存関係とそれぞれのライセンスを一覧にしたものです。

> **Note / 注意**: The English version of this document takes legal precedence.
> 本文書の法的効力は英語版が優先されます。

ReftrixMCP itself is licensed under the
[GNU Affero General Public License v3.0 (AGPL-3.0-only)](./LICENSE).

ReftrixMCP自体は [GNU Affero General Public License v3.0 (AGPL-3.0-only)](./LICENSE) の下でライセンスされています。

To regenerate a complete list with all transitive dependencies, run:

すべての推移的依存関係を含む完全なリストを再生成するには、以下を実行してください:

```
npx license-checker --production
```

---

## License Summary / ライセンスサマリー

| License | Key Packages |
|---------|-------------|
| MIT | ~81% of dependencies |
| Apache-2.0 | ~5% of dependencies |
| ISC | ~5% of dependencies |
| BSD-2-Clause / BSD-3-Clause | ~5% of dependencies |
| MPL-2.0 | DOMPurify, axe-core |
| LGPL-3.0-or-later | Sharp/libvips (dynamic linking) |

依存関係の約81%がMITライセンスで、残りはApache-2.0、ISC、BSDなどの寛容なライセンスです。
MPL-2.0およびLGPL-3.0-or-laterの依存関係は、AGPL-3.0との互換性が確認済みです。

---

## Principal Dependencies / 主要な依存関係

| Package | Version | License | Repository |
|---------|---------|---------|------------|
| @modelcontextprotocol/sdk | 1.26.x | MIT | https://github.com/modelcontextprotocol/typescript-sdk |
| @prisma/client | 6.x | Apache-2.0 | https://github.com/prisma/prisma |
| @huggingface/transformers | 3.x | Apache-2.0 | https://github.com/huggingface/transformers.js |
| onnxruntime-node | 1.21.x | MIT | https://github.com/microsoft/onnxruntime |
| zod | 3.24.x | MIT | https://github.com/colinhacks/zod |
| bullmq | 5.x | MIT | https://github.com/taskforcesh/bullmq |
| ioredis | 5.x | MIT | https://github.com/redis/ioredis |
| jsdom | 27.x | MIT | https://github.com/jsdom/jsdom |
| ws | 8.x | MIT | https://github.com/websockets/ws |
| sharp | 0.34.x | Apache-2.0 (npm pkg); libvips: LGPL-3.0-or-later (dynamic linking) | https://github.com/lovell/sharp |
| pixelmatch | 6.0.x | MIT | https://github.com/mapbox/pixelmatch |
| pngjs | 7.x | MIT | https://github.com/lukeapage/pngjs |
| dompurify | 3.3.x | MPL-2.0 OR Apache-2.0 | https://github.com/cure53/DOMPurify |
| axe-core | 4.x | MPL-2.0 | https://github.com/dequelabs/axe-core |
| culori | 4.x | MIT | https://github.com/Evercoder/culori |
| cheerio | 1.x | MIT | https://github.com/cheeriojs/cheerio |
| css-tree | 3.x | MIT | https://github.com/csstree/csstree |
| postcss | 8.x | MIT | https://github.com/postcss/postcss |
| robots-parser | 3.x | MIT | https://github.com/nickmccurdy/robots-parser |
| playwright | 1.57.x | Apache-2.0 | https://github.com/microsoft/playwright |

---

## ML Models (downloaded at runtime, not bundled) / MLモデル（実行時にダウンロード、バンドルには含まれません）

The following ML models are used at runtime but are **NOT** included in this
distribution. They are downloaded automatically on first use.

以下のMLモデルは実行時に使用されますが、本配布物には含まれて**いません**。
初回使用時に自動的にダウンロードされます。

| Model | License | URL |
|-------|---------|-----|
| intfloat/multilingual-e5-base | MIT | https://huggingface.co/intfloat/multilingual-e5-base |

---

## License Texts / ライセンス全文

The full text of each license type used by dependencies can be found at:

依存関係が使用する各ライセンスの全文は、以下のリンクで確認できます:

- **MIT**: https://opensource.org/licenses/MIT
- **Apache-2.0**: https://www.apache.org/licenses/LICENSE-2.0
- **ISC**: https://opensource.org/licenses/ISC
- **BSD-2-Clause**: https://opensource.org/licenses/BSD-2-Clause
- **BSD-3-Clause**: https://opensource.org/licenses/BSD-3-Clause
- **MPL-2.0**: https://www.mozilla.org/en-US/MPL/2.0/
- **LGPL-3.0-or-later**: https://www.gnu.org/licenses/lgpl-3.0.html
- **CC0-1.0**: https://creativecommons.org/publicdomain/zero/1.0/
- **CC-BY-4.0**: https://creativecommons.org/licenses/by/4.0/

---

## License Compatibility / ライセンス互換性

All third-party dependencies have been verified for compatibility with AGPL-3.0-only:

すべてのサードパーティ依存関係は、AGPL-3.0-onlyとの互換性が確認済みです:

- **Permissive licenses** (MIT, ISC, BSD, Apache-2.0, CC0, CC-BY-4.0) impose no
  copyleft obligations that conflict with the AGPL.
  **寛容なライセンス**（MIT、ISC、BSD、Apache-2.0、CC0、CC-BY-4.0）は、AGPLと矛盾するコピーレフト義務を課しません。
- **MPL-2.0** (weak copyleft): Section 3.3 explicitly permits combining MPL-covered
  files with AGPL-covered files in a "Larger Work."
  **MPL-2.0**（弱いコピーレフト）: 第3.3条により、MPL対象ファイルとAGPL対象ファイルを「より大きな著作物」として結合することが明示的に許可されています。
- **LGPL-3.0-or-later**: Sharp uses libvips via dynamic linking (N-API/addon),
  satisfying the LGPL requirement to allow relinking.
  **LGPL-3.0-or-later**: Sharpは動的リンク（N-API/addon）を介してlibvipsを使用しており、再リンクを許可するLGPLの要件を満たしています。
- **Apache-2.0**: Compatible with AGPL-3.0 per GPLv3 Section 7.
  **Apache-2.0**: GPLv3第7条に基づき、AGPL-3.0と互換性があります。

See individual package directories in `node_modules/` for full license texts
of all transitive dependencies.

すべての推移的依存関係のライセンス全文は、`node_modules/` 内の各パッケージディレクトリをご参照ください。
