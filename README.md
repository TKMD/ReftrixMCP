# ReftrixMCP

**Web design knowledge base platform -- layout analysis, motion detection, and quality evaluation via MCP tools.**

[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-336791)](https://www.postgresql.org/)
[![MCP](https://img.shields.io/badge/MCP-Protocol-green)](https://modelcontextprotocol.io/)
[![pnpm](https://img.shields.io/badge/pnpm-10-f69220)](https://pnpm.io/)

<details>
<summary>Japanese / 日本語の概要</summary>

ReftrixMCPは、Webデザインパターンをベクトル検索(pgvector HNSW)と
RAGで検索可能なナレッジベースに集約し、MCPツール経由でClaude等の
AIエージェントと統合するプラットフォームです。

**主要機能**: レイアウト分析 / モーション検出 / 品質評価 / セマンティック検索 / レスポンシブ解析

**20のMCPツール**を提供: Layout(5) / Motion(2) / Quality(3) / Page(2) / Narrative(1) / Background(1) / Responsive(1) / Style(1) / Brief(1) / Project(2) / System(1)

詳細な日本語ドキュメント: [docs/README.ja.md](docs/README.ja.md)

</details>

## What it does

- **Layout analysis** -- auto-detect sections (hero, feature, CTA, etc.), extract grid/typography, and generate React/Vue/HTML code
- **Motion detection** -- discover CSS/JS animations with frame capture (15 px/frame video mode), CLS detection via Pixelmatch
- **Quality evaluation** -- score designs on three axes (originality, craftsmanship, contextuality) with anti-AI-cliche detection
- **Semantic search** -- find layout, motion, narrative, background, and responsive patterns via pgvector HNSW hybrid search
- **Vision integration** -- optional Ollama llama3.2-vision for richer layout understanding (graceful degradation when unavailable)
- **Code generation** -- convert analyzed sections to React, Vue, or plain HTML with matched motion patterns

## Why ReftrixMCP

| | |
|---|---|
| **Layout-aware** | Sections, grids, and typography extracted as structured data -- not just screenshots |
| **Motion-aware** | CSS static analysis + frame-by-frame video capture for real animation behavior |
| **Quality-aware** | Three-axis scoring with actionable improvement suggestions |
| **Searchable** | 768-dim multilingual embeddings (e5-base) with HNSW index and hybrid RRF ranking |
| **MCP-native** | 20 tools purpose-built for Claude Desktop and MCP Client CLI |

## Quickstart

### Prerequisites

Node.js 20+, pnpm 10+, Docker & Docker Compose, Ollama (optional, for vision analysis)

### Setup

```bash
git clone https://github.com/TKMD/ReftrixMCP.git && cd ReftrixMCP
pnpm install
cp .env.example .env          # edit DATABASE_URL / REDIS_URL as needed
docker compose up -d           # PostgreSQL 18 + pgvector + Redis
pnpm db:migrate && pnpm db:seed
pnpm build
```

### Connect to Claude

**Claude Desktop** -- add to your MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "reftrix": {
      "command": "node",
      "args": ["/path/to/ReftrixMCP/apps/mcp-server/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://reftrix:change_me@localhost:26432/reftrix?schema=public",
        "REDIS_URL": "redis://localhost:27379"
      }
    }
  }
}
```

**MCP Client CLI** -- add to `.mcp.json` in the project root or `~/.claude/.mcp.json` with the same config above.

> Replace `change_me` with a secure password. Port 26432 = standard 5432 + 21000 offset.

### Start worker (optional)

```bash
pnpm --filter @reftrix/mcp-server worker:start:page     # page.analyze worker
pnpm --filter @reftrix/mcp-server worker:start:quality   # quality.evaluate worker
```

## Example tools

ReftrixMCP provides **20 MCP tools**. Key examples:

- `layout.ingest` -- fetch a web page, take a screenshot, and extract section patterns
- `layout.search` -- semantic search over layout sections by natural-language query
- `motion.detect` -- detect CSS/JS animations with video-mode frame capture
- `quality.evaluate` -- score design quality on originality, craftsmanship, and contextuality
- `page.analyze` -- unified analysis: layout + motion + quality in one call (async via BullMQ)
- `responsive.search` -- search responsive analysis results by viewport and breakpoint

Full tool reference: [MCP Tools Guide](docs/users-guide/02-mcp-tools-guide.md)

## Architecture

```
MCP Client (Claude Desktop / Code)  --stdio-->  MCP Server (20 tools, Zod)
  +-- Service Layer: Playwright, Sharp+Pixelmatch, DOMPurify
  +-- ML Layer: ONNX Runtime (multilingual-e5-base, 768-dim)
  +-- BullMQ Workers: page.analyze, quality.evaluate
  +-- PostgreSQL 18 + pgvector 0.8 (HNSW, tsvector)  +  Redis 7
```

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](docs/users-guide/01-getting-started.md) | Installation, setup, and first analysis |
| [MCP Tools Guide](docs/users-guide/02-mcp-tools-guide.md) | All 20 tools with usage examples |
| [page.analyze Deep Dive](docs/users-guide/03-page-analyze-deep-dive.md) | Async analysis flow and data structures |
| [Troubleshooting](docs/users-guide/04-troubleshooting.md) | Common issues and solutions |

## Known limitations

- CPU-mode embedding takes ~2-5 s per text; GPU recommended for batch workloads
- Minimum 8 GB RAM; 16 GB recommended for concurrent analysis
- First embedding call downloads ~400 MB model (multilingual-e5-base)
- `page.analyze` requires a separate worker process (`worker:start:page`)
- Narrative analysis needs Ollama running locally (optional feature)

## License

AGPL-3.0-only -- see [LICENSE](LICENSE).

Network use requires source disclosure per [Section 13](https://www.gnu.org/licenses/agpl-3.0.html#section13).
Source: [github.com/TKMD/ReftrixMCP](https://github.com/TKMD/ReftrixMCP)
Commercial license: [licence@reftrix.io](mailto:licence@reftrix.io)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Report vulnerabilities per [SECURITY.md](SECURITY.md).
Privacy: [docs/legal/PRIVACY_POLICY.md](docs/legal/PRIVACY_POLICY.md) | Third-party licenses: [THIRDPARTY_LICENSES.md](THIRDPARTY_LICENSES.md)
