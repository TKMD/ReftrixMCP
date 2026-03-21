// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Part Embedding Service Tests
 *
 * パーツEmbedding生成サービスとDB保存サービスのユニットテスト。
 * DINOv2/e5-baseをモックし、テキスト表現構築・検証・バッチ処理をテスト。
 *
 * Unit tests for part embedding generation and DB save services.
 * Mocks DINOv2/e5-base and tests text representation building,
 * validation, and batch processing.
 *
 * @module tests/services/part/part-embedding
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildPartTextRepresentation,
  generateVisualEmbedding,
  generateTextEmbedding,
  generatePartEmbeddings,
  type ComponentPartForEmbedding,
  type ComponentPartWithCrop,
  type EmbeddingServiceLike,
} from "../../../src/services/part/part-embedding.service";
import {
  savePartEmbeddings,
  type PartEmbeddingPrismaClient,
} from "../../../src/services/part/part-embedding-db.service";
import type { DINOv2Service } from "@reftrix/ml";

// ============================================================================
// Test Helpers / テストヘルパー
// ============================================================================

/**
 * テスト用の768D正規化ベクトルを生成
 * Generate a normalized 768D vector for testing
 */
function createMockEmbedding(seed: number = 1): number[] {
  const embedding = new Array(768).fill(0).map((_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
  return embedding.map((v) => v / norm);
}

/**
 * NaN/Infinityを含む768Dベクトルを生成
 * Generate a 768D vector containing NaN/Infinity
 */
function createNaNEmbedding(): number[] {
  const embedding = createMockEmbedding();
  embedding[100] = NaN;
  return embedding;
}

function createInfinityEmbedding(): number[] {
  const embedding = createMockEmbedding();
  embedding[200] = Infinity;
  return embedding;
}

/**
 * ゼロベクトルを生成
 * Generate a zero vector
 */
function createZeroEmbedding(): number[] {
  return new Array(768).fill(0);
}

/**
 * テスト用パーツデータ（基本）
 * Basic test part data
 */
function createBasicPart(
  overrides?: Partial<ComponentPartForEmbedding>
): ComponentPartForEmbedding {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    partType: "button",
    partSubtype: null,
    computedStyles: {},
    cssClasses: [],
    attributes: {},
    interactionInfo: {},
    ...overrides,
  };
}

/**
 * テスト用パーツデータ（cropBuffer付き）
 * Test part data with cropBuffer
 */
function createPartWithCrop(overrides?: Partial<ComponentPartWithCrop>): ComponentPartWithCrop {
  return {
    ...createBasicPart(),
    cropBuffer: Buffer.alloc(224 * 224 * 3, 128),
    ...overrides,
  };
}

/**
 * DINOv2Serviceモックを作成
 * Create DINOv2Service mock
 */
function createMockDINOv2Service(embedding?: number[]): DINOv2Service {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(embedding ?? createMockEmbedding(1)),
    initialize: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  } as unknown as DINOv2Service;
}

/**
 * EmbeddingServiceモックを作成
 * Create EmbeddingService mock
 */
function createMockEmbeddingService(embedding?: number[]): EmbeddingServiceLike {
  return {
    generateEmbedding: vi.fn().mockResolvedValue(embedding ?? createMockEmbedding(2)),
  };
}

/**
 * PrismaClientモックを作成
 * Create PrismaClient mock
 */
function createMockPrismaClient(): PartEmbeddingPrismaClient {
  let idCounter = 0;
  return {
    componentPartEmbedding: {
      create: vi.fn().mockImplementation(() => {
        idCounter++;
        return Promise.resolve({ id: `emb-id-${idCounter}` });
      }),
    },
    $executeRawUnsafe: vi.fn().mockResolvedValue(1),
  };
}

// ============================================================================
// buildPartTextRepresentation Tests
// ============================================================================

describe("buildPartTextRepresentation", () => {
  it("基本パーツタイプのみのテキスト表現を生成する / generates text for basic part type", () => {
    const part = createBasicPart({ partType: "button" });
    const result = buildPartTextRepresentation(part);

    expect(result).toContain("type:button");
    expect(result.startsWith("passage: ")).toBe(true);
  });

  it('"passage: " プレフィックスで始まる / starts with "passage: " prefix', () => {
    const part = createBasicPart();
    const result = buildPartTextRepresentation(part);

    expect(result.startsWith("passage: ")).toBe(true);
  });

  it("サブタイプが含まれる / includes subtype when present", () => {
    const part = createBasicPart({
      partType: "button",
      partSubtype: "primary_button",
    });
    const result = buildPartTextRepresentation(part);

    expect(result).toContain("type:button");
    expect(result).toContain("subtype:primary_button");
  });

  it("スタイル情報が含まれる / includes style information", () => {
    const part = createBasicPart({
      computedStyles: {
        "background-color": "#3b82f6",
        color: "#ffffff",
        "font-size": "16px",
        "border-radius": "8px",
        "box-shadow": "0 2px 4px rgba(0,0,0,0.1)",
      },
    });
    const result = buildPartTextRepresentation(part);

    expect(result).toContain("styles:[");
    expect(result).toContain("background-color:#3b82f6");
    expect(result).toContain("color:#ffffff");
    expect(result).toContain("font-size:16px");
    expect(result).toContain("border-radius:8px");
    expect(result).toContain("box-shadow:");
  });

  it('"none" や "initial" のスタイルは除外される / excludes "none" and "initial" styles', () => {
    const part = createBasicPart({
      computedStyles: {
        "background-color": "#3b82f6",
        border: "none",
        "box-shadow": "initial",
        display: "",
      },
    });
    const result = buildPartTextRepresentation(part);

    expect(result).toContain("background-color:#3b82f6");
    expect(result).not.toContain("border:none");
    expect(result).not.toContain("box-shadow:initial");
  });

  it("CSSクラスが含まれる / includes CSS classes", () => {
    const part = createBasicPart({
      cssClasses: ["btn", "btn-primary", "rounded-lg"],
    });
    const result = buildPartTextRepresentation(part);

    expect(result).toContain("classes:[btn, btn-primary, rounded-lg]");
  });

  it("CSSクラスが10件に制限される / limits CSS classes to 10", () => {
    const classes = Array.from({ length: 15 }, (_, i) => `class-${i}`);
    const part = createBasicPart({ cssClasses: classes });
    const result = buildPartTextRepresentation(part);

    // 最初の10クラスは含まれる / First 10 classes included
    expect(result).toContain("class-0");
    expect(result).toContain("class-9");
    // 11番目以降は含まれない / 11th and beyond excluded
    expect(result).not.toContain("class-10");
  });

  it("属性情報が含まれる / includes attribute information", () => {
    const part = createBasicPart({
      attributes: {
        alt: "Logo image",
        placeholder: "Enter your name",
        "aria-label": "Submit form",
        "data-custom": "value", // TEXT_REPR_ATTRIBUTE_KEYS にない属性は除外
      },
    });
    const result = buildPartTextRepresentation(part);

    expect(result).toContain("attrs:[");
    expect(result).toContain("alt:Logo image");
    expect(result).toContain("placeholder:Enter your name");
    expect(result).toContain("aria-label:Submit form");
    expect(result).not.toContain("data-custom");
  });

  it("インタラクション情報が含まれる / includes interaction information", () => {
    const part = createBasicPart({
      interactionInfo: {
        hasHover: true,
        hasFocus: true,
        hasActive: false,
        hasTransition: true,
      },
    });
    const result = buildPartTextRepresentation(part);

    expect(result).toContain("interaction:[");
    expect(result).toContain("hasHover");
    expect(result).toContain("hasFocus");
    expect(result).toContain("hasTransition");
    expect(result).not.toContain("hasActive");
  });

  it("完全なパーツのテキスト表現を生成する / generates complete text representation", () => {
    const part = createBasicPart({
      partType: "cta",
      partSubtype: "hero_cta",
      computedStyles: {
        "background-color": "#ff6600",
        color: "#fff",
        "border-radius": "24px",
      },
      cssClasses: ["cta-primary", "animate-pulse"],
      attributes: {
        "aria-label": "Get started now",
        role: "button",
      },
      interactionInfo: {
        hasHover: true,
        hasTransition: true,
      },
    });
    const result = buildPartTextRepresentation(part);

    expect(result.startsWith("passage: ")).toBe(true);
    expect(result).toContain("type:cta");
    expect(result).toContain("subtype:hero_cta");
    expect(result).toContain("styles:[");
    expect(result).toContain("classes:[cta-primary, animate-pulse]");
    expect(result).toContain("attrs:[");
    expect(result).toContain("interaction:[");
  });
});

// ============================================================================
// generateVisualEmbedding Tests
// ============================================================================

describe("generateVisualEmbedding", () => {
  it("有効なEmbeddingを返す / returns valid embedding", async () => {
    const mockEmbedding = createMockEmbedding(1);
    const dinov2 = createMockDINOv2Service(mockEmbedding);
    const cropBuffer = Buffer.alloc(224 * 224 * 3, 128);

    const result = await generateVisualEmbedding(dinov2, cropBuffer);

    expect(result).toEqual(mockEmbedding);
    expect(result).toHaveLength(768);
    expect(dinov2.generateEmbedding).toHaveBeenCalledWith(cropBuffer);
  });

  it("NaN含有ベクトルを拒否する [H-3] / rejects NaN vector [H-3]", async () => {
    const nanEmbedding = createNaNEmbedding();
    const dinov2 = createMockDINOv2Service(nanEmbedding);
    const cropBuffer = Buffer.alloc(224 * 224 * 3, 128);

    await expect(generateVisualEmbedding(dinov2, cropBuffer)).rejects.toThrow(
      "Invalid visual embedding: contains NaN or Infinity"
    );
  });

  it("Infinity含有ベクトルを拒否する [H-3] / rejects Infinity vector [H-3]", async () => {
    const infEmbedding = createInfinityEmbedding();
    const dinov2 = createMockDINOv2Service(infEmbedding);
    const cropBuffer = Buffer.alloc(224 * 224 * 3, 128);

    await expect(generateVisualEmbedding(dinov2, cropBuffer)).rejects.toThrow(
      "Invalid visual embedding: contains NaN or Infinity"
    );
  });

  it("ゼロベクトルを拒否する [H-3] / rejects zero vector [H-3]", async () => {
    const zeroEmbedding = createZeroEmbedding();
    const dinov2 = createMockDINOv2Service(zeroEmbedding);
    const cropBuffer = Buffer.alloc(224 * 224 * 3, 128);

    await expect(generateVisualEmbedding(dinov2, cropBuffer)).rejects.toThrow(
      "Invalid visual embedding: zero vector (L2 norm is 0)"
    );
  });

  it("次元数が768でない場合にエラーを投げる / throws on dimension mismatch", async () => {
    const shortEmbedding = new Array(256).fill(0.1);
    const dinov2 = createMockDINOv2Service(shortEmbedding);
    const cropBuffer = Buffer.alloc(224 * 224 * 3, 128);

    await expect(generateVisualEmbedding(dinov2, cropBuffer)).rejects.toThrow(
      "Visual embedding dimension mismatch"
    );
  });
});

// ============================================================================
// generateTextEmbedding Tests
// ============================================================================

describe("generateTextEmbedding", () => {
  it("有効なEmbeddingを返す / returns valid embedding", async () => {
    const mockEmbedding = createMockEmbedding(2);
    const embeddingService = createMockEmbeddingService(mockEmbedding);
    const textRepr = "passage: type:button styles:[color:#fff]";

    const result = await generateTextEmbedding(embeddingService, textRepr);

    expect(result).toEqual(mockEmbedding);
    expect(result).toHaveLength(768);
    // "passage: " プレフィックスを除去してから渡す
    expect(embeddingService.generateEmbedding).toHaveBeenCalledWith(
      "type:button styles:[color:#fff]",
      "passage"
    );
  });

  it('"passage: " プレフィックスを除去して渡す / strips "passage: " prefix before passing', async () => {
    const embeddingService = createMockEmbeddingService();
    const textRepr = "passage: type:card subtype:product_card";

    await generateTextEmbedding(embeddingService, textRepr);

    expect(embeddingService.generateEmbedding).toHaveBeenCalledWith(
      "type:card subtype:product_card",
      "passage"
    );
  });

  it("プレフィックスなしのテキストもそのまま渡す / passes text without prefix as-is", async () => {
    const embeddingService = createMockEmbeddingService();
    const textRepr = "type:icon classes:[icon-sm]";

    await generateTextEmbedding(embeddingService, textRepr);

    expect(embeddingService.generateEmbedding).toHaveBeenCalledWith(
      "type:icon classes:[icon-sm]",
      "passage"
    );
  });

  it("NaN含有ベクトルを拒否する [H-3] / rejects NaN vector [H-3]", async () => {
    const nanEmbedding = createNaNEmbedding();
    const embeddingService = createMockEmbeddingService(nanEmbedding);

    await expect(generateTextEmbedding(embeddingService, "passage: type:button")).rejects.toThrow(
      "Invalid text embedding: contains NaN or Infinity"
    );
  });
});

// ============================================================================
// generatePartEmbeddings Tests
// ============================================================================

describe("generatePartEmbeddings", () => {
  let dinov2: DINOv2Service;
  let embeddingService: EmbeddingServiceLike;

  beforeEach(() => {
    dinov2 = createMockDINOv2Service();
    embeddingService = createMockEmbeddingService();
  });

  it("空配列を処理する / handles empty array", async () => {
    const results = await generatePartEmbeddings([], dinov2, embeddingService);

    expect(results).toEqual([]);
  });

  it("cropBuffer付きパーツをvisual+text両方生成する / generates visual+text for parts with cropBuffer", async () => {
    const parts: ComponentPartWithCrop[] = [
      createPartWithCrop({ id: "part-1", partType: "button" }),
    ];

    const results = await generatePartEmbeddings(parts, dinov2, embeddingService);

    expect(results).toHaveLength(1);
    expect(results[0]!.componentPartId).toBe("part-1");
    expect(results[0]!.visualEmbedding).not.toBeNull();
    expect(results[0]!.visualEmbedding).toHaveLength(768);
    expect(results[0]!.textEmbedding).toHaveLength(768);
    expect(results[0]!.textRepresentation.startsWith("passage: ")).toBe(true);
  });

  it("cropBuffer=nullのパーツはvisualEmbeddingがnull / null cropBuffer results in null visualEmbedding", async () => {
    const parts: ComponentPartWithCrop[] = [
      createPartWithCrop({ id: "part-logo", partType: "icon", cropBuffer: null }),
    ];

    const results = await generatePartEmbeddings(parts, dinov2, embeddingService);

    expect(results).toHaveLength(1);
    expect(results[0]!.visualEmbedding).toBeNull();
    expect(results[0]!.textEmbedding).toHaveLength(768);
    // DINOv2は呼ばれない / DINOv2 should not be called
    expect(dinov2.generateEmbedding).not.toHaveBeenCalled();
  });

  it("複数パーツをバッチ処理する / processes multiple parts in batch", async () => {
    const parts: ComponentPartWithCrop[] = [
      createPartWithCrop({ id: "part-1", partType: "button" }),
      createPartWithCrop({ id: "part-2", partType: "card", cropBuffer: null }),
      createPartWithCrop({ id: "part-3", partType: "heading" }),
    ];

    const results = await generatePartEmbeddings(parts, dinov2, embeddingService);

    expect(results).toHaveLength(3);
    expect(results[0]!.visualEmbedding).not.toBeNull();
    expect(results[1]!.visualEmbedding).toBeNull(); // no cropBuffer
    expect(results[2]!.visualEmbedding).not.toBeNull();
  });

  it("chunkSizeオプションを受け付ける / respects chunkSize option", async () => {
    const parts: ComponentPartWithCrop[] = Array.from({ length: 8 }, (_, i) =>
      createPartWithCrop({ id: `part-${i}`, partType: "button" })
    );

    const results = await generatePartEmbeddings(parts, dinov2, embeddingService, {
      chunkSize: 3,
    });

    expect(results).toHaveLength(8);
  });

  it("部分失敗しても継続する（Graceful Degradation） / continues on partial failure", async () => {
    // 2番目のパーツでDINOv2がエラー
    let callCount = 0;
    const failingDinov2 = {
      generateEmbedding: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 2) {
          return Promise.reject(new Error("OOM in DINOv2"));
        }
        return Promise.resolve(createMockEmbedding(callCount));
      }),
    } as unknown as DINOv2Service;

    const parts: ComponentPartWithCrop[] = [
      createPartWithCrop({ id: "part-1", partType: "button" }),
      createPartWithCrop({ id: "part-2", partType: "card" }),
      createPartWithCrop({ id: "part-3", partType: "heading" }),
    ];

    const results = await generatePartEmbeddings(parts, failingDinov2, embeddingService);

    // 2番目が失敗しても1番目と3番目は成功 / 1st and 3rd succeed despite 2nd failure
    expect(results).toHaveLength(2);
    expect(results[0]!.componentPartId).toBe("part-1");
    expect(results[1]!.componentPartId).toBe("part-3");
  });
});

// ============================================================================
// savePartEmbeddings Tests
// ============================================================================

describe("savePartEmbeddings", () => {
  it("空配列を処理する / handles empty array", async () => {
    const prisma = createMockPrismaClient();

    const result = await savePartEmbeddings(prisma, []);

    expect(result.savedCount).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it("visual+text両方のEmbeddingを保存する / saves both visual and text embeddings", async () => {
    const prisma = createMockPrismaClient();
    const embeddings = [
      {
        componentPartId: "part-1",
        visualEmbedding: createMockEmbedding(1),
        textEmbedding: createMockEmbedding(2),
        textRepresentation: "passage: type:button",
      },
    ];

    const result = await savePartEmbeddings(prisma, embeddings);

    expect(result.savedCount).toBe(1);
    expect(result.errors).toEqual([]);

    // Step 1: Prisma create が呼ばれる
    expect(prisma.componentPartEmbedding.create).toHaveBeenCalledTimes(1);
    expect(prisma.componentPartEmbedding.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        componentPartId: "part-1",
        textRepresentation: "passage: type:button",
        visualModelVersion: "dinov2-vit-b14",
        textModelVersion: "multilingual-e5-base",
      }),
    });

    // Step 2: raw SQL で vector 更新（visual + text 両方）
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const rawCall = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0]!;
    expect(rawCall[0]).toContain("visual_embedding = $1::vector(768)");
    expect(rawCall[0]).toContain("text_embedding = $2::vector(768)");
  });

  it("visualEmbedding=nullの場合はtextのみ更新する / updates text only when visualEmbedding is null", async () => {
    const prisma = createMockPrismaClient();
    const embeddings = [
      {
        componentPartId: "part-logo",
        visualEmbedding: null,
        textEmbedding: createMockEmbedding(2),
        textRepresentation: "passage: type:icon",
      },
    ];

    const result = await savePartEmbeddings(prisma, embeddings);

    expect(result.savedCount).toBe(1);
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const rawCall = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0]!;
    // visual_embedding は含まれない / visual_embedding not included
    expect(rawCall[0]).not.toContain("visual_embedding");
    expect(rawCall[0]).toContain("text_embedding = $1::vector(768)");
  });

  it("部分失敗時にエラーを記録して継続する / records errors and continues on partial failure", async () => {
    const prisma = createMockPrismaClient();
    // 2番目のcreateでエラー
    let createCount = 0;
    vi.mocked(prisma.componentPartEmbedding.create).mockImplementation(() => {
      createCount++;
      if (createCount === 2) {
        return Promise.reject(new Error("Unique constraint violation"));
      }
      return Promise.resolve({ id: `emb-id-${createCount}` });
    });

    const embeddings = [
      {
        componentPartId: "part-1",
        visualEmbedding: createMockEmbedding(1),
        textEmbedding: createMockEmbedding(2),
        textRepresentation: "passage: type:button",
      },
      {
        componentPartId: "part-2",
        visualEmbedding: createMockEmbedding(3),
        textEmbedding: createMockEmbedding(4),
        textRepresentation: "passage: type:card",
      },
      {
        componentPartId: "part-3",
        visualEmbedding: null,
        textEmbedding: createMockEmbedding(5),
        textRepresentation: "passage: type:icon",
      },
    ];

    const result = await savePartEmbeddings(prisma, embeddings);

    expect(result.savedCount).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("part-2");
    expect(result.errors[0]).toContain("Unique constraint violation");
  });

  it("正しいvectorフォーマット文字列を生成する / generates correct vector format string", async () => {
    const prisma = createMockPrismaClient();
    const embedding = [0.1, 0.2, 0.3];
    // 768Dにパディング
    while (embedding.length < 768) {
      embedding.push(0);
    }

    const embeddings = [
      {
        componentPartId: "part-1",
        visualEmbedding: embedding,
        textEmbedding: embedding,
        textRepresentation: "passage: type:button",
      },
    ];

    await savePartEmbeddings(prisma, embeddings);

    const rawCall = vi.mocked(prisma.$executeRawUnsafe).mock.calls[0]!;
    // $1がvisual vector string, $2がtext vector string, $3がid
    const visualVectorStr = rawCall[1] as string;
    expect(visualVectorStr.startsWith("[")).toBe(true);
    expect(visualVectorStr.endsWith("]")).toBe(true);
    expect(visualVectorStr).toContain("0.1,0.2,0.3");
  });
});
