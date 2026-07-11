# ReftrixMCP

**Web design knowledge base platform -- layout analysis, motion detection, and quality evaluation via MCP tools.**

> For frontend engineers, designers, and AI-agent builders who want to analyze real websites and retrieve reusable UI patterns via Claude or any MCP client.

[![License: AGPL-3.0-only](https://img.shields.io/badge/License-AGPL--3.0--only-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-18-336791)](https://www.postgresql.org/)
[![MCP](https://img.shields.io/badge/MCP-Protocol-green)](https://modelcontextprotocol.io/)
[![pnpm](https://img.shields.io/badge/pnpm-10-f69220)](https://pnpm.io/)

<a href="https://glama.ai/mcp/servers/@TKMD/reftrix-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@TKMD/reftrix-mcp/badge" alt="ReftrixMCP MCP server" />
</a>

<details>
<summary>Japanese / 日本語の概要</summary>

ReftrixMCPは、Webデザインパターンをベクトル検索(pgvector HNSW)と
RAGで検索可能なナレッジベースに集約し、MCPツール経由でClaude等の
AIエージェントと統合するプラットフォームです。

**主要機能**: レイアウト分析 / モーション検出 / 品質評価 / セマンティック検索 / 横断検索 / 画像類似検索 / レスポンシブ解析 / 嗜好プロファイリング / パーツ分析 / レート制限 / 検索キャッシュ / BullMQ UI / SBOM

**<!-- gen:tool-count -->40<!-- /gen:tool-count -->のMCPツール**を提供: Layout(5) / Motion(2) / Quality(1) / Page(4) / Narrative(1) / Background(1) / Responsive(2) / Preference(3) / Part(3) / Style(1) / Brief(1) / System(1) / Search(2) / Design(5) / Data(2) / Audit(1) / Embedding(1) / Accessibility(1) / Performance(1) / Report(1)

詳細な日本語ドキュメント: [docs/README.ja.md](docs/README.ja.md)

</details>

## What it does

- **Layout analysis** -- auto-detect sections (hero, feature, CTA, etc.), extract grid/typography, and generate React/Vue/HTML code
- **Motion detection** -- discover CSS/JS animations with frame capture (15 px/frame video mode), CLS detection via Pixelmatch
- **Quality evaluation** -- score designs on three axes (originality, craftsmanship, contextuality) with anti-AI-cliche detection
- **Semantic search** -- find layout, motion, narrative, background, and responsive patterns via pgvector HNSW hybrid search
- **Preference profiling** -- learn user design preferences through feedback sessions and personalize search results via reranking (GDPR-compliant)
- **Part-level analysis** -- extract 16 UI part types (button, icon, heading, etc.) with DINOv2 visual embeddings for visual similarity search
- **Vision integration** -- Ollama llama3.2-vision for richer layout, motion, and narrative understanding
- **Section post-processing** -- auto merge/split sections by type, heading, and height (Rule 1-4) for optimal structure
- **Multi-tile capture** -- split large sections (>viewport height) into tiles for complete DINOv2 visual coverage
- **Blank image detection** -- detect lazy-loading unrendered sections and re-capture via Playwright for full coverage
- **Code generation** -- convert analyzed sections to React, Vue, or plain HTML with matched motion patterns
- **Unified search** -- cross-service search across layout, part, motion, background, and narrative patterns in a single query
- **Image similarity search** -- find visually similar designs via DINOv2 embeddings from Base64/URL input (RRF 3-source)
- **Rate limiting** -- Token Bucket + Redis Lua (CWE-770 DoS prevention), 3-tier (analysis 10 RPM / search 120 RPM / default 60 RPM)
- **Search cache** -- LRU in-memory cache (lru-cache v11) with TTL-based natural expiry (5 min)
- **BullMQ UI** -- Bull Board dashboard for monitoring async page.analyze jobs (port 21080)
- **SBOM** -- CycloneDX 1.6 auto-generation for EU CRA vulnerability reporting compliance

## Why ReftrixMCP

|                      |                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Layout-aware**     | Sections, grids, and typography extracted as structured data -- not just screenshots                        |
| **Motion-aware**     | CSS static analysis + frame-by-frame video capture for real animation behavior                              |
| **Quality-aware**    | Three-axis scoring with actionable improvement suggestions                                                  |
| **Searchable**       | 768-dim multilingual embeddings (e5-base) with HNSW index and hybrid RRF ranking                            |
| **Preference-aware** | User preference profiling with feedback-driven reranking across all search tools                            |
| **Part-aware**       | 16 UI part types extracted with DINOv2 visual embeddings for cross-site component comparison                |
| **MCP-native**       | <!-- gen:tool-count -->40<!-- /gen:tool-count --> tools purpose-built for Claude Desktop and MCP Client CLI |

## Quickstart

> Run `page.analyze` on any URL in under 5 minutes.

### Prerequisites

Node.js 20+, pnpm 10+, Docker & Docker Compose, [Ollama](https://ollama.com/)

### Setup

```bash
git clone https://github.com/TKMD/ReftrixMCP.git && cd ReftrixMCP
pnpm install                                     # CUDA skip is default; see GPU note below
cp .env.example .env.local                       # edit DATABASE_URL / REDIS_URL as needed
cp .env.local packages/database/.env             # Prisma CLI requires this copy
pnpm docker:up                                   # PostgreSQL 18 + pgvector + Redis
pnpm db:migrate && pnpm db:seed
pnpm build
pnpm exec playwright install chromium            # browser for page crawling
pnpm --filter @reftrixmcp/ml download:dinov2        # DINOv2 visual embedding model (~330 MB)
pnpm --filter @reftrixmcp/ml repair:e5-cache --check # (optional) verify multilingual-e5-base ONNX cache (~1.1 GB) integrity
curl -fsSL https://ollama.com/install.sh | sh    # install Ollama
ollama pull llama3.2-vision                      # vision model (~7.9 GB)
ollama serve                                     # keep running in a separate terminal
```

> **Note**: If you change `.env.local`, also update `packages/database/.env`.
> `page.analyze` workers are auto-forked by `WorkerSupervisor` when the MCP server starts (v0.4.0 PR7d-2+). Manual start via `pnpm --filter @reftrixmcp/mcp-server worker:start:page` is **developer-only** and requires `REFTRIX_ALLOW_MANUAL_WORKER=true` to bypass the Redis-based dual-run guard if the MCP server is also running.
> See [Getting Started](docs/users-guide/01-getting-started.md) for GPU configuration and details.
>
> **GPU / CUDA**: CUDA binary download is skipped by default (CPU fallback). For GPU acceleration setup, see [Troubleshooting: CUDA Detection](docs/users-guide/04-troubleshooting.md#onnxruntime-cuda-detection).
>
> **pnpm "Ignored build scripts"**: On `pnpm install`, pnpm 10 prints `Ignored build scripts: @prisma/client, esbuild, sharp, ...` and suggests `Run "pnpm approve-builds"`. This is expected, not an error — pnpm 10 blocks dependency build/lifecycle scripts by default as a supply-chain safeguard. Setup still completes because `sharp` and `esbuild` ship prebuilt binaries, and the Prisma client is generated by the `@reftrixmcp/database` workspace package's own `postinstall` (`prisma generate`) during `pnpm install` — a workspace lifecycle script, which pnpm does not gate behind the dependency build-script allowlist. Only run `pnpm approve-builds` if you have a specific reason to let one of these blocked dependencies run its own native build step (`onnxruntime-node` is already allow-listed via `pnpm.onlyBuiltDependencies`, so it never appears in the ignored list; and CUDA acceleration is a separate opt-in — see the GPU / CUDA note above — not `pnpm approve-builds`).

### Connect to Claude

Add to your MCP config:

- **Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
- **MCP Client CLI**: `.mcp.json` in the project root or `~/.claude/.mcp.json`

```json
{
  "mcpServers": {
    "reftrix": {
      "command": "node",
      "args": ["/absolute/path/to/ReftrixMCP/apps/mcp-server/dist/index.js"],
      "env": {
        "NODE_ENV": "development",
        "DATABASE_URL": "postgresql://reftrix:change_me@localhost:26432/reftrix?schema=public",
        "REDIS_URL": "redis://localhost:27379",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "OLLAMA_HOST": "http://localhost:11434",
        "ENABLE_SECTION_SCREENSHOT_FALLBACK": "true"
      }
    }
  }
}
```

> Replace `change_me` with a secure password. Port 26432 = standard 5432 + 21000 offset.
>
> `OLLAMA_BASE_URL` is used by the MCP server process; `OLLAMA_HOST` is used by the worker process. Both must match if Ollama runs on a non-default port.
>
> `ENABLE_SECTION_SCREENSHOT_FALLBACK` enables Playwright-based individual section screenshots for sections outside the initial screenshot range (WebGL/lazy-rendered pages). This significantly improves DINOv2 visual embedding coverage. Set to `"false"` to disable.
>
> **Optional environment variables** (defaults work out of the box):
> `MAX_TILES_PER_SECTION` (default 20, max 100) -- max tiles per section for multi-tile capture.
> `BLANK_IMAGE_STDDEV_THRESHOLD` (default 5.0) -- stddev threshold for blank image detection.
> `DUPLICATE_VECTOR_THRESHOLD` (default 0.995) -- cosine similarity threshold for vision embedding dedup.
> `EMBEDDING_IDLE_TIMEOUT_MS` (default 30000) -- ONNX Worker VRAM auto-release timer (0 to disable).
> `DINOV2_MODEL_PATH` -- custom DINOv2 ViT-B/14 ONNX model path.
> `EMBEDDING_CACHE_ENABLED` (default true) -- enable/disable the Layout Embedding disk cache (additive opt-out flag; set `"false"` to write no cache files).
> `REFTRIX_EMBEDDING_CACHE_ROOT` (default `/tmp/reftrix-embedding-cache`) -- embedding cache root; a root resolving outside `os.tmpdir()` is rejected by default (fail-closed). Set `REFTRIX_EMBEDDING_CACHE_ROOT_ALLOW_FALLBACK=true` to instead degrade to the default root with a warning.

## Example tools

ReftrixMCP provides **<!-- gen:tool-count -->40<!-- /gen:tool-count --> MCP tools**. Key examples:

- `layout.ingest` -- fetch a web page, take a screenshot, and extract section patterns
- `layout.search` -- semantic search over layout sections by natural-language query
- `motion.detect` -- detect CSS/JS animations with video-mode frame capture
- `quality.evaluate` -- score design quality on originality, craftsmanship, and contextuality
- `page.analyze` -- unified analysis: layout + motion + quality + responsive in one call (async via BullMQ), with opt-in Phase 7.5: accessibility audit, performance evaluation, and auto snapshot
- `responsive.search` -- search responsive analysis results by viewport and breakpoint
- `preference.hear` -- interactive preference hearing sessions with sample presentation and feedback collection
- `preference.get` -- retrieve preference profiles (with GDPR data portability support)
- `preference.reset` -- reset or permanently delete preference profiles (GDPR Right to Erasure)
- `part.search` -- semantic search over UI parts with visual (DINOv2) or text embeddings
- `part.inspect` -- get detailed part info including computed styles, bounding box, and accessibility
- `part.compare` -- compare 2-5 parts side by side on styles, layout, and interaction

Full tool reference: [MCP Tools Guide](docs/users-guide/02-mcp-tools-guide.md)

## Architecture

```
MCP Client (Claude Desktop / Code)  --stdio-->  MCP Server (<!-- gen:tool-count -->40<!-- /gen:tool-count --> tools, Zod)
  +-- Service Layer: Playwright, Sharp+Pixelmatch, DOMPurify
  +-- ML Layer: ONNX Runtime (multilingual-e5-base + DINOv2 ViT-B/14, 768-dim)
  +-- BullMQ Workers: page.analyze, quality.evaluate
  +-- PostgreSQL 18 + pgvector 0.8 (HNSW, tsvector)  +  Redis 7
```

## Documentation

| Guide                                                                   | Description                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [Getting Started](docs/users-guide/01-getting-started.md)               | Installation, setup, and first analysis                                         |
| [MCP Tools Guide](docs/users-guide/02-mcp-tools-guide.md)               | All <!-- gen:tool-count -->40<!-- /gen:tool-count --> tools with usage examples |
| [page.analyze Deep Dive](docs/users-guide/03-page-analyze-deep-dive.md) | Async analysis flow and data structures                                         |
| [Troubleshooting](docs/users-guide/04-troubleshooting.md)               | Common issues and solutions                                                     |

## Known limitations

- `onnxruntime-node` is an optional dependency that `pnpm install` installs by default (it powers the ML features — embedding and visual search). If it fails to install on an unsupported platform, or you skip it with `pnpm install --no-optional`, the non-ML tools (layout analysis, quality evaluation, code generation) still work
- CPU-mode embedding takes ~2-5 s per text; GPU recommended for batch workloads
- Minimum 16 GB RAM; 32 GB recommended for concurrent analysis with Ollama Vision
- First embedding call downloads ~1.1 GB ONNX model (multilingual-e5-base, FP32) into the transformers.js cache. Verify integrity at any time with `pnpm --filter @reftrixmcp/ml repair:e5-cache --check`; pass `--repair` to re-download on size/SHA-256 mismatch, or `--force` to always re-download
- `page.analyze` workers are auto-forked by `WorkerSupervisor` when the MCP server starts (v0.4.0 PR7d-2+); manual start is developer-only (`REFTRIX_ALLOW_MANUAL_WORKER=true` required when MCP server is running)
- Vision analysis (layout, motion, narrative) requires Ollama + `llama3.2-vision` running locally
- DINOv2 visual embedding model requires ~330 MB download (ViT-B/14 ONNX)

## Release notes / リリースノート

- **Plan v4.4 PR-N (2026-05-17)**: `WorkerSupervisorOptions.restartDelayMs` field formal removal + env-only canonical SSOT consolidation per ADR-0035 Amendment 1 §Decision 5. The `WORKER_RESTART_DELAY_MS` and `EMBEDDING_BACKFILL_RESTART_DELAY_MS` environment variables are now the sole source of truth for per-type restart cooldown values; resolution is performed via `getRestartDelayMsForType(workerType)`. Server version bumped to 0.6.0. / `WorkerSupervisorOptions.restartDelayMs` フィールドを正式削除し、ADR-0035 Amendment 1 §Decision 5 に従い env-only canonical SSOT へ一元化。`WORKER_RESTART_DELAY_MS` と `EMBEDDING_BACKFILL_RESTART_DELAY_MS` 環境変数が per-type restart cooldown 値の唯一の真実源となり、`getRestartDelayMsForType(workerType)` 経由で解決される。サーバーバージョンを 0.6.0 に bump。

## License

AGPL-3.0-only -- see [LICENSE](LICENSE).

Network use requires source disclosure per [Section 13](https://www.gnu.org/licenses/agpl-3.0.html#section13).
Source: [github.com/TKMD/ReftrixMCP](https://github.com/TKMD/ReftrixMCP)
Commercial license: [licence@reftrix.io](mailto:licence@reftrix.io)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Report vulnerabilities per [SECURITY.md](SECURITY.md).
Privacy: [docs/legal/PRIVACY_POLICY.md](docs/legal/PRIVACY_POLICY.md) | Profiling privacy: [apps/mcp-server/PRIVACY.md](apps/mcp-server/PRIVACY.md) | Data retention: [apps/mcp-server/DATA_RETENTION.md](apps/mcp-server/DATA_RETENTION.md) | Third-party licenses: [THIRDPARTY_LICENSES.md](THIRDPARTY_LICENSES.md)
