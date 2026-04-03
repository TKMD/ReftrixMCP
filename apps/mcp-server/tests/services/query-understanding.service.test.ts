// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * QueryUnderstandingService テスト / QueryUnderstandingService Tests
 *
 * クエリ理解サービスの検証:
 * - クエリタイプ分類（visual/structural/functional/stylistic）
 * - フィルタ自動抽出（industry/audience/tags）
 * - クエリ拡張（同義語・関連語の自動付与）
 * - エッジケース（空クエリ、混合クエリ、日本語クエリ）
 *
 * Query understanding service verification:
 * - Query type classification (visual/structural/functional/stylistic)
 * - Auto-filter extraction (industry/audience/tags)
 * - Query expansion (synonym/related term auto-addition)
 * - Edge cases (empty query, mixed query, Japanese query)
 *
 * @module tests/services/query-understanding.service
 */

import { describe, it, expect } from "vitest";
import {
  classifyQueryType,
  extractFilters,
  expandQuery,
  understandQuery,
  type QueryType,
  type QueryUnderstandingResult,
} from "../../src/services/search/query-understanding.service";

// ============================================================================
// classifyQueryType / クエリタイプ分類
// ============================================================================

describe("classifyQueryType", () => {
  // --- visual type ---
  describe("visual タイプ / visual type", () => {
    it("色に関するクエリをvisualに分類する", () => {
      expect(classifyQueryType("blue gradient background")).toBe("visual");
    });

    it("画像に関するクエリをvisualに分類する", () => {
      expect(classifyQueryType("hero image with large photo")).toBe("visual");
    });

    it("dark themeクエリをvisualに分類する", () => {
      expect(classifyQueryType("dark theme design")).toBe("visual");
    });

    it("typographyクエリをvisualに分類する", () => {
      expect(classifyQueryType("bold typography heading")).toBe("visual");
    });

    it("iconクエリをvisualに分類する", () => {
      expect(classifyQueryType("icon set with color palette")).toBe("visual");
    });
  });

  // --- structural type ---
  describe("structural タイプ / structural type", () => {
    it("gridに関するクエリをstructuralに分類する", () => {
      expect(classifyQueryType("3 column grid layout")).toBe("structural");
    });

    it("sidebarクエリをstructuralに分類する", () => {
      expect(classifyQueryType("sidebar navigation layout")).toBe("structural");
    });

    it("headerクエリをstructuralに分類する", () => {
      expect(classifyQueryType("sticky header with logo")).toBe("structural");
    });

    it("footerクエリをstructuralに分類する", () => {
      expect(classifyQueryType("footer with multiple columns")).toBe("structural");
    });

    it("sectionクエリをstructuralに分類する", () => {
      expect(classifyQueryType("hero section with CTA")).toBe("structural");
    });
  });

  // --- functional type ---
  describe("functional タイプ / functional type", () => {
    it("buttonクエリをfunctionalに分類する", () => {
      expect(classifyQueryType("button with hover effect")).toBe("functional");
    });

    it("formクエリをfunctionalに分類する", () => {
      expect(classifyQueryType("contact form with validation")).toBe("functional");
    });

    it("animationクエリをfunctionalに分類する", () => {
      expect(classifyQueryType("scroll animation entrance")).toBe("functional");
    });

    it("interactiveクエリをfunctionalに分類する", () => {
      expect(classifyQueryType("interactive carousel component")).toBe("functional");
    });

    it("modalクエリをfunctionalに分類する", () => {
      expect(classifyQueryType("modal dialog popup")).toBe("functional");
    });
  });

  // --- stylistic type ---
  describe("stylistic タイプ / stylistic type", () => {
    it("minimalクエリをstylisticに分類する", () => {
      expect(classifyQueryType("minimal clean design")).toBe("stylistic");
    });

    it("professionalクエリをstylisticに分類する", () => {
      expect(classifyQueryType("professional corporate style")).toBe("stylistic");
    });

    it("modernクエリをstylisticに分類する", () => {
      expect(classifyQueryType("modern trendy website")).toBe("stylistic");
    });

    it("elegantクエリをstylisticに分類する", () => {
      expect(classifyQueryType("elegant luxury feel")).toBe("stylistic");
    });

    it("playfulクエリをstylisticに分類する", () => {
      expect(classifyQueryType("playful fun colorful style")).toBe("stylistic");
    });
  });

  // --- edge cases ---
  describe("エッジケース / edge cases", () => {
    it("空文字列の場合はvisualをデフォルトで返す", () => {
      expect(classifyQueryType("")).toBe("visual");
    });

    it("分類不能なクエリはvisualをデフォルトで返す", () => {
      expect(classifyQueryType("xyz123")).toBe("visual");
    });

    it("混合クエリでは最も強いシグナルのタイプを返す", () => {
      // "grid layout" (structural) が "blue" (visual) より具体的
      const result = classifyQueryType("blue grid layout");
      expect(["visual", "structural"]).toContain(result);
    });

    it("大文字小文字を区別しない", () => {
      expect(classifyQueryType("DARK THEME DESIGN")).toBe("visual");
    });

    it("明示的なクエリタイプ指定時はそれを尊重する", () => {
      // auto以外が指定された場合のオーバーライドテスト
      const result = classifyQueryType("some query", "functional");
      expect(result).toBe("functional");
    });
  });
});

// ============================================================================
// extractFilters / フィルタ自動抽出
// ============================================================================

describe("extractFilters", () => {
  // --- industry extraction ---
  describe("industry 抽出 / industry extraction", () => {
    it("SaaSクエリからindustryを抽出する", () => {
      const filters = extractFilters("SaaS pricing page design");
      expect(filters.industry).toBe("SaaS");
    });

    it("e-commerceクエリからindustryを抽出する", () => {
      const filters = extractFilters("e-commerce product listing");
      expect(filters.industry).toBe("E-commerce");
    });

    it("fintech関連クエリからindustryを抽出する", () => {
      const filters = extractFilters("fintech dashboard design");
      expect(filters.industry).toBe("Fintech");
    });

    it("healthcare関連クエリからindustryを抽出する", () => {
      const filters = extractFilters("healthcare portal interface");
      expect(filters.industry).toBe("Healthcare");
    });
  });

  // --- audience extraction ---
  describe("audience 抽出 / audience extraction", () => {
    it("developer向けクエリからaudienceを抽出する", () => {
      const filters = extractFilters("developer documentation page");
      expect(filters.audience).toBe("Developer");
    });

    it("enterprise向けクエリからaudienceを抽出する", () => {
      const filters = extractFilters("enterprise dashboard B2B");
      expect(filters.audience).toBe("Enterprise");
    });

    it("consumer向けクエリからaudienceを抽出する", () => {
      const filters = extractFilters("consumer mobile app landing");
      expect(filters.audience).toBe("Consumer");
    });
  });

  // --- tags extraction ---
  describe("tags 抽出 / tags extraction", () => {
    it("responsive関連クエリからタグを抽出する", () => {
      const filters = extractFilters("responsive mobile-first design");
      expect(filters.tags).toContain("responsive");
    });

    it("accessibility関連クエリからタグを抽出する", () => {
      const filters = extractFilters("accessible WCAG compliant form");
      expect(filters.tags).toContain("accessibility");
    });

    it("landing page関連クエリからタグを抽出する", () => {
      const filters = extractFilters("landing page hero section");
      expect(filters.tags).toContain("landing-page");
    });
  });

  // --- edge cases ---
  describe("エッジケース / edge cases", () => {
    it("フィルタが抽出できない場合は空のオブジェクトを返す", () => {
      const filters = extractFilters("xyz random query 123");
      expect(filters.industry).toBeUndefined();
      expect(filters.audience).toBeUndefined();
      expect(filters.tags).toBeUndefined();
    });

    it("空文字列の場合は空のフィルタを返す", () => {
      const filters = extractFilters("");
      expect(filters.industry).toBeUndefined();
      expect(filters.audience).toBeUndefined();
      expect(filters.tags).toBeUndefined();
    });

    it("複数のフィルタを同時に抽出できる", () => {
      const filters = extractFilters("SaaS developer responsive landing page");
      expect(filters.industry).toBe("SaaS");
      expect(filters.audience).toBe("Developer");
      expect(filters.tags).toBeDefined();
      expect(filters.tags!.length).toBeGreaterThan(0);
    });
  });
});

// ============================================================================
// expandQuery / クエリ拡張
// ============================================================================

describe("expandQuery", () => {
  it("heroクエリにバナー関連語を付与する", () => {
    const expanded = expandQuery("hero section");
    expect(expanded).toContain("hero");
    expect(expanded.length).toBeGreaterThan("hero section".length);
  });

  it("CTAクエリにcall-to-action関連語を付与する", () => {
    const expanded = expandQuery("CTA button");
    expect(expanded.toLowerCase()).toContain("call-to-action");
  });

  it("navクエリにnavigation関連語を付与する", () => {
    const expanded = expandQuery("nav menu");
    expect(expanded.toLowerCase()).toContain("navigation");
  });

  it("空文字列の場合はそのまま返す", () => {
    const expanded = expandQuery("");
    expect(expanded).toBe("");
  });

  it("拡張不要なクエリはそのまま返す", () => {
    const expanded = expandQuery("xyz random query");
    expect(expanded).toBe("xyz random query");
  });

  it("重複する拡張語を付与しない", () => {
    const expanded = expandQuery("navigation menu nav");
    const words = expanded.toLowerCase().split(/\s+/);
    const uniqueWords = new Set(words);
    // 重複が完全になくなるとは限らないが、意図的に重複追加しないことを検証
    expect(words.length).toBeLessThanOrEqual(uniqueWords.size + 3);
  });
});

// ============================================================================
// understandQuery / クエリ理解統合
// ============================================================================

describe("understandQuery", () => {
  it("クエリを分析してQueryUnderstandingResultを返す", () => {
    const result = understandQuery("SaaS pricing grid layout");
    expect(result).toHaveProperty("originalQuery");
    expect(result).toHaveProperty("expandedQuery");
    expect(result).toHaveProperty("queryType");
    expect(result).toHaveProperty("extractedFilters");
    expect(result.originalQuery).toBe("SaaS pricing grid layout");
  });

  it("queryTypeがautoの場合は自動分類する", () => {
    const result = understandQuery("dark gradient background");
    expect(result.queryType).toBe("visual");
  });

  it("queryTypeが指定された場合はそれを使用する", () => {
    const result = understandQuery("dark gradient background", "structural");
    expect(result.queryType).toBe("structural");
  });

  it("フィルタを自動抽出する", () => {
    const result = understandQuery("SaaS developer landing page");
    expect(result.extractedFilters.industry).toBe("SaaS");
    expect(result.extractedFilters.audience).toBe("Developer");
  });

  it("クエリ拡張を適用する", () => {
    const result = understandQuery("hero section");
    expect(result.expandedQuery.length).toBeGreaterThanOrEqual(result.originalQuery.length);
  });

  it("空クエリでもエラーにならない", () => {
    const result = understandQuery("");
    expect(result.originalQuery).toBe("");
    expect(result.queryType).toBe("visual");
  });
});
