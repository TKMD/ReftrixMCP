# Reftrix AI/MLモデル ライセンスガイド / AI/ML Model License Guide

**バージョン / Version**: 0.1.0
**法的調査日 / Legal Research Date**: 2026-02-23
**対象プロジェクト / Project**: Reftrix (AGPL-3.0-only + Commercial Dual License)

---

## 目次 / Table of Contents

1. [概要 / Overview](#1-概要--overview)
2. [モデル一覧 / Model Summary](#2-モデル一覧--model-summary)
3. [Llama 3.2 Vision -- EU地域制限 / EU Regional Restriction](#3-llama-32-vision----eu地域制限--eu-regional-restriction)
4. [multilingual-e5-base](#4-multilingual-e5-base)
5. [ONNX Runtime](#5-onnx-runtime)
6. [リスク軽減措置 / Risk Mitigation](#6-リスク軽減措置--risk-mitigation)
7. [免責事項 / Disclaimer](#7-免責事項--disclaimer)

---

## 1. 概要 / Overview

### 日本語

Reftrixは、Webデザインの構造化ナレッジ管理プラットフォームとして、以下のAI/MLモデルをオプション機能として使用しています。これらのモデルはReftrixのコアバイナリにバンドルされておらず、ユーザーが個別にセットアップする外部依存です。

**重要**: すべてのAI/MLモデルの使用はオプションです。Reftrixの基本機能（レイアウト解析、HTML/CSS構造分析）はAI/MLモデルなしでも動作します。Vision LLMによるスクリーンショット分析（Scroll Vision Analysis）は、対応モデルが利用可能な場合のみ実行されます。

### English

Reftrix uses the following AI/ML models as optional features in its web design structured knowledge management platform. These models are NOT bundled with Reftrix's core binaries -- they are external dependencies that users set up independently.

**Important**: All AI/ML model usage is optional. Reftrix's core features (layout analysis, HTML/CSS structure analysis) work without any AI/ML models. Vision LLM-based screenshot analysis (Scroll Vision Analysis) runs only when a compatible model is available.

---

## 2. モデル一覧 / Model Summary

| モデル / Model | 用途 / Usage | ライセンス / License | 地域制限 / Regional Restriction | 必須 / Required |
|---|---|---|---|---|
| **Llama 3.2 Vision** (11B) | Scroll Vision Analysis (Phase 2.5) | Llama 3.2 Community License | **EU域内制限あり / EU Restricted** | いいえ / No |
| **multilingual-e5-base** | Embedding生成 (768次元) | MIT License | なし / None | はい / Yes |
| **ONNX Runtime** | ML推論エンジン | MIT License | なし / None | はい / Yes |

---

## 3. Llama 3.2 Vision -- EU地域制限 / EU Regional Restriction

### 3.1 使用箇所 / Usage in Reftrix

#### 日本語

Llama 3.2 Vision（11Bパラメータ）は、ReftrixのScroll Vision Analysis機能（パイプライン Phase 2.5）で使用されます。この機能は、Webページのスクロール中に撮影したスクリーンショットをVision LLMで分析し、ビジュアルデザインパターン（視覚的階層、色使い、タイポグラフィ、スペーシング等）を検出します。

- **接続方式**: Ollama（ローカルLLMサーバー）経由のHTTP API
- **環境変数**: `OLLAMA_BASE_URL`（デフォルト: `http://localhost:11434`）
- **モデル指定**: `llama3.2-vision`（Ollamaモデル名。タグ省略時はOllamaのデフォルトタグ `:latest` が使用されます）
- **Reftrixはモデルをバンドルしていません**: ユーザーがOllamaを通じて自身でモデルをダウンロード・セットアップする必要があります

#### English

Llama 3.2 Vision (11B parameters) is used in Reftrix's Scroll Vision Analysis feature (pipeline Phase 2.5). This feature analyzes screenshots taken during web page scrolling using a Vision LLM, detecting visual design patterns (visual hierarchy, color usage, typography, spacing, etc.).

- **Connection**: Via Ollama (local LLM server) HTTP API
- **Environment variable**: `OLLAMA_BASE_URL` (default: `http://localhost:11434`)
- **Model identifier**: `llama3.2-vision` (Ollama model name; when the tag is omitted, Ollama uses the default `:latest` tag)
- **Reftrix does NOT bundle the model**: Users must download and set up the model themselves through Ollama

### 3.2 ライセンス / License

#### 日本語

Llama 3.2 Visionは、**Llama 3.2 Community License Agreement**（Meta Platforms, Inc.独自ライセンス）の下で提供されています。これはOpen Source Initiative（OSI）が承認するオープンソースライセンスではなく、Meta社の独自商用ライセンスです。

**主要条件**:
- 商用利用: 許可（条件付き）
- 月間アクティブユーザー（MAU）制限: 月間7億MAUを超える製品・サービスの場合、Metaへの個別ライセンス申請が必要
- 帰属表示義務: 「Built with Llama」の目立つ表示が必要
- 再配布: 許可（ライセンス契約のコピーの同封が必要）
- 派生モデル: モデル名の先頭に「Llama」を含める必要あり

**ライセンス全文**: https://www.llama.com/llama3_2/license/
**利用ポリシー**: https://www.llama.com/llama3_2/use-policy/

#### English

Llama 3.2 Vision is provided under the **Llama 3.2 Community License Agreement**, a proprietary license by Meta Platforms, Inc. This is NOT an Open Source Initiative (OSI)-approved open-source license.

**Key terms**:
- Commercial use: Permitted (with conditions)
- Monthly Active Users (MAU) limit: Products/services exceeding 700 million MAU require a separate license from Meta
- Attribution obligation: Must prominently display "Built with Llama"
- Redistribution: Permitted (must include a copy of the license agreement)
- Derivative models: Must include "Llama" at the beginning of model name

**Full license text**: https://www.llama.com/llama3_2/license/
**Acceptable Use Policy**: https://www.llama.com/llama3_2/use-policy/

### 3.3 EU地域制限（重要） / EU Regional Restriction (IMPORTANT)

#### 日本語

**Llama 3.2 Community License Agreement の Acceptable Use Policy には、以下の条項が含まれています**:

> "With respect to any multimodal models included in Llama 3.2, the rights granted under Section 1(a) of the Llama 3.2 Community License Agreement are not being granted to you if you are an individual domiciled in, or a company with a principal place of business in, the European Union."

**これは以下を意味します**:

| 対象 | 制限の適用 |
|------|-----------|
| EU域内に住所を有する**個人** | ライセンス権が付与されない |
| EU域内に主たる事業所を有する**法人** | ライセンス権が付与されない |
| Llama 3.2 **テキストのみ**モデル（1B, 3B） | **制限なし**（マルチモーダルモデルではないため） |
| Llama 3.2 **Vision**モデル（11B, 90B） | **制限あり**（マルチモーダルモデルに該当） |
| マルチモーダルモデルを組み込んだ製品・サービスの**エンドユーザー** | **制限なし**（エンドユーザー例外の適用） |
| EU域外に主たる事業所を有する法人がEU域内に提供するサービス | **制限なし**（標準的なグローバル配布として許容） |

**制限の理由**: Meta社は、EU域内におけるGDPR（一般データ保護規則）への準拠状況やEU AI Act（EU人工知能法）等の規制不確実性を理由として、マルチモーダルモデルのEU域内でのライセンス付与を見合わせています。

**2026年2月時点の最新状況**: この制限は依然として有効です。EU AI Actの完全施行（2026年8月2日予定）後にMeta社が方針を変更する可能性がありますが、現時点で制限解除の公式発表はありません。また、Llama 4（2025年4月リリース）においても、全モデルがマルチモーダルであるためEU域内制限が同様に適用されています。

#### English

**The Llama 3.2 Community License Agreement's Acceptable Use Policy contains the following clause**:

> "With respect to any multimodal models included in Llama 3.2, the rights granted under Section 1(a) of the Llama 3.2 Community License Agreement are not being granted to you if you are an individual domiciled in, or a company with a principal place of business in, the European Union."

**This means**:

| Subject | Restriction Applies |
|---------|---------------------|
| **Individuals** domiciled in the EU | License rights NOT granted |
| **Companies** with principal place of business in the EU | License rights NOT granted |
| Llama 3.2 **text-only** models (1B, 3B) | **No restriction** (not multimodal) |
| Llama 3.2 **Vision** models (11B, 90B) | **Restricted** (classified as multimodal) |
| **End users** of products/services incorporating multimodal models | **No restriction** (end-user exception) |
| Non-EU companies distributing services to EU customers | **No restriction** (permitted under standard global distribution) |

**Reason for restriction**: Meta cites regulatory uncertainty around GDPR compliance and the EU AI Act as the reason for withholding multimodal model licenses in the EU.

**Status as of February 2026**: This restriction remains in effect. While Meta may revise its policy after the full implementation of the EU AI Act (scheduled for August 2, 2026), no official announcement of lifting the restriction has been made. Llama 4 (released April 2025) applies the same EU restriction to all models, as all Llama 4 models are multimodal.

### 3.4 EU域内ユーザーへの影響 / Impact on EU-Based Users

#### 日本語

**EU域内に所在するReftrixユーザーへ**:

1. **Llama 3.2 Visionをダウンロード・使用する権利がライセンス上付与されていません**。Ollama経由でのダウンロードであっても、Llama 3.2 Community Licenseの制限は適用されます。

2. **ReftrixのScroll Vision Analysis機能は、Llama 3.2 Visionなしでも動作に影響しません**。この機能はオプションであり、Vision LLMが利用不可の場合、当該フェーズ（Phase 2.5）は自動的にスキップされます。

3. **代替のVision LLMを使用することを強く推奨します**。以下のセクション（3.5）で代替モデルを紹介しています。

4. **「エンドユーザー例外」の解釈について**: Llama 3.2 Community Licenseは「マルチモーダルモデルを組み込んだ製品・サービスのエンドユーザーには制限が適用されない」と定めています。ただし、Reftrixのアーキテクチャでは、ユーザーが自身でOllamaを通じてモデルをダウンロード・ホストするため、この場合のユーザーは「エンドユーザー」ではなく「直接のライセンシー」と解釈される可能性が高いです。

#### English

**For Reftrix users based in the EU**:

1. **You are NOT granted a license to download or use Llama 3.2 Vision**. The Llama 3.2 Community License restriction applies even when downloading via Ollama.

2. **Reftrix's Scroll Vision Analysis feature works fine without Llama 3.2 Vision**. This feature is optional; when no Vision LLM is available, the corresponding phase (Phase 2.5) is automatically skipped.

3. **We strongly recommend using an alternative Vision LLM**. See section 3.5 below for alternatives.

4. **Regarding the "end-user exception"**: The Llama 3.2 Community License states that the restriction "does not apply to end users of a product or service that incorporates any such multimodal models." However, in Reftrix's architecture, users download and host the model themselves through Ollama, which likely makes them "direct licensees" rather than "end users" under this exception.

### 3.5 EU域内で使用可能な代替Vision LLM / Alternative Vision LLMs for EU Users

#### 日本語

以下のVision LLMはEU地域制限がなく、Ollama経由でReftrixと併用可能です。

| モデル | ライセンス | EU制限 | Ollama対応 | 備考 |
|-------|-----------|--------|-----------|------|
| **Qwen2.5-VL** (7B/32B) | Apache 2.0 | なし | あり (`ollama pull qwen2.5vl`) | Alibaba Cloud提供。高い多言語対応力。推奨代替 |
| **Qwen3-VL** (2B/8B) | Apache 2.0 | なし | あり (`ollama pull qwen3-vl`) | Qwenシリーズ最新。より高精度 |
| **Gemma 3** (4B/12B/27B) | Gemma Terms of Use | EU固有制限なし | あり (`ollama pull gemma3`) | Google DeepMind提供。地域制限の明示なし |
| **Mistral** (各種) | Apache 2.0 | なし | あり | 欧州企業Mistral AI提供。EUフレンドリー |
| **MiniCPM-V** | Apache 2.0 | なし | あり | 軽量Vision LLM |
| **Moondream** (2B) | Apache 2.0 | なし | あり (`ollama pull moondream`) | 非常に軽量、エッジデバイス向け |

**推奨**: EU域内のユーザーには、**Qwen2.5-VL** または **Qwen3-VL** を推奨します。Apache 2.0ライセンスにより地域制限がなく、多言語（日本語・英語を含む）での画像理解に優れています。

**環境変数での切り替え方法**:

Reftrixは、Ollamaで利用可能な任意のVision LLMモデルを使用するように設定可能です。使用するモデルの変更は、環境変数または設定ファイルで指定できます。

```bash
# .env.local での設定例
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_VISION_MODEL=qwen2.5vl:7b   # デフォルトの llama3.2-vision を上書き
```

**注意**: Gemma 3はGoogle独自の「Gemma Terms of Use」で提供されており、OSIの定義するオープンソースライセンスではありません。ただし、EU地域制限は明示的に含まれていません。各モデルのライセンス条件は、使用前に必ず確認してください。

#### English

The following Vision LLMs have no EU regional restrictions and can be used with Reftrix via Ollama:

| Model | License | EU Restriction | Ollama | Notes |
|-------|---------|----------------|--------|-------|
| **Qwen2.5-VL** (7B/32B) | Apache 2.0 | None | Yes (`ollama pull qwen2.5vl`) | By Alibaba Cloud. Strong multilingual support. Recommended |
| **Qwen3-VL** (2B/8B) | Apache 2.0 | None | Yes (`ollama pull qwen3-vl`) | Latest Qwen series. Higher accuracy |
| **Gemma 3** (4B/12B/27B) | Gemma Terms of Use | No explicit EU restriction | Yes (`ollama pull gemma3`) | By Google DeepMind |
| **Mistral** (various) | Apache 2.0 | None | Yes | By Mistral AI (EU-based company). EU-friendly |
| **MiniCPM-V** | Apache 2.0 | None | Yes | Lightweight Vision LLM |
| **Moondream** (2B) | Apache 2.0 | None | Yes (`ollama pull moondream`) | Very lightweight, edge-friendly |

**Recommendation**: For EU-based users, we recommend **Qwen2.5-VL** or **Qwen3-VL**. Their Apache 2.0 license has no regional restrictions, and they excel at multilingual (including Japanese and English) image understanding.

**Switching models via environment variables**:

Reftrix can be configured to use any Vision LLM model available through Ollama. The model can be changed via environment variables or configuration files:

```bash
# Example .env.local configuration
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_VISION_MODEL=qwen2.5vl:7b   # Override default llama3.2-vision
```

**Note**: Gemma 3 is provided under Google's proprietary "Gemma Terms of Use" and is not an OSI-approved open-source license. However, it does not contain explicit EU regional restrictions. Always review each model's license terms before use.

### 3.6 Ollamaを介した利用とライセンスの関係 / Ollama Usage and License Implications

#### 日本語

**Ollama経由でLlama 3.2 Visionを使用する場合でも、Llama 3.2 Community Licenseの条件はすべて適用されます。**

Ollamaはモデルのダウンロード・実行を簡便化するツールですが、ライセンスの仲介者ではありません。ユーザーがOllamaを通じてLlama 3.2 Visionをダウンロードする際、ユーザー自身がMeta社との間でLlama 3.2 Community Licenseを受諾する立場にあります。したがって:

- EU域内のユーザーがOllama経由でLlama 3.2 Visionをダウンロードした場合、ライセンス上の権利が付与されていないモデルを使用していることになります
- Reftrixプロジェクトは、ユーザーが使用するモデルのライセンス遵守について責任を負いません
- ユーザーは、使用するモデルのライセンス条件を自己の責任で確認・遵守する必要があります

#### English

**Using Llama 3.2 Vision through Ollama does NOT exempt you from the Llama 3.2 Community License terms.**

Ollama is a tool that simplifies model downloading and execution, but it is not a license intermediary. When users download Llama 3.2 Vision through Ollama, they are directly accepting the Llama 3.2 Community License from Meta. Therefore:

- EU-based users who download Llama 3.2 Vision via Ollama would be using a model for which they have not been granted license rights
- The Reftrix project is not responsible for users' compliance with the licenses of models they choose to use
- Users must verify and comply with the license terms of any models they use at their own responsibility

### 3.7 「Built with Llama」帰属表示 / "Built with Llama" Attribution

#### 日本語

Llama 3.2 Community Licenseは、Llamaモデルを使用する製品・サービスに「Built with Llama」の目立つ表示を求めています。

Reftrixは、Llama 3.2 Visionをオプション機能の外部依存として使用しており、モデル自体をバンドルしていません。ユーザーがLlama 3.2 Visionを使用する場合、Llamaライセンスの帰属表示義務はユーザー自身に適用されます。

Reftrixプロジェクトとしての帰属表示: Reftrixプロジェクトのドキュメントにおいて、Scroll Vision Analysis機能がLlama 3.2 Visionモデルをサポートしていることを明示しています。

> **Built with Llama** -- Reftrix's Scroll Vision Analysis feature supports Meta's Llama 3.2 Vision model as one of multiple compatible Vision LLMs.

#### English

The Llama 3.2 Community License requires prominent display of "Built with Llama" for products and services using Llama models.

Reftrix uses Llama 3.2 Vision as an optional external dependency and does not bundle the model itself. When users choose to use Llama 3.2 Vision, the Llama license attribution obligation applies to those users.

Reftrix project attribution: In Reftrix project documentation, we clearly state that the Scroll Vision Analysis feature supports the Llama 3.2 Vision model.

> **Built with Llama** -- Reftrix's Scroll Vision Analysis feature supports Meta's Llama 3.2 Vision model as one of multiple compatible Vision LLMs.

---

## 4. multilingual-e5-base

### 4.1 使用箇所 / Usage in Reftrix

#### 日本語

multilingual-e5-base（intfloat/multilingual-e5-base）は、ReftrixのEmbedding生成機能で使用されています。

- **用途**: テキストおよびHTML構造データの768次元ベクトル表現への変換
- **適用箇所**: Section Embedding、Motion Embedding、Background Embedding、JS Animation Embedding
- **実行環境**: ONNX Runtime経由でローカル実行
- **特記事項**: e5モデルはプレフィックス必須（クエリ時: `query:`, ドキュメント格納時: `passage:`）

#### English

multilingual-e5-base (intfloat/multilingual-e5-base) is used in Reftrix's embedding generation features.

- **Usage**: Converting text and HTML structure data to 768-dimensional vector representations
- **Applied to**: Section Embedding, Motion Embedding, Background Embedding, JS Animation Embedding
- **Runtime**: Executed locally via ONNX Runtime
- **Note**: e5 models require prefixes (`query:` for queries, `passage:` for document storage)

### 4.2 ライセンス / License

| 項目 / Item | 内容 / Details |
|---|---|
| ライセンス / License | **MIT License** |
| 提供元 / Provider | Microsoft Research (intfloat) |
| 商用利用 / Commercial use | 許可 / Permitted |
| 改変・再配布 / Modification & redistribution | 許可 / Permitted |
| 地域制限 / Regional restriction | **なし / None** |
| AGPL-3.0との互換性 / AGPL-3.0 compatibility | **互換 / Compatible** |

**出典 / Source**: https://huggingface.co/intfloat/multilingual-e5-base

---

## 5. ONNX Runtime

### 5.1 使用箇所 / Usage in Reftrix

#### 日本語

ONNX Runtime（Microsoft）は、ReftrixのML推論エンジンとして使用されています。multilingual-e5-baseモデルの推論を実行し、Embedding生成を行います。

- **バージョン**: 1.21.x
- **実行モード**: CPU（デフォルト）、CUDA/ROCm（オプション、`ONNX_EXECUTION_PROVIDER`環境変数で指定）
- **Worker Thread**: Node.js Worker Threadsで別スレッド実行（メインスレッドのイベントループ保護）

#### English

ONNX Runtime (Microsoft) is used as the ML inference engine in Reftrix. It runs inference on the multilingual-e5-base model for embedding generation.

- **Version**: 1.21.x
- **Execution mode**: CPU (default), CUDA/ROCm (optional, via `ONNX_EXECUTION_PROVIDER` environment variable)
- **Worker Thread**: Runs in a separate thread via Node.js Worker Threads (protecting the main thread event loop)

### 5.2 ライセンス / License

| 項目 / Item | 内容 / Details |
|---|---|
| ライセンス / License | **MIT License** |
| 提供元 / Provider | Microsoft |
| 商用利用 / Commercial use | 許可 / Permitted |
| 改変・再配布 / Modification & redistribution | 許可 / Permitted |
| 地域制限 / Regional restriction | **なし / None** |
| AGPL-3.0との互換性 / AGPL-3.0 compatibility | **互換 / Compatible** |

---

## 6. リスク軽減措置 / Risk Mitigation

### 6.1 Scroll Vision Analysisの無効化 / Disabling Scroll Vision Analysis

#### 日本語

Scroll Vision Analysis（Phase 2.5）は、以下の方法で無効化できます:

1. **Ollamaを起動しない**: Ollamaサーバーが起動していなければ、Scroll Vision Analysisは自動的にスキップされます
2. **環境変数による無効化**: `.env.local`でVisionモデルの使用を無効にできます

```bash
# .env.local
# Ollama接続先を未設定にすることで、Vision分析をスキップ
# OLLAMA_BASE_URL=  (コメントアウトまたは削除)
```

Vision分析なしでも、以下の機能は正常に動作します:
- Layout Analysis（HTML/CSS構造解析）
- Motion Detection（CSSアニメーション検出）
- Quality Evaluation（デザイン品質評価）
- Embedding Generation（multilingual-e5-baseによるベクトル生成）

#### English

Scroll Vision Analysis (Phase 2.5) can be disabled in the following ways:

1. **Do not start Ollama**: If the Ollama server is not running, Scroll Vision Analysis is automatically skipped
2. **Environment variable**: Disable Vision model usage in `.env.local`

```bash
# .env.local
# Skip Vision analysis by not setting Ollama URL
# OLLAMA_BASE_URL=  (comment out or remove)
```

Without Vision analysis, the following features work normally:
- Layout Analysis (HTML/CSS structure analysis)
- Motion Detection (CSS animation detection)
- Quality Evaluation (design quality evaluation)
- Embedding Generation (vector generation via multilingual-e5-base)

### 6.2 代替Vision LLMへの切り替え / Switching to Alternative Vision LLMs

#### 日本語

EU域内のユーザー、またはLlama 3.2 Community Licenseの条件に同意しないユーザーは、以下の手順で代替Vision LLMに切り替えることができます:

```bash
# 1. 代替モデルをOllamaでダウンロード
ollama pull qwen2.5vl:7b

# 2. .env.local でモデルを指定
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_VISION_MODEL=qwen2.5vl:7b
```

#### English

EU-based users, or users who do not agree to the Llama 3.2 Community License terms, can switch to an alternative Vision LLM:

```bash
# 1. Download an alternative model via Ollama
ollama pull qwen2.5vl:7b

# 2. Specify the model in .env.local
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_VISION_MODEL=qwen2.5vl:7b
```

### 6.3 EU域内ユーザー向け推奨設定 / Recommended Configuration for EU Users

#### 日本語

EU域内のユーザーには以下の設定を推奨します:

```bash
# .env.local（EU域内ユーザー推奨設定）

# Ollamaの設定
OLLAMA_BASE_URL=http://localhost:11434

# EU制限のないVision LLMを使用
OLLAMA_VISION_MODEL=qwen2.5vl:7b    # Apache 2.0, EU制限なし

# ONNX Runtime（制限なし、デフォルト設定で可）
# ONNX_EXECUTION_PROVIDER=cpu        # デフォルト
```

**チェックリスト**:
- [ ] Llama 3.2 Visionを使用していないことを確認
- [ ] 代替Vision LLM（Qwen2.5-VL等）をインストール済み
- [ ] `OLLAMA_VISION_MODEL`環境変数が正しく設定されていることを確認

#### English

We recommend the following configuration for EU-based users:

```bash
# .env.local (Recommended for EU users)

# Ollama configuration
OLLAMA_BASE_URL=http://localhost:11434

# Use a Vision LLM without EU restrictions
OLLAMA_VISION_MODEL=qwen2.5vl:7b    # Apache 2.0, No EU restriction

# ONNX Runtime (no restrictions, default settings are fine)
# ONNX_EXECUTION_PROVIDER=cpu        # default
```

**Checklist**:
- [ ] Confirm you are NOT using Llama 3.2 Vision
- [ ] Install an alternative Vision LLM (e.g., Qwen2.5-VL)
- [ ] Verify `OLLAMA_VISION_MODEL` environment variable is correctly set

---

## 7. 免責事項 / Disclaimer

---

**免責事項 / Disclaimer**

本文書は一般的な法的情報の提供を目的としており、特定の事案に対する法的助言を構成するものではありません。
各モデルのライセンス条件は変更される可能性があります。ユーザーは使用前に各モデルの最新のライセンス条件を直接確認してください。
具体的な法的判断が必要な場合は、資格を有する弁護士にご相談ください。

This document is provided for general informational purposes only and does not constitute legal advice
for any specific situation. License terms for each model may change over time. Users should verify
the latest license terms directly with each model provider before use.
Please consult a qualified attorney for specific legal decisions.

法的調査日 / Legal Research Date: 2026-02-23

---

## 参考文献 / References

### ライセンス文書 / License Documents

- Llama 3.2 Community License Agreement: https://www.llama.com/llama3_2/license/
- Llama 3.2 Acceptable Use Policy: https://www.llama.com/llama3_2/use-policy/
- Llama FAQ: https://www.llama.com/faq/
- multilingual-e5-base (MIT License): https://huggingface.co/intfloat/multilingual-e5-base
- ONNX Runtime (MIT License): https://github.com/microsoft/onnxruntime

### 分析・解説記事 / Analysis & Commentary

- Sara Zan, "Using Llama Models in the EU" (2025-05-16): https://www.zansara.dev/posts/2025-05-16-llama-eu-ban/
- Thomas Pasberg, "Why does Meta restrict the usage of Llama3.2 in the EU?": https://medium.com/@thomas-pasberg/why-does-meta-restrict-the-usage-of-llama3-2-in-the-eu-4079946abb07
- Slator, "Meta Rolls Out Multimodal Llama 3.2 -- But Not in Europe": https://slator.com/meta-rolls-out-multimodal-llama-3-2-but-not-in-europe/
- ioplus, "European Union excluded from Llama 4 multimodal models": https://ioplus.nl/en/posts/european-union-excluded-from-llama-4-multimodal-models

### HuggingFace Discussions

- meta-llama/Llama-3.2-11B-Vision Discussion #22 - "Why EXACTLY this model is not available in Europe?": https://huggingface.co/meta-llama/Llama-3.2-11B-Vision/discussions/22
- meta-llama/Llama-3.2-11B-Vision-Instruct Discussion #28 - "Request for Compliance with EU Regulations": https://huggingface.co/meta-llama/Llama-3.2-11B-Vision-Instruct/discussions/28

### 規制・法令 / Regulations

- EU AI Act (Regulation (EU) 2024/1689): https://artificialintelligenceact.eu/
- GDPR (Regulation (EU) 2016/679): https://eur-lex.europa.eu/eli/reg/2016/679/oj

### 代替モデル / Alternative Models

- Qwen2.5-VL (Apache 2.0): https://ollama.com/library/qwen2.5vl
- Qwen3-VL (Apache 2.0): https://ollama.com/library/qwen3-vl
- Gemma 3 (Gemma Terms of Use): https://ollama.com/library/gemma3
- Moondream (Apache 2.0): https://ollama.com/library/moondream

---

*Reftrix AI Model License Guide v0.1.0*
*Prepared by: Legal Compliance Counsel (AI-assisted analysis)*
*法的調査日 / Legal Research Date: 2026-02-23*
