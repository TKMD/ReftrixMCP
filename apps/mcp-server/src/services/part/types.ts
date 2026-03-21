// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part type definitions for Part-Level Analysis
 *
 * パーツ単位分析の型定義。v0.2.1仕様に基づくコア16タイプ、
 * 将来拡張タイプ、パーツ抽出設定、検出ヒューリスティクスを定義。
 *
 * Part type definitions for Part-Level Analysis. Defines core 16 types,
 * future extension types, extraction config, and detection heuristics
 * based on v0.2.1 specification.
 *
 * @module services/part/types
 */

// ============================================================================
// Part Type Constants / パーツタイプ定数
// ============================================================================

/**
 * コア16タイプ (v0.2.0)
 * Core 16 types (v0.2.0)
 *
 * Prismaスキーマコメントの22種のうち、抽出品質が検証済みの16種。
 * Of the 22 types in the Prisma schema comments, 16 types with validated extraction quality.
 */
export const ALL_PART_TYPES = [
  "button",
  "link",
  "image",
  "video",
  "form",
  "input",
  "heading",
  "card",
  "navigation",
  "footer",
  "cta",
  "hero_image",
  "icon",
  "badge",
  "tag",
  "avatar",
] as const;

/**
 * 将来拡張タイプ（まだALL_PART_TYPESに含まない）
 * Future extension types (not yet in ALL_PART_TYPES)
 *
 * ARIA roleヒューリスティクスにのみ定義され、
 * 抽出品質の検証後にALL_PART_TYPESへ昇格する。
 *
 * Defined only in ARIA role heuristics;
 * will be promoted to ALL_PART_TYPES when extraction quality is validated.
 */
export const FUTURE_PART_TYPES = [
  "carousel",
  "accordion",
  "tab",
  "modal",
  "tooltip",
  "dropdown",
] as const;

// ============================================================================
// Part Type Unions / パーツタイプ型
// ============================================================================

/** コア16パーツタイプ / Core 16 part types */
export type PartType = (typeof ALL_PART_TYPES)[number];

/** 将来拡張パーツタイプ / Future extension part types */
export type FuturePartType = (typeof FUTURE_PART_TYPES)[number];

/** 全パーツタイプ（コア + 将来拡張） / All part types (core + future) */
export type AllPartType = PartType | FuturePartType;

// ============================================================================
// PII Risk / PIIリスク
// ============================================================================

/**
 * PIIリスクレベル分類
 * PII risk level classification
 *
 * - 'none': 一般的なUIパーツ / General UI parts
 * - 'low': ユーザーデータフィールドを含むフォーム/入力 / Forms/inputs with user data fields
 * - 'high': アバタータイプ → CSSプロパティのみ保存、画像バッファ保存禁止 / Avatar type → CSS only, no image buffer
 */
export type PiiRiskLevel = "none" | "low" | "high";

// ============================================================================
// Core Interfaces / コアインターフェース
// ============================================================================

/**
 * バウンディングボックス（セクション相対座標）
 * Bounding box (relative to section)
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * インタラクション情報
 * Interaction information
 *
 * ホバー、フォーカス、アクティブ、トランジションの有無を記録。
 * Records presence of hover, focus, active states, and transitions.
 */
export interface InteractionInfo {
  hasHover: boolean;
  hasFocus: boolean;
  hasActive: boolean;
  hasTransition: boolean;
  transitionDuration?: string;
}

// ============================================================================
// Extraction Config / 抽出設定
// ============================================================================

/**
 * パーツ抽出設定
 * Part extraction configuration
 *
 * Phase 1.1のパーツ抽出パイプラインで使用する設定。
 * メモリ制限・タイムアウト・サンプリング上限を含む。
 *
 * Configuration used by the Phase 1.1 part extraction pipeline.
 * Includes memory limits, timeout, and sampling caps.
 */
export interface PartExtractionConfig {
  /** パーツ抽出の有効/無効 / Enable/disable part extraction */
  enabled: boolean;
  /** タイプ別最大パーツ数 / Max parts per type per section */
  maxPartsPerType: number;
  /** 最小パーツサイズ（px、幅または高さ） / Min part size (px, width or height) */
  minPartSize: number;
  /** クロップサイズ（DINOv2入力サイズ） / Crop size (DINOv2 input size) */
  cropSize: number;
  /** 抽出対象パーツタイプ / Part types to extract */
  partTypes: PartType[];
  /** RSSメモリ制限（バイト）。超過時はPhase 1.1をスキップ / RSS memory limit (bytes). Skip Phase 1.1 if exceeded */
  rssLimitBytes: number;
  /** 独立タイムアウト（ミリ秒） / Independent timeout (milliseconds) */
  timeoutMs: number;
}

/**
 * デフォルトパーツ抽出設定
 * Default part extraction configuration
 */
export const DEFAULT_PART_EXTRACTION_CONFIG: PartExtractionConfig = {
  enabled: true,
  maxPartsPerType: 5,
  minPartSize: 20,
  cropSize: 224,
  partTypes: [...ALL_PART_TYPES],
  rssLimitBytes: 8 * 1024 * 1024 * 1024, // 8GB
  timeoutMs: 30_000, // 30s
};

// ============================================================================
// Extraction Result / 抽出結果
// ============================================================================

/**
 * 抽出済みパーツ
 * Extracted part
 *
 * Phase 1.1で抽出された個別UIパーツの完全な情報。
 * DB保存前の中間表現として使用。
 *
 * Complete information for an individual UI part extracted in Phase 1.1.
 * Used as intermediate representation before DB persistence.
 */
export interface ExtractedPart {
  /** パーツタイプ / Part type */
  partType: PartType;
  /** パーツサブタイプ（例: primary_button, icon_button） / Part subtype (e.g., primary_button, icon_button) */
  partSubtype: string | null;
  /** DOMPurifyサニタイズ済みHTMLスニペット / DOMPurify-sanitized HTML snippet */
  htmlSnippet: string | null;
  /** 計算済みスタイル / Computed styles */
  computedStyles: Record<string, string>;
  /** セクション相対バウンディングボックス / Section-relative bounding box */
  boundingBox: BoundingBox;
  /** CSSクラスリスト / CSS class list */
  cssClasses: string[];
  /** HTML属性（PIIマスク済み） / HTML attributes (PII-masked) */
  attributes: Record<string, string>;
  /** インタラクション情報 / Interaction information */
  interactionInfo: InteractionInfo;
  /** ビジュアルシグネチャ（SHA-256、重複排除用） / Visual signature (SHA-256, for dedup) */
  visualSignature: string | null;
  /** 同一セクション内のpartType別インデックス (0-4) / Per-partType index within section (0-4) */
  sampleIndex: number;
  /** PIIリスクレベル / PII risk level */
  piiRiskLevel: PiiRiskLevel;
  /** タグ / Tags */
  tags: string[];
  /** メタデータ / Metadata */
  metadata: Record<string, unknown>;
  /** ソースURL（web_pages.urlからコピー、フェッチには使用しない） / Source URL (copied from web_pages.url, not used for fetching) */
  sourceUrl: string | null;
  /** 利用範囲（inspiration_onlyのみ） / Usage scope (inspiration_only only) */
  usageScope: "inspiration_only";
  /** クロップ済み画像バッファ（piiRiskLevel='high'の場合はnull） / Cropped image buffer (null for piiRiskLevel='high') */
  cropBuffer: Buffer | null;
}

/**
 * パーツ抽出結果
 * Part extraction result
 *
 * Phase 1.1の実行結果。抽出パーツ一覧とスキップ情報を含む。
 * Phase 1.1 execution result. Contains extracted parts and skip information.
 */
export interface PartExtractionResult {
  /** 抽出されたパーツ一覧 / List of extracted parts */
  parts: ExtractedPart[];
  /** スキップされたパーツ数 / Number of skipped parts */
  skippedCount: number;
  /** スキップ理由 / Skip reason */
  skipReason?: "memory_pressure" | "timeout" | "disabled";
  /** 抽出処理時間（ミリ秒） / Extraction duration (milliseconds) */
  durationMs: number;
}

// ============================================================================
// Detection Heuristics / 検出ヒューリスティクス
// ============================================================================

/**
 * HTMLタグからパーツタイプへのマッピング（一次検出）
 * HTML tag to part type mapping (primary detection)
 */
export const TAG_TO_PART_TYPE: Record<string, PartType> = {
  button: "button",
  a: "link",
  img: "image",
  video: "video",
  form: "form",
  input: "input",
  select: "input",
  textarea: "input",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  nav: "navigation",
  footer: "footer",
  svg: "icon",
};

/**
 * CSSクラスパターンからパーツタイプへのマッピング（二次検出）
 * CSS class pattern to part type mapping (secondary detection)
 */
export const CLASS_PATTERNS: ReadonlyArray<{ pattern: RegExp; type: PartType }> = [
  { pattern: /\b(btn|button|cta)\b/i, type: "button" },
  { pattern: /\b(card|tile)\b/i, type: "card" },
  { pattern: /\b(badge|chip|tag|label)\b/i, type: "badge" },
  { pattern: /\b(avatar|profile-img)\b/i, type: "avatar" },
  { pattern: /\b(hero|banner)\b/i, type: "hero_image" },
  { pattern: /\b(nav|navbar|menu)\b/i, type: "navigation" },
];

/**
 * ARIAロールからパーツタイプへのマッピング（三次検出）
 * ARIA role to part type mapping (tertiary detection)
 *
 * コアタイプと将来拡張タイプの両方を含む。
 * 将来拡張タイプ（tab, modal, tooltip, dropdown）は
 * ALL_PART_TYPESへの昇格時に有効化される。
 *
 * Includes both core types and future extension types.
 * Future types (tab, modal, tooltip, dropdown) become
 * active when promoted to ALL_PART_TYPES.
 */
export const ROLE_TO_PART_TYPE: Record<string, string> = {
  button: "button",
  link: "link",
  navigation: "navigation",
  img: "image",
  tab: "tab",
  tabpanel: "tab",
  dialog: "modal",
  tooltip: "tooltip",
  menu: "dropdown",
  listbox: "dropdown",
};
