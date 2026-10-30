// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only
//
// Test-only preload harness for INV-SEC-NODE-RUNTIME-FLOOR-001 (`node -r`).
// argv: <node> <undici> <release-name>. Only redefines process.versions / process.release.
// The product guard accepts no input; never place this file under src/ or dist/.
const [node, undici, releaseName] = process.argv.slice(2);
Object.defineProperty(process, "versions", {
  value: { ...process.versions, node, undici },
  configurable: true,
});
Object.defineProperty(process, "release", {
  value: { ...process.release, name: releaseName },
  configurable: true,
});
