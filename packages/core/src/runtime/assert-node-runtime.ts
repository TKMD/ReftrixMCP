// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Node.js runtime floor guard (side-effect module) / 起動時の fail-closed guard
 *
 * entrypoint の最初の import として読み込まれ、下限未満の実行時なら固定メッセージを stderr (fd 2) に同期書き込みして
 * exit 1 する。入力は `process.versions` / `process.release` / zlib の定数だけで、env・argv・
 * global は参照しない。回避経路は設けない。export は無い。
 * Loaded as the first import of every entrypoint; exits 1 with a fixed stderr message below the
 * floor. Reads only process.versions / process.release / zlib constants; no escape hatch.
 */

import fs from "node:fs";
import process from "node:process";
import zlib from "node:zlib";
import { NODE_ENGINES_RANGE, evaluateNodeRuntime } from "./node-runtime-floor.js";

const verdict = evaluateNodeRuntime({
  node: process.versions.node,
  undici: process.versions.undici,
  // @ts-expect-error -- @types/node does not declare this constant yet; present only on patched Node.
  brotliBlockSwitchMarker: zlib.constants.BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH,
  releaseName: process.release.name,
});

if (!verdict.ok) {
  // Synchronous write: the process must not continue to later imports before the message is out.
  fs.writeSync(
    2,
    `[reftrix] Unsupported Node.js runtime. Supported: ${NODE_ENGINES_RANGE}. See CHANGELOG.md (BREAKING: Node.js runtime floor).\n`
  );
  process.exit(1);
}
