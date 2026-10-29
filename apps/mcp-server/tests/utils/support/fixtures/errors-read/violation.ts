// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Violation fixture for INV-ZOD-ERRORS-READ-ZERO-001: reads `.errors` on a ZodError (line 11).
// The batch-result read below must NOT be reported.
import { z } from "zod";

export function readsZodErrors(): number {
  const parsed = z.string().safeParse(1);
  if (parsed.success) return 0;
  return parsed.error.errors.length;
}

export function readsBatchResultErrors(result: { errors: string[] }): number {
  return result.errors.length;
}
