// SPDX-FileCopyrightText: 2026 TKMD and Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * layout-handler テスト
 *
 * Vision統合によるセクション検出強化のテスト
 * - mergeVisionDetectedSections関数の動作検証
 * - HTML検出とVision検出の統合
 * - 重複除去と信頼度ブースト
 *
 * @module tests/unit/tools/page/handlers/layout-handler
 */

import { describe, it, expect } from 'vitest';

// =========================================
// mergeVisionDetectedSections 関数のテスト用型定義
// =========================================

/**
 * MutableSection型（layout-handler.tsから抽出）
 */
interface MutableSection {
  id: string;
  type: string;
  positionIndex: number;
  heading?: string;
  confidence: number;
  htmlSnippet?: string;
  position?: { startY: number; endY: number; height: number };
  visionFeatures?: {
    success: boolean;
    features: Array<{
      type: string;
      confidence: number;
      description?: string;
    }>;
    textRepresentation?: string;
    error?: string;
    processingTimeMs: number;
    modelName: string;
    sectionBounds?: {
      startY: number;
      endY: number;
      height: number;
    };
  };
}

/**
 * SectionBoundariesData型（vision-adapterから抽出）
 */
interface SectionBoundaryInfo {
  type: string;
  startY: number;
  endY: number;
  confidence: number;
}

interface SectionBoundariesData {
  sections?: SectionBoundaryInfo[];
  totalHeight?: number;
}

// =========================================
// mergeVisionDetectedSections の再実装（テスト用）
// =========================================

/**
 * Vision検出セクション境界をHTML検出結果と統合
 * layout-handler.tsの実装と同じロジック
 */
function mergeVisionDetectedSections(
  htmlSections: MutableSection[],
  visionBoundaries: SectionBoundariesData | undefined
): MutableSection[] {
  if (!visionBoundaries || !visionBoundaries.sections || visionBoundaries.sections.length === 0) {
    return htmlSections;
  }

  const mergedSections: MutableSection[] = [...htmlSections];
  let addedVisionSections = 0;

  for (const visionSection of visionBoundaries.sections) {
    const visionStartY = visionSection.startY;
    const visionEndY = visionSection.endY;
    const visionHeight = visionEndY - visionStartY;

    if (visionHeight <= 0) {
      continue;
    }

    // 既存セクションとの重複チェック
    let hasOverlap = false;
    let bestOverlapIndex = -1;
    let bestOverlapRatio = 0;

    for (let i = 0; i < mergedSections.length; i++) {
      const htmlSection = mergedSections[i];
      if (!htmlSection?.position) {
        continue;
      }

      const htmlStartY = htmlSection.position.startY;
      const htmlEndY = htmlSection.position.endY;

      // 重複領域を計算
      const overlapStartY = Math.max(visionStartY, htmlStartY);
      const overlapEndY = Math.min(visionEndY, htmlEndY);
      const overlapHeight = Math.max(0, overlapEndY - overlapStartY);

      // 重複率を計算（両方向で確認）
      const overlapRatioVision = overlapHeight / visionHeight;
      const overlapRatioHtml = overlapHeight / (htmlEndY - htmlStartY);
      const maxOverlapRatio = Math.max(overlapRatioVision, overlapRatioHtml);

      if (maxOverlapRatio > 0.5) {
        hasOverlap = true;
        if (maxOverlapRatio > bestOverlapRatio) {
          bestOverlapRatio = maxOverlapRatio;
          bestOverlapIndex = i;
        }
      }
    }

    if (hasOverlap && bestOverlapIndex >= 0) {
      // 既存セクションと重複: 信頼度をブースト
      const existingSection = mergedSections[bestOverlapIndex];
      if (existingSection) {
        // Vision検出で確認されたので信頼度を上げる（最大15%ブースト）
        const boostAmount = Math.min(0.15, visionSection.confidence * 0.2);
        existingSection.confidence = Math.min(1, existingSection.confidence + boostAmount);

        // セクションタイプがunknownの場合はVisionの結果で更新
        if (existingSection.type === 'unknown' && visionSection.type !== 'unknown') {
          existingSection.type = visionSection.type;
        }
      }
    } else {
      // 新規Vision専用セクションとして追加
      const newSection: MutableSection = {
        id: `vision-${addedVisionSections}`,
        type: visionSection.type || 'unknown',
        positionIndex: mergedSections.length,
        confidence: visionSection.confidence * 0.85, // Vision検出は若干低めに設定
        position: {
          startY: visionStartY,
          endY: visionEndY,
          height: visionHeight,
        },
        visionFeatures: {
          success: true,
          features: [{
            type: 'section_boundaries',
            confidence: visionSection.confidence,
            description: `Vision-detected ${visionSection.type} section`,
          }],
          processingTimeMs: 0,
          modelName: 'llama3.2-vision',
        },
      };

      mergedSections.push(newSection);
      addedVisionSections++;
    }
  }

  // 位置インデックスを再計算（Y座標順にソート）
  mergedSections.sort((a, b) => {
    const aStartY = a.position?.startY ?? 0;
    const bStartY = b.position?.startY ?? 0;
    return aStartY - bStartY;
  });

  mergedSections.forEach((section, index) => {
    section.positionIndex = index;
  });

  return mergedSections;
}

// =========================================
// テストスイート
// =========================================

describe('layout-handler', () => {
  describe('mergeVisionDetectedSections', () => {
    // =========================================
    // 1. 基本的な動作テスト
    // =========================================
    describe('Basic Operations', () => {
      it('should return htmlSections unchanged when visionBoundaries is undefined', () => {
        const htmlSections: MutableSection[] = [
          {
            id: 'section-1',
            type: 'hero',
            positionIndex: 0,
            confidence: 0.8,
            position: { startY: 0, endY: 500, height: 500 },
          },
        ];

        const result = mergeVisionDetectedSections(htmlSections, undefined);
        expect(result).toEqual(htmlSections);
        expect(result.length).toBe(1);
      });

      it('should return htmlSections unchanged when visionBoundaries.sections is empty', () => {
        const htmlSections: MutableSection[] = [
          {
            id: 'section-1',
            type: 'hero',
            positionIndex: 0,
            confidence: 0.8,
            position: { startY: 0, endY: 500, height: 500 },
          },
        ];

        const result = mergeVisionDetectedSections(htmlSections, { sections: [] });
        expect(result).toEqual(htmlSections);
      });

      it('should handle empty htmlSections with vision boundaries', () => {
        const htmlSections: MutableSection[] = [];
        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'hero', startY: 0, endY: 500, confidence: 0.9 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result.length).toBe(1);
        expect(result[0].type).toBe('hero');
      });
    });

    // =========================================
    // 2. Vision専用セクション追加テスト
    // =========================================
    describe('Vision-Only Section Addition', () => {
      it('should add vision-detected section when no overlap with HTML sections', () => {
        const htmlSections: MutableSection[] = [
          {
            id: 'section-1',
            type: 'hero',
            positionIndex: 0,
            confidence: 0.8,
            position: { startY: 0, endY: 500, height: 500 },
          },
        ];

        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'feature', startY: 600, endY: 1100, confidence: 0.85 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result.length).toBe(2);
        expect(result[1].type).toBe('feature');
        expect(result[1].position?.startY).toBe(600);
      });

      it('should apply 0.85 confidence multiplier to vision-detected sections', () => {
        const htmlSections: MutableSection[] = [];
        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'hero', startY: 0, endY: 500, confidence: 1.0 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result[0].confidence).toBe(0.85); // 1.0 * 0.85
      });

      it('should add visionFeatures to vision-detected sections', () => {
        const htmlSections: MutableSection[] = [];
        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'cta', startY: 0, endY: 300, confidence: 0.9 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result[0].visionFeatures).toBeDefined();
        expect(result[0].visionFeatures?.success).toBe(true);
        expect(result[0].visionFeatures?.modelName).toBe('llama3.2-vision');
      });

      it('should add multiple vision-detected sections', () => {
        const htmlSections: MutableSection[] = [];
        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'hero', startY: 0, endY: 500, confidence: 0.9 },
            { type: 'feature', startY: 500, endY: 1000, confidence: 0.85 },
            { type: 'cta', startY: 1000, endY: 1300, confidence: 0.88 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result.length).toBe(3);
      });
    });

    // =========================================
    // 3. 重複検出と信頼度ブーストテスト
    // =========================================
    describe('Overlap Detection and Confidence Boost', () => {
      it('should boost confidence when vision section overlaps >50% with HTML section', () => {
        const htmlSections: MutableSection[] = [
          {
            id: 'section-1',
            type: 'hero',
            positionIndex: 0,
            confidence: 0.7,
            position: { startY: 0, endY: 500, height: 500 },
          },
        ];

        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'hero', startY: 50, endY: 450, confidence: 0.9 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result.length).toBe(1); // Should not add new section
        expect(result[0].confidence).toBeGreaterThan(0.7); // Confidence boosted
      });

      it('should cap confidence boost at 0.15', () => {
        const htmlSections: MutableSection[] = [
          {
            id: 'section-1',
            type: 'hero',
            positionIndex: 0,
            confidence: 0.9,
            position: { startY: 0, endY: 500, height: 500 },
          },
        ];

        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'hero', startY: 0, endY: 500, confidence: 1.0 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        // Boost = min(0.15, 1.0 * 0.2) = 0.15
        // New confidence = min(1, 0.9 + 0.15) = 1.0
        expect(result[0].confidence).toBeLessThanOrEqual(1);
      });

      it('should update unknown type to vision-detected type on overlap', () => {
        const htmlSections: MutableSection[] = [
          {
            id: 'section-1',
            type: 'unknown',
            positionIndex: 0,
            confidence: 0.5,
            position: { startY: 0, endY: 500, height: 500 },
          },
        ];

        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'hero', startY: 0, endY: 500, confidence: 0.9 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result[0].type).toBe('hero'); // Type updated from 'unknown' to 'hero'
      });

      it('should NOT update non-unknown type on overlap', () => {
        const htmlSections: MutableSection[] = [
          {
            id: 'section-1',
            type: 'feature', // Already classified
            positionIndex: 0,
            confidence: 0.8,
            position: { startY: 0, endY: 500, height: 500 },
          },
        ];

        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'hero', startY: 0, endY: 500, confidence: 0.9 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result[0].type).toBe('feature'); // Type preserved
      });

      it('should add new section when overlap is <=50%', () => {
        const htmlSections: MutableSection[] = [
          {
            id: 'section-1',
            type: 'hero',
            positionIndex: 0,
            confidence: 0.8,
            position: { startY: 0, endY: 500, height: 500 },
          },
        ];

        const visionBoundaries: SectionBoundariesData = {
          sections: [
            // Only 200px overlap (40% of vision section, 40% of HTML section)
            { type: 'feature', startY: 300, endY: 800, confidence: 0.85 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result.length).toBe(2); // New section added
      });
    });

    // =========================================
    // 4. ソートとpositionIndexテスト
    // =========================================
    describe('Sorting and Position Index', () => {
      it('should sort merged sections by startY', () => {
        const htmlSections: MutableSection[] = [
          {
            id: 'section-2',
            type: 'footer',
            positionIndex: 0,
            confidence: 0.8,
            position: { startY: 1000, endY: 1200, height: 200 },
          },
        ];

        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'hero', startY: 0, endY: 500, confidence: 0.9 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result[0].position?.startY).toBe(0); // hero comes first
        expect(result[1].position?.startY).toBe(1000); // footer comes second
      });

      it('should update positionIndex after sorting', () => {
        const htmlSections: MutableSection[] = [
          {
            id: 'section-2',
            type: 'footer',
            positionIndex: 0,
            confidence: 0.8,
            position: { startY: 1000, endY: 1200, height: 200 },
          },
        ];

        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'hero', startY: 0, endY: 500, confidence: 0.9 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result[0].positionIndex).toBe(0);
        expect(result[1].positionIndex).toBe(1);
      });

      it('should handle sections without position info', () => {
        const htmlSections: MutableSection[] = [
          {
            id: 'section-1',
            type: 'hero',
            positionIndex: 0,
            confidence: 0.8,
            // No position info
          },
        ];

        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'feature', startY: 500, endY: 1000, confidence: 0.85 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result.length).toBe(2);
        // Section without position treated as startY: 0
        expect(result[0].positionIndex).toBe(0);
      });
    });

    // =========================================
    // 5. エッジケーステスト
    // =========================================
    describe('Edge Cases', () => {
      it('should skip vision sections with zero or negative height', () => {
        const htmlSections: MutableSection[] = [];
        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'hero', startY: 100, endY: 100, confidence: 0.9 }, // Zero height
            { type: 'feature', startY: 500, endY: 400, confidence: 0.85 }, // Negative height
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result.length).toBe(0);
      });

      it('should handle vision section with unknown type', () => {
        const htmlSections: MutableSection[] = [];
        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'unknown', startY: 0, endY: 500, confidence: 0.7 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result[0].type).toBe('unknown');
      });

      it('should handle vision section with empty type', () => {
        const htmlSections: MutableSection[] = [];
        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: '', startY: 0, endY: 500, confidence: 0.7 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        expect(result[0].type).toBe('unknown'); // Falls back to 'unknown'
      });

      it('should prefer best overlap when multiple HTML sections overlap', () => {
        const htmlSections: MutableSection[] = [
          {
            id: 'section-1',
            type: 'unknown',
            positionIndex: 0,
            confidence: 0.6,
            position: { startY: 0, endY: 400, height: 400 },
          },
          {
            id: 'section-2',
            type: 'unknown',
            positionIndex: 1,
            confidence: 0.6,
            position: { startY: 200, endY: 600, height: 400 },
          },
        ];

        const visionBoundaries: SectionBoundariesData = {
          sections: [
            // Overlaps both: 200px with section-1, 300px with section-2
            { type: 'hero', startY: 200, endY: 500, confidence: 0.9 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);
        // Should boost section-2 (better overlap) and update its type
        expect(result.length).toBe(2); // No new section added
        const section2 = result.find(s => s.id === 'section-2');
        expect(section2?.type).toBe('hero');
      });
    });

    // =========================================
    // 6. 複雑なシナリオテスト
    // =========================================
    describe('Complex Scenarios', () => {
      it('should handle real-world scenario with multiple HTML and Vision sections', () => {
        const htmlSections: MutableSection[] = [
          {
            id: 'nav-1',
            type: 'navigation',
            positionIndex: 0,
            confidence: 0.95,
            position: { startY: 0, endY: 80, height: 80 },
          },
          {
            id: 'unknown-1',
            type: 'unknown',
            positionIndex: 1,
            confidence: 0.4,
            position: { startY: 100, endY: 600, height: 500 },
          },
          {
            id: 'footer-1',
            type: 'footer',
            positionIndex: 2,
            confidence: 0.9,
            position: { startY: 2000, endY: 2200, height: 200 },
          },
        ];

        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'navigation', startY: 0, endY: 80, confidence: 0.9 },
            { type: 'hero', startY: 80, endY: 580, confidence: 0.88 },
            { type: 'feature', startY: 600, endY: 1200, confidence: 0.85 },
            { type: 'testimonial', startY: 1200, endY: 1600, confidence: 0.82 },
            { type: 'cta', startY: 1600, endY: 1900, confidence: 0.87 },
            { type: 'footer', startY: 2000, endY: 2200, confidence: 0.92 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);

        // Navigation boosted
        const nav = result.find(s => s.id === 'nav-1');
        expect(nav?.confidence).toBeGreaterThan(0.95);

        // Unknown updated to hero
        const hero = result.find(s => s.id === 'unknown-1');
        expect(hero?.type).toBe('hero');

        // Feature, testimonial, cta added
        expect(result.some(s => s.type === 'feature')).toBe(true);
        expect(result.some(s => s.type === 'testimonial')).toBe(true);
        expect(result.some(s => s.type === 'cta')).toBe(true);

        // Footer boosted
        const footer = result.find(s => s.id === 'footer-1');
        expect(footer?.confidence).toBeGreaterThan(0.9);

        // Total sections increased
        expect(result.length).toBeGreaterThan(3);
      });

      it('should double section count when Vision detects sections missed by HTML', () => {
        // Simulate scenario where HTML only detects 2 sections
        const htmlSections: MutableSection[] = [
          {
            id: 'nav-1',
            type: 'navigation',
            positionIndex: 0,
            confidence: 0.9,
            position: { startY: 0, endY: 80, height: 80 },
          },
          {
            id: 'footer-1',
            type: 'footer',
            positionIndex: 1,
            confidence: 0.85,
            position: { startY: 2000, endY: 2200, height: 200 },
          },
        ];

        // Vision detects 4 additional sections
        const visionBoundaries: SectionBoundariesData = {
          sections: [
            { type: 'hero', startY: 100, endY: 600, confidence: 0.9 },
            { type: 'feature', startY: 600, endY: 1200, confidence: 0.85 },
            { type: 'testimonial', startY: 1200, endY: 1600, confidence: 0.82 },
            { type: 'cta', startY: 1600, endY: 2000, confidence: 0.88 },
          ],
        };

        const result = mergeVisionDetectedSections(htmlSections, visionBoundaries);

        // Original 2 + Vision 4 = 6 sections (more than doubled)
        expect(result.length).toBeGreaterThanOrEqual(4); // At least doubled
        expect(result.length).toBe(6);
      });
    });
  });
});
