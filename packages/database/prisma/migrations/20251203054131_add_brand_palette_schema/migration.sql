-- CreateEnum
CREATE TYPE "PaletteMode" AS ENUM ('light', 'dark', 'system');

-- CreateEnum
CREATE TYPE "ColorRole" AS ENUM ('primary', 'secondary', 'accent', 'neutral', 'semantic');

-- CreateTable
CREATE TABLE "brand_palettes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "mode" "PaletteMode" NOT NULL DEFAULT 'light',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "brand_palettes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "color_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "palette_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "hex" VARCHAR(7) NOT NULL,
    "oklch_l" DOUBLE PRECISION NOT NULL,
    "oklch_c" DOUBLE PRECISION NOT NULL,
    "oklch_h" DOUBLE PRECISION NOT NULL,
    "role" "ColorRole" NOT NULL,
    "semantic_meaning" VARCHAR(200),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "color_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brand_palettes_slug_key" ON "brand_palettes"("slug");

-- CreateIndex
CREATE INDEX "brand_palettes_mode_idx" ON "brand_palettes"("mode");

-- CreateIndex
CREATE INDEX "brand_palettes_is_default_idx" ON "brand_palettes"("is_default");

-- CreateIndex
CREATE INDEX "color_tokens_palette_id_idx" ON "color_tokens"("palette_id");

-- CreateIndex
CREATE INDEX "color_tokens_role_idx" ON "color_tokens"("role");

-- CreateIndex
CREATE UNIQUE INDEX "color_tokens_palette_id_name_key" ON "color_tokens"("palette_id", "name");

-- AddForeignKey
ALTER TABLE "color_tokens" ADD CONSTRAINT "color_tokens_palette_id_fkey" FOREIGN KEY ("palette_id") REFERENCES "brand_palettes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
