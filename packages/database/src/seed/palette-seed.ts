// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Reftrix Brand Palette Seed Script
 *
 * MCPツール style.get_palette, style.apply で使用するブランドパレットの初期データ
 * OKLCHカラースペースでの色値を保持（モダンCSS対応）
 *
 * @see schema.prisma - BrandPalette, ColorToken models
 */

import type { PrismaClient, ColorRole, PaletteMode } from "@prisma/client";

/**
 * パレットシードデータを投入
 * upsertを使用して再実行可能（idempotent）な設計
 */
export async function seedPalettes(prisma: PrismaClient): Promise<{
  standardPalette: { id: string; name: string };
  darkPalette: { id: string; name: string };
}> {
  console.log("[Seed:Palettes] ブランドパレットのシード開始...");

  // ============================================================================
  // Reftrix Standard パレット（ライトモード）
  // ============================================================================
  const standardPalette = await prisma.brandPalette.upsert({
    where: { slug: "reftrix-standard" },
    update: {
      name: "Reftrix Standard",
      description: "Reftrixのデフォルトブランドパレット",
      mode: "light" as PaletteMode,
      isDefault: true,
    },
    create: {
      name: "Reftrix Standard",
      slug: "reftrix-standard",
      description: "Reftrixのデフォルトブランドパレット",
      mode: "light" as PaletteMode,
      isDefault: true,
    },
  });

  // Standard パレットのカラートークン
  const standardTokens = [
    {
      name: "Primary Blue",
      hex: "#3B82F6",
      oklchL: 0.623,
      oklchC: 0.214,
      oklchH: 259.7,
      role: "primary" as ColorRole,
      sortOrder: 0,
    },
    {
      name: "Secondary Indigo",
      hex: "#6366F1",
      oklchL: 0.585,
      oklchC: 0.241,
      oklchH: 279.0,
      role: "secondary" as ColorRole,
      sortOrder: 1,
    },
    {
      name: "Accent Violet",
      hex: "#8B5CF6",
      oklchL: 0.586,
      oklchC: 0.234,
      oklchH: 293.0,
      role: "accent" as ColorRole,
      sortOrder: 2,
    },
    {
      name: "Neutral Gray",
      hex: "#6B7280",
      oklchL: 0.554,
      oklchC: 0.022,
      oklchH: 258.0,
      role: "neutral" as ColorRole,
      sortOrder: 3,
    },
    {
      name: "Success Green",
      hex: "#22C55E",
      oklchL: 0.723,
      oklchC: 0.213,
      oklchH: 142.5,
      role: "semantic" as ColorRole,
      semanticMeaning: "success",
      sortOrder: 4,
    },
    {
      name: "Error Red",
      hex: "#EF4444",
      oklchL: 0.628,
      oklchC: 0.258,
      oklchH: 27.0,
      role: "semantic" as ColorRole,
      semanticMeaning: "error",
      sortOrder: 5,
    },
    {
      name: "Warning Amber",
      hex: "#F59E0B",
      oklchL: 0.769,
      oklchC: 0.188,
      oklchH: 84.0,
      role: "semantic" as ColorRole,
      semanticMeaning: "warning",
      sortOrder: 6,
    },
    {
      name: "Info Cyan",
      hex: "#06B6D4",
      oklchL: 0.714,
      oklchC: 0.134,
      oklchH: 203.0,
      role: "semantic" as ColorRole,
      semanticMeaning: "info",
      sortOrder: 7,
    },
  ];

  // 既存トークンを削除して再作成（upsertの複合キーが複雑なため）
  await prisma.colorToken.deleteMany({
    where: { paletteId: standardPalette.id },
  });

  for (const token of standardTokens) {
    await prisma.colorToken.create({
      data: {
        paletteId: standardPalette.id,
        ...token,
      },
    });
  }

  console.log(`  [CREATE/UPDATE] ${standardPalette.name} (${standardTokens.length} tokens)`);

  // ============================================================================
  // Reftrix Dark パレット（ダークモード）
  // ============================================================================
  const darkPalette = await prisma.brandPalette.upsert({
    where: { slug: "reftrix-dark" },
    update: {
      name: "Reftrix Dark",
      description: "Reftrixのダークモードパレット",
      mode: "dark" as PaletteMode,
      isDefault: false,
    },
    create: {
      name: "Reftrix Dark",
      slug: "reftrix-dark",
      description: "Reftrixのダークモードパレット",
      mode: "dark" as PaletteMode,
      isDefault: false,
    },
  });

  // Dark パレットのカラートークン（明度を上げた版）
  const darkTokens = [
    {
      name: "Primary Blue Light",
      hex: "#60A5FA",
      oklchL: 0.728,
      oklchC: 0.18,
      oklchH: 254.0,
      role: "primary" as ColorRole,
      sortOrder: 0,
    },
    {
      name: "Secondary Indigo Light",
      hex: "#818CF8",
      oklchL: 0.695,
      oklchC: 0.196,
      oklchH: 277.0,
      role: "secondary" as ColorRole,
      sortOrder: 1,
    },
    {
      name: "Accent Violet Light",
      hex: "#A78BFA",
      oklchL: 0.695,
      oklchC: 0.198,
      oklchH: 290.0,
      role: "accent" as ColorRole,
      sortOrder: 2,
    },
    {
      name: "Neutral Gray Light",
      hex: "#9CA3AF",
      oklchL: 0.718,
      oklchC: 0.018,
      oklchH: 256.0,
      role: "neutral" as ColorRole,
      sortOrder: 3,
    },
    {
      name: "Success Green Light",
      hex: "#4ADE80",
      oklchL: 0.812,
      oklchC: 0.195,
      oklchH: 145.0,
      role: "semantic" as ColorRole,
      semanticMeaning: "success",
      sortOrder: 4,
    },
    {
      name: "Error Red Light",
      hex: "#F87171",
      oklchL: 0.718,
      oklchC: 0.196,
      oklchH: 25.0,
      role: "semantic" as ColorRole,
      semanticMeaning: "error",
      sortOrder: 5,
    },
    {
      name: "Warning Amber Light",
      hex: "#FBBF24",
      oklchL: 0.852,
      oklchC: 0.178,
      oklchH: 86.0,
      role: "semantic" as ColorRole,
      semanticMeaning: "warning",
      sortOrder: 6,
    },
    {
      name: "Info Cyan Light",
      hex: "#22D3EE",
      oklchL: 0.802,
      oklchC: 0.124,
      oklchH: 201.0,
      role: "semantic" as ColorRole,
      semanticMeaning: "info",
      sortOrder: 7,
    },
  ];

  // 既存トークンを削除して再作成
  await prisma.colorToken.deleteMany({
    where: { paletteId: darkPalette.id },
  });

  for (const token of darkTokens) {
    await prisma.colorToken.create({
      data: {
        paletteId: darkPalette.id,
        ...token,
      },
    });
  }

  console.log(`  [CREATE/UPDATE] ${darkPalette.name} (${darkTokens.length} tokens)`);

  // ============================================================================
  // サマリー表示
  // ============================================================================
  console.log("[Seed:Palettes] 完了:");
  console.log(`  - パレット数: 2`);
  console.log(`  - トークン総数: ${standardTokens.length + darkTokens.length}`);

  return { standardPalette, darkPalette };
}
