// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part Extraction Service
 *
 * Phase 1.1 of page-analyze worker pipeline.
 * セクション内の個別UIパーツ（ボタン、カード、ナビゲーション等）を
 * ヒューリスティクスで識別・抽出し、DOMPurifyでサニタイズする。
 *
 * Identifies and extracts individual UI parts (buttons, cards, navigation, etc.)
 * within sections using heuristics, and sanitizes with DOMPurify.
 *
 * @module services/part/part-extraction.service
 */

import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import sharp from "sharp";
import { createHash } from "crypto";

import {
  type PartType,
  type ExtractedPart,
  type PartExtractionConfig,
  type PartExtractionResult,
  type BoundingBox,
  type PiiRiskLevel,
  type InteractionInfo,
  TAG_TO_PART_TYPE,
  CLASS_PATTERNS,
  ROLE_TO_PART_TYPE,
  ALL_PART_TYPES,
} from "./types";
import { logger, isDevelopment } from "../../utils/logger";

// ============================================================================
// Constants / 定数
// ============================================================================

/**
 * PIIリスクが 'high' となるパーツタイプ
 * Part types classified as 'high' PII risk
 */
const HIGH_PII_TYPES: ReadonlySet<PartType> = new Set(["avatar"]);

// NOTE: form/input のPII判定は classifyPiiRisk() 内で直接処理
// form/input PII classification is handled directly in classifyPiiRisk()

/**
 * ユーザーデータを示すフィールド名パターン（input の PII 判定用）
 * Field name patterns indicating user data (for input PII classification)
 */
const USER_DATA_FIELD_PATTERNS =
  /\b(email|password|name|phone|tel|address|username|login|user|account)\b/i;

/**
 * 検索用フィールド名パターン（PIIとみなさない）
 * Search field name patterns (not considered PII)
 */
const SEARCH_FIELD_PATTERNS = /\b(search|query|q|filter|keyword)\b/i;

/**
 * Emailマスクパターン / Email mask pattern
 */
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * 電話番号マスクパターン / Phone mask pattern
 *
 * 区切り文字（ハイフン、ドット、スペース）を少なくとも1つ含む番号のみマッチ。
 * 単純な数字列（例: "12345"）は電話番号とみなさない。
 * Only matches numbers containing at least one separator (hyphen, dot, space).
 * Plain digit sequences (e.g., "12345") are not considered phone numbers.
 */
const PHONE_PATTERN =
  /(\+?\d{1,4}[-.\s])\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}|\(?\d{2,4}\)?[-.\s]\d{1,4}[-.\s]\d{1,9}/g;

/**
 * コアパーツタイプのセット（高速ルックアップ用）
 * Core part type set (for fast lookup)
 */
const CORE_PART_TYPE_SET: ReadonlySet<string> = new Set(ALL_PART_TYPES);

// ============================================================================
// DOMPurify Setup / DOMPurifyセットアップ
// ============================================================================

/**
 * パーツ用DOMPurifyインスタンス
 * Part-specific DOMPurify instance
 *
 * html-sanitizer.ts のグローバルインスタンスとは独立して使用。
 * パーツHTMLは小さいためバイパス不要。
 */
const purifyWindow = new JSDOM("").window;
const DOMPurify = createDOMPurify(purifyWindow);

const PART_DOMPURIFY_CONFIG = {
  FORBID_TAGS: [
    "script",
    "noscript",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "applet",
    "meta",
    "link",
    "base",
    "title",
  ] as string[],
  FORBID_ATTR: [
    "onclick",
    "ondblclick",
    "onmousedown",
    "onmouseup",
    "onmouseover",
    "onmousemove",
    "onmouseout",
    "onmouseenter",
    "onmouseleave",
    "onkeydown",
    "onkeypress",
    "onkeyup",
    "onfocus",
    "onblur",
    "onchange",
    "onsubmit",
    "onreset",
    "onload",
    "onunload",
    "onerror",
    "onabort",
    "onresize",
    "onscroll",
    "oncontextmenu",
    "formaction",
  ] as string[],
  ALLOW_UNKNOWN_PROTOCOLS: false,
  ALLOW_DATA_ATTR: true,
  USE_PROFILES: { svg: true, svgFilters: true, html: true },
  SAFE_FOR_TEMPLATES: true,
  SANITIZE_DOM: true,
  KEEP_CONTENT: true,
};

// ============================================================================
// Public Functions / 公開関数
// ============================================================================

/**
 * セクションHTMLからパーツを抽出する（メイン関数）
 * Extract parts from section HTML (main function)
 *
 * @param params - 抽出パラメータ / Extraction parameters
 * @returns 抽出結果 / Extraction result
 */
export async function extractPartsFromSection(params: {
  sectionHtml: string;
  sectionIndex: number;
  config: PartExtractionConfig;
  computedStylesMap: Map<string, Record<string, string>>;
  sectionBoundingBox: BoundingBox;
  fullScreenshot?: Buffer;
  sourceUrl?: string | null;
}): Promise<PartExtractionResult> {
  const startTime = Date.now();
  const { sectionHtml, config, computedStylesMap, sectionBoundingBox, fullScreenshot, sourceUrl } =
    params;

  // 空入力 / Empty input guard
  if (!sectionHtml || typeof sectionHtml !== "string" || sectionHtml.trim() === "") {
    return { parts: [], skippedCount: 0, durationMs: 0 };
  }

  const allowedTypes = new Set(config.partTypes);
  const dom = new JSDOM(`<body>${sectionHtml}</body>`);
  const document = dom.window.document;
  const body = document.body;

  // 全要素を走査してパーツ候補を収集 / Walk all elements to collect part candidates
  const allElements = body.querySelectorAll("*");
  const candidates: Array<{ element: Element; partType: PartType }> = [];

  for (const element of allElements) {
    const partType = identifyPartType(element);
    if (partType === null) continue;
    if (!allowedTypes.has(partType)) continue;
    candidates.push({ element, partType });
  }

  // タイプ別サンプリング / Per-type sampling
  const typeCounters = new Map<PartType, number>();
  const sampledCandidates: Array<{ element: Element; partType: PartType; sampleIndex: number }> =
    [];
  let skippedCount = 0;

  for (const candidate of candidates) {
    const currentCount = typeCounters.get(candidate.partType) ?? 0;
    if (currentCount >= config.maxPartsPerType) {
      skippedCount++;
      continue;
    }

    // minPartSize フィルタ（JSDOMではgetBoundingClientRectが0を返す場合がある）
    const rect = candidate.element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      if (rect.width < config.minPartSize && rect.height < config.minPartSize) {
        skippedCount++;
        continue;
      }
    }

    typeCounters.set(candidate.partType, currentCount + 1);
    sampledCandidates.push({
      ...candidate,
      sampleIndex: currentCount,
    });
  }

  // 各候補をExtractedPartに変換 / Convert each candidate to ExtractedPart
  const parts: ExtractedPart[] = [];

  for (const { element, partType, sampleIndex } of sampledCandidates) {
    const isLogo = isLogoElement(element);
    const piiRiskLevel = classifyPiiRisk(partType, element);

    // 属性を収集 / Collect attributes
    const rawAttributes: Record<string, string> = {};
    for (const attr of element.attributes) {
      rawAttributes[attr.name] = attr.value;
    }
    const attributes = maskPiiInAttributes(rawAttributes);

    // CSSクラスリスト / CSS class list
    const cssClasses = Array.from(element.classList);

    // HTMLスニペット（ロゴの場合はnull）/ HTML snippet (null for logos)
    let htmlSnippet: string | null = null;
    if (!isLogo) {
      const rawHtml = element.outerHTML;
      htmlSnippet = DOMPurify.sanitize(rawHtml, PART_DOMPURIFY_CONFIG);
    }

    // 計算済みスタイル / Computed styles
    const elementId = element.id || element.getAttribute("data-part-id") || "";
    const computedStyles = computedStylesMap.get(elementId) ?? {};

    // バウンディングボックス（セクション相対）/ Bounding box (section-relative)
    const rect = element.getBoundingClientRect();
    const boundingBox: BoundingBox = {
      x: Math.max(0, rect.left - sectionBoundingBox.x),
      y: Math.max(0, rect.top - sectionBoundingBox.y),
      width: rect.width,
      height: rect.height,
    };

    // インタラクション情報 / Interaction info
    const interactionInfo = extractInteractionInfo(element, computedStyles);

    // 画像クロップ / Image crop
    let cropBuffer: Buffer | null = null;
    let visualSignature: string | null = null;

    if (
      fullScreenshot &&
      !isLogo &&
      piiRiskLevel !== "high" &&
      boundingBox.width > 0 &&
      boundingBox.height > 0
    ) {
      try {
        cropBuffer = await cropAndResizePart(
          fullScreenshot,
          {
            x: boundingBox.x + sectionBoundingBox.x,
            y: boundingBox.y + sectionBoundingBox.y,
            width: boundingBox.width,
            height: boundingBox.height,
          },
          config.cropSize
        );
        visualSignature = computeVisualSignature(cropBuffer);
      } catch (error) {
        logger.warn("[part-extraction] Failed to crop part image", {
          partType,
          error: (error as Error).message,
        });
      }
    }

    // パーツサブタイプ判定 / Part subtype determination
    const partSubtype = inferPartSubtype(partType, element);

    // タグ生成 / Tag generation
    const tags = generatePartTags(partType, element, cssClasses);

    // メタデータ / Metadata
    const metadata: Record<string, unknown> = {};
    if (isLogo) {
      metadata.isLogo = true;
    }

    const extractedPart: ExtractedPart = {
      partType,
      partSubtype,
      htmlSnippet,
      computedStyles,
      boundingBox,
      cssClasses,
      attributes,
      interactionInfo,
      visualSignature,
      sampleIndex,
      piiRiskLevel,
      tags,
      metadata,
      sourceUrl: sourceUrl ?? null,
      usageScope: "inspiration_only",
      cropBuffer: piiRiskLevel === "high" ? null : cropBuffer,
    };

    parts.push(extractedPart);
  }

  const durationMs = Date.now() - startTime;

  if (isDevelopment()) {
    logger.info("[part-extraction] Extraction completed", {
      sectionIndex: params.sectionIndex,
      totalCandidates: candidates.length,
      extractedParts: parts.length,
      skippedCount,
      durationMs,
    });
  }

  return { parts, skippedCount, durationMs };
}

/**
 * パーツ種別を判定する
 * Identify part type from element
 *
 * 優先順位: タグ → クラスパターン → ARIA role
 * Priority: tag → class pattern → ARIA role
 *
 * @param element - DOM要素 / DOM element
 * @returns パーツタイプまたはnull / Part type or null
 */
export function identifyPartType(element: Element): PartType | null {
  // 1. タグベース検出 / Tag-based detection
  const tagName = element.tagName.toLowerCase();
  const tagType = TAG_TO_PART_TYPE[tagName];
  if (tagType !== undefined) {
    return tagType;
  }

  // 2. クラスパターン検出 / Class pattern detection
  // SVG要素のclassNameはSVGAnimatedStringのためgetAttribute('class')を使用
  const classAttrValue = element.getAttribute("class") ?? "";
  if (classAttrValue.length > 0) {
    for (const { pattern, type } of CLASS_PATTERNS) {
      if (pattern.test(classAttrValue)) {
        return type;
      }
    }
  }

  // 3. ARIA role検出 / ARIA role detection
  const role = element.getAttribute("role");
  if (role) {
    const roleType = ROLE_TO_PART_TYPE[role];
    if (roleType !== undefined && CORE_PART_TYPE_SET.has(roleType)) {
      return roleType as PartType;
    }
  }

  return null;
}

/**
 * PIIリスクレベルを分類する
 * Classify PII risk level
 *
 * @param partType - パーツタイプ / Part type
 * @param element - DOM要素 / DOM element
 * @returns PIIリスクレベル / PII risk level
 */
export function classifyPiiRisk(partType: PartType, element: Element): PiiRiskLevel {
  // avatar → high
  if (HIGH_PII_TYPES.has(partType)) {
    return "high";
  }

  // form → low（常にユーザーデータを含む可能性がある）
  if (partType === "form") {
    return "low";
  }

  // input → フィールド名に応じて判定
  if (partType === "input") {
    const nameAttr = element.getAttribute("name") ?? "";
    const typeAttr = element.getAttribute("type") ?? "";

    // 検索フィールドは PII とみなさない
    if (SEARCH_FIELD_PATTERNS.test(nameAttr) || typeAttr === "search") {
      return "none";
    }

    // ユーザーデータフィールドの場合は low
    if (USER_DATA_FIELD_PATTERNS.test(nameAttr) || USER_DATA_FIELD_PATTERNS.test(typeAttr)) {
      return "low";
    }

    return "none";
  }

  return "none";
}

/**
 * 属性内のPIIをマスクする
 * Mask PII in attributes
 *
 * @param attributes - HTML属性 / HTML attributes
 * @returns マスク済み属性 / Masked attributes
 */
export function maskPiiInAttributes(attributes: Record<string, string>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    let maskedValue = value;
    maskedValue = maskedValue.replace(EMAIL_PATTERN, "***@***.***");
    maskedValue = maskedValue.replace(PHONE_PATTERN, "***-****-****");
    masked[key] = maskedValue;
  }
  return masked;
}

/**
 * クロップ領域を画像範囲内にクランプする（leaf helper、単一定義）
 * Clamp a crop region within the image bounds (leaf helper, single definition)
 *
 * `cropAndResizePart()` 内にインラインで書かれていた 4 式を behaviour-invariant な
 * code motion で切り出したものであり、**production の唯一の定義**である。
 * `INV-SHARP-PIPELINE-PARITY-001` の Layer A guard はこの helper を import して
 * 「実効 extract 寸法」を得る — guard 側で clamp 式を複製すると production 側の
 * clamp 変更で guard が silent に stale 化し、BI-16 が Layer A assert に課した
 * 「チェーン再実装禁止」と同 class の drift surface を guard 層に新設するため。
 *
 * Extracted from the four inline expressions inside `cropAndResizePart()` by a
 * behaviour-invariant code motion; this is the **single production definition**.
 * The `INV-SHARP-PIPELINE-PARITY-001` Layer A guard imports it to derive the
 * "effective extract dimensions" rather than re-implementing the clamp, which
 * would create the same class of drift surface that BI-16 forbids for the
 * Layer A assert chain.
 *
 * @param boundingBox - クロップ領域（非整数・負座標・画像外はみ出しを許容） / Crop region (non-integer, negative and out-of-bounds values allowed)
 * @param imgWidth - 元画像の幅 / Source image width
 * @param imgHeight - 元画像の高さ / Source image height
 * @returns sharp `.extract()` に渡せるクランプ済み領域 / Clamped region suitable for sharp `.extract()`
 */
export function clampExtractRegion(
  boundingBox: BoundingBox,
  imgWidth: number,
  imgHeight: number
): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.round(boundingBox.x));
  const top = Math.max(0, Math.round(boundingBox.y));
  const width = Math.min(Math.round(boundingBox.width), Math.max(1, imgWidth - left));
  const height = Math.min(Math.round(boundingBox.height), Math.max(1, imgHeight - top));
  return { left, top, width, height };
}

/**
 * 画像をクロップしてリサイズする
 * Crop and resize image
 *
 * @param fullScreenshot - フルスクリーンショット / Full screenshot buffer
 * @param boundingBox - クロップ領域 / Crop region
 * @param cropSize - リサイズ後のサイズ / Target size (width & height)
 * @returns クロップ済み画像バッファ / Cropped image buffer
 */
export async function cropAndResizePart(
  fullScreenshot: Buffer,
  boundingBox: BoundingBox,
  cropSize: number
): Promise<Buffer> {
  if (boundingBox.width <= 0 || boundingBox.height <= 0) {
    throw new Error(
      `Invalid bounding box: width=${boundingBox.width}, height=${boundingBox.height}. Both must be positive.`
    );
  }

  const metadata = await sharp(fullScreenshot).metadata();
  const imgWidth = metadata.width ?? 0;
  const imgHeight = metadata.height ?? 0;

  // クロップ領域を画像範囲内にクランプ / Clamp crop region within image bounds
  const { left, top, width, height } = clampExtractRegion(boundingBox, imgWidth, imgHeight);

  return sharp(fullScreenshot)
    .extract({ left, top, width, height })
    .resize(cropSize, cropSize, { fit: "cover", kernel: "cubic" })
    .removeAlpha()
    .toColorspace("srgb")
    .toBuffer();
}

/**
 * 画像バッファからビジュアルシグネチャ（SHA-256）を生成する
 * Compute visual signature (SHA-256) from image buffer
 *
 * @param imageBuffer - 画像バッファ / Image buffer
 * @returns SHA-256ハッシュ文字列（64文字hex） / SHA-256 hash string (64 char hex)
 */
export function computeVisualSignature(imageBuffer: Buffer): string {
  return createHash("sha256").update(imageBuffer).digest("hex");
}

/**
 * 要素がロゴかどうかを判定する
 * Determine if element is a logo
 *
 * header内の SVG で .logo / [class*="logo"] クラスを持つ場合にtrue。
 * True when an SVG or element with .logo / [class*="logo"] class is inside a header.
 *
 * @param element - DOM要素 / DOM element
 * @returns ロゴかどうか / Whether the element is a logo
 */
export function isLogoElement(element: Element): boolean {
  // header内でない場合はロゴではない / Not a logo if not inside header
  const header = element.closest("header");
  if (!header) {
    return false;
  }

  // SVGタグ + logoクラスパターン / SVG tag + logo class pattern
  const tagName = element.tagName.toLowerCase();

  // SVG要素のclassNameはSVGAnimatedString（stringではない）ため、
  // getAttribute('class') を使用する
  // SVG element className is SVGAnimatedString (not a string),
  // so use getAttribute('class') instead
  const classString = element.getAttribute("class") ?? "";

  const hasLogoClass = /\blogo\b/i.test(classString) || classString.toLowerCase().includes("logo");

  if (tagName === "svg" && hasLogoClass) {
    return true;
  }

  // SVG以外でもlogoクラスを持つ場合 / Non-SVG elements with logo class
  if (hasLogoClass) {
    return true;
  }

  return false;
}

// ============================================================================
// Internal Functions / 内部関数
// ============================================================================

/**
 * インタラクション情報を抽出する
 * Extract interaction information from element
 */
function extractInteractionInfo(
  element: Element,
  computedStyles: Record<string, string>
): InteractionInfo {
  const tagName = element.tagName.toLowerCase();
  const isInteractive = ["button", "a", "input", "select", "textarea"].includes(tagName);

  const transitionValue = computedStyles["transition"] ?? "";
  const hasTransition = transitionValue !== "" && transitionValue !== "none";

  return {
    hasHover: isInteractive,
    hasFocus: isInteractive,
    hasActive: isInteractive,
    hasTransition,
    ...(hasTransition && transitionValue ? { transitionDuration: transitionValue } : {}),
  };
}

/**
 * パーツサブタイプを推定する
 * Infer part subtype from element attributes and classes
 */
function inferPartSubtype(partType: PartType, element: Element): string | null {
  const classList = element.getAttribute("class") ?? "";

  switch (partType) {
    case "button": {
      if (/\bprimary\b/i.test(classList)) return "primary_button";
      if (/\bsecondary\b/i.test(classList)) return "secondary_button";
      if (/\bicon\b/i.test(classList)) return "icon_button";
      if (/\bghost\b/i.test(classList)) return "ghost_button";
      const typeAttr = element.getAttribute("type");
      if (typeAttr === "submit") return "submit_button";
      return null;
    }
    case "input": {
      const typeAttr = element.getAttribute("type") ?? "text";
      return `${typeAttr}_input`;
    }
    case "heading": {
      const tagName = element.tagName.toLowerCase();
      return tagName; // h1, h2, h3, etc.
    }
    case "image": {
      if (element.getAttribute("loading") === "lazy") return "lazy_image";
      return null;
    }
    default:
      return null;
  }
}

/**
 * パーツタグを生成する
 * Generate tags for a part
 */
function generatePartTags(partType: PartType, element: Element, cssClasses: string[]): string[] {
  const tags: string[] = [partType];
  const tagName = element.tagName.toLowerCase();

  if (tagName !== partType) {
    tags.push(tagName);
  }

  // 主要なCSSフレームワーク用クラスからタグを生成
  for (const cls of cssClasses) {
    if (/^(btn|cta|card|badge|chip|nav|hero|avatar)/i.test(cls)) {
      tags.push(cls.toLowerCase());
    }
  }

  return [...new Set(tags)];
}
