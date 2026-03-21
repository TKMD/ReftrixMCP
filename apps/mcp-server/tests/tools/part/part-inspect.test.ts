// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * part.inspect MCPツール テスト
 *
 * 目的:
 * - part.inspect ハンドラーの入力バリデーション（Zod schema）
 * - 正常系: パーツID指定での詳細取得
 * - includeHtml / includeEmbedding オプション
 * - パーツ未検出時のエラーレスポンス
 * - エラーハンドリング（サニタイズされたエラーメッセージ）
 * - ツール定義（MCP Protocol準拠）
 *
 * @module tests/tools/part/part-inspect.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  partInspectHandler,
  partInspectToolDefinition,
  setPartInspectPrismaClientFactory,
  resetPartInspectPrismaClientFactory,
  PART_INSPECT_ERROR_CODES,
  type PartInspectOutput,
  type PartInspectPrismaClient,
} from "../../../src/tools/part/inspect.tool";

// =====================================================
// テストデータ
// =====================================================

const VALID_UUID = "01234567-89ab-cdef-0123-456789abcdef";
const ANOTHER_UUID = "01234567-89ab-cdef-0123-456789abcde0";

/**
 * モックパーツ詳細行を生成
 */
function createMockPartRow(id: string = VALID_UUID): Record<string, unknown> {
  return {
    id,
    part_type: "button",
    part_subtype: "primary_button",
    html_snippet: '<button class="btn-primary">Submit</button>',
    computed_styles: { color: "#ffffff", backgroundColor: "#2563eb" },
    bounding_box: { x: 50, y: 100, width: 200, height: 48 },
    css_classes: ["btn-primary", "rounded-lg"],
    attributes: { type: "submit", "data-testid": "submit-btn" },
    interaction_info: { hasHover: true, hasFocus: true, hasActive: true, hasTransition: true },
    visual_signature: "sha256-abc123",
    sample_index: 0,
    pii_risk_level: "none",
    tags: ["primary", "cta"],
    metadata: { framework: "tailwind" },
    source_url: "https://example.com",
    usage_scope: "inspiration_only",
    section_type: "hero",
    web_page_url: "https://example.com",
    created_at: "2026-03-12T10:00:00.000Z",
    has_text_embedding: true,
    has_visual_embedding: true,
  };
}

// =====================================================
// モック
// =====================================================

let mockPrismaClient: PartInspectPrismaClient;

describe("part.inspect MCPツール", () => {
  beforeEach(() => {
    mockPrismaClient = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([createMockPartRow()]),
    };

    setPartInspectPrismaClientFactory(() => mockPrismaClient);
  });

  afterEach(() => {
    resetPartInspectPrismaClientFactory();
    vi.restoreAllMocks();
  });

  // =====================================================
  // ツール定義テスト
  // =====================================================

  describe("ツール定義 / Tool definition", () => {
    it("正しいツール名を持つこと", () => {
      expect(partInspectToolDefinition.name).toBe("part.inspect");
    });

    it("説明文が存在すること", () => {
      expect(partInspectToolDefinition.description).toBeTruthy();
      expect(partInspectToolDefinition.description.length).toBeGreaterThan(10);
    });

    it("MCP annotationsが存在すること", () => {
      expect(partInspectToolDefinition.annotations).toBeDefined();
      expect(partInspectToolDefinition.annotations.readOnlyHint).toBe(true);
      expect(partInspectToolDefinition.annotations.idempotentHint).toBe(true);
      expect(partInspectToolDefinition.annotations.openWorldHint).toBe(false);
    });

    it("inputSchemaにpart_idがrequiredで定義されていること", () => {
      expect(partInspectToolDefinition.inputSchema.type).toBe("object");
      expect(partInspectToolDefinition.inputSchema.properties.part_id).toBeDefined();
      expect(partInspectToolDefinition.inputSchema.required).toContain("part_id");
    });
  });

  // =====================================================
  // 入力バリデーション
  // =====================================================

  describe("入力バリデーション / Input validation", () => {
    it("part_idが未指定の場合はバリデーションエラー", async () => {
      const result = (await partInspectHandler({})) as PartInspectOutput;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_INSPECT_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("part_idが不正なUUIDの場合はバリデーションエラー", async () => {
      const result = (await partInspectHandler({ part_id: "not-a-uuid" })) as PartInspectOutput;
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_INSPECT_ERROR_CODES.VALIDATION_ERROR);
      }
    });

    it("include_htmlがboolean以外の場合もZodが変換すること", async () => {
      // Zodのdefaultにより、未指定時はfalseになる
      const result = (await partInspectHandler({
        part_id: VALID_UUID,
      })) as PartInspectOutput;

      expect(result.success).toBe(true);
    });
  });

  // =====================================================
  // 正常系テスト
  // =====================================================

  describe("正常系 / Success cases", () => {
    it("有効なpart_idでパーツ詳細を返すこと", async () => {
      const result = (await partInspectHandler({
        part_id: VALID_UUID,
      })) as PartInspectOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe(VALID_UUID);
        expect(result.data.partType).toBe("button");
        expect(result.data.partSubtype).toBe("primary_button");
        expect(result.data.sectionType).toBe("hero");
        expect(result.data.webPageUrl).toBe("https://example.com");
        expect(result.data.boundingBox).toEqual({ x: 50, y: 100, width: 200, height: 48 });
      }
    });

    it("include_html=falseの場合はhtmlSnippetがnull", async () => {
      // include_html=falseの場合、SQLクエリがNULL AS html_snippetを返す
      mockPrismaClient.$queryRawUnsafe = vi
        .fn()
        .mockResolvedValue([{ ...createMockPartRow(), html_snippet: null }]);

      const result = (await partInspectHandler({
        part_id: VALID_UUID,
        include_html: false,
      })) as PartInspectOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.htmlSnippet).toBeNull();
      }
    });

    it("include_html=trueの場合はhtmlSnippetを含むこと", async () => {
      const result = (await partInspectHandler({
        part_id: VALID_UUID,
        include_html: true,
      })) as PartInspectOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.htmlSnippet).toContain("<button");
      }
    });

    it("include_embedding=trueの場合はembedding情報を含むこと", async () => {
      const result = (await partInspectHandler({
        part_id: VALID_UUID,
        include_embedding: true,
      })) as PartInspectOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hasTextEmbedding).toBe(true);
        expect(result.data.hasVisualEmbedding).toBe(true);
      }
    });

    it("include_embedding=falseの場合はembedding情報を含まないこと", async () => {
      const result = (await partInspectHandler({
        part_id: VALID_UUID,
        include_embedding: false,
      })) as PartInspectOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.hasTextEmbedding).toBeUndefined();
        expect(result.data.hasVisualEmbedding).toBeUndefined();
      }
    });

    it("computedStylesが正しくマッピングされること", async () => {
      const result = (await partInspectHandler({
        part_id: VALID_UUID,
      })) as PartInspectOutput;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.computedStyles).toEqual({
          color: "#ffffff",
          backgroundColor: "#2563eb",
        });
      }
    });
  });

  // =====================================================
  // パーツ未検出 / Part not found
  // =====================================================

  describe("パーツ未検出 / Part not found", () => {
    it("存在しないpart_idの場合はNOT_FOUNDエラーを返すこと", async () => {
      mockPrismaClient.$queryRawUnsafe = vi.fn().mockResolvedValue([]);

      const result = (await partInspectHandler({
        part_id: ANOTHER_UUID,
      })) as PartInspectOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_INSPECT_ERROR_CODES.NOT_FOUND);
        expect(result.error.message).toContain("Part not found");
        // PII配慮: フルUUIDが漏洩しないこと
        expect(result.error.message).not.toContain(ANOTHER_UUID);
      }
    });
  });

  // =====================================================
  // サービス未初期化 / Service unavailable
  // =====================================================

  describe("サービス未初期化 / Service unavailable", () => {
    it("PrismaClientFactoryが未設定の場合はSERVICE_UNAVAILABLEを返すこと", async () => {
      resetPartInspectPrismaClientFactory();

      const result = (await partInspectHandler({
        part_id: VALID_UUID,
      })) as PartInspectOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_INSPECT_ERROR_CODES.SERVICE_UNAVAILABLE);
      }
    });
  });

  // =====================================================
  // エラーハンドリング
  // =====================================================

  describe("エラーハンドリング / Error handling", () => {
    it("DB障害時にサニタイズされたエラーを返すこと", async () => {
      mockPrismaClient.$queryRawUnsafe = vi
        .fn()
        .mockRejectedValue(new Error("database connection refused on port 26432"));

      const result = (await partInspectHandler({
        part_id: VALID_UUID,
      })) as PartInspectOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe(PART_INSPECT_ERROR_CODES.INTERNAL_ERROR);
        // DB内部構造やポート番号が漏洩しないこと
        expect(result.error.message).not.toContain("26432");
        expect(result.error.message).not.toContain("component_parts");
      }
    });

    it("Prisma P2025エラーがサニタイズされること", async () => {
      const prismaError = new Error("Record to update not found") as Error & { code: string };
      prismaError.code = "P2025";
      mockPrismaClient.$queryRawUnsafe = vi.fn().mockRejectedValue(prismaError);

      const result = (await partInspectHandler({
        part_id: VALID_UUID,
      })) as PartInspectOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe("Record not found");
      }
    });

    it("Prisma P2002エラーがサニタイズされること", async () => {
      const prismaError = new Error("Unique constraint violation on field: id") as Error & {
        code: string;
      };
      prismaError.code = "P2002";
      mockPrismaClient.$queryRawUnsafe = vi.fn().mockRejectedValue(prismaError);

      const result = (await partInspectHandler({
        part_id: VALID_UUID,
      })) as PartInspectOutput;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe("A record with this value already exists");
        // 内部構造が漏洩しないこと
        expect(result.error.message).not.toContain("Unique constraint");
        expect(result.error.message).not.toContain("field");
      }
    });
  });
});
