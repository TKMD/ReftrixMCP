// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * INV-PART-PID-NOT-PERSISTED-001（VR-M-01）
 *
 * 取り込み時に振る `data-reftrix-pid` は、パーツ抽出が実測位置を引くためだけに使い、保存・
 * ハッシュ・埋め込み・後続フェーズに渡る文字列に残さない。あわせて、実測位置があるときの
 * パーツ抽出（見えている要素だけ・実測位置と style を使う）を固定する。
 *
 * The ingest-time `data-reftrix-pid` is only a key for part extraction and never survives into a
 * persisted, hashed, embedded or later-phase string. Also pins extraction with live geometry.
 */
import { describe, expect, it } from "vitest";
import { extractPartsFromSection } from "../../../src/services/part/part-extraction.service";
import { DEFAULT_PART_EXTRACTION_CONFIG } from "../../../src/services/part/types";
import type { PartGeometryMap } from "../../../src/services/part/part-live-geometry";
import { sanitizeHtml } from "../../../src/utils/html-sanitizer";
import { PART_PID_ATTR } from "../../../src/utils/part-pid";
import { releaseLayoutPids } from "../../../src/workers/phases/phase-1-layout";
import type { PipelineState } from "../../../src/workers/phases/types";

const SECTION = `<section ${PART_PID_ATTR}="10">
  <h2 ${PART_PID_ATTR}="11">Title</h2>
  <button ${PART_PID_ATTR}="12" class="btn">Go</button>
  <button ${PART_PID_ATTR}="13" class="btn">Hidden at capture</button>
  <a ${PART_PID_ATTR}="14" href="/x">Link</a>
</section>`;

describe("INV-PART-PID-NOT-PERSISTED-001", () => {
  it("extraction with live geometry keeps only measured elements, uses live rect/styles, drops the pid", async () => {
    const live: PartGeometryMap = new Map([
      [11, { x: 40, y: 1010, width: 300, height: 40, styles: { "font-size": "32px" } }],
      [
        12,
        { x: 40, y: 1080, width: 120, height: 44, styles: { "background-color": "rgb(1, 2, 3)" } },
      ],
      [14, { x: -20, y: 990, width: 80, height: 20 }],
    ]);
    const sectionBox = { x: 0, y: 1000, width: 1280, height: 400 };
    const result = await extractPartsFromSection({
      sectionHtml: SECTION,
      sectionIndex: 0,
      config: DEFAULT_PART_EXTRACTION_CONFIG,
      computedStylesMap: new Map(),
      sectionBoundingBox: sectionBox,
      liveGeometry: live,
    });

    expect(result.notVisibleCount).toBe(1);
    expect(result.parts.map((p) => p.partType).sort()).toEqual(["button", "heading", "link"]);
    const button = result.parts.find((p) => p.partType === "button")!;
    expect(button.boundingBox).toEqual({ x: 40, y: 80, width: 120, height: 44 });
    expect(button.computedStyles).toEqual({ "background-color": "rgb(1, 2, 3)" });
    // 実測値はクランプしない（セクション原点を足すと文書座標に戻る）/ live boxes are not clamped
    const link = result.parts.find((p) => p.partType === "link")!;
    expect(link.boundingBox).toEqual({ x: -20, y: -10, width: 80, height: 20 });

    for (const part of result.parts) {
      expect(JSON.stringify({ h: part.htmlSnippet, a: part.attributes })).not.toContain(
        PART_PID_ATTR
      );
    }
  });

  it("extraction without live geometry is unchanged (no notVisibleCount, JSDOM boxes)", async () => {
    const result = await extractPartsFromSection({
      sectionHtml: SECTION,
      sectionIndex: 0,
      config: DEFAULT_PART_EXTRACTION_CONFIG,
      computedStylesMap: new Map(),
      sectionBoundingBox: { x: 0, y: 0, width: 1280, height: 400 },
    });
    expect(result.notVisibleCount).toBeUndefined();
    expect(result.parts.filter((p) => p.partType === "button")).toHaveLength(2);
    for (const part of result.parts) {
      expect(JSON.stringify({ h: part.htmlSnippet, a: part.attributes })).not.toContain(
        PART_PID_ATTR
      );
    }
  });

  it("sanitizeHtml strips pids on the DOMPurify path", () => {
    expect(sanitizeHtml(SECTION)).not.toContain(PART_PID_ATTR);
    expect(
      sanitizeHtml(
        `<html><head><title>t</title></head><body ${PART_PID_ATTR}="0"><p ${PART_PID_ATTR}="1">x</p></body></html>`,
        { preserveDocumentStructure: true }
      )
    ).not.toContain(PART_PID_ATTR);
  });

  it("sanitizeHtml strips pids on the bypass path for huge HTML", () => {
    const huge = `<div ${PART_PID_ATTR}="1">` + "<p>x</p>".repeat(200_000) + `</div>`;
    expect(huge.length).toBeGreaterThan(1_000_000);
    expect(sanitizeHtml(huge)).not.toContain(PART_PID_ATTR);
  });

  it("releaseLayoutPids strips snippets handed to later phases and drops the numbered HTML", () => {
    const state = {
      layoutHtml: SECTION,
      partGeometry: new Map(),
      layoutResultForNarrative: {
        sections: [{ htmlSnippet: SECTION }, { htmlSnippet: undefined }],
      },
    } as unknown as PipelineState;
    releaseLayoutPids(state);
    expect(state.layoutHtml).toBeNull();
    expect(state.partGeometry).toBeNull();
    const sections = (
      state.layoutResultForNarrative as unknown as { sections: Array<{ htmlSnippet?: string }> }
    ).sections;
    expect(sections[0]!.htmlSnippet).not.toContain(PART_PID_ATTR);
  });
});
