// SPDX-FileCopyrightText: 2025-2026 Reftrix Contributors
// SPDX-License-Identifier: AGPL-3.0-only

// Negative fixture for INV-ZOD-ERRORS-READ-ZERO-001: none of these reads `errors` on a ZodError.
import { ZodError } from "zod";

interface BatchResult {
  errors: string[];
}

export function batchResult(result: BatchResult): number {
  const { errors } = result;
  return errors.length + result["errors"].length + result.errors.length;
}

export function issuesAreFine(e: ZodError): number {
  const { issues } = e;
  return issues.length + e["issues"].length + e.issues.length;
}

export function plainObject(): number {
  const bag = { errors: [1, 2] };
  let errors: number[] = [];
  ({ errors } = bag);
  return errors.length;
}
