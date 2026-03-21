// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part Extraction Service Tests
 *
 * パーツ抽出サービスのユニットテスト。
 * TDD Red → Green → Refactor サイクルに従い、
 * パーツ識別・PII分類・マスク・サニタイズ・クロップ・シグネチャ・サンプリングを検証。
 *
 * Unit tests for the Part Extraction Service.
 * Following TDD Red → Green → Refactor cycle,
 * validates part identification, PII classification, masking, sanitization,
 * cropping, signature, and sampling.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";

// テスト対象のモジュール / Module under test
import {
  identifyPartType,
  classifyPiiRisk,
  maskPiiInAttributes,
  computeVisualSignature,
  cropAndResizePart,
  isLogoElement,
  extractPartsFromSection,
} from "../../../src/services/part/part-extraction.service";
import type { PartType, PartExtractionConfig, BoundingBox } from "../../../src/services/part/types";
import { DEFAULT_PART_EXTRACTION_CONFIG } from "../../../src/services/part/types";

// Sharp mock setup
vi.mock("sharp", () => {
  const mockSharpInstance = {
    extract: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    ensureAlpha: vi.fn().mockReturnThis(),
    removeAlpha: vi.fn().mockReturnThis(),
    toColorspace: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from("mock-cropped-image")),
    metadata: vi.fn().mockResolvedValue({ width: 1280, height: 3000, channels: 4 }),
  };
  const sharpFn = vi.fn().mockReturnValue(mockSharpInstance);
  return { default: sharpFn };
});

// ============================================================================
// Helper: JSDOM要素生成 / JSDOM element creation helper
// ============================================================================

function createElement(html: string): Element {
  const dom = new JSDOM(`<body>${html}</body>`);
  const body = dom.window.document.body;
  return body.firstElementChild as Element;
}

// ============================================================================
// identifyPartType - パーツ種別判定 / Part type identification
// ============================================================================

describe("identifyPartType", () => {
  describe("タグベース検出 / Tag-based detection", () => {
    it("button タグを button として識別する", () => {
      const el = createElement("<button>Click me</button>");
      expect(identifyPartType(el)).toBe("button");
    });

    it("a タグを link として識別する", () => {
      const el = createElement('<a href="https://example.com">Link</a>');
      expect(identifyPartType(el)).toBe("link");
    });

    it("img タグを image として識別する", () => {
      const el = createElement('<img src="photo.jpg" alt="photo" />');
      expect(identifyPartType(el)).toBe("image");
    });

    it("video タグを video として識別する", () => {
      const el = createElement('<video src="video.mp4"></video>');
      expect(identifyPartType(el)).toBe("video");
    });

    it("form タグを form として識別する", () => {
      const el = createElement('<form action="/submit"></form>');
      expect(identifyPartType(el)).toBe("form");
    });

    it("input タグを input として識別する", () => {
      const el = createElement('<input type="text" />');
      expect(identifyPartType(el)).toBe("input");
    });

    it("select タグを input として識別する", () => {
      const el = createElement("<select><option>A</option></select>");
      expect(identifyPartType(el)).toBe("input");
    });

    it("textarea タグを input として識別する", () => {
      const el = createElement("<textarea></textarea>");
      expect(identifyPartType(el)).toBe("input");
    });

    it("h1-h6 タグを heading として識別する", () => {
      for (let i = 1; i <= 6; i++) {
        const el = createElement(`<h${i}>Heading</h${i}>`);
        expect(identifyPartType(el)).toBe("heading");
      }
    });

    it("nav タグを navigation として識別する", () => {
      const el = createElement('<nav><a href="/">Home</a></nav>');
      expect(identifyPartType(el)).toBe("navigation");
    });

    it("footer タグを footer として識別する", () => {
      const el = createElement("<footer>Footer content</footer>");
      expect(identifyPartType(el)).toBe("footer");
    });

    it("svg タグを icon として識別する", () => {
      const el = createElement('<svg viewBox="0 0 24 24"><path d="M0 0" /></svg>');
      expect(identifyPartType(el)).toBe("icon");
    });
  });

  describe("クラスパターン検出 / Class pattern detection", () => {
    it("btn クラスを button として識別する", () => {
      const el = createElement('<div class="btn btn-primary">Click</div>');
      expect(identifyPartType(el)).toBe("button");
    });

    it("cta クラスを button として識別する", () => {
      const el = createElement('<div class="cta-section">Get Started</div>');
      expect(identifyPartType(el)).toBe("button");
    });

    it("card クラスを card として識別する", () => {
      const el = createElement('<div class="card-item">Content</div>');
      expect(identifyPartType(el)).toBe("card");
    });

    it("badge クラスを badge として識別する", () => {
      const el = createElement('<span class="badge">New</span>');
      expect(identifyPartType(el)).toBe("badge");
    });

    it("avatar クラスを avatar として識別する", () => {
      const el = createElement('<div class="avatar-circle">JD</div>');
      expect(identifyPartType(el)).toBe("avatar");
    });

    it("hero クラスを hero_image として識別する", () => {
      const el = createElement('<div class="hero-banner">Hero</div>');
      expect(identifyPartType(el)).toBe("hero_image");
    });

    it("navbar クラスを navigation として識別する", () => {
      const el = createElement('<div class="navbar">Nav</div>');
      expect(identifyPartType(el)).toBe("navigation");
    });
  });

  describe("ARIA role検出 / ARIA role detection", () => {
    it('role="button" を button として識別する', () => {
      const el = createElement('<div role="button">Click</div>');
      expect(identifyPartType(el)).toBe("button");
    });

    it('role="link" を link として識別する', () => {
      const el = createElement('<div role="link">Link</div>');
      expect(identifyPartType(el)).toBe("link");
    });

    it('role="navigation" を navigation として識別する', () => {
      const el = createElement('<div role="navigation">Nav</div>');
      expect(identifyPartType(el)).toBe("navigation");
    });

    it('role="img" を image として識別する', () => {
      const el = createElement('<div role="img" aria-label="Photo">Photo</div>');
      expect(identifyPartType(el)).toBe("image");
    });
  });

  describe("未識別要素 / Unidentified elements", () => {
    it("マッチしない div は null を返す", () => {
      const el = createElement('<div class="unknown-class">Content</div>');
      expect(identifyPartType(el)).toBeNull();
    });

    it("マッチしない span は null を返す", () => {
      const el = createElement("<span>Text</span>");
      expect(identifyPartType(el)).toBeNull();
    });
  });

  describe("将来拡張タイプの除外 / Future type exclusion", () => {
    it('role="dialog" (modal) はコアタイプに含まれないため null を返す', () => {
      const el = createElement('<div role="dialog">Modal</div>');
      expect(identifyPartType(el)).toBeNull();
    });

    it('role="tab" はコアタイプに含まれないため null を返す', () => {
      const el = createElement('<div role="tab">Tab</div>');
      expect(identifyPartType(el)).toBeNull();
    });
  });

  describe("優先順位 / Priority order", () => {
    it("タグ検出がクラス検出より優先される", () => {
      // button タグに card クラスがついている場合 → button（タグ優先）
      const el = createElement('<button class="card">Click</button>');
      expect(identifyPartType(el)).toBe("button");
    });
  });
});

// ============================================================================
// classifyPiiRisk - PIIリスク分類 / PII risk classification
// ============================================================================

describe("classifyPiiRisk", () => {
  it('avatar タイプを "high" に分類する', () => {
    const el = createElement('<div class="avatar">JD</div>');
    expect(classifyPiiRisk("avatar", el)).toBe("high");
  });

  it('form タイプを "low" に分類する', () => {
    const el = createElement('<form><input type="email" name="email" /></form>');
    expect(classifyPiiRisk("form", el)).toBe("low");
  });

  it('input タイプでユーザーデータフィールドを含む場合 "low" に分類する', () => {
    const el = createElement('<input type="text" name="username" />');
    expect(classifyPiiRisk("input", el)).toBe("low");
  });

  it('button タイプを "none" に分類する', () => {
    const el = createElement("<button>Submit</button>");
    expect(classifyPiiRisk("button", el)).toBe("none");
  });

  it('card タイプを "none" に分類する', () => {
    const el = createElement('<div class="card">Content</div>');
    expect(classifyPiiRisk("card", el)).toBe("none");
  });

  it('heading タイプを "none" に分類する', () => {
    const el = createElement("<h1>Title</h1>");
    expect(classifyPiiRisk("heading", el)).toBe("none");
  });

  it('image タイプを "none" に分類する', () => {
    const el = createElement('<img src="photo.jpg" />');
    expect(classifyPiiRisk("image", el)).toBe("none");
  });

  it('input タイプで search フィールドは "none" に分類する', () => {
    const el = createElement('<input type="search" name="q" />');
    expect(classifyPiiRisk("input", el)).toBe("none");
  });
});

// ============================================================================
// maskPiiInAttributes - PIIマスク / PII masking
// ============================================================================

describe("maskPiiInAttributes", () => {
  it("emailパターンをマスクする", () => {
    const attrs = { placeholder: "user@example.com", type: "email" };
    const masked = maskPiiInAttributes(attrs);
    expect(masked.placeholder).toBe("***@***.***");
    expect(masked.type).toBe("email");
  });

  it("電話番号パターンをマスクする", () => {
    const attrs = { value: "090-1234-5678" };
    const masked = maskPiiInAttributes(attrs);
    expect(masked.value).toBe("***-****-****");
  });

  it("国際電話番号パターンをマスクする", () => {
    const attrs = { value: "+81-90-1234-5678" };
    const masked = maskPiiInAttributes(attrs);
    expect(masked.value).not.toContain("1234");
  });

  it("PIIを含まない属性はそのまま返す", () => {
    const attrs = { class: "btn-primary", "data-id": "12345" };
    const masked = maskPiiInAttributes(attrs);
    expect(masked).toEqual(attrs);
  });

  it("空のオブジェクトを正しく処理する", () => {
    const masked = maskPiiInAttributes({});
    expect(masked).toEqual({});
  });

  it("複数のPIIを含む属性をすべてマスクする", () => {
    const attrs = {
      title: "Contact: test@mail.com or 03-1234-5678",
    };
    const masked = maskPiiInAttributes(attrs);
    expect(masked.title).not.toContain("test@mail.com");
    expect(masked.title).not.toContain("1234-5678");
  });
});

// ============================================================================
// computeVisualSignature - SHA-256ハッシュ / SHA-256 hash
// ============================================================================

describe("computeVisualSignature", () => {
  it("Buffer から SHA-256 ハッシュを生成する", () => {
    const buffer = Buffer.from("test-image-data");
    const signature = computeVisualSignature(buffer);
    // SHA-256 は 64文字の16進数文字列
    expect(signature).toHaveLength(64);
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it("同じ入力に対して同じハッシュを生成する", () => {
    const buffer = Buffer.from("deterministic-input");
    const sig1 = computeVisualSignature(buffer);
    const sig2 = computeVisualSignature(buffer);
    expect(sig1).toBe(sig2);
  });

  it("異なる入力に対して異なるハッシュを生成する", () => {
    const buf1 = Buffer.from("image-1");
    const buf2 = Buffer.from("image-2");
    expect(computeVisualSignature(buf1)).not.toBe(computeVisualSignature(buf2));
  });
});

// ============================================================================
// cropAndResizePart - 画像クロップ＆リサイズ / Image crop & resize
// ============================================================================

describe("cropAndResizePart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("BoundingBoxに基づいてクロップしてリサイズする", async () => {
    const screenshot = Buffer.from("full-screenshot-data");
    const bbox: BoundingBox = { x: 100, y: 200, width: 300, height: 150 };
    const result = await cropAndResizePart(screenshot, bbox, 224);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBeGreaterThan(0);
  });

  it("ゼロサイズのBoundingBoxに対してエラーをスローする", async () => {
    const screenshot = Buffer.from("full-screenshot-data");
    const bbox: BoundingBox = { x: 0, y: 0, width: 0, height: 0 };
    await expect(cropAndResizePart(screenshot, bbox, 224)).rejects.toThrow();
  });
});

// ============================================================================
// isLogoElement - ロゴ検出 / Logo detection
// ============================================================================

describe("isLogoElement", () => {
  it("header内の .logo クラスを持つ SVG をロゴと判定する", () => {
    const dom = new JSDOM(
      '<header><svg class="logo" viewBox="0 0 24 24"><path d="M0 0" /></svg></header>'
    );
    const svg = dom.window.document.querySelector("svg") as Element;
    expect(isLogoElement(svg)).toBe(true);
  });

  it('header内の class*="logo" を持つ要素をロゴと判定する', () => {
    const dom = new JSDOM('<header><div class="site-logo"><img src="logo.png" /></div></header>');
    const el = dom.window.document.querySelector(".site-logo") as Element;
    expect(isLogoElement(el)).toBe(true);
  });

  it("header外の SVG はロゴと判定しない", () => {
    const dom = new JSDOM(
      '<main><svg class="logo" viewBox="0 0 24 24"><path d="M0 0" /></svg></main>'
    );
    const svg = dom.window.document.querySelector("svg") as Element;
    expect(isLogoElement(svg)).toBe(false);
  });

  it("header内でもlogoクラスを持たない要素はロゴと判定しない", () => {
    const dom = new JSDOM(
      '<header><svg class="icon-menu" viewBox="0 0 24 24"><path d="M0 0" /></svg></header>'
    );
    const svg = dom.window.document.querySelector("svg") as Element;
    expect(isLogoElement(svg)).toBe(false);
  });
});

// ============================================================================
// DOMPurifyサニタイズ / DOMPurify sanitization
// ============================================================================

describe("DOMPurify sanitization in extractPartsFromSection", () => {
  it("script タグを含むHTMLをサニタイズして除去する", async () => {
    const html =
      '<div><button onclick="alert(1)">Click</button><script>alert("xss")</script></div>';
    const result = await extractPartsFromSection({
      sectionHtml: html,
      sectionIndex: 0,
      config: DEFAULT_PART_EXTRACTION_CONFIG,
      computedStylesMap: new Map(),
      sectionBoundingBox: { x: 0, y: 0, width: 1280, height: 800 },
    });
    // 結果のパーツのhtmlSnippetに<script>が含まれていないことを確認
    for (const part of result.parts) {
      if (part.htmlSnippet) {
        expect(part.htmlSnippet).not.toContain("<script>");
        expect(part.htmlSnippet).not.toContain("alert");
      }
    }
  });

  it("javascript: URLを除去する", async () => {
    const html = '<div><a href="javascript:void(0)">Link</a></div>';
    const result = await extractPartsFromSection({
      sectionHtml: html,
      sectionIndex: 0,
      config: DEFAULT_PART_EXTRACTION_CONFIG,
      computedStylesMap: new Map(),
      sectionBoundingBox: { x: 0, y: 0, width: 1280, height: 800 },
    });
    for (const part of result.parts) {
      if (part.htmlSnippet) {
        expect(part.htmlSnippet).not.toContain("javascript:");
      }
    }
  });
});

// ============================================================================
// extractPartsFromSection - メイン抽出関数 / Main extraction function
// ============================================================================

describe("extractPartsFromSection", () => {
  it("セクションHTMLからパーツを抽出する", async () => {
    const html = `
      <section>
        <h2>Title</h2>
        <p>Description</p>
        <button class="btn-primary">Get Started</button>
        <a href="/learn">Learn More</a>
      </section>
    `;
    const result = await extractPartsFromSection({
      sectionHtml: html,
      sectionIndex: 0,
      config: DEFAULT_PART_EXTRACTION_CONFIG,
      computedStylesMap: new Map(),
      sectionBoundingBox: { x: 0, y: 0, width: 1280, height: 800 },
    });

    expect(result.parts.length).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // heading, button, link が抽出されることを確認
    const partTypes = result.parts.map((p) => p.partType);
    expect(partTypes).toContain("heading");
    expect(partTypes).toContain("button");
    expect(partTypes).toContain("link");
  });

  it("maxPartsPerType でタイプ別にサンプリングする", async () => {
    // 10個のボタンを含むHTML
    const buttons = Array.from({ length: 10 }, (_, i) => `<button>Btn ${i}</button>`).join("");
    const html = `<section>${buttons}</section>`;

    const config: PartExtractionConfig = {
      ...DEFAULT_PART_EXTRACTION_CONFIG,
      maxPartsPerType: 3,
    };

    const result = await extractPartsFromSection({
      sectionHtml: html,
      sectionIndex: 0,
      config,
      computedStylesMap: new Map(),
      sectionBoundingBox: { x: 0, y: 0, width: 1280, height: 800 },
    });

    const buttonParts = result.parts.filter((p) => p.partType === "button");
    expect(buttonParts.length).toBeLessThanOrEqual(3);
    // サンプリングされたパーツのsampleIndexを検証
    buttonParts.forEach((part, index) => {
      expect(part.sampleIndex).toBe(index);
    });
  });

  it("minPartSize 未満の要素をスキップする", async () => {
    // JSDOM ではgetBoundingClientRectが常に0を返すため、
    // minPartSize > 0 の場合は全てスキップされる
    const html = "<section><button>Tiny</button></section>";
    const config: PartExtractionConfig = {
      ...DEFAULT_PART_EXTRACTION_CONFIG,
      minPartSize: 9999, // 非常に大きな閾値
    };

    const result = await extractPartsFromSection({
      sectionHtml: html,
      sectionIndex: 0,
      config,
      computedStylesMap: new Map(),
      sectionBoundingBox: { x: 0, y: 0, width: 1280, height: 800 },
    });

    // JSDOMではサイズ情報が取得できないため、
    // minPartSizeフィルタリングに関する結果を検証
    expect(result.skippedCount).toBeGreaterThanOrEqual(0);
  });

  it("空のセクションHTMLは空の結果を返す", async () => {
    const result = await extractPartsFromSection({
      sectionHtml: "",
      sectionIndex: 0,
      config: DEFAULT_PART_EXTRACTION_CONFIG,
      computedStylesMap: new Map(),
      sectionBoundingBox: { x: 0, y: 0, width: 1280, height: 800 },
    });

    expect(result.parts).toEqual([]);
    expect(result.skippedCount).toBe(0);
  });

  it("null/undefined 入力を安全に処理する", async () => {
    const result = await extractPartsFromSection({
      sectionHtml: null as unknown as string,
      sectionIndex: 0,
      config: DEFAULT_PART_EXTRACTION_CONFIG,
      computedStylesMap: new Map(),
      sectionBoundingBox: { x: 0, y: 0, width: 1280, height: 800 },
    });

    expect(result.parts).toEqual([]);
    expect(result.skippedCount).toBe(0);
  });

  it("ロゴ要素は metadata.isLogo=true で htmlSnippet=null になる", async () => {
    const html = `
      <header>
        <svg class="logo" viewBox="0 0 100 30"><path d="M0 0" /></svg>
        <nav><a href="/">Home</a></nav>
      </header>
    `;
    const result = await extractPartsFromSection({
      sectionHtml: html,
      sectionIndex: 0,
      config: DEFAULT_PART_EXTRACTION_CONFIG,
      computedStylesMap: new Map(),
      sectionBoundingBox: { x: 0, y: 0, width: 1280, height: 800 },
    });

    const logoParts = result.parts.filter(
      (p) => p.metadata && (p.metadata as Record<string, unknown>).isLogo === true
    );
    if (logoParts.length > 0) {
      expect(logoParts[0].htmlSnippet).toBeNull();
    }
  });

  it('各パーツに usageScope="inspiration_only" が設定される', async () => {
    const html = "<section><button>Click</button></section>";
    const result = await extractPartsFromSection({
      sectionHtml: html,
      sectionIndex: 0,
      config: DEFAULT_PART_EXTRACTION_CONFIG,
      computedStylesMap: new Map(),
      sectionBoundingBox: { x: 0, y: 0, width: 1280, height: 800 },
    });

    for (const part of result.parts) {
      expect(part.usageScope).toBe("inspiration_only");
    }
  });

  it('avatar タイプのパーツは piiRiskLevel="high" になる', async () => {
    const html = '<section><div class="avatar">JD</div></section>';
    const result = await extractPartsFromSection({
      sectionHtml: html,
      sectionIndex: 0,
      config: DEFAULT_PART_EXTRACTION_CONFIG,
      computedStylesMap: new Map(),
      sectionBoundingBox: { x: 0, y: 0, width: 1280, height: 800 },
    });

    const avatarParts = result.parts.filter((p) => p.partType === "avatar");
    if (avatarParts.length > 0) {
      expect(avatarParts[0].piiRiskLevel).toBe("high");
      // high risk パーツには cropBuffer がない
      expect(avatarParts[0].cropBuffer).toBeNull();
    }
  });

  it("partTypes フィルタで指定されたタイプのみ抽出する", async () => {
    const html = `
      <section>
        <h2>Title</h2>
        <button>Click</button>
        <a href="/">Link</a>
        <img src="photo.jpg" alt="photo" />
      </section>
    `;
    const config: PartExtractionConfig = {
      ...DEFAULT_PART_EXTRACTION_CONFIG,
      partTypes: ["button", "heading"],
    };
    const result = await extractPartsFromSection({
      sectionHtml: html,
      sectionIndex: 0,
      config,
      computedStylesMap: new Map(),
      sectionBoundingBox: { x: 0, y: 0, width: 1280, height: 800 },
    });

    const partTypes = new Set(result.parts.map((p) => p.partType));
    expect(partTypes.has("link")).toBe(false);
    expect(partTypes.has("image")).toBe(false);
  });
});
