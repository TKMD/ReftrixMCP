-- CreateTable: design_systems
-- Description: デザインシステムの構造トークンを管理するテーブル
-- BrandPaletteは色に特化、DesignSystemは構造トークン（余白、角丸、影、タイポ等）を管理

CREATE TABLE "design_systems" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(250) NOT NULL,
    "description" TEXT,
    "spacing_scale" JSONB NOT NULL DEFAULT '{}',
    "corner_radius_set" JSONB NOT NULL DEFAULT '{}',
    "shadow_tokens" JSONB NOT NULL DEFAULT '{}',
    "typography_scale" JSONB NOT NULL DEFAULT '{}',
    "icon_spec" JSONB NOT NULL DEFAULT '{}',
    "default_svg_spec" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "brand_palette_id" UUID,
    "project_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "design_systems_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: Unique constraint on slug
CREATE UNIQUE INDEX "design_systems_slug_key" ON "design_systems"("slug");

-- CreateIndex: Unique constraint on brand_palette_id (1:1 relation)
CREATE UNIQUE INDEX "design_systems_brand_palette_id_key" ON "design_systems"("brand_palette_id");

-- CreateIndex: Unique constraint on project_id (1:1 relation)
CREATE UNIQUE INDEX "design_systems_project_id_key" ON "design_systems"("project_id");

-- CreateIndex: Index on is_default for quick default lookup
CREATE INDEX "design_systems_is_default_idx" ON "design_systems"("is_default");

-- CreateIndex: Index on created_at for sorting
CREATE INDEX "design_systems_created_at_idx" ON "design_systems"("created_at" DESC);

-- AddForeignKey: Relation to brand_palettes (optional 1:1)
ALTER TABLE "design_systems" ADD CONSTRAINT "design_systems_brand_palette_id_fkey" FOREIGN KEY ("brand_palette_id") REFERENCES "brand_palettes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: Relation to projects (optional 1:1)
ALTER TABLE "design_systems" ADD CONSTRAINT "design_systems_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
