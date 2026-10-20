// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 TKMD & Reftrix Contributors

/**
 * sharp-safe: libvips の SVG / Magick（IM6 / IM7）/ PDF loader を process 全体で block した sharp。
 * apps/mcp-server/src、apps/mcp-server/scripts、packages/*\/src、apps/cli/src の sharp 取得は
 * この module 経由に限る（INV-SEC-SHARP-SVG-BLOCK-001 (d)）。
 * leaf module: import は "sharp" のみ。block が無い sharp では import 時に throw する（fail-closed）。
 * IM7 の loader（VipsForeignLoadMagick7）は IM6 の VipsForeignLoadMagick の subclass ではないため
 * 別に指定する。prebuilt sharp には Magick / PDF loader が無く、その 3 要素は no-op。
 * global libvips build での効果は CI で検証していない（best-effort、IM7 環境は実測なし）。
 *
 * sharp with the SVG / Magick (IM6 / IM7) / PDF libvips loaders blocked process-wide. All sharp
 * acquisition in apps/mcp-server/src, apps/mcp-server/scripts, packages/*\/src and apps/cli/src
 * goes through this leaf module; it throws at import time if `block` is missing. The Magick / PDF
 * entries are no-ops on prebuilt sharp; on a global libvips build they are best-effort and
 * unverified (no ImageMagick 7 environment was measured).
 */
import sharp from "sharp";

if (typeof sharp.block !== "function") {
  throw new Error("sharp-safe: sharp.block is not available; refusing to load sharp unblocked");
}

sharp.block({
  operation: [
    "VipsForeignLoadSvg",
    "VipsForeignLoadMagick",
    "VipsForeignLoadMagick7",
    "VipsForeignLoadPdf",
  ],
});

export default sharp;
